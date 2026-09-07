import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import type { ThreeRepoRequestRoots } from "./preflight.js";

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

vi.mock("./installation.js", () => ({
  defaultInstallationConfigPath: () => "__sta_cli_roots_missing_installation__.yaml",
  loadInstallationConfig: (...a: unknown[]) => loadInstallationConfig(...a),
}));
vi.mock("./preflight.js", () => ({
  preflightThreeRepoTask: (...a: unknown[]) => preflightThreeRepoTask(...a),
}));
vi.mock("../targetcli/roots.js", () => ({
  resolveFrameworkRoot: () => "/framework/root",
}));

const { resolveWritableWorkRoots, resolveDocsRoot, resolveThreeRepoTaskLookup } = await import("./cliRoots.js");
const originalInstallationConfig = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;

const PR = "/project/root";
const workRoots = (rs: ThreeRepoRequestRoots["workRoots"]): ThreeRepoRequestRoots => ({
  bindingRoot: "/fw",
  knowledgeRoot: "/kn",
  workRoots: rs,
});

beforeEach(() => {
  loadInstallationConfig.mockReset();
  preflightThreeRepoTask.mockReset();
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG = "__sta_cli_roots_missing_installation__.yaml";
});

afterEach(() => {
  if (originalInstallationConfig === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
  else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = originalInstallationConfig;
});

describe("resolveWritableWorkRoots", () => {
  it("no installation config (legacy project) → [projectRoot]", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null }, AgentStage.QA_ENGINEER)).toEqual([PR]);
  });

  it("installation config present, but the task is not in the store → refuses", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*Target binding.*state store/);
    expect(preflightThreeRepoTask).not.toHaveBeenCalled();
  });

  it("installation config with Target roots → deduped paths regardless of QA's read access", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(
      workRoots([
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "b", path: "/repo/b", access: "write" },
        { targetId: "c", path: "/repo/c", access: "read" },
      ]),
    );
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toEqual(["/repo/a", "/repo/b", "/repo/c"]);
  });

  it("installation config present but no Target roots resolved → refuses", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(workRoots([]));
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*no resolvable Target.*binding is missing/);
  });

  it("a throwing three-repo preflight → refuses with the task and binding failure", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockImplementation(() => {
      throw new Error("Target bindings are not usable");
    });
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never }, AgentStage.QA_ENGINEER)).toThrow(/T-1.*Target binding.*not usable/);
  });

  it("uses the real Framework root rather than the caller's Target workspace", () => {
    process.env.AGENTCLAUDE_INSTALLATION_CONFIG = "/somewhere/installation.yaml";
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
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
      throw new Error("cannot read installation config");
    });
    expect(resolveDocsRoot(PR)).toBe(PR);
  });

  it("installation config without a knowledge_root → projectRoot", () => {
    loadInstallationConfig.mockReturnValue({});
    expect(resolveDocsRoot(PR)).toBe(PR);
  });

  it("installation config with knowledge_root → the knowledge root", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/knowledge" });
    expect(resolveDocsRoot(PR)).toBe("/knowledge");
  });
});

describe("resolveThreeRepoTaskLookup", () => {
  it("no installation config → undefined (legacy, executor gets no threeRepoTask)", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    expect(resolveThreeRepoTaskLookup(PR, { loadTask: () => null })).toBeUndefined();
  });

  it("installation config present → a per-stage lookup that reloads the task each call", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
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
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    const lookup = resolveThreeRepoTaskLookup(PR, { loadTask: () => null });
    expect(() => lookup!("T-gone", AgentStage.QA_ENGINEER)).toThrow(/disappeared from the state store/);
  });
});

describe("all five production call sites share the same resolvers", () => {
  function oldDocsRoot(projectRoot: string): string {
    let out = projectRoot;
    try {
      const installation = loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined) as {
        knowledge_root?: string;
      };
      if (installation.knowledge_root) out = installation.knowledge_root;
    } catch {
      /* legacy */
    }
    return out;
  }

  it("single-repo (no config): all five sites resolve to projectRoot", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    const task = {};
    const store = { loadTask: () => task as never };
    // Three writable-root sites: qaRoots and both changedFiles closures.
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([PR]);
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([PR]);
    expect(resolveWritableWorkRoots(PR, "T-1", store, AgentStage.QA_ENGINEER)).toEqual([PR]);
    // two docs-root sites (qaDocsRoot + previousRound closure)
    expect(resolveDocsRoot(PR)).toBe(PR);
    expect(resolveDocsRoot(PR)).toBe(oldDocsRoot(PR));
  });

  it("three-repo: all five sites resolve consistently without a Framework fallback", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/knowledge" });
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
    expect(a).toEqual(["/t/be", "/t/fe"]);
    expect(a).toEqual(b);
    expect(a).toEqual(c);

    const d1 = resolveDocsRoot(PR);
    const d2 = resolveDocsRoot(PR);
    expect(d1).toBe("/knowledge");
    expect(d1).toBe(d2);
    expect(d1).toBe(oldDocsRoot(PR));
  });
});
