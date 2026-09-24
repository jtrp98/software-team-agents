import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliUsageError, runCli } from "../../cli.js";
import { parseBoundedRunArgs, renderAwaitingHuman, BOUNDED_RUN_USAGE } from "./boundedRun.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../../runtime/mockAdapter.js";
import { RuntimeCapability } from "../../runtime/runtimeCapabilities.js";
import type { RuntimeAgentResult } from "../../runtime/runtimeAdapter.js";
import { writeSignedOffHandoffs } from "../../orchestrator/stageGuards.testSupport.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";
import { AgentStage } from "../../types.js";

/**
 * T-V8-021 — CLI-level coverage for the explicit bounded-run command:
 * parsing/refusal, the ambiguity gate, dry-run preview, an eligible run to
 * COMPLETED, a gated run, and `--resume`. Since V13 TASK-007 every execution
 * case here drives the one task engine through the real CLI wiring - the
 * production executor composition `sta run` uses, the ledger-attempt
 * boundary and a real Target - with only the runtime adapter mocked.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const roots: string[] = [];

// `resolveContextDocsRoot` reads `STA_KNOWLEDGE_ROOT`/an installation
// config before falling back to `projectRoot` — a fixture must not inherit
// whatever real three-repo installation happens to be configured on the
// machine running this suite (`cli.test.ts` pins the same two vars).
const KNOWLEDGE_ROOT_ORIGINAL = process.env.STA_KNOWLEDGE_ROOT;
const INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
beforeEach(() => {
  delete process.env.STA_KNOWLEDGE_ROOT;
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-boundedrun-test-no-installation.yaml");
});
afterEach(async () => {
  if (KNOWLEDGE_ROOT_ORIGINAL === undefined) delete process.env.STA_KNOWLEDGE_ROOT;
  else process.env.STA_KNOWLEDGE_ROOT = KNOWLEDGE_ROOT_ORIGINAL;
  if (INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = INSTALLATION_CONFIG_ORIGINAL;
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    ),
  );
}, 90_000); // [amend R11] same cleanup hook as the R10 amendment (10s -> 30s -> 90s): Windows rm EPERM/EBUSY retries on freshly written fixture .git objects can exceed 30s under antivirus/load; product code holds no handles here (bisected: fails identically with the pre-R11 preflight)


describe("parseBoundedRunArgs", () => {
  it("requires --module and exactly one scope for a new run", () => {
    expect(() => parseBoundedRunArgs(["--all"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--phase", "1"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit"], "/repo")).not.toThrow();
  });

  it("requires --autonomy edit|full for an unattended (non-dry-run) new run", () => {
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all"], "/repo")).toThrow(/--autonomy/);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--dry-run"], "/repo")).not.toThrow();
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "read-only"], "/repo")).toThrow(/--autonomy edit or --autonomy full/);
  });

  it("validates --until against the closed RunBoundary vocabulary", () => {
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit", "--until", "nope"], "/repo")).toThrow(/--until must be one of/);
    for (const until of ["next-gate", "qa", "done"]) {
      expect(parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit", "--until", until], "/repo").until).toBe(until);
    }
  });

  it("--resume refuses scope and classification flags — those belong to the frozen run, not to resuming it", () => {
    expect(() => parseBoundedRunArgs(["--resume", "01ABC", "--all"], "/repo")).toThrow(/--all\/--phase\/--task do not apply/);
    expect(() => parseBoundedRunArgs(["--resume", "01ABC", "--bug-fix"], "/repo")).toThrow(/classification flags do not apply/);
  });

  it("T-V10 TASK-007 — --resume states autonomy like the first run: the ledger freezes no autonomy to inherit", () => {
    expect(() => parseBoundedRunArgs(["--resume", "01ABC"], "/repo")).toThrow(/--resume 01ABC also needs --autonomy edit or --autonomy full/);
    expect(() => parseBoundedRunArgs(["--resume", "01ABC", "--autonomy", "propose"], "/repo")).toThrow(/--autonomy edit or --autonomy full/);
    expect(parseBoundedRunArgs(["--resume", "01ABC", "--autonomy", "full"], "/repo").autonomy).toBe("full");
    expect(parseBoundedRunArgs(["--resume", "01ABC", "--dry-run"], "/repo").resumeRunId).toBe("01ABC");
  });

  it("--task splits and trims a comma list; an empty one refuses", () => {
    expect(parseBoundedRunArgs(["--module", "m", "--task", "BE-1, BE-2", "--dry-run"], "/repo").scope).toEqual({ kind: "tasks", taskIds: ["BE-1", "BE-2"] });
    expect(() => parseBoundedRunArgs(["--module", "m", "--task", "", "--dry-run"], "/repo")).toThrow(CliUsageError);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--not-a-flag"], "/repo")).toThrow(/unrecognized argument/);
  });

  it("parses --root <name>; duplicates, missing values and --knowledge-root coexistence refuse (DR §4)", () => {
    expect(parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--root", "work"], "/repo").rootName).toBe("work");
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--root"], "/repo")).toThrow(/--root requires a value/);
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--root", "a", "--root", "b"], "/repo")).toThrow(/--root may be given at most once/);
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--root", "a", "--knowledge-root", "C:\kn"], "/repo")).toThrow(
      /--root and --knowledge-root are mutually exclusive/,
    );
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--root", "Work"], "/repo")).toThrow(/must match/);
  });

  it("accumulates repeatable --target-id into targetIds and sets single targetId (T-V9-011)", () => {
    const single = parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--target-id", "api"], "/repo");
    expect(single.targetIds).toEqual(["api"]);
    expect(single.targetId).toBe("api");

    const multi = parseBoundedRunArgs(
      ["--module", "m", "--all", "--dry-run", "--target-id", "api", "--target-id", "web"],
      "/repo",
    );
    expect(multi.targetIds).toEqual(["api", "web"]);
    expect(multi.targetId).toBeUndefined();

    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--target-id"], "/repo")).toThrow(
      /--target-id requires a value/,
    );
  });

  it("USAGE names every classification override flag and both invocation forms", () => {
    expect(BOUNDED_RUN_USAGE).toContain("--resume");
    expect(BOUNDED_RUN_USAGE).toContain("--dry-run");
    expect(BOUNDED_RUN_USAGE).toContain("--bug-fix");
    expect(BOUNDED_RUN_USAGE).toContain("--schema");
  });
});

import { boundedRunProject as project, playPlanTaskStage, PLAN_TASK_GUARD_FILES } from "./boundedRunFixture.testSupport.js";
import { declareInstallationConfigOverrideChannelForTest } from "../../threeRepo/installation.js";
import { installFrameworkWorkflows } from "../../workflow/workflows.testSupport.js";

declareInstallationConfigOverrideChannelForTest();

/** A mock runtime playing every plan-task stage (see `playPlanTaskStage`). */
function planTaskAdapter(
  targetRoot: string,
  options: { module?: string; engineer?: (call: number) => Partial<RuntimeAgentResult> | undefined } = {},
): MockRuntimeAdapter {
  let engineerCalls = 0;
  let self: MockRuntimeAdapter;
  const adapter = new MockRuntimeAdapter({
    id: "claude-code",
    models: ["sonnet"],
    respond: (req) => {
      if (req.role !== "reviewer" && req.role !== "qa-engineer") engineerCalls += 1;
      const over = playPlanTaskStage(req, self.workspace.files, targetRoot, { ...options, engineerCall: engineerCalls });
      return okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] }, ...over });
    },
    files: PLAN_TASK_GUARD_FILES,
  });
  self = adapter;
  return adapter;
}

/** Plays every stage of the plan-task workflow (engineer, reviewer, QA) to a verified pass. */
export function completingAdapter(targetRoot: string): MockRuntimeAdapter {
  return planTaskAdapter(targetRoot);
}

/** A single-repo project whose BA -> SA -> DEV handoffs a person has signed off and acknowledged. */
function signedProject() {
  const fixture = project(roots, git);
  writeSignedOffHandoffs(fixture.root, "orders");
  return fixture;
}

function stageSequence(root: string, taskId: string): string[] {
  const store = new SqliteTaskStore(defaultStateDbPath(root));
  try {
    return store.eventsForTask(taskId).filter((e) => e.type === "STAGE_COMPLETED").map((e) => String(e.payload.stage));
  } finally {
    store.close();
  }
}

describe("sta bounded-run (CLI)", () => {
  it("dry-run preview matches what a real freeze would register, and mutates nothing", async () => {
    const { root, targetRoot } = project(roots, git);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("plan_hash=") && l.includes("tasks=1"))).toBe(true);
    expect(logs.some((l) => l.includes("BE-004") && l.includes("owner=backend-engineer"))).toBe(true);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
    expect(git(targetRoot, "branch", "--list")).not.toContain("sta/run");
  });

  it("stops with the exact ambiguity rather than guessing when the requested scope names an unknown task", async () => {
    const { root, targetRoot } = project(roots, git);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--task", "NOPE", "--target-root", targetRoot, "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(4);
    expect(errors.some((l) => l.includes("unknown-task") && l.includes("NOPE"))).toBe(true);
    // Nothing was registered — the refusal happened before any mutation.
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("selects the Knowledge root through the central selector: unknown --root refuses with the deterministic root list (DR §8.2)", async () => {
    const { root, targetApi, knowledgeRoot } = threeRepoBoundedRunProject(roots, git);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetApi, "--project-root", root, "--dry-run", "--root", "nope"],
        root,
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes('unknown Knowledge root "nope"') && l.includes("available roots: default"))).toBe(true);
    // The same command with the v1 legacy name resolves and previews.
    const logs: string[] = [];
    const logSpy = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetApi, "--project-root", root, "--dry-run", "--root", "default"],
        root,
      );
    } finally {
      console.log = logSpy;
    }
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(knowledgeRoot, "knowledge-root-touched.txt"))).toBe(false);
  });

  it("--knowledge-root survives as a compatibility channel only when the path canonical-matches a registered root (DR §4)", async () => {
    const { root, targetApi, knowledgeRoot } = threeRepoBoundedRunProject(roots, git);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetApi, "--project-root", root, "--dry-run", "--knowledge-root", knowledgeRoot.toUpperCase()],
        root,
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);

    const errors: string[] = [];
    const errSpy = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetApi, "--project-root", root, "--dry-run", "--knowledge-root", path.join(knowledgeRoot, "elsewhere")],
        root,
      );
    } finally {
      console.error = errSpy;
    }
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes("does not match any registered Knowledge root"))).toBe(true);
  });

  it("(a) runs an eligible task to COMPLETED through the real CLI dispatch: the engine's stages, evidence and verified completion", async () => {
    const { root, targetRoot } = signedProject();
    const adapter = completingAdapter(targetRoot);
    const registry = new RuntimeRegistry([adapter]);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("froze run"))).toBe(true);
    expect(logs.some((l) => l.includes("COMPLETED"))).toBe(true);

    expect(stageSequence(root, "BE-004")).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);
    const store = new SqliteTaskStore(defaultStateDbPath(root));
    const ledger = new SqliteRunLedger(store, { projectRoot: root });
    try {
      const runs = ledger.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("COMPLETED");
      // COMPLETED because the engine's completion verifies, and the ledger task is its projection.
      const row = store.loadTask("BE-004")!;
      expect(row.machine.current).toBe("DEPLOYED");
      expect(row.completionEvidenceId).not.toBeNull();
      expect(ledger.readTasks(runs[0]!.run_id).map((task) => task.status)).toEqual(["DONE"]);
      expect(ledger.attemptsForTask(runs[0]!.run_id, "BE-004").map((attempt) => attempt.status)).toEqual(["SUCCEEDED"]);
      expect(ledger.checkpointsForRun(runs[0]!.run_id)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  }, 30_000);

  it("halts a run with no runtime to compose, and names the exact resume command", async () => {
    const { root, targetRoot } = signedProject();
    const registry = new RuntimeRegistry([]); // nothing registered
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    // V13 TASK-007: the same composition `sta run` uses refuses to start with no
    // registered runtime; the run halts (exit 1), it is not a human gate.
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("HALTED") && l.includes("not registered"))).toBe(true);
    expect(logs.some((l) => l.includes("sta bounded-run --resume"))).toBe(true);
  }, 30_000);

  /**
   * V13 TASK-007 (d) — the role-lane prerequisites are a stage-entry guard of
   * the engine, fail-closed on missing/empty Knowledge, and a bounded run meets
   * it before anything is frozen or dispatched.
   *
   * Control: "(a) runs an eligible task to COMPLETED" above is this same
   * fixture and adapter with the BA -> SA -> DEV handoffs signed off, and it
   * completes - so the stop below is the guard, not the runtime or fixture.
   */
  it("(d) with no Knowledge, the role-lane guard stops the engineer before any freeze or dispatch", async () => {
    const { root, targetRoot } = project(roots, git);
    const adapter = completingAdapter(targetRoot);
    const registry = new RuntimeRegistry([adapter]);

    const gatedLogs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => gatedLogs.push(line);
    let gatedCode: number;
    try {
      gatedCode = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(gatedCode).toBe(4);
    const gatedOutput = gatedLogs.join("\n");
    expect(gatedOutput).toContain("GATE");
    expect(gatedOutput).toContain("[bounded-run] awaiting a human decision (1):");
    expect(gatedOutput).toMatch(/\[bounded-run] {3}BE-004: cannot start backend-engineer: no knowledge\/ directory/);
    // Nothing launched, nothing frozen, no branch.
    expect(adapter.requests).toEqual([]);
    expect(git(targetRoot, "branch", "--list", "sta/run/*")).toBe("");
    const runId = gatedLogs.find((line) => line.includes("froze run"))!.match(/froze run (\S+):/)![1]!;
    {
      const store = new SqliteTaskStore(defaultStateDbPath(root));
      const ledger = new SqliteRunLedger(store, { projectRoot: root });
      try {
        expect(ledger.attemptsForTask(runId, "BE-004")).toEqual([]);
        expect(ledger.readRun(runId)?.status).toBe("AWAITING_HUMAN");
      } finally {
        ledger.close();
      }
    }

    // The stop is durable: a resume reports the engine's projection rather than starting work.
    const resumeLogs: string[] = [];
    const resumeSpy = console.log;
    console.log = (line: string) => resumeLogs.push(line);
    let resumeCode: number;
    try {
      resumeCode = await runCli(
        ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--dry-run"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = resumeSpy;
    }
    expect(resumeCode).toBe(0);
    const resumeOutput = resumeLogs.join("\n");
    expect(resumeOutput).toContain("status=AWAITING_HUMAN");
    expect(resumeOutput).toContain("blocked=BE-004");
    expect(adapter.requests).toEqual([]);

    // `sta status` reads the same engine projection, so the stop and its reason are visible without the run id.
    const statusLogs: string[] = [];
    const statusSpy = console.log;
    console.log = (line: string) => statusLogs.push(line);
    try {
      expect(await runCli(["status", "--project-root", root], root)).toBe(0);
    } finally {
      console.log = statusSpy;
    }
    const statusOutput = statusLogs.join("\n");
    expect(statusOutput).toContain(`bounded run ${runId} (AWAITING_HUMAN) module=orders: 0/1 task(s) verified done by the engine, 1 awaiting a human decision`);
    expect(statusOutput).toContain("BE-004: cannot start backend-engineer: no knowledge/ directory");
    expect(statusOutput).toContain("see `sta status BE-004` for what a person must do");

    // A person records the handoffs; the same frozen run now completes.
    writeSignedOffHandoffs(root, "orders");
    const resumedLogs: string[] = [];
    const resumedSpy = console.log;
    console.log = (line: string) => resumedLogs.push(line);
    try {
      resumeCode = await runCli(
        ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = resumedSpy;
    }
    expect(resumeCode, resumedLogs.join("\n")).toBe(0);
    expect(resumedLogs.join("\n")).toContain("COMPLETED");
  }, 60_000);

  it("--resume reports current readiness without mutating state under --dry-run", async () => {
    const { root, targetRoot } = project(roots, git);
    const registry = new RuntimeRegistry([]);
    let runId = "";
    const capture: string[] = [];
    let spy = console.log;
    console.log = (line: string) => capture.push(line);
    try {
      await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    const froze = capture.find((l) => l.includes("froze run"));
    expect(froze).toBeDefined();
    runId = froze!.match(/froze run (\S+):/)![1]!;

    const logs: string[] = [];
    spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--dry-run"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes(`resuming run ${runId}`))).toBe(true);
    expect(logs.some((l) => l.includes("readiness:"))).toBe(true);
  });
});


interface ThreeRepoFixture {
  root: string;
  knowledgeRoot: string;
  targetApi: string;
  targetWeb: string;
  installationConfig: string;
}

function threeRepoBoundedRunProject(
  rootsList: string[],
  gitRunner: (root: string, ...args: string[]) => string,
  options: {
    multiTask?: boolean;
    omitPlanTargets?: boolean;
    retiredApi?: boolean;
    originMismatch?: boolean;
    /** Record the BA -> SA -> DEV handoffs a person signed off (needed only where the engineer must run). */
    signed?: boolean;
  } = {},
): ThreeRepoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-three-repo-cli-"));
  installFrameworkWorkflows(root);
  rootsList.push(root);

  const knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v9-three-repo-kn-"));
  rootsList.push(knowledgeRoot);
  gitRunner(knowledgeRoot, "init", "-b", "main");
  gitRunner(knowledgeRoot, "config", "user.name", "Fixture");
  gitRunner(knowledgeRoot, "config", "user.email", "fixture@example.invalid");

  const targetApi = fs.mkdtempSync(path.join(os.tmpdir(), "v9-three-repo-api-"));
  rootsList.push(targetApi);
  gitRunner(targetApi, "init", "-b", "main");
  gitRunner(targetApi, "config", "user.name", "Fixture");
  gitRunner(targetApi, "config", "user.email", "fixture@example.invalid");
  gitRunner(targetApi, "config", "remote.origin.url", options.originMismatch ? "https://github.com/acme/wrong.git" : "https://github.com/acme/api.git");
  fs.mkdirSync(path.join(targetApi, "src"), { recursive: true });
  const orderSource = "export function orderSummary(): number { return 0; }\n";
  fs.writeFileSync(path.join(targetApi, "src", "orders.ts"), orderSource);
  fs.writeFileSync(path.join(targetApi, "package.json"), JSON.stringify({ name: "orders-api", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
  fs.mkdirSync(path.join(targetApi, ".claude", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(targetApi, ".claude", "scripts", "static-analysis-gate.js"),
    "process.stdout.write(JSON.stringify({ ok: true, problems: [] }));\nprocess.exit(0);\n",
  );
  gitRunner(targetApi, "add", "--", "src/orders.ts", "package.json", ".claude/scripts/static-analysis-gate.js");
  gitRunner(targetApi, "commit", "-m", "initial", "--");
  const headSha = gitRunner(targetApi, "rev-parse", "HEAD");
  const orderHash = sha256(orderSource);

  const targetWeb = fs.mkdtempSync(path.join(os.tmpdir(), "v9-three-repo-web-"));
  rootsList.push(targetWeb);
  gitRunner(targetWeb, "init", "-b", "main");
  gitRunner(targetWeb, "config", "user.name", "Fixture");
  gitRunner(targetWeb, "config", "user.email", "fixture@example.invalid");
  gitRunner(targetWeb, "config", "remote.origin.url", "https://github.com/acme/web.git");
  fs.mkdirSync(path.join(targetWeb, "src"), { recursive: true });
  fs.writeFileSync(path.join(targetWeb, "src", "App.tsx"), "export function App() { return null; }\n");
  fs.writeFileSync(path.join(targetWeb, "package.json"), JSON.stringify({ name: "orders-web", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
  fs.mkdirSync(path.join(targetWeb, ".claude", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(targetWeb, ".claude", "scripts", "static-analysis-gate.js"),
    "process.stdout.write(JSON.stringify({ ok: true, problems: [] }));\nprocess.exit(0);\n",
  );
  gitRunner(targetWeb, "add", "--", "src/App.tsx", "package.json", ".claude/scripts/static-analysis-gate.js");
  gitRunner(targetWeb, "commit", "-m", "initial", "--");

  fs.writeFileSync(
    path.join(knowledgeRoot, "targets.yaml"),
    `schema_version: 1\ntargets:\n  - target_id: api\n    name: Orders API\n    remote_url: https://github.com/acme/api.git\n    status: ${options.retiredApi ? "retired" : "active"}\n    type: backend\n  - target_id: web\n    name: Orders Web\n    remote_url: https://github.com/acme/web.git\n    status: active\n    type: frontend\n`,
  );
  fs.mkdirSync(path.join(knowledgeRoot, ".workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeRoot, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(targetApi)}\n  web:\n    path: ${JSON.stringify(targetWeb)}\n`,
  );
  gitRunner(knowledgeRoot, "add", "--", "targets.yaml");
  gitRunner(knowledgeRoot, "commit", "-m", "initial", "--");

  const installationConfig = path.join(root, "installation.yaml");
  fs.writeFileSync(
    installationConfig,
    `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`,
  );
  process.env.STA_INSTALLATION_CONFIG = installationConfig;

  const requirement = "# Requirement\n\n- REQ-007: Order summary responses stay stable when no line item exists.\n- AC-007.2: Zero-total responses for orders with no line items must stay serializable.\n";
  const design = `# Design

Design evidence format: 1

## Feasibility Summary

Independently implementable.

## Feature-by-Feature Feasibility

One declaration below defines the selected behavior.

## Data Model

No schema changes.

## DES-011 \u2014 Order summary response
Contract:OrderSummary.v2 \u2014 the empty-order response shape.
Contract:OrderWeb.v1 \u2014 the web UI contract shape.
DEC-011 \u2014 keep summary construction behind one serializer boundary.
Evidence EVD-011: claim=DES-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${orderHash}
Evidence EVD-012: claim=Contract:OrderSummary.v2 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${orderHash}
Evidence EVD-013: claim=DEC-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${orderHash}
Evidence EVD-014: claim=Contract:OrderWeb.v1 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${orderHash}
Compatibility: unchanged
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: retain the current empty-order handler.
Material ambiguity: none

## Modules

Orders service.

## Targets

- api
- web

## Risks & Dependencies

The per-section decision records are authoritative.

## Unresolved Open Questions

\u2014

## Change Log

- Undated fixture; no human sign-off is implied.
`;

  const singlePlan = `# Plan

PlanTask format: 1

## Plan Summary
Deliver one independently verifiable contract-preserving task.

## Phase 1: Orders

### Task BE-004 \u2014 Preserve the order summary

Objective: Return the existing order summary for an empty order.
Why: Clients need a stable empty-order response.
Owner: backend-engineer
Depends on: none
Traceability: REQ-007, AC-007.2, DES-011
Produces: Contract:OrderSummary.v2
Consumes: none
Risk: shared-contract
Human gate: none
Status: pending
${options.omitPlanTargets ? "" : "Targets: api\n"}
#### Scope and constraints

Preserve the response contract while handling empty line items.

#### Retrieval hints

Hypothesis: The OrderSummary serializer and empty-order regression are likely boundaries; confirm symbols and paths against current source.
Query: Locate definitions and references for Contract:OrderSummary.v2 and the empty-order behavior.
Provenance: DES-011, Contract:OrderSummary.v2

#### Do not modify

Authentication, database schema and unrelated response fields.

#### Acceptance criteria

AC-007.2: An empty order returns the documented zero total without an exception.

#### Required validation and expected evidence

Verify AC-007.2 with the empty-order regression and existing serializer tests. Record commands, exit codes and response assertions.

#### Rollback/compatibility notes

Preserve existing nonempty-order serialization. The patch can be removed independently.

## Sequencing Notes
No preceding implementation is required.

## Unresolved Open Questions
None.

## Change Log
Undated canonical fixture; no human sign-off is implied.
`;

  const multiPlan = `# Plan

PlanTask format: 1

## Plan Summary
Deliver two tasks across two targets.

## Phase 1: Orders

### Task BE-004 \u2014 Preserve the order summary

Objective: Return the existing order summary for an empty order.
Why: Clients need a stable empty-order response.
Owner: backend-engineer
Depends on: none
Traceability: REQ-007, AC-007.2, DES-011
Produces: Contract:OrderSummary.v2
Consumes: none
Risk: shared-contract
Human gate: none
Status: pending
Targets: api

#### Scope and constraints

Preserve the response contract while handling empty line items.

#### Retrieval hints

Hypothesis: The OrderSummary serializer and empty-order regression are likely boundaries; confirm symbols and paths against current source.
Query: Locate definitions and references for Contract:OrderSummary.v2 and the empty-order behavior.
Provenance: DES-011, Contract:OrderSummary.v2

#### Do not modify

Authentication, database schema and unrelated response fields.

#### Acceptance criteria

AC-007.2: An empty order returns the documented zero total without an exception.

#### Required validation and expected evidence

Verify AC-007.2 with the empty-order regression and existing serializer tests. Record commands, exit codes and response assertions.

#### Rollback/compatibility notes

Preserve existing nonempty-order serialization. The patch can be removed independently.

### Task FE-005 \u2014 Render the order summary

Objective: Render the order summary on web.
Why: Users need to view order summaries.
Owner: frontend-engineer
Depends on: BE-004
Traceability: REQ-007, AC-007.2, DES-011
Produces: Contract:OrderWeb.v1
Consumes: Contract:OrderSummary.v2
Risk: shared-contract
Human gate: none
Status: pending
Targets: web

#### Scope and constraints

Render order summary in web interface.

#### Retrieval hints

Hypothesis: App component renders order summary.
Query: Locate definitions and references for Contract:OrderSummary.v2 and the empty-order behavior.
Provenance: DES-011, Contract:OrderSummary.v2, Contract:OrderWeb.v1

#### Do not modify

Authentication, database schema and unrelated response fields.

#### Acceptance criteria

AC-007.2: An empty order returns the documented zero total without an exception.

#### Required validation and expected evidence

Verify AC-007.2 with unit tests. Record commands, exit codes and response assertions.

#### Rollback/compatibility notes

Preserve existing nonempty-order serialization. The patch can be removed independently.

## Sequencing Notes
No preceding implementation is required.

## Unresolved Open Questions
None.

## Change Log
Undated canonical fixture; no human sign-off is implied.
`;

  const plan = options.multiTask ? multiPlan : singlePlan;

  const docs = path.join(knowledgeRoot, "_docs", "module", "orders");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "plan.md"), plan);
  fs.writeFileSync(path.join(docs, "requirement.md"), requirement);
  fs.writeFileSync(path.join(docs, "design.md"), design);

  const templateContracts = path.join(fileURLToPath(new URL("../../../../templates/contracts", import.meta.url)));
  const contracts = path.join(root, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  // Every role's contract: the engine's reviewer-independence check reads them all.
  for (const file of fs.readdirSync(templateContracts).filter((name) => name.endsWith(".yaml"))) {
    fs.copyFileSync(path.join(templateContracts, file), path.join(contracts, file));
  }
  // The BA -> SA -> DEV handoffs a person signed off (the engine's role-lane guard reads the Knowledge root).
  if (options.signed) writeSignedOffHandoffs(knowledgeRoot, "orders");

  return { root, knowledgeRoot, targetApi, targetWeb, installationConfig };
}

describe("T-V9-011 sta bounded-run Target binding reconciliation", () => {
  it("three-repo bounded run populates registry-validated targetBindings and preflight-derived targetWorkRoots", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { signed: true });
    const adapter = completingAdapter(targetApi);
    const registry = new RuntimeRegistry([adapter]);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code, logs.join("\n")).toBe(0);
    expect(logs.some((l) => l.includes("froze run"))).toBe(true);
    expect(logs.some((l) => l.includes("COMPLETED"))).toBe(true);
    expect(stageSequence(root, "BE-004")).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    try {
      const task = store.loadTask("BE-004");
      expect(task).toBeDefined();
      expect(task!.targetBindings).toEqual({
        targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }],
      });
      const canonicalApi = fs.realpathSync.native(targetApi);
      expect(task!.runtimeTask!.scope.work_roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: AgentStage.BACKEND_ENGINEER, target_id: "api", root: canonicalApi }),
          expect.objectContaining({ stage: AgentStage.QA_ENGINEER, target_id: "api", root: canonicalApi }),
        ]),
      );
    } finally {
      store.close();
    }
  }, 30_000);

  it("V13 TASK-007 — the three-repo reviewer reads the Target and may write only its Knowledge-side review docs", async () => {
    const { root, knowledgeRoot, targetApi } = threeRepoBoundedRunProject(roots, git, { signed: true });
    const adapter = completingAdapter(targetApi);
    const code = await runCli(
      ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--autonomy", "edit"],
      root,
      { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
    );
    expect(code).toBe(0);
    const canonicalApi = fs.realpathSync.native(targetApi);
    const REVIEW_WRITES = ["_docs/module/*/review.md", "_docs/module/*/review/**"];

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    let runtimeTask;
    try {
      runtimeTask = store.loadTask("BE-004")!.runtimeTask!;
    } finally {
      store.close();
    }
    if (!("version" in runtimeTask) || runtimeTask.version !== 2) throw new Error("expected a canonical RuntimeTask");
    const reviewerRoots = runtimeTask.scope.work_roots.filter((r) => r.stage === AgentStage.REVIEWER);
    const qaRoots = runtimeTask.scope.work_roots.filter((r) => r.stage === AgentStage.QA_ENGINEER);
    // Exactly the read-only Target access QA gets.
    expect(reviewerRoots.map((r) => [r.target_id, r.root, r.access])).toEqual([["api", canonicalApi, "read"]]);
    expect(qaRoots.map((r) => [r.target_id, r.root, r.access])).toEqual([["api", canonicalApi, "read"]]);
    // Its write scope is its contract's review docs - no Target code.
    expect(reviewerRoots[0]!.allow.map((a) => a.contract_glob).sort()).toEqual(REVIEW_WRITES);
    expect(reviewerRoots[0]!.allow.some((a) => /^(src|app|server|components|prisma)\//.test(a.contract_glob))).toBe(false);

    // The dispatched packet says the same.
    const packetDir = path.join(knowledgeRoot, ".workflow", "packets", "BE-004");
    const reviewerPackets = fs.readdirSync(packetDir).filter((name) => name.startsWith("reviewer-"));
    expect(reviewerPackets.length).toBeGreaterThan(0);
    const packet = JSON.parse(fs.readFileSync(path.join(packetDir, reviewerPackets[0]!), "utf8")) as { scope: { roots: string[]; allow: string[]; deny: string[] } };
    expect(packet.scope.roots.map((r) => path.resolve(r))).toEqual([canonicalApi]);
    expect([...packet.scope.allow].sort()).toEqual(REVIEW_WRITES);
    expect(packet.scope.deny).toEqual(expect.arrayContaining(["src/**", "app/**", "server/**"]));
    expect(adapter.requests.some((request) => request.role === "reviewer")).toBe(true);
  }, 30_000);

  it("bounded run against a retired Target is refused before any attempt starts", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { retiredApi: true });
    const adapter = completingAdapter(targetApi);
    const registry = new RuntimeRegistry([adapter]);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes("[bounded-run] refused:") && l.includes("retired"))).toBe(true);
    expect(adapter.requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("bounded run against a Target with origin remote mismatch is refused before any attempt starts", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { originMismatch: true });
    const adapter = completingAdapter(targetApi);
    const registry = new RuntimeRegistry([adapter]);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes("[bounded-run] refused:") && l.includes("expected canonical remote_url"))).toBe(true);
    expect(adapter.requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("multi-Target run without explicit git-identity root is refused", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { multiTask: true });
    const adapter = completingAdapter(targetApi);
    const registry = new RuntimeRegistry([adapter]);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes("[bounded-run] refused: run spans multiple Targets (api, web) \u2014 git-identity root must be named explicitly with --target-root"))).toBe(true);
    expect(adapter.requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("multi-Target run with explicit git-identity root previews cleanly under --dry-run", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { multiTask: true });
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetApi, "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("tasks=2"))).toBe(true);
    expect(logs.some((l) => l.includes("target root=") && l.includes("id=api"))).toBe(true);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("fallback to --target-id when plan does not declare Targets:", async () => {
    const { root, targetApi } = threeRepoBoundedRunProject(roots, git, { omitPlanTargets: true });
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("tasks=1"))).toBe(true);
    expect(logs.some((l) => l.includes("target root=") && l.includes("id=api"))).toBe(true);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });
});

describe("V10 TASK-025 — runtime state has one home: the Knowledge root", () => {
  it("a three-repo run persists every packet under the Knowledge root, and the invoking cwd gains none", async () => {
    const { root, knowledgeRoot, targetApi } = threeRepoBoundedRunProject(roots, git, { signed: true });
    const adapter = completingAdapter(targetApi);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-id", "api", "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
      );
    } finally {
      console.log = spy;
    }
    expect(code, logs.join("\n")).toBe(0);
    expect(logs.some((l) => l.includes("COMPLETED"))).toBe(true);
    expect(stageSequence(root, "BE-004")).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);

    // The prepare-time packet and the per-stage executor packet all land in
    // the Knowledge root's .workflow — the executor's (attempt 2) used to
    // follow the Framework contract root instead.
    const packets = path.join(knowledgeRoot, ".workflow", "packets", "BE-004");
    const written = fs.readdirSync(packets).sort();
    expect(written).toContain("backend-engineer-1.json");
    expect(written).toContain("backend-engineer-2.json");
    // The cwd the run was commanded from gains no packet storage at all.
    expect(fs.existsSync(path.join(root, ".workflow", "packets"))).toBe(false);
  }, 30_000);
});

describe("T-V10 bounded-run autonomy/routing plumbing (TASK-005, TASK-006)", () => {
  it("TASK-005 — `--autonomy edit` reaches every adapter request the engine dispatches, not just the parser", async () => {
    const { root, targetRoot } = signedProject();
    const adapter = completingAdapter(targetRoot);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
      );
    } finally {
      console.log = spy;
    }
    expect(code, logs.join("\n")).toBe(0);
    expect(adapter.requests.length).toBeGreaterThanOrEqual(3);
    expect(adapter.requests.every((request) => request.autonomy === "edit")).toBe(true);
  }, 30_000);

  it("TASK-005 — a --dry-run still needs no autonomy and dispatches nothing at all", async () => {
    const { root, targetRoot } = signedProject();
    const adapter = completingAdapter(targetRoot);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--dry-run"],
        root,
        { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(adapter.requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("TASK-006 — `--model` reaches the attempt freeze, and an explicit model stays fail-closed there", async () => {
    const { root, targetRoot } = signedProject();
    const adapter = completingAdapter(targetRoot);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit", "--model", "not-declared", "--effort", "high"],
        root,
        { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
      );
    } finally {
      console.log = spy;
    }
    // attemptFreeze's shipped boundary: a route naming an explicit model may not
    // start unless the runtime's model-selection is verified - the flag cannot
    // silently carry the run to that model (T-V10 TASK-006 "policy wins"). The
    // refusal is a failed engineer role-run, so the run halts (V13 TASK-007).
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("HALTED");
    expect(adapter.requests).toEqual([]);

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    const ledger = new SqliteRunLedger(store, { projectRoot: root });
    try {
      const run = ledger.listRuns()[0]!;
      expect(ledger.attemptsForTask(run.run_id, "BE-004")).toHaveLength(0);
      expect(store.runsForTask("BE-004").at(-1)?.failure_reason ?? "").toContain("no verified model-selection capability");
    } finally {
      ledger.close();
    }
  }, 30_000);

  it("TASK-006 — `--effort` rides the flag lane end-to-end into the attempt's frozen requested route", async () => {
    const { root, targetRoot } = signedProject();
    const adapter = completingAdapter(targetRoot);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit", "--effort", "high"],
        root,
        { createRuntimeRegistry: () => new RuntimeRegistry([adapter]) },
      );
    } finally {
      console.log = spy;
    }
    expect(code, logs.join("\n")).toBe(0);

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    const ledger = new SqliteRunLedger(store, { projectRoot: root });
    try {
      const run = ledger.listRuns()[0]!;
      const attempts = ledger.attemptsForTask(run.run_id, "BE-004");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.requested).toEqual({ runtime: "claude-code", model: null, effort: "high" });
      expect(attempts[0]!.route_basis).toBe("level-1");
    } finally {
      ledger.close();
    }
  }, 30_000);
});

/**
 * V10 TASK-031 — the closing summary is the only place a run with several
 * gates reports all of them; `ControllerResult.reason` carries one line.
 */
describe("V10 TASK-031 — awaiting-human summary", () => {
  it("prints one line per gated task with the command that clears it", () => {
    const lines = renderAwaitingHuman([
      { taskId: "BE-001", reason: "schema confirmation required" },
      { taskId: "BE-002", reason: "no runtime route resolved for BE-002/backend-engineer" },
      { taskId: "FE-001", reason: "UX sign-off is missing" },
    ]);
    expect(lines).toEqual([
      "[bounded-run] awaiting a human decision (3):",
      "[bounded-run]   BE-001: schema confirmation required — `sta approve BE-001`",
      "[bounded-run]   BE-002: no runtime route resolved for BE-002/backend-engineer — `sta approve BE-002`",
      "[bounded-run]   FE-001: UX sign-off is missing — `sta approve FE-001`",
    ]);
  });

  it("adds nothing when no task is waiting on a person", () => {
    expect(renderAwaitingHuman([])).toEqual([]);
  });

  it("keeps one gate's line readable by folding newlines and capping the reason", () => {
    const [, line] = renderAwaitingHuman([{ taskId: "BE-001", reason: `head\n${"x".repeat(400)}` }]);
    expect(line!.startsWith("[bounded-run]   BE-001: head x")).toBe(true);
    expect(line).toContain("…");
    expect(line).toContain("`sta approve BE-001`");
    expect(line!.length).toBeLessThan(200);
  });
});
