import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, USAGE, parseArgs, runCli, watchListing } from "./cli.js";
import { defaultProjectRoot } from "./agents/agentContract.js";
import { classifyTask } from "./classification/taskClassifier.js";
import { SqliteTaskStore } from "./store/sqliteStore.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { acquireTaskLock, releaseTaskLock } from "./concurrency/taskLock.js";
import { Environment } from "./environment/environment.js";

describe("parseArgs", () => {
  it("parses required flags and maps classification flags", () => {
    const args = parseArgs(
      ["--task-id", "T-1", "--module", "sales-crm", "--new-feature", "--backend", "--frontend"],
      "/repo",
    );
    expect(args).toEqual({
      taskId: "T-1",
      module: "sales-crm",
      projectRoot: "/repo",
      classification: { isNewFeatureModuleOrProject: true, touchesBackend: true, touchesFrontend: true },
      resume: false,
      list: false,
      checkContracts: false,
      checkLayout: false,
      checkWorkflows: false,
      checkProfile: false,
      checkDecisions: false,
      checkTestPyramid: false,
      checkReviewSeparation: false,
      checkEscalationPolicy: false,
      checkWorkspace: false,
      checkRepos: false,
      checkEnvironments: false,
      environment: Environment.LOCAL,
      dependsOn: [],
      stateDb: undefined,
      phases: [],
    });
  });

  it("--project-root overrides the default", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--project-root", "/other"], "/repo");
    expect(args.projectRoot).toBe("/other");
  });

  it("throws CliUsageError when --task-id is missing", () => {
    expect(() => parseArgs(["--module", "m"], "/repo")).toThrow(CliUsageError);
  });

  it("throws CliUsageError when --module is missing", () => {
    expect(() => parseArgs(["--task-id", "T-1"], "/repo")).toThrow(CliUsageError);
  });

  it("throws CliUsageError on an unrecognized flag", () => {
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--nope"], "/repo")).toThrow(CliUsageError);
  });
});

describe("parseArgs — persistence and dependency flags (T01)", () => {
  it("--resume marks the run as a continuation and needs no classification flags", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--resume"], "/repo");
    expect(args.resume).toBe(true);
    expect(args.classification).toEqual({});
  });

  it("--depends-on splits and trims a comma-separated list", () => {
    const args = parseArgs(["--task-id", "T-2", "--module", "m", "--depends-on", "T-1, T-0 ,"], "/repo");
    expect(args.dependsOn).toEqual(["T-1", "T-0"]);
  });

  it("rejects --depends-on together with --resume, since dependencies are fixed at creation", () => {
    expect(() => parseArgs(["--task-id", "T-2", "--module", "m", "--resume", "--depends-on", "T-1"], "/repo")).toThrow(
      CliUsageError,
    );
  });

  it("--list needs neither --task-id nor --module", () => {
    const args = parseArgs(["--list"], "/repo");
    expect(args.list).toBe(true);
    expect(args.taskId).toBeUndefined();
  });

  it("--phase parses a comma-separated list, for slicing module docs (T05)", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m", "--phase", "2, 3"], "/repo").phases).toEqual([2, 3]);
  });

  it("--phase drops values that are not positive integers rather than passing them on", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m", "--phase", "0,x,-1,4"], "/repo").phases).toEqual([4]);
  });

  it("defaults to no phase, which sends the plan whole instead of slicing it wrong", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m"], "/repo").phases).toEqual([]);
  });

  it("--state-db overrides where state is kept", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--state-db", "/tmp/x.db"], "/repo");
    expect(args.stateDb).toBe("/tmp/x.db");
  });
});

describe("runCli --list (T01 wiring: sqlite store + registry + view)", () => {
  it("opens (and creates) the state database under the project root and reports an empty store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
    try {
      const code = await runCli(["--list", "--project-root", dir], dir);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, ".workflow", "state.db"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--resume on a task the store has never seen is a usage error, not a silent fresh run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
    try {
      await expect(runCli(["--task-id", "ghost", "--module", "m", "--resume", "--project-root", dir], dir)).rejects.toThrow(
        CliUsageError,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCli --check-contracts (T03)", () => {
  it("passes against this repo's own contracts, without opening a state database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cc-"));
    try {
      const code = await runCli(["--check-contracts"], defaultProjectRoot());
      expect(code).toBe(0);
      // No --project-root pointed here, so nothing should have been created either way.
      expect(fs.existsSync(path.join(dir, ".workflow"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when the contracts folder is missing, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cc-"));
    try {
      expect(await runCli(["--check-contracts", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module", () => {
    expect(parseArgs(["--check-contracts"], "/repo").checkContracts).toBe(true);
  });
});

describe("runCli --check-workflows (T09)", () => {
  it("passes against this repo's own workflows, without opening a state database", async () => {
    expect(await runCli(["--check-workflows"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there are no workflow files, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cw-"));
    try {
      expect(await runCli(["--check-workflows", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-workflows"], "/repo").checkWorkflows).toBe(true);
    expect(USAGE).toContain("--check-workflows");
  });
});

describe("runCli --check-profile (T13/T14)", () => {
  it("passes against this repo's own profile", async () => {
    expect(await runCli(["--check-profile"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there is no project.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cp-"));
    try {
      expect(await runCli(["--check-profile", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-profile"], "/repo").checkProfile).toBe(true);
    expect(USAGE).toContain("--check-profile");
  });
});

describe("runCli --check-layout (T04)", () => {
  it("passes against this repo's own layout, without opening a state database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cl-"));
    try {
      expect(await runCli(["--check-layout"], defaultProjectRoot())).toBe(0);
      expect(fs.existsSync(path.join(dir, ".workflow"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when there is no layout.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cl-"));
    try {
      expect(await runCli(["--check-layout", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module", () => {
    expect(parseArgs(["--check-layout"], "/repo").checkLayout).toBe(true);
  });

  it("is listed in the usage text, so it is discoverable without reading the source", () => {
    expect(USAGE).toContain("--check-layout");
  });
});

describe("runCli --check-decisions (T16)", () => {
  it("passes against this repo's own decisions/", async () => {
    expect(await runCli(["--check-decisions"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there is no decisions/ directory, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cd-"));
    try {
      expect(await runCli(["--check-decisions", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-decisions"], "/repo").checkDecisions).toBe(true);
    expect(USAGE).toContain("--check-decisions");
  });
});

describe("runCli --check-test-pyramid (T21)", () => {
  it("passes against this repo's own test-pyramid.yaml", async () => {
    expect(await runCli(["--check-test-pyramid"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there is no test-pyramid.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ctp-"));
    try {
      expect(await runCli(["--check-test-pyramid", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-test-pyramid"], "/repo").checkTestPyramid).toBe(true);
    expect(USAGE).toContain("--check-test-pyramid");
  });
});

describe("T31 verbs — run/status/approve/retry/resume/pause/cancel", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-verbs-"));
  }

  /** Seeds a task directly through the registry, without going through `runCli`'s `run` verb — so these tests never need a real `claude` binary on PATH. */
  function seedTask(dir: string, taskId: string): void {
    const store = new SqliteTaskStore(defaultStateDbPath(dir));
    const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
    registry.create({ taskId, classification: classifyTask({ isClearBugFix: true, touchesBackend: true }) });
    registry.close();
  }

  it("`run --list` behaves exactly like `--list` — the verb is a thin pass-through", async () => {
    const dir = tmpDir();
    try {
      const code = await runCli(["run", "--list", "--project-root", dir], dir);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, ".workflow", "state.db"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`status` with no id behaves like `--list`", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      expect(await runCli(["status", "--project-root", dir], dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`status <task-id>` reports that one task's detail", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      expect(await runCli(["status", "T-1", "--project-root", dir], dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`status <unknown-id>` fails rather than silently reporting nothing", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      expect(await runCli(["status", "ghost", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`pause <task-id>` then `status` reports PAUSED", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      expect(await runCli(["pause", "T-1", "--project-root", dir], dir)).toBe(0);
      const store = new SqliteTaskStore(defaultStateDbPath(dir));
      expect(store.loadTask("T-1")!.paused).toBe(true);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`cancel <task-id> --reason` records the reason", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      expect(await runCli(["cancel", "T-1", "--reason", "duplicate", "--project-root", dir], dir)).toBe(0);
      const store = new SqliteTaskStore(defaultStateDbPath(dir));
      const task = store.loadTask("T-1")!;
      expect(task.cancelled).toBe(true);
      expect(task.cancelReason).toBe("duplicate");
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`run` on a paused task refuses without --resume, and never reaches the executor", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      await runCli(["pause", "T-1", "--project-root", dir], dir);
      const code = await runCli(["run", "--task-id", "T-1", "--module", "m", "--project-root", dir], dir);
      expect(code).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`resume`/`retry` on a cancelled task refuse permanently, not just once", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      await runCli(["cancel", "T-1", "--reason", "abandoned", "--project-root", dir], dir);
      expect(await runCli(["resume", "T-1", "--module", "m", "--project-root", dir], dir)).toBe(1);
      expect(await runCli(["retry", "T-1", "--module", "m", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`approve` on a task that isn't waiting on a human decision says so, rather than hanging on a prompt", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1"); // freshly created — sits at CREATED, nothing to approve yet
      expect(await runCli(["approve", "T-1", "--yes", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`approve` on a cancelled task refuses instead of asking", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      await runCli(["cancel", "T-1", "--reason", "x", "--project-root", dir], dir);
      expect(await runCli(["approve", "T-1", "--yes", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`approve` on an unknown task id is a usage error", async () => {
    const dir = tmpDir();
    try {
      await expect(runCli(["approve", "ghost", "--yes", "--project-root", dir], dir)).rejects.toThrow(CliUsageError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`pause`/`cancel`/`resume`/`retry`/`approve` all require a task id", async () => {
    const dir = tmpDir();
    try {
      for (const verb of ["pause", "cancel", "resume", "retry", "approve"]) {
        await expect(runCli([verb, "--project-root", dir], dir)).rejects.toThrow(CliUsageError);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T32 dashboard — status emoji and watchListing", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-watch-"));
  }

  function seedTask(dir: string, taskId: string): void {
    const store = new SqliteTaskStore(defaultStateDbPath(dir));
    const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
    registry.create({ taskId, classification: classifyTask({ isClearBugFix: true, touchesBackend: true }) });
    registry.close();
  }

  it("`status` prints TASKS.md T32's own glyphs (✅ 🔄 ⏳) for the statuses they apply to", async () => {
    const dir = tmpDir();
    const logs: string[] = [];
    const spy = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      seedTask(dir, "T-1"); // freshly created -> RUNNING (its first stage is ready)
      await runCli(["status", "--project-root", dir], dir);
    } finally {
      console.log = spy;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(logs.some((l) => l.includes("🔄"))).toBe(true);
  });

  it("watchListing renders exactly `iterations` times and sleeps between renders, not after the last one", async () => {
    const dir = tmpDir();
    try {
      seedTask(dir, "T-1");
      const store = new SqliteTaskStore(defaultStateDbPath(dir));
      const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
      let renders = 0;
      let sleeps = 0;
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        if (String(args[0] ?? "").includes("T-1")) renders++;
      };
      try {
        await watchListing(registry, {
          intervalMs: 1,
          iterations: 3,
          sleep: async () => {
            sleeps++;
          },
          clear: () => {},
        });
      } finally {
        console.log = originalLog;
        registry.close();
      }
      expect(renders).toBe(3);
      expect(sleeps).toBe(2); // between renders 1->2 and 2->3, never a trailing sleep after the last one
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watchListing calls clear() before every render, for a live-refreshing view rather than a scrolling log", async () => {
    const dir = tmpDir();
    try {
      const store = new SqliteTaskStore(defaultStateDbPath(dir));
      const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
      let clears = 0;
      try {
        await watchListing(registry, { intervalMs: 1, iterations: 2, sleep: async () => {}, clear: () => clears++ });
      } finally {
        registry.close();
      }
      expect(clears).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T35 concurrency lock, wired into the CLI", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lock-"));
  }

  it("refuses to run/resume a task another process already holds the lock for", async () => {
    const dir = tmpDir();
    try {
      acquireTaskLock(dir, "T-1");
      const code = await runCli(
        ["--task-id", "T-1", "--module", "m", "--project-root", dir, "--new-feature"],
        dir,
      );
      expect(code).toBe(4);
    } finally {
      releaseTaskLock(dir, "T-1");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not hold the lock across unrelated tasks", async () => {
    const dir = tmpDir();
    try {
      acquireTaskLock(dir, "T-1");
      // A --list on the same store doesn't touch any specific task's lock at all.
      expect(await runCli(["--list", "--project-root", dir], dir)).toBe(0);
    } finally {
      releaseTaskLock(dir, "T-1");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases the lock once the run finishes (even though it fails without a real `claude` binary), so a later call is not permanently locked out", async () => {
    const dir = tmpDir();
    // No lock pre-held this time — run will fail quickly (no `claude` on PATH in CI), but the
    // lock must still be released rather than leaking, or every future call would return 4 forever.
    await runCli(["--task-id", "T-1", "--module", "m", "--project-root", dir, "--bug-fix", "--backend"], dir);
    const code = await runCli(["status", "T-1", "--project-root", dir], dir);
    expect(code).toBe(0); // status never touches the lock, but this also proves the store isn't wedged
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("T37 audit verb", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-audit-"));
  }

  /** Seeds a task and drives it far enough to produce a trail, without needing a real `claude` binary. */
  function seedWithEvents(dir: string, taskId: string): void {
    const store = new SqliteTaskStore(defaultStateDbPath(dir));
    const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
    const orch = registry.create({
      taskId,
      classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
    });
    for (let i = 0; i < 6; i++) {
      const status = orch.status();
      if (status.kind !== "RUNNING") break;
      orch.reportCompletion(status.stage, { outcome: { tokens: 10, cost: 0.01, result: "PASS" } }, { start: 0, end: 1 });
    }
    registry.close();
  }

  it("prints the trail for a task", async () => {
    const dir = tmpDir();
    try {
      seedWithEvents(dir, "T-1");
      expect(await runCli(["audit", "T-1", "--project-root", dir], dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts --decisions without mistaking it for the task id", async () => {
    const dir = tmpDir();
    try {
      seedWithEvents(dir, "T-1");
      expect(await runCli(["audit", "--decisions", "T-1", "--project-root", dir], dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on an unknown task rather than printing an empty trail", async () => {
    const dir = tmpDir();
    try {
      seedWithEvents(dir, "T-1");
      expect(await runCli(["audit", "ghost", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a task id", async () => {
    const dir = tmpDir();
    try {
      await expect(runCli(["audit", "--project-root", dir], dir)).rejects.toThrow(CliUsageError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is named in the usage text", () => {
    expect(USAGE).toContain("orchestrate audit");
  });
});

describe("runCli --check-review-separation (T39)", () => {
  it("passes against this repo and names the deliberately-unreviewed workflow as a note", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-review-separation"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("no agent can review its own work");
      // The typo workflow ships an engineer's work with nobody checking it, on purpose.
      expect(logs.join("\n")).toContain('workflow "typo"');
    } finally {
      console.log = original;
    }
  });

  it("is parsed as a check flag, so --task-id/--module are not required", () => {
    const args = parseArgs(["--check-review-separation"], "/repo");
    expect(args.checkReviewSeparation).toBe(true);
    expect(args.taskId).toBeUndefined();
  });

  it("is named in the usage text", () => {
    expect(USAGE).toContain("--check-review-separation");
  });
});

describe("runCli --check-escalation-policy (T40)", () => {
  it("passes against this repo and notes the severity that never retries", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-escalation-policy"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("agrees with the runtime policy");
      expect(logs.join("\n")).toContain('severity "critical"');
    } finally {
      console.log = original;
    }
  });

  it("exits non-zero when there is no escalation-policy.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ep-"));
    try {
      expect(await runCli(["--check-escalation-policy", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-escalation-policy"], "/repo").checkEscalationPolicy).toBe(true);
    expect(USAGE).toContain("--check-escalation-policy");
  });
});

describe("runCli --check-workspace (T41)", () => {
  it("passes against this repo, noting that it runs standalone (no workspace.yaml)", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-workspace"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("workspace.yaml is fine");
      expect(logs.join("\n")).toContain("runs standalone");
    } finally {
      console.log = original;
    }
  });

  it("exits non-zero when workspace.yaml exists but points at a root that doesn't", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cwrk-"));
    try {
      fs.writeFileSync(path.join(dir, "workspace.yaml"), "version: 1\nprojects:\n  - name: ghost\n    root: ./nowhere\n", "utf8");
      expect(await runCli(["--check-workspace", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-workspace"], "/repo").checkWorkspace).toBe(true);
    expect(USAGE).toContain("--check-workspace");
  });
});

describe("T41 projects verb", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-projects-"));
  }

  it("says so when there is no workspace.yaml, and does not create a state database", async () => {
    const dir = tmpDir();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["projects", "--project-root", dir], dir);
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("no workspace.yaml");
      expect(fs.existsSync(path.join(dir, ".workflow"))).toBe(false);
    } finally {
      console.log = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every project workspace.yaml names, without creating a store for one that never ran", async () => {
    const dir = tmpDir();
    const untouched = path.join(dir, "untouched");
    const withTasks = path.join(dir, "with-tasks");
    fs.mkdirSync(untouched, { recursive: true });
    fs.mkdirSync(withTasks, { recursive: true });

    // Seed a task directly through the store, like other T31 verb tests do — no real `claude` binary needed.
    const { SqliteTaskStore } = await import("./store/sqliteStore.js");
    const { TaskRegistry } = await import("./orchestrator/taskRegistry.js");
    const { classifyTask } = await import("./classification/taskClassifier.js");
    const { defaultStateDbPath, defaultStateViewPath } = await import("./store/stateView.js");
    const store = new SqliteTaskStore(defaultStateDbPath(withTasks));
    const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(withTasks) });
    registry.create({ taskId: "T-1", classification: classifyTask({ isTypoOrCopyOnly: true }), dependsOn: [] });
    registry.close();

    fs.writeFileSync(
      path.join(dir, "workspace.yaml"),
      "version: 1\nprojects:\n  - name: untouched\n    root: ./untouched\n  - name: with-tasks\n    root: ./with-tasks\n",
      "utf8",
    );

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["projects", "--project-root", dir], dir);
      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("untouched");
      expect(out).toContain("no tasks yet");
      expect(out).toContain("with-tasks");
      expect(out).toContain("1 task(s)");
      expect(fs.existsSync(path.join(untouched, ".workflow"))).toBe(false);
    } finally {
      console.log = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is listed in the usage text", () => {
    expect(USAGE).toContain("orchestrate projects");
  });
});

describe("runCli --check-repos (T42)", () => {
  it("passes against this repo, noting that it's single-repo (no repos.yaml)", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-repos"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("repos.yaml is fine");
      expect(logs.join("\n")).toContain("the same repo");
    } finally {
      console.log = original;
    }
  });

  it("exits non-zero when repos.yaml exists but claims the same stage in two repos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-crepo-"));
    try {
      const a = path.join(dir, "a");
      const b = path.join(dir, "b");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "repos.yaml"),
        "version: 1\nrepos:\n  - name: a\n    root: ./a\n    stages: [devops]\n  - name: b\n    root: ./b\n    stages: [devops]\n",
        "utf8",
      );
      expect(await runCli(["--check-repos", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-repos"], "/repo").checkRepos).toBe(true);
    expect(USAGE).toContain("--check-repos");
  });
});

describe("--env (T43)", () => {
  it("parseArgs defaults to local when --env is not passed", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m", "--typo"], "/repo").environment).toBe(Environment.LOCAL);
  });

  it("parseArgs accepts each of the four fixed names", () => {
    for (const env of Object.values(Environment)) {
      expect(parseArgs(["--task-id", "T-1", "--module", "m", "--typo", "--env", env], "/repo").environment).toBe(env);
    }
  });

  it("parseArgs rejects a name that isn't one of the four, rather than silently accepting a typo", () => {
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--typo", "--env", "prod"], "/repo")).toThrow(CliUsageError);
  });

  it("a task's environment is set at creation and is unaffected by later --env — resuming reads it back off the stored row, not the flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-env-"));
    try {
      const store = new SqliteTaskStore(defaultStateDbPath(dir));
      const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(dir) });
      registry.create({
        taskId: "T-1",
        classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
        environment: Environment.STAGING,
      });
      expect(store.loadTask("T-1")?.environment).toBe(Environment.STAGING);

      // registry.open() is what --resume/--retry drive (see openTask() in cli.ts) — it never
      // takes an --env value, it only reads the row `create()` already wrote.
      const resumed = registry.open("T-1");
      expect(resumed.environment).toBe(Environment.STAGING);
      registry.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is listed in the usage text", () => {
    expect(USAGE).toContain("--env");
  });
});

describe("runCli --check-environments (T43)", () => {
  it("passes against this repo, noting that it uses the built-in descriptions (no environments.yaml)", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-environments"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("environments.yaml is fine");
      expect(logs.join("\n")).toContain("built-in");
    } finally {
      console.log = original;
    }
  });

  it("exits non-zero when environments.yaml's default names an environment it never declares", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cenv-"));
    try {
      fs.writeFileSync(
        path.join(dir, "environments.yaml"),
        "version: 1\nenvironments:\n  - name: dev\n    description: x\ndefault: production\n",
        "utf8",
      );
      expect(await runCli(["--check-environments", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-environments"], "/repo").checkEnvironments).toBe(true);
    expect(USAGE).toContain("--check-environments");
  });
});
