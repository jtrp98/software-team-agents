import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureKnowledgeRoot,
  configureNamedKnowledgeRoot,
  InstallationConfigError,
} from "./installation.js";
import { auditTargetOwnershipAcrossRoots } from "./ownershipAudit.js";
import { exitCodeFor, runDoctor } from "./doctor.js";
import { canonicalRepositoryCoordinate } from "./repositoryIdentity.js";
import { summarizeKnowledgeSelection } from "./rootSelector.js";
import { canonicalPathForComparison } from "./installation.js";

/**
 * V11 TASK-025 — "Target ownership across configured roots" (DT §4). The
 * audit reads the canonical installation map plus every configured root's
 * targets.yaml and .workflow/targets.local.yaml — never a filesystem scan.
 * The R05 machine-state (two roots switched by hand, both registering the
 * same remote and mapping the same checkout) left `sta doctor` at exit 0 with
 * the other root invisible; this check is what makes that state FAIL.
 */

const roots: string[] = [];
function tempRoot(name: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sta-ownaudit-${name}-`)));
  roots.push(root);
  return root;
}
function initRepository(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}
function writeRegistry(knowledgeRoot: string, yaml: string): void {
  fs.writeFileSync(path.join(knowledgeRoot, "targets.yaml"), yaml, "utf8");
}
function writeLocalMapping(knowledgeRoot: string, yaml: string | null): void {
  const dir = path.join(knowledgeRoot, ".workflow");
  fs.mkdirSync(dir, { recursive: true });
  if (yaml !== null) fs.writeFileSync(path.join(dir, "targets.local.yaml"), yaml, "utf8");
}
function v1Entry(targetId: string, remote: string, type = "frontend"): string {
  return `  - target_id: ${targetId}\n    name: ${targetId}\n    remote_url: ${remote}\n    status: active\n    type: ${type}\n`;
}
function mapping(targetId: string, p: string): string {
  return `schema_version: 1\ntargets:\n  ${targetId}:\n    path: "${p.replaceAll("\\", "\\\\")}"\n`;
}
function namesInstallation(configPath: string, rootA: string, rootB: string): void {
  // the v2 writers validate roots as standalone Git checkouts, exactly as a
  // real machine's `sta configure` run would
  initRepository(rootA);
  initRepository(rootB);
  configureKnowledgeRoot(rootA, configPath);
  configureNamedKnowledgeRoot(rootA, { rootName: "personal", configPath });
  configureNamedKnowledgeRoot(rootB, { rootName: "work", configPath });
}
function owners(audit: ReturnType<typeof auditTargetOwnershipAcrossRoots>): string[] {
  return audit.problems.map((problem) => problem);
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("V11 TASK-025 — Target ownership across configured roots (DT §4)", () => {
  it("FAILs the R05 hand-switch state: the same remote registered and the same checkout mapped in two roots", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    const checkout = tempRoot("checkout");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeRegistry(rootB, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeLocalMapping(rootA, mapping("api", checkout));
    writeLocalMapping(rootB, mapping("api", checkout));

    const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });

    expect(audit.status).toBe("FAIL");
    expect(owners(audit)).toContainEqual(
      expect.stringContaining(
        `Target ownership: canonical repository "${canonicalRepositoryCoordinate("https://github.com/acme/api.git")}" appears in multiple configured roots: personal/api, work/api. Resolve through the human-gated ownership transfer before running either Target.`,
      ),
    );
    expect(owners(audit)).toContainEqual(
      expect.stringContaining(`is mapped by owning Targets in multiple configured roots: personal/api, work/api`),
    );
    expect(audit.warnings.join("\n")).toContain("Cross-machine Target ownership is unverified");
    expect(audit.scannedRoots).toEqual(["personal", "work"]);
  });

  it("FAILs when the same canonical key arrives under different remote spellings, and when an alias collides across roots", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeRegistry(
      rootB,
      `schema_version: 2\ntargets:\n  - target_id: service\n    name: service\n    remote_url: git@github.com:acme/api.git\n    status: active\n    ownership_state: owned\n    repository_aliases: []\n`,
    );

    const spelling = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(spelling.status).toBe("FAIL");
    expect(spelling.problems.join("\n")).toContain(`canonical repository "github.com/acme/api" appears in multiple configured roots: personal/api, work/service`);

    // An alias is the same identity space as the canonical key (DT §4): the
    // tombstone's past coordinate cannot resurface as another root's remote.
    writeRegistry(
      rootB,
      `schema_version: 2\ntargets:\n  - target_id: service\n    name: service\n    remote_url: https://github.com/acme/other.git\n    status: active\n    ownership_state: owned\n    repository_aliases: ["github.com/acme/api"]\n`,
    );
    const alias = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(alias.status).toBe("FAIL");
    expect(alias.problems.join("\n")).toContain(`canonical repository "github.com/acme/api" appears in multiple configured roots: personal/api, work/service`);
  });

  it("does not count a released tombstone as an owner, but keeps `retired` owning (DT §5.1)", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeRegistry(
      rootB,
      `schema_version: 2\ntargets:\n  - target_id: api\n    name: api\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: released\n    repository_aliases: []\n`,
    );
    const released = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(released.status).toBe("PASS");
    expect(released.problems).toEqual([]);
    expect(released.detail).toContain("released tombstone");

    writeRegistry(
      rootB,
      `schema_version: 2\ntargets:\n  - target_id: api\n    name: api\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: owned\n    repository_aliases: []\n`,
    );
    const retired = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(retired.status).toBe("FAIL");
    expect(retired.problems.join("\n")).toContain("appears in multiple configured roots");
  });

  it("FAILs on a registry that exists but cannot be proven, and treats an absent registry as empty (register's own semantics)", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    fs.writeFileSync(path.join(rootB, "targets.yaml"), "schema_version: 9\ntargets: []\n", "utf8");

    const broken = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(broken.status).toBe("FAIL");
    expect(broken.problems.join("\n")).toContain(`root "work" cannot be read`);
    expect(broken.problems.join("\n")).toContain("targets.yaml");

    fs.rmSync(path.join(rootB, "targets.yaml"));
    const absent = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(absent.status).toBe("PASS");
    expect(absent.scannedRoots).toEqual(["personal", "work"]);
  });

  it("WARNINGs an opaque legacy SSH alias with no machine-local mapping instead of silently passing uniqueness", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "git@github-work:acme/api.git")}`);
    writeRegistry(rootB, `schema_version: 1\ntargets:\n${v1Entry("other", "https://github.com/acme/other.git")}`);

    const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(audit.status).toBe("WARNING");
    expect(audit.problems).toEqual([]);
    expect(audit.warnings.join("\n")).toContain(`personal/api`);
    expect(audit.warnings.join("\n")).toContain("with no machine-local mapping");
  });

  it("WARNINGs (never FAILs silently) when the same opaque alias is mapped in one root but not the other — unprovable, not unique", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "git@github-work:acme/api.git")}`);
    writeRegistry(rootB, `schema_version: 1\ntargets:\n${v1Entry("api", "git@github-work:acme/api.git")}`);
    writeLocalMapping(
      rootA,
      `schema_version: 1\ntargets:\n  api:\n    path: "${tempRoot("unused").replaceAll("\\", "\\\\")}"\nremote_host_aliases:\n  github-work: github.com\n`,
    );

    const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
    expect(audit.status).toBe("WARNING");
    expect(audit.warnings.join("\n")).toContain("work/api");
  });

  it("answers PASS with a legacy note when no installation config exists, and never claims cross-machine coverage", () => {
    const missing = path.join(tempRoot("none"), "installation.yaml");
    const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: missing });
    expect(audit.status).toBe("PASS");
    expect(audit.scannedRoots).toEqual([]);
    expect(audit.warnings).toEqual([]);
    expect(audit.detail).toContain("no installation config");
  });

  it("surfaces an unreadable installation map as the check's failure, not a pass-by-absence", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    fs.writeFileSync(configPath, "schema_version: 1\nknowledge_root: relative/nonexistent\n", "utf8");
    // A v1 file that exists but points nowhere still loads; break it instead:
    fs.writeFileSync(configPath, "schema_version: 99\n", "utf8");
    expect(() => auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath })).toThrow(InstallationConfigError);
  });
});

describe("V11 TASK-025 — doctor wires the installation-wide check", () => {
  it("reports the R05 state as a FAIL check (exit 1) while every other check stays independent", async () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    const checkout = tempRoot("checkout");
    namesInstallation(configPath, rootA, rootB);
    writeRegistry(rootA, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeRegistry(rootB, `schema_version: 1\ntargets:\n${v1Entry("api", "https://github.com/acme/api.git")}`);
    writeLocalMapping(rootA, mapping("api", checkout));
    writeLocalMapping(rootB, mapping("api", checkout));

    const report = await runDoctor({ projectRoot: rootA, installationConfigPath: configPath });
    const check = report.checks.find((entry) => entry.name === "Target ownership across configured roots");
    expect(check).toBeDefined();
    expect(check!.status).toBe("FAIL");
    expect(check!.detail).toContain("personal/api, work/api");
    expect(check!.fix).toContain("ownership transfer");
    expect(exitCodeFor(report)).toBe(1);
  });

  it("stays PASS on a clean two-root installation, and `--root <name>` inspects the named root, not the default", async () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    initRepository(rootA);
    initRepository(rootB);
    namesInstallation(configPath, rootA, rootB);
    // the selected-root registry check treats a missing targets.yaml as its own
    // FAIL, so the clean fixture declares an empty registry on the default root
    writeRegistry(rootA, "schema_version: 1\ntargets: []\n");
    writeRegistry(rootB, `schema_version: 1\ntargets:\n${v1Entry("service", "https://github.com/acme/service.git")}`);

    const clean = await runDoctor({ projectRoot: rootA, installationConfigPath: configPath });
    const cleanCheck = clean.checks.find((entry) => entry.name === "Target ownership across configured roots");
    expect(cleanCheck!.status).toBe("PASS");
    expect(exitCodeFor(clean)).toBe(0);

    // DR §4: `sta doctor --root <name>` examines the named root; no flag means
    // the default (here `personal`). The Target registry check only exists for
    // the examined root, so its presence proves which root was inspected.
    const byFlag = await runDoctor({ projectRoot: rootA, installationConfigPath: configPath, knowledgeRootName: "work" });
    expect(byFlag.checks.find((entry) => entry.name === "Target registry (targets.yaml)")!.detail).toContain("1 target(s registered)");
    const byDefault = await runDoctor({ projectRoot: rootA, installationConfigPath: configPath });
    expect(byDefault.checks.find((entry) => entry.name === "Target registry (targets.yaml)")!.detail).toContain("0 target(s registered)");
  });
});

describe("V11 TASK-025 — summarizeKnowledgeSelection (DR §7.4: name, path, source, default)", () => {
  it("summarizes the selected root and the untouched default for v2, with and without --root", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);
    const same = (a: string | undefined, b: string): boolean => a !== undefined && canonicalPathForComparison(a) === canonicalPathForComparison(b);

    const byDefault = summarizeKnowledgeSelection({ installationConfigPath: configPath });
    expect(byDefault).toMatchObject({ name: "personal", source: "default", defaultRootName: "personal" });
    expect(same(byDefault!.path, rootA)).toBe(true);

    const byFlag = summarizeKnowledgeSelection({ installationConfigPath: configPath, requestedName: "work" });
    expect(byFlag).toMatchObject({ name: "work", source: "flag", defaultRootName: "personal" });
    expect(same(byFlag!.path, rootB)).toBe(true);
    expect(same(byFlag!.defaultPath, byDefault!.defaultPath as string)).toBe(true);
  });

  it("reports the legacy v1 selection and answers undefined when no installation exists", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    initRepository(rootA);
    configureKnowledgeRoot(rootA, configPath);

    const legacy = summarizeKnowledgeSelection({ installationConfigPath: configPath });
    expect(legacy).toMatchObject({ name: "default", source: "legacy-v1", defaultRootName: "default" });

    expect(summarizeKnowledgeSelection({ installationConfigPath: path.join(tempRoot("none"), "installation.yaml") })).toBeUndefined();
  });

  it("reports a managed launch-env selection with the installation default, and never invents a name for it", () => {
    const configPath = path.join(tempRoot("cfg"), "installation.yaml");
    const rootA = tempRoot("rootA");
    const rootB = tempRoot("rootB");
    namesInstallation(configPath, rootA, rootB);

    const launched = summarizeKnowledgeSelection({
      installationConfigPath: configPath,
      env: { STA_KNOWLEDGE_ROOT: rootB, STA_KNOWLEDGE_ROOT_NAME: "work" },
    });
    expect(launched).toMatchObject({ name: "work", source: "launch-env", defaultRootName: "personal" });

    const unnamed = summarizeKnowledgeSelection({ installationConfigPath: configPath, env: { STA_KNOWLEDGE_ROOT: rootB } });
    expect(unnamed!.name).toBeUndefined();
    expect(unnamed!.source).toBe("launch-env");
    expect(unnamed!.defaultRootName).toBe("personal");
  });
});
