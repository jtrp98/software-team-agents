import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declareInstallationConfigOverrideChannelForTest,
  type InstallationConfig,
} from "./installation.js";
import {
  extractRootSelectorFlag,
  matchInstalledKnowledgeRootPath,
  resolveInstallationRoot,
  resolveSelectedKnowledgeRootOrLegacy,
  RootSelectorFlagError,
} from "./rootSelector.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DR §3/§8.2 — the central Knowledge-root selector. Exactly one root leaves
 * this module per invocation; a caller never receives the roots map. The
 * fixtures here mirror the design's selector/CLI table: default selection,
 * named selection, deterministic unknown-name refusal (names only, no paths),
 * legacy v1 assertion, the `--root` flag refusals and the fail-closed
 * read-side ("installation exists but is broken" never degrades to
 * projectRoot — only a missing installation file does).
 */

const V1: InstallationConfig = { schema_version: 1, knowledge_root: "C:\\kn\\root" };
const V2: InstallationConfig = {
  schema_version: 2,
  knowledge_root: "C:\\kn\\work",
  default_root: "work",
  knowledge_roots: { personal: "C:\\kn\\personal", work: "C:\\kn\\work" },
};

describe("resolveInstallationRoot — the one selector (DR §3)", () => {
  it("v1 + no flag → the synthetic default root (source legacy-v1)", () => {
    expect(resolveInstallationRoot(V1)).toEqual({
      name: "default",
      path: path.resolve("C:\\kn\\root"),
      source: "legacy-v1",
    });
  });

  it("v1 + --root default → the exact same value", () => {
    expect(resolveInstallationRoot(V1, "default")).toEqual(resolveInstallationRoot(V1));
  });

  it("v1 + any other name → refused, available roots listed", () => {
    expect(() => resolveInstallationRoot(V1, "work")).toThrow(/unknown Knowledge root "work"; available roots: default/);
  });

  it("v2 + no flag → default_root", () => {
    const selected = resolveInstallationRoot(V2);
    expect(selected.name).toBe("work");
    expect(selected.path).toBe(path.resolve("C:\\kn\\work"));
    expect(selected.source).toBe("default");
  });

  it("v2 + --root <name> → that entry as flag source, without touching the default", () => {
    expect(resolveInstallationRoot(V2, "personal")).toEqual({
      name: "personal",
      path: path.resolve("C:\\kn\\personal"),
      source: "flag",
    });
    expect(resolveInstallationRoot(V2).name).toBe("work");
  });

  it("v2 + unknown name → exit-grade error: deterministic sorted names + default, no paths", () => {
    expect(() => resolveInstallationRoot(V2, "demo")).toThrow(
      `unknown Knowledge root "demo"; available roots: personal, work; default: work`,
    );
    const message = (() => {
      try {
        resolveInstallationRoot(V2, "demo");
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();
    expect(message).not.toMatch(/C:\\|C:\//);
  });
});

describe("extractRootSelectorFlag — the one --root parser rule set", () => {
  it("extracts --root <name> wherever it appears and drops the pair from rest", () => {
    expect(extractRootSelectorFlag(["--module", "m", "--root", "work", "--until", "qa"])).toEqual({
      requestedName: "work",
      rest: ["--module", "m", "--until", "qa"],
    });
  });

  it("no --root → undefined name, argv unchanged", () => {
    expect(extractRootSelectorFlag(["--module", "m"])).toEqual({ requestedName: undefined, rest: ["--module", "m"] });
  });

  it("missing value → refused", () => {
    expect(() => extractRootSelectorFlag(["--root"])).toThrow(RootSelectorFlagError);
    expect(() => extractRootSelectorFlag(["--root", "--module"])).toThrow(/--root requires a root name/);
  });

  it("duplicate --root → refused", () => {
    expect(() => extractRootSelectorFlag(["--root", "a", "--root", "b"])).toThrow(/--root may be given at most once/);
  });

  it("--root together with --knowledge-root → refused (DR §4)", () => {
    expect(() => extractRootSelectorFlag(["--root", "a", "--knowledge-root", "C:\\kn"])).toThrow(
      /--root and --knowledge-root are mutually exclusive/,
    );
    expect(() => extractRootSelectorFlag(["--knowledge-root", "C:\\kn"])).not.toThrow();
  });

  it("a value violating the root-name contract → refused before any disk read", () => {
    expect(() => extractRootSelectorFlag(["--root", "Work"])).toThrow(/must match/);
  });
});

describe("resolveSelectedKnowledgeRootOrLegacy — fail-closed read side (DR §3 rule 6)", () => {
  const roots: string[] = [];
  const original = process.env.STA_INSTALLATION_CONFIG;
  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-rootselector-"));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    if (original === undefined) delete process.env.STA_INSTALLATION_CONFIG;
    else process.env.STA_INSTALLATION_CONFIG = original;
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("installation file missing → legacy projectRoot (unchanged)", () => {
    process.env.STA_INSTALLATION_CONFIG = path.join(tmpDir(), "absent.yaml");
    const projectRoot = tmpDir();
    expect(resolveSelectedKnowledgeRootOrLegacy(projectRoot)).toBe(path.resolve(projectRoot));
  });

  it("installation file present but invalid → throws, never degrades to projectRoot", () => {
    const cfgDir = tmpDir();
    const configPath = path.join(cfgDir, "installation.yaml");
    fs.writeFileSync(configPath, "schema_version: 1\nknowledge_root: 123\n", "utf8");
    process.env.STA_INSTALLATION_CONFIG = configPath;
    expect(() => resolveSelectedKnowledgeRootOrLegacy(tmpDir())).toThrow(/installation config is invalid/);
  });

  it("v2 installation + requested name → the selected root path", () => {
    const cfgDir = tmpDir();
    const configPath = path.join(cfgDir, "installation.yaml");
    fs.writeFileSync(
      configPath,
      "schema_version: 2\nknowledge_root: C:\\kn\\work\ndefault_root: work\nknowledge_roots:\n  personal: C:\\kn\\personal\n  work: C:\\kn\\work\n",
      "utf8",
    );
    process.env.STA_INSTALLATION_CONFIG = configPath;
    expect(resolveSelectedKnowledgeRootOrLegacy(tmpDir(), "personal")).toBe(path.resolve("C:\\kn\\personal"));
  });
});

describe("matchInstalledKnowledgeRootPath — the --knowledge-root compatibility assertion (DR §4)", () => {
  it("v1: a canonical-matching path (case/slash tolerant on win32) resolves to the root", () => {
    expect(matchInstalledKnowledgeRootPath(V1, "c:/KN/ROOT")).toBe(path.resolve("C:\\kn\\root"));
  });

  it("v2: a path outside knowledge_roots → refused", () => {
    expect(() => matchInstalledKnowledgeRootPath(V2, "C:\\elsewhere\\kn")).toThrow(/does not match any registered Knowledge root/);
  });

  it("v2: a path matching exactly one entry resolves to that entry", () => {
    expect(matchInstalledKnowledgeRootPath(V2, "C:\\kn\\PERSONAL\\")).toBe(path.resolve("C:\\kn\\personal"));
  });
});
