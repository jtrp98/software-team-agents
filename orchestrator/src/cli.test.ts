import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, USAGE, createProductionRuntimeRegistry, parseArgs, productionQaInputs, runCli, watchListing } from "./cli.js";
import { defaultProjectRoot } from "./agents/agentContract.js";
import { classifyTask } from "./classification/taskClassifier.js";
import { SqliteTaskStore } from "./store/sqliteStore.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { acquireTaskLock, releaseTaskLock } from "./concurrency/taskLock.js";
import { Environment } from "./environment/environment.js";
import { AgentStage } from "./types.js";
import type { ExecutionPacket } from "./artifacts/schemas.js";
import { writeExecutionPacket } from "./state/runtimeArtifacts.js";

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
      checkPromptBudget: false,
      checkWorkflows: false,
      checkBindings: false,
      checkProfile: false,
      checkDecisions: false,
      checkTestPyramid: false,
      checkReviewSeparation: false,
      checkEscalationPolicy: false,
      checkWorkspace: false,
      checkRepos: false,
      checkEnvironments: false,
      checkDocStructure: false,
      checkPlan: false,
      checkKnowledge: false,
      checkInstallation: false,
      checkRoles: false,
      buildTemplates: undefined,
      environment: Environment.LOCAL,
      dependsOn: [],
      stateDb: undefined,
      phases: [],
      targetBindings: { frontend_target: null, backend_target: null },
      autonomy: undefined,
      runtime: undefined,
      mode: undefined,
      noQaOptimization: false,
      noDeterministicGate: false,
      tokenBudget: undefined,
      version: false,
    });
  });

  it("parses --version without requiring a task id", () => {
    expect(parseArgs(["--version"], "/repo").version).toBe(true);
  });

  it("parses --autonomy and rejects values Claude Code cannot express", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--autonomy", "edit"], "/repo");
    expect(args.autonomy).toBe("edit");
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--autonomy", "yolo"], "/repo")).toThrow(CliUsageError);
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--autonomy"], "/repo")).toThrow(CliUsageError);
  });

  it("parses --runtime and rejects runtimes no adapter implements (T-OC5)", () => {
    const explicit = parseArgs(["--task-id", "T-1", "--module", "m", "--runtime", "opencode"], "/repo");
    expect(explicit.runtime).toBe("opencode");
    expect(explicit.mode).toBe("single");
    expect(parseArgs(["--task-id", "T-1", "--module", "m"], "/repo").runtime).toBeUndefined();
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--runtime", "ghost"], "/repo")).toThrow(CliUsageError);
  });

  it("parses all three orchestrated modes and rejects unknown modes", () => {
    for (const mode of ["single", "auto", "manual"] as const) {
      expect(parseArgs(["--task-id", "T-1", "--module", "m", "--mode", mode], "/repo").mode).toBe(mode);
    }
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--mode", "silent"], "/repo")).toThrow(CliUsageError);
  });

  it("parses the post-hoc token budget and deterministic-gate escape hatch", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--token-budget", "42000", "--no-deterministic-gate"], "/repo");
    expect(args.tokenBudget).toBe(42_000);
    expect(args.noDeterministicGate).toBe(true);
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--token-budget", "0"], "/repo")).toThrow(CliUsageError);
  });

  it("--project-root overrides the default", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--project-root", "/other"], "/repo");
    expect(args.projectRoot).toBe("/other");
  });

  it("records explicit frontend/backend Target bindings and refuses changes on resume", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--backend", "--backend-target", "api"], "/repo");
    expect(args.targetBindings).toEqual({ frontend_target: null, backend_target: "api" });
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--resume", "--backend-target", "api"], "/repo")).toThrow(/immutable/);
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

describe("T-V3R-032 production runtime composition", () => {
  it("constructs the complete runtime registry used by the real CLI executor call site", () => {
    expect(createProductionRuntimeRegistry(defaultProjectRoot()).ids()).toEqual(["claude-code", "codex", "opencode"]);
    expect(createProductionRuntimeRegistry(defaultProjectRoot(), { allowPaidFallback: true }).ids()).toEqual([
      "claude-code", "codex", "opencode", "paid-api",
    ]);
    const source = fs.readFileSync(path.join(defaultProjectRoot(), "orchestrator", "src", "cli.ts"), "utf8");
    expect(source).toContain("registry: runtimeRegistry");
    expect(source).toContain("runtime: defaultRuntime");
  });
});

describe("productionQaInputs (T-V3TOK-062)", () => {
  it("uses plan/design references and a compact diff summary without blank evidence placeholders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-qa-inputs-"));
    try {
      const docs = path.join(root, "_docs", "module", "sales");
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, "plan.md"), "## Phase 1\n\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 (DES-002) — import invoices | pending | backend-engineer | — |\n");
      fs.writeFileSync(path.join(docs, "design.md"), "# Design\n\n## Risks & Dependencies\n\n- external API\n");
      const inputs = await productionQaInputs({ docsRoot: root, moduleName: "sales", taskId: "BE-001", roots: [root] });
      const pkg = inputs.packageInputs();
      expect(pkg.taskIntent).toContain("import invoices");
      expect(pkg.acceptanceCriteria).toContain("design.md#DES-002");
      expect(pkg.knownRisks).toEqual(["design.md#Risks-&-Dependencies"]);
      expect(pkg.diffSummary).not.toContain("(none supplied)");
      expect(Buffer.byteLength(pkg.diffSummary)).toBeLessThan(2_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("runCli verb routing (T-V1-09 — verbs must survive the flag parser)", () => {
  /**
   * The main entry once parsed argv for `--version` *before* routing, and the
   * flag parser rejects bare tokens — so every documented verb form crashed
   * with "unrecognized argument" before its handler ever ran. These cases pin
   * the order: verbs route first, the flag form still answers --version.
   */
  it("routes `status` without --task-id and reports an empty store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-verb-"));
    try {
      const code = await runCli(["status", "--project-root", dir], dir);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes the `runtimes` verb (T-V1-04) and exits 0", async () => {
    expect(await runCli(["runtimes"], defaultProjectRoot())).toBe(0);
  });

  it("still answers the flag-form `--version` after parsing succeeds", async () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...parts: unknown[]) => logged.push(parts.join(" "));
    try {
      expect(await runCli(["--version"], defaultProjectRoot())).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged.join("\n")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("keeps rejecting an unknown bare token in the flag form", () => {
    expect(() => parseArgs(["bogus-verb-like-token"], "/repo")).toThrow(CliUsageError);
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
    // A code task with no bindings is legal only in legacy (unconfigured) mode.
    // This test must not depend on whether THIS machine has an installation
    // configured, so point the mode check at a path that cannot exist.
    const prevConfig = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
    process.env.AGENTCLAUDE_INSTALLATION_CONFIG = path.join(dir, "no-installation.yaml");
    // No lock pre-held this time — run will fail quickly (no `claude` on PATH in CI), but the
    // lock must still be released rather than leaking, or every future call would return 4 forever.
    try {
      await runCli(["--task-id", "T-1", "--module", "m", "--project-root", dir, "--bug-fix", "--backend"], dir);
      const code = await runCli(["status", "T-1", "--project-root", dir], dir);
      expect(code).toBe(0); // status never touches the lock, but this also proves the store isn't wedged
    } finally {
      if (prevConfig === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
      else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = prevConfig;
      // Windows can hold a just-used temp dir for a moment (AV/indexer), turning
      // cleanup into EPERM and an otherwise-green suite red on timing alone.
      // One short retry; if it still fails, leave the tmpdir — force:true has
      // already done the meaningful part, and a leaked temp dir is not a
      // regression signal.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") {
          await new Promise((r) => setTimeout(r, 75));
          fs.rmSync(dir, { recursive: true, force: true });
        } else {
          throw e;
        }
      }
    }
  });
});

describe("T-V3TOK-003 tokens verb", () => {
  it("reports interactive unknown token fields as not reported while retaining its static measurement", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-tokens-"));
    const store = new SqliteTaskStore(defaultStateDbPath(dir));
    store.appendRun({
      task_id: "session:dev:2026-08-26T00:00:00.000Z", agent: AgentStage.BACKEND_ENGINEER,
      start_time: 1, end_time: 2, duration: 1, model: null, promptVersion: null, tokens: 0, cost: 0,
      result: "PASS", retry_count: 0, failure_reason: null, input_tokens: null, output_tokens: null,
      cache_read_tokens: null, context_chars: null, qa_mode: null, runtime: "claude",
      requested_runtime: null, requested_model: null, routing_basis: null, fallback_reason: null, fallback_count: null,
      session_kind: "interactive",
      deterministic_gate: null,
      instruction_surface_bytes: 123,
      static_chars: 321, handoff_chars: null, doc_chars: null, doc_chars_before: null, knowledge_chars: null, code_intel_chars: null, tool_output_chars: null,
      context_budget_chars: 100, context_budget_source: "role", context_overflow_chars: 221, context_budget_warning: true,
      context_base_chars: 321, context_task_chars: 0, context_safety_chars: 0, context_docs_chars: 0, context_knowledge_chars: 0, context_code_chars: 0, context_tool_output_chars: 0, context_reserve_chars: 0,
    });
    store.close();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      expect(await runCli(["tokens", "--project-root", dir], dir)).toBe(0);
      expect(logs.join("\n")).toContain("not reported");
      expect(logs.join("\n")).toContain("static=321");
      expect(logs.join("\n")).toContain("always-on-instructions=123 B");
      expect(logs.join("\n")).toContain("context-budget warnings: 1/1 measured run(s), overflow=221");
      expect(await runCli(["tokens", "--help"], dir)).toBe(0);
      expect(USAGE).toContain("sta tokens");
    } finally {
      console.log = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T-V3TOK-041 context verb", () => {
  it("routes through the CLI and emits machine-readable composition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-context-cli-"));
    const dir = path.join(root, "_docs", "module", "sales");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), "# Req\n\n## Scope\nMVP\n", "utf8");
    fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n", "utf8");
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      expect(await runCli(["context", "backend-engineer", "--module", "sales", "--phase", "1", "--json", "--project-root", root], root)).toBe(0);
      const output = JSON.parse(logs.join("\n")) as { module: string; composition: { doc_chars_before: number; direct_file_reads: number } };
      expect(output.module).toBe("sales");
      expect(output.composition.doc_chars_before).toBeGreaterThan(0);
      expect(output.composition.direct_file_reads).toBeGreaterThan(0);
      expect(USAGE).toContain("sta context <role>");
    } finally {
      console.log = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the latest persisted packet without reopening module documents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-context-packet-"));
    const text = "Task T-PACKET\n## Acceptance Criteria\n- inspectable";
    const packet: ExecutionPacket = {
      text,
      composition: { static_chars: text.length, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0 },
      budgetComposition: { base: text.length, task: 0, safety: 0, docs: 0, knowledge: 0, code: 0, tool_output: 0, reserve: 0 },
      task_id: "T-PACKET",
      stage: AgentStage.BACKEND_ENGINEER,
      role: "backend-engineer",
      acceptance_criteria: ["inspectable"],
      required_verification: [],
      stop_conditions: ["STOP on invalid state"],
      scope: { allow: ["server/**"], deny: [".git/**"] },
      sources: ["runtime-task"],
    };
    writeExecutionPacket({ projectRoot: root, packet });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      expect(await runCli(["context", "backend-engineer", "--task", "T-PACKET", "--packet", "--json", "--project-root", root], root)).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ task_id: "T-PACKET", scope: { allow: ["server/**"] } });
      expect(USAGE).toContain("--packet");
    } finally {
      console.log = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(USAGE).toContain("sta audit");
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
    expect(USAGE).toContain("sta projects");
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

describe("runCli --check-knowledge (T61)", () => {
  it("passes against this repo", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await runCli(["--check-knowledge"], defaultProjectRoot());
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("knowledge/ is consistent");
    } finally {
      console.log = original;
    }
  });

  it("passes with a note on a repo that has captured nothing yet — this checks consistency, not progress", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cknow-"));
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      expect(await runCli(["--check-knowledge", "--project-root", dir], dir)).toBe(0);
      expect(logs.join("\n")).toContain("no `knowledge/` directory yet");
    } finally {
      console.log = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when an item names a relation target that does not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cknow-"));
    try {
      const file = path.join(dir, "knowledge", "sales-crm", "test", "TEST-003.yaml");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          "schema_version: 1",
          "id: TEST-003",
          "kind: test",
          "title: shift ownership",
          "version: 1",
          "status: draft",
          "owner: test-planner",
          "module: sales-crm",
          "repo: null",
          "sensitive: false",
          'created_at: "2026-08-20T09:00:00Z"',
          'updated_at: "2026-08-20T09:00:00Z"',
          "sources:",
          "  - type: agent",
          "    locator: test-planner",
          '    captured_at: "2026-08-20T09:00:00Z"',
          "    digest: null",
          "relations:",
          "  - { type: verifies, to: REQ-404 }",
          "payload:",
          "  levels: [api]",
          "  automated: false",
          'body: ""',
          "",
        ].join("\n"),
        "utf8",
      );
      expect(await runCli(["--check-knowledge", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-knowledge"], "/repo").checkKnowledge).toBe(true);
    expect(USAGE).toContain("--check-knowledge");
  });
});

describe("runCli --check-plan (T-PM1.3)", () => {
  const PLAN_OK = [
    "# Plan",
    "",
    "## Phase 1: Orders",
    "",
    "| Task | Status | Owner | Depends on |",
    "|---|---|---|---|",
    "| BE-001 (DES-001) — order CRUD | pending | backend-engineer | — |",
    "",
    "## Sequencing Notes",
    "—",
    "",
    "## Unresolved Open Questions",
    "—",
    "",
    "## Change Log",
    "2026-08-26: created.",
    "",
  ].join("\n");

  it("passes a well-formed plan", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cp-"));
    try {
      fs.mkdirSync(path.join(dir, "_docs", "module", "sales"), { recursive: true });
      fs.writeFileSync(path.join(dir, "_docs", "module", "sales", "plan.md"), PLAN_OK, "utf8");
      expect(await runCli(["--check-plan"], dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a dependency names a task that does not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cp-"));
    try {
      fs.mkdirSync(path.join(dir, "_docs", "module", "sales"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "_docs", "module", "sales", "plan.md"),
        PLAN_OK.replace("| — |", "| BE-999 |"),
        "utf8",
      );
      expect(await runCli(["--check-plan"], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scopes to --module and needs neither --task-id nor a state database", async () => {
    expect(parseArgs(["--check-plan", "--module", "sales"], "/repo").checkPlan).toBe(true);
    expect(USAGE).toContain("--check-plan");
  });
});
