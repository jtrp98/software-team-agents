import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import type { ThreeRepoRequestRoots } from "./preflight.js";
import { declareInstallationConfigOverrideChannelForTest, InstallationConfigError } from "./installation.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * The extracted three-repo resolvers, tested directly.
 *
 * `loadInstallationConfig` and `preflightThreeRepoTask` are the two seams
 * shared across call sites; mocking them lets each fail-open branch be
 * exercised cheaply. `cliRoots.integration.test.ts` covers the resolver with a
 * real framework/knowledge/target installation and no preflight mock.
 */
const loadInstallationConfig = vi.fn();
const preflightThreeRepoTask = vi.fn();

vi.mock("./installation.js", async (importOriginal) => {
  // [amended R10] rootSelector (imported by cliRoots) needs the real
  // InstallationConfigError/normalizeKnowledgeRoots, so the mock now spreads
  // the actual module and overrides only the three IO seams.
  const actual = await importOriginal<typeof import("./installation.js")>();
  return {
    ...actual,
    defaultInstallationConfigPath: () => "__sta_cli_roots_missing_installation__.yaml",
    installationConfigOverride: () => process.env.STA_INSTALLATION_CONFIG || undefined,
    loadInstallationConfig: (...a: unknown[]) => loadInstallationConfig(...a),
  };
});
vi.mock("./preflight.js", () => ({
  preflightThreeRepoTask: (...a: unknown[]) => preflightThreeRepoTask(...a),
}));
vi.mock("../targetcli/roots.js", () => ({
  resolveFrameworkRoot: () => "/framework/root",
}));

const { resolveWritableWorkRoots, resolveDocsRoot, resolveThreeRepoTaskLookup } = await import("./cliRoots.js");
const originalInstallationConfig = process.env.STA_INSTALLATION_CONFIG;

const PR = "/project/root";
const workRoots = (rs: ThreeRepoRequestRoots["workRoots"]): ThreeRepoRequestRoots => ({
  bindingRoot: "/fw",
  knowledgeRoot: "/kn",
  knowledgeRootName: "default",
  workRoots: rs,
});

beforeEach(() => {
  loadInstallationConfig.mockReset();
  preflightThreeRepoTask.mockReset();
  process.env.STA_INSTALLATION_CONFIG = "__sta_cli_roots_missing_installation__.yaml";
});

afterEach(() => {
  if (originalInstallationConfig === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = originalInstallationConfig;
});

describe("resolveWritableWorkRoots", () => {
  it("no installation config (legacy project) → [projectRoot]", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null }, AgentStage.QA_ENGINEER)).toEqual([{ path: PR }]);
  });

  it("installation config present, but the task is not in the store → refuses", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*Target binding.*state store/);
    expect(preflightThreeRepoTask).not.toHaveBeenCalled();
  });

  it("installation config with Target roots → deduped paths regardless of QA's read access", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(
      workRoots([
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "b", path: "/repo/b", access: "write" },
        { targetId: "c", path: "/repo/c", access: "read" },
      ]),
    );
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toEqual([
      { targetId: "a", path: "/repo/a" },
      { targetId: "b", path: "/repo/b" },
      { targetId: "c", path: "/repo/c" },
    ]);
  });

  it("installation config present but no Target roots resolved → refuses", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(workRoots([]));
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*no resolvable Target.*binding is missing/);
  });

  it("a throwing three-repo preflight → refuses with the task and binding failure", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    preflightThreeRepoTask.mockImplementation(() => {
      throw new Error("Target bindings are not usable");
    });
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*Target binding.*not usable/);
  });

  it("uses the real Framework root rather than the caller's Target workspace", () => {
    process.env.STA_INSTALLATION_CONFIG = "/somewhere/installation.yaml";
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(workRoots([{ targetId: "a", path: "/repo/a", access: "write" }]));
    resolveWritableWorkRoots(PR, "T-9", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER);
    expect(preflightThreeRepoTask).toHaveBeenCalledWith({}, AgentStage.QA_ENGINEER, {
      frameworkRoot: "/framework/root",
      installationConfigPath: "/somewhere/installation.yaml",
    });
  });
});

describe("resolveDocsRoot", () => {
  it("no installation config (legacy project) → projectRoot", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new InstallationConfigError("cannot read installation config");
    });
    expect(resolveDocsRoot(PR)).toBe(path.resolve(PR));
  });

  it("installation file exists but is unusable → throws (fail-closed, DR §3 rule 6)", () => {
    // [amended R10 — knowingly] The removed case mocked `{}` (a shape the
    // loader can never return — schema requires schema_version +
    // knowledge_root) and pinned the A12 silent projectRoot fallback.
    // TASK-017 makes "exists but broken" a thrown error; missing file stays
    // legacy (covered by the case above via the absent config path).
    const existing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sta-cliRoots-broken-")), "installation.yaml");
    fs.writeFileSync(existing, "placeholder: the loader is mocked; only the file's existence matters", "utf8");
    process.env.STA_INSTALLATION_CONFIG = existing;
    loadInstallationConfig.mockImplementation(() => {
      throw new InstallationConfigError("installation config is invalid: ...");
    });
    expect(() => resolveDocsRoot(PR)).toThrow(/installation config is invalid/);
  });

  it("installation config with knowledge_root → the knowledge root", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/knowledge" });
    expect(resolveDocsRoot(PR)).toBe(path.resolve("/knowledge"));
  });
});

describe("resolveThreeRepoTaskLookup", () => {
  it("no installation config → undefined (legacy, executor gets no threeRepoTask)", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new InstallationConfigError("cannot read installation config");
    });
    expect(resolveThreeRepoTaskLookup(PR, { loadTask: () => null })).toBeUndefined();
  });

  it("installation file exists but is unusable → throws (A15 fail-closed, DR §3 rule 6)", () => {
    // [amended R10 — knowingly] pins the TASK-017 conversion of the A15
    // fail-open: a broken installation no longer passes for a legacy project.
    const existing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sta-cliRoots-broken-")), "installation.yaml");
    fs.writeFileSync(existing, "placeholder: the loader is mocked; only the file's existence matters", "utf8");
    process.env.STA_INSTALLATION_CONFIG = existing;
    loadInstallationConfig.mockImplementation(() => {
      throw new InstallationConfigError("installation config is invalid: ...");
    });
    expect(() => resolveThreeRepoTaskLookup(PR, { loadTask: () => null })).toThrow(/installation config is invalid/);
  });

  it("installation config present → a per-stage lookup that reloads the task each call", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    const roots = workRoots([{ targetId: "a", path: "/repo/a", access: "write" }]);
    preflightThreeRepoTask.mockReturnValue(roots);
    const task = { taskId: "T-1" };
    let calls = 0;
    const lookup = resolveThreeRepoTaskLookup(PR, {
      loadTask: () => {
        calls += 1;
        return task as never;
      },
    });
    expect(lookup).toBeTypeOf("function");
    expect(lookup!("T-1", AgentStage.BACKEND_ENGINEER)).toEqual({ task, roots });
    lookup!("T-1", AgentStage.QA_ENGINEER);
    expect(calls).toBe(2);
  });

  it("the lookup throws if the task vanished from the store", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/kn" });
    const lookup = resolveThreeRepoTaskLookup(PR, { loadTask: () => null });
    expect(() => lookup!("T-gone", AgentStage.QA_ENGINEER)).toThrow(/disappeared from the state store/);
  });
});

describe("all five production call sites share the same resolvers", () => {
  function oldDocsRoot(projectRoot: string): string {
    let out = path.resolve(projectRoot);
    try {
      const installation = loadInstallationConfig(process.env.STA_INSTALLATION_CONFIG || undefined) as {
        knowledge_root?: string;
      };
      if (installation.knowledge_root) out = path.resolve(installation.knowledge_root);
    } catch {
      /* legacy */
    }
    return out;
  }

  it("single-repo (no config): all five sites resolve to projectRoot", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new InstallationConfigError("cannot read installation config");
    });
    const task = {};
    const store = { loadTask: () => task as never };
    // Three writable-root sites: qaRoots and both changedFiles closures.
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([{ path: PR }]);
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([{ path: PR }]);
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([{ path: PR }]);
    // two docs-root sites (qaDocsRoot + previousRound closure)
    expect(resolveDocsRoot(PR)).toBe(path.resolve(PR));
    expect(resolveDocsRoot(PR)).toBe(oldDocsRoot(PR));
  });

  it("three-repo: all five sites resolve consistently without a Framework fallback", () => {
    loadInstallationConfig.mockReturnValue({ schema_version: 1, knowledge_root: "/knowledge" });
    preflightThreeRepoTask.mockReturnValue(
      workRoots([
        { targetId: "be", path: "/t/be", access: "write" },
        { targetId: "fe", path: "/t/fe", access: "read" },
      ]),
    );
    const task = { taskId: "T-1" };
    const store = { loadTask: () => task as never };

    const a = resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER);
    const b = resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER);
    const c = resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER);
    expect(a).toEqual([
      { targetId: "be", path: "/t/be" },
      { targetId: "fe", path: "/t/fe" },
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual(c);

    const d1 = resolveDocsRoot(PR);
    const d2 = resolveDocsRoot(PR);
    expect(d1).toBe(path.resolve("/knowledge"));
    expect(d1).toBe(d2);
    expect(d1).toBe(oldDocsRoot(PR));
  });
});
