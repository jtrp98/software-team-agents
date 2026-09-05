import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import type { ThreeRepoRequestRoots } from "./preflight.js";

/**
 * The extracted three-repo resolvers, tested directly.
 *
 * `loadInstallationConfig` and `preflightThreeRepoTask` are the two seams
 * shared across call sites; mocking them lets each fail-open branch be
 * exercised without a full framework/knowledge/target git fixture (that path is
 * covered end-to-end by `scripts/migration-fixtures.mjs`).
 */
const loadInstallationConfig = vi.fn();
const preflightThreeRepoTask = vi.fn();

vi.mock("./installation.js", () => ({
  loadInstallationConfig: (...a: unknown[]) => loadInstallationConfig(...a),
}));
vi.mock("./preflight.js", () => ({
  preflightThreeRepoTask: (...a: unknown[]) => preflightThreeRepoTask(...a),
}));

const { resolveWritableWorkRoots, resolveDocsRoot, resolveThreeRepoTaskLookup } = await import("./cliRoots.js");

const PR = "/project/root";
const workRoots = (rs: ThreeRepoRequestRoots["workRoots"]): ThreeRepoRequestRoots => ({
  bindingRoot: "/fw",
  knowledgeRoot: "/kn",
  workRoots: rs,
});

beforeEach(() => {
  loadInstallationConfig.mockReset();
  preflightThreeRepoTask.mockReset();
  delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
});

describe("resolveWritableWorkRoots", () => {
  it("no installation config (legacy project) → [projectRoot]", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null })).toEqual([PR]);
  });

  it("installation config present, but the task is not in the store → [projectRoot]", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => null })).toEqual([PR]);
    expect(preflightThreeRepoTask).not.toHaveBeenCalled();
  });

  it("installation config with write roots → deduped write-root paths only", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(
      workRoots([
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "a", path: "/repo/a", access: "write" },
        { targetId: "b", path: "/repo/b", access: "write" },
        { targetId: "c", path: "/repo/c", access: "read" },
      ]),
    );
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never })).toEqual(["/repo/a", "/repo/b"]);
  });

  it("installation config present but no write roots resolved → [projectRoot]", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(workRoots([{ targetId: "b", path: "/repo/b", access: "read" }]));
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never })).toEqual([PR]);
  });

  it("a throwing preflight → legacy fallback, no exception escapes", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockImplementation(() => {
      throw new Error("Target bindings are not usable");
    });
    expect(() => resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never })).not.toThrow();
    expect(resolveWritableWorkRoots(PR, "T-1", { loadTask: () => ({}) as never })).toEqual([PR]);
  });

  it("defaults the stage to QA_ENGINEER and passes frameworkRoot + config path through", () => {
    process.env.AGENTCLAUDE_INSTALLATION_CONFIG = "/somewhere/installation.yaml";
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/kn" });
    preflightThreeRepoTask.mockReturnValue(workRoots([{ targetId: "a", path: "/repo/a", access: "write" }]));
    resolveWritableWorkRoots(PR, "T-9", { loadTask: () => ({}) as never });
    expect(preflightThreeRepoTask).toHaveBeenCalledWith({}, AgentStage.QA_ENGINEER, {
      frameworkRoot: PR,
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

describe("all four former call sites resolve identically (T-V4-CLI-003 acceptance)", () => {
  /** The exact pre-extraction inline logic, reproduced to prove equivalence. */
  function oldQaRoots(projectRoot: string, task: unknown): string[] {
    let out: string[] = [projectRoot];
    try {
      loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
      if (task) {
        const roots3 = preflightThreeRepoTask(task, AgentStage.QA_ENGINEER, {
          frameworkRoot: projectRoot,
          installationConfigPath: process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined,
        }) as ThreeRepoRequestRoots;
        const writes = roots3.workRoots.filter((r) => r.access === "write").map((r) => r.path);
        if (writes.length > 0) out = [...new Set(writes)];
      }
    } catch {
      /* legacy */
    }
    return out;
  }
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

  it("single-repo (no config): all four sites resolve to projectRoot", () => {
    loadInstallationConfig.mockImplementation(() => {
      throw new Error("cannot read installation config");
    });
    const task = {};
    const store = { loadTask: () => task as never };
    // two writable-root sites (qaRoots + changedFiles closure)
    expect(resolveWritableWorkRoots(PR, "T-1", store)).toEqual([PR]);
    expect(resolveWritableWorkRoots(PR, "T-1", store)).toEqual(oldQaRoots(PR, task));
    // two docs-root sites (qaDocsRoot + previousRound closure)
    expect(resolveDocsRoot(PR)).toBe(PR);
    expect(resolveDocsRoot(PR)).toBe(oldDocsRoot(PR));
  });

  it("three-repo: all four sites resolve to the same values the inline copies did", () => {
    loadInstallationConfig.mockReturnValue({ knowledge_root: "/knowledge" });
    preflightThreeRepoTask.mockReturnValue(
      workRoots([
        { targetId: "be", path: "/t/be", access: "write" },
        { targetId: "fe", path: "/t/fe", access: "read" },
      ]),
    );
    const task = { taskId: "T-1" };
    const store = { loadTask: () => task as never };

    const a = resolveWritableWorkRoots(PR, "T-1", store);
    const b = resolveWritableWorkRoots(PR, "T-1", store);
    expect(a).toEqual(["/t/be"]);
    expect(a).toEqual(b);
    expect(a).toEqual(oldQaRoots(PR, task));

    const d1 = resolveDocsRoot(PR);
    const d2 = resolveDocsRoot(PR);
    expect(d1).toBe("/knowledge");
    expect(d1).toBe(d2);
    expect(d1).toBe(oldDocsRoot(PR));
  });
});
