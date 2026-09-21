import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declareInstallationConfigOverrideChannelForTest } from "./installation.js";
import { loadTargetRegistry, normalizeTargetRegistry, writeTargetRegistry } from "./targets.js";
import { registerTarget, type RegisterTargetInput } from "./targetRegistration.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DT §2.4/§3.1/§6 — target-registry v2 (dual-reader) and the administrative
 * register surface. Six steps before any write: canonical installation roots
 * snapshot → every root's registry loaded (sorted, unreadable = refuse) →
 * canonicalize remote_url + aliases → key/alias collision within and across
 * roots → `assertTargetIdsImmutable` → fresh re-validation before the write.
 * A direct `writeTargetRegistry` call that adds or flips ownership without
 * the register context is refused — it must not become a bypass API.
 */

const roots: string[] = [];
const originalConfigEnv = process.env.STA_INSTALLATION_CONFIG;

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sta-targetreg-${prefix}-`));
  roots.push(dir);
  return dir;
}

function knowledgeRoot(prefix: string, registryYaml?: string, localYaml?: string): string {
  const dir = tmpDir(prefix);
  fs.mkdirSync(path.join(dir, ".workflow"), { recursive: true });
  if (registryYaml !== undefined) fs.writeFileSync(path.join(dir, "targets.yaml"), registryYaml, "utf8");
  if (localYaml !== undefined) fs.writeFileSync(path.join(dir, ".workflow", "targets.local.yaml"), localYaml, "utf8");
  return dir;
}

function twoRootInstallation(rootA: string, rootB: string): string {
  const configPath = path.join(tmpDir("cfg"), "installation.yaml");
  fs.writeFileSync(
    configPath,
    `schema_version: 2\nknowledge_root: ${JSON.stringify(rootA)}\ndefault_root: alpha\nknowledge_roots:\n  alpha: ${JSON.stringify(rootA)}\n  beta: ${JSON.stringify(rootB)}\n`,
    "utf8",
  );
  process.env.STA_INSTALLATION_CONFIG = configPath;
  return configPath;
}

function register(overrides: Partial<RegisterTargetInput>): ReturnType<typeof registerTarget> {
  return registerTarget({
    targetId: "api",
    name: "Orders API",
    remoteUrl: "https://github.com/acme/api.git",
    ...overrides,
  });
}

afterEach(() => {
  if (originalConfigEnv === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = originalConfigEnv;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("registry v2 dual-reader (DT §2.4/§6)", () => {
  it("a v1 registry normalizes in memory to owned + empty aliases, and the file bytes stay untouched", () => {
    const k = knowledgeRoot("v1", "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n");
    const before = fs.readFileSync(path.join(k, "targets.yaml"));
    const normalized = normalizeTargetRegistry(loadTargetRegistry(k));
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.targets[0]).toMatchObject({ target_id: "api", ownership_state: "owned", repository_aliases: [] });
    expect(fs.readFileSync(path.join(k, "targets.yaml")).equals(before)).toBe(true);
  });

  it("a v2 registry round-trips ownership_state and canonical repository_aliases", () => {
    const k = knowledgeRoot("v2");
    writeTargetRegistry(k, {
      schema_version: 2,
      targets: [{
        target_id: "api",
        name: "API",
        remote_url: "https://github.com/acme/api.git",
        status: "retired",
        type: "backend",
        ownership_state: "owned",
        repository_aliases: ["git.example.com/legacy/api"],
      }],
    }, { ownership: { channel: "register-flow", operation: "addition" } });
    const normalized = normalizeTargetRegistry(loadTargetRegistry(k));
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.targets[0]).toMatchObject({ ownership_state: "owned", repository_aliases: ["git.example.com/legacy/api"] });

    writeTargetRegistry(k, {
      schema_version: 2,
      targets: [{
        target_id: "api",
        name: "API",
        remote_url: "https://github.com/acme/api.git",
        status: "retired",
        type: "backend",
        ownership_state: "released",
        repository_aliases: ["git.example.com/legacy/api"],
      }],
    }, { ownership: { channel: "register-flow", operation: "ownership-release" } });
    expect(normalizeTargetRegistry(loadTargetRegistry(k)).targets[0]?.ownership_state).toBe("released");
  });

  it("v2 rejects a non-canonical alias and an active+released combination (DT §5.1/§6)", () => {
    const k = knowledgeRoot("v2bad");
    expect(() => writeTargetRegistry(k, {
      schema_version: 2,
      targets: [{
        target_id: "api",
        name: "API",
        remote_url: "https://github.com/acme/api.git",
        status: "active",
        ownership_state: "owned",
        repository_aliases: ["github-work/acme/api"],
      }],
    }, { ownership: { channel: "register-flow", operation: "addition" } })).toThrow(/repository_aliases entry "github-work\/acme\/api" is not a canonical repository coordinate/);

    expect(() => writeTargetRegistry(k, {
      schema_version: 2,
      targets: [{
        target_id: "api",
        name: "API",
        remote_url: "https://github.com/acme/api.git",
        status: "active",
        ownership_state: "released",
      }],
    }, { ownership: { channel: "register-flow", operation: "addition" } })).toThrow(/active\+released, which is invalid/);
  });

  it("a direct write that adds ownership without the register context is refused (DT §3.1 step 6)", () => {
    const k = knowledgeRoot("bypass");
    expect(() => writeTargetRegistry(k, {
      schema_version: 1,
      targets: [{ target_id: "api", name: "API", remote_url: "https://github.com/acme/api.git", status: "active" }],
    })).toThrow(/administrative register flow/);
    // Ownership-neutral writes (a type narrowing against an existing
    // registry) stay direct.
    const k2 = knowledgeRoot("direct", "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n");
    writeTargetRegistry(k2, {
      schema_version: 1,
      targets: [{ target_id: "api", name: "API", remote_url: "https://github.com/acme/api.git", status: "active", type: "fullstack" }],
    });
    expect(loadTargetRegistry(k2).targets[0]?.type).toBe("fullstack");
  });
});

describe("registerTarget — the DT §3.1 six-step write path", () => {
  it("adds a Target to the default root on a two-root installation and writes registry v2", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    const result = register({});
    expect(result.rootName).toBe("alpha");
    expect(fs.readFileSync(path.join(rootA, "targets.yaml"), "utf8")).toContain("schema_version: 2");
    expect(normalizeTargetRegistry(loadTargetRegistry(rootA)).targets[0]).toMatchObject({ target_id: "api", ownership_state: "owned" });
    expect(fs.existsSync(path.join(rootB, "targets.yaml"))).toBe(true);
  });

  it("refuses a canonical repository already owned by another root with the transfer guidance (draft error 1)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ rootName: "beta" })).toThrow(
      /Target registration refused: canonical repository "github\.com\/acme\/api" is already owned by root "alpha" as Target "backend"/,
    );
    expect(() => register({ rootName: "beta" })).toThrow(/do not edit targets\.yaml by hand\./);
  });

  it("refuses fail-closed when another root's registry is unreadable (draft error 2)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n");
    const rootB = knowledgeRoot("beta", "this is not: [a registry\n");
    twoRootInstallation(rootA, rootB);
    // The unreadable-reason text is multiline (the YAML parse error), so the
    // refusal's head and tail are asserted separately.
    expect(() => register({})).toThrow(/Cannot verify machine-local Target ownership: registry for root "beta" is unreadable:/);
    expect(() => register({})).toThrow(/Repair that registry and retry; registration is refused fail-closed\./);
  });

  it("refuses an alias-form remote whose SSH host has no machine-local mapping (draft error 3)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ remoteUrl: "git@github-work:acme/api.git" })).toThrow(
      /Cannot verify Target ownership: remote "git@github-work:acme\/api\.git" uses SSH host alias "github-work" with no machine-local canonical-host mapping\. Declare the alias or use a canonical remote_url; registration is refused fail-closed\./,
    );
  });

  it("uses machine-local remote_host_aliases from the root's targets.local.yaml to canonicalize", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n", "schema_version: 1\ntargets: {}\nremote_host_aliases:\n  github-work: github.com\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    const result = register({ remoteUrl: "git@github-work:acme/api.git" });
    expect(result.canonicalCoordinate).toBe("github.com/acme/api");
  });

  it("refuses an alias that collides with another root's owned coordinate (DT §6)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 2\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/other.git\n    status: active\n    ownership_state: owned\n    repository_aliases: [github.com/acme/api]\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ rootName: "beta" })).toThrow(/already owned by root "alpha"/);
  });

  it("refuses credential-bearing remotes and remotes that canonicalize to nothing (DT §6)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ remoteUrl: "https://user:token@github.com/acme/api.git" })).toThrow(/credential/);
    expect(() => register({ remoteUrl: "C:\\local\\path" })).toThrow(/canonicalized/);
  });

  it("reactivates a retired Target through the flow (DT §3.1)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    type: backend\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    const result = register({});
    expect(result.operation).toBe("reactivation");
    expect(normalizeTargetRegistry(loadTargetRegistry(rootA)).targets[0]?.status).toBe("active");
  });

  it("refuses an identity change hidden as a reactivation — remote moves go through the transfer gate (DT §2.4)", () => {
    const rootA = knowledgeRoot("alpha2", "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    type: backend\n");
    const rootB = knowledgeRoot("beta2", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ remoteUrl: "https://github.com/acme/api-v2.git" })).toThrow(
      /remote_url is immutable and its canonical identity changed/,
    );
  });

  it("refuses re-registering an already-active id in its own root", () => {
    const rootA = knowledgeRoot("alpha3", "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n");
    const rootB = knowledgeRoot("beta3", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({})).toThrow(/already active in root "alpha"/);
  });

  it("an unknown --root name refuses with the deterministic root list before any write", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 1\ntargets: []\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    expect(() => register({ rootName: "demo" })).toThrow(/unknown Knowledge root "demo"; available roots: alpha, beta; default: alpha/);
    expect(fs.readFileSync(path.join(rootA, "targets.yaml"), "utf8")).toContain("targets: []");
  });

  it("a released tombstone in another root does not count as an owner (DT §4 PASS rule)", () => {
    const rootA = knowledgeRoot("alpha", "schema_version: 2\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: released\n");
    const rootB = knowledgeRoot("beta", "schema_version: 1\ntargets: []\n");
    twoRootInstallation(rootA, rootB);
    const result = register({ rootName: "beta" });
    expect(result.canonicalCoordinate).toBe("github.com/acme/api");
  });
});

describe("registerTarget — legacy single-root (v1) installation", () => {
  it("snapshots the synthetic default root and writes v2 into it", () => {
    const k = knowledgeRoot("legacy", "schema_version: 1\ntargets: []\n");
    const configPath = path.join(tmpDir("cfg"), "installation.yaml");
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(k)}\n`, "utf8");
    process.env.STA_INSTALLATION_CONFIG = configPath;
    const result = register({});
    expect(result.rootName).toBe("default");
    expect(normalizeTargetRegistry(loadTargetRegistry(k)).targets[0]).toMatchObject({ target_id: "api" });
  });
});

describe("normalizeTargetRegistry — released stays loadable for tombstone reads", () => {
  it("keeps target_id/remote_url/aliases readable on a released entry", () => {
    const k = knowledgeRoot("tomb", "schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: released\n    repository_aliases: [git.example.com/legacy/api]\n");
    const entry = normalizeTargetRegistry(loadTargetRegistry(k)).targets[0];
    expect(entry).toMatchObject({
      target_id: "api",
      remote_url: "https://github.com/acme/api.git",
      status: "retired",
      ownership_state: "released",
      repository_aliases: ["git.example.com/legacy/api"],
    });
  });
});

describe("TASK-028 sweep — duplicates inside one root (DT §6 reject row)", () => {
  it("a v2 file whose two entries claim one coordinate does not load — the collision refuses at read time", () => {
    const k = knowledgeRoot(
      "v2-collide",
      `schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    ownership_state: owned\n  - target_id: backend\n    name: Backend\n    remote_url: git@github.com:acme/api.git\n    status: active\n    ownership_state: owned\n`,
    );
    expect(() => loadTargetRegistry(k)).toThrow(
      /Target registry coordinates "api" and "backend" collide on "github\.com\/acme\/api"/,
    );
  });

  it("the register flow refuses a second Target whose remote canonicalizes to a coordinate the same root already owns", () => {
    const alpha = knowledgeRoot("alpha");
    const beta = knowledgeRoot("beta");
    twoRootInstallation(alpha, beta);
    register({});
    expect(() => register({ targetId: "api-shadow", name: "Shadow" })).toThrow(
      /canonical repository "github\.com\/acme\/api" is already owned by root "alpha" as Target "api"/,
    );
  });

  it("a retired Target of another root that was never released still blocks a new registration — only the transfer lifts it (DT §6)", () => {
    const alpha = knowledgeRoot(
      "alpha",
      `schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: owned\n`,
    );
    const beta = knowledgeRoot("beta");
    twoRootInstallation(alpha, beta);
    expect(() => register({ rootName: "beta" })).toThrow(
      /canonical repository "github\.com\/acme\/api" is already owned by root "alpha" as Target "api"/,
    );
  });
});
