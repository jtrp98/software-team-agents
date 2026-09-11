import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { projectWaveRun, resolveExecutionAuthority, LedgerAdapterError } from "../ledger/adapters.js";
import { observeRuns } from "./observability.js";
import { runArtifactPaths, type KnownJournalRecord, type RunManifest } from "./journal.js";
import { writeLegacyWaveRun } from "./legacyWaveRecord.testSupport.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts` under `orchestrator/src`, so "nothing imports it" is a fact rather than a grep someone ran once. */
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

const ALL_SOURCES = sourceFiles().map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
const PRODUCTION_SOURCES = ALL_SOURCES.filter(({ file }) => !/[.]test[.]ts$|[.]testSupport[.]ts$/.test(file));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Production files with a live (non-comment) line matching `pattern`.
 *
 * Comments are excluded deliberately: a note recording what was removed and
 * where its behaviour went is the evidence this task is meant to leave behind,
 * not a surviving dependency. Tests are excluded for the same reason — they
 * assert the absence of these names and therefore have to spell them.
 */
function offendersFor(pattern: RegExp): string[] {
  return PRODUCTION_SOURCES
    .filter(({ text }) =>
      text.split(/\r?\n/).some((line) => pattern.test(line) && !/^\s*([*]|\/\/|\/[*])/.test(line)))
    .map(({ file }) => path.relative(SRC, file).split(path.sep).join("/"));
}

describe("T-V8-029 — the retired wave lifecycle is unreachable, not merely unused", () => {
  it.each([
    "run/waveRunner.ts",
    "run/recovery.ts",
    "run/eligibility.ts",
    "run/waveRunner.test.ts",
    "run/recovery.test.ts",
    "run/eligibility.test.ts",
    "run/killWaveFixture.test.ts",
  ])("deleted module %s no longer exists", (relative) => {
    expect(fs.existsSync(path.join(SRC, relative))).toBe(false);
  });

  it.each([
    "waveRunner",
    "run/recovery",
    "run/eligibility",
    "executeWave",
    "buildWavePreview",
    "renderWavePreview",
    "findActiveWaveRun",
    "reconcileWaveRunForResume",
    "WaveRunRecoveryError",
    "evaluateAutoEligibility",
    "renderAutoEligibility",
    "tasksInDerivedWave",
    "openPreparedForWave",
    "WaveTaskNotPreparedError",
    "planReadinessAdvisory",
    "writeRunManifest",
    "appendJournalRecord",
    "repairTruncatedJournal",
    "pruneWaveRunArtifacts",
    "WAVE_ATTEMPT_STARTED",
    "WAVE_CHECKPOINT_REATTRIBUTED",
  ])("no production source calls retired symbol %s", (symbol) => {
    expect(offendersFor(new RegExp(escapeRegExp(symbol)))).toEqual([]);
  });

  it("leaves no production reference to a wave-only execution state or QA handoff line", () => {
    // `cli.ts` keeps the retired flag *names* on purpose, to refuse them explicitly.
    const offenders = offendersFor(/none verified\. Next: qa-engineer|--resume-run|--no-wave-runner|--register-only/)
      .filter((file) => file !== "cli.ts");
    expect(offenders).toEqual([]);
  });

  it("keeps exactly one readiness authority: the ledger's, with no plan-document advisory left", () => {
    const planGraph = ALL_SOURCES.find(({ file }) => file.endsWith(path.join("docs", "planGraph.ts")))!.text;
    expect(planGraph).not.toContain("PlanReadinessAdvisory");
    const ledger = ALL_SOURCES.find(({ file }) => file.endsWith(path.join("ledger", "runLedger.ts")))!.text;
    expect(ledger).toContain("readiness(");
  });

  it("keeps the legacy journal readers, because an old record must stay inspectable", async () => {
    const journal = await import("./journal.js");
    for (const reader of ["readRunManifest", "readJournal", "runArtifactPaths", "isKnownJournalRecord", "createRunId"]) {
      expect(Object.keys(journal)).toContain(reader);
    }
    const stateMachine = await import("./stateMachine.js");
    expect(Object.keys(stateMachine)).toContain("reconstructRunState");
  });
});

describe("T-V8-029 — a legacy wave record stays inspectable and cannot be resumed", () => {
  const RUN_ID = "01J00000000000000000000099";

  function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
    return {
      run_id: RUN_ID,
      created_at: "2026-09-07T00:00:00.000Z",
      target_root: "C:/target",
      target_id: "target",
      knowledge_root: "C:/knowledge",
      module: "orders",
      wave: 1,
      plan_hash: "a".repeat(64),
      task_order: ["BE-1"],
      base_branch: "main",
      base_sha: "b".repeat(40),
      run_branch: `sta/run/orders/${RUN_ID}`,
      runtime_id: "claude-code",
      tier: "T3",
      model: "opus",
      max_tasks: 1,
      sta_version: "1.1.0",
      ...overrides,
    };
  }

  const RECORDS: KnownJournalRecord[] = [
    { ts: "2026-09-07T00:00:00.000Z", kind: "RUN_STARTED" },
    { ts: "2026-09-07T00:00:01.000Z", kind: "RUN_ISOLATED" },
    { ts: "2026-09-07T00:00:02.000Z", kind: "TASK_READY", task_id: "BE-1" },
    { ts: "2026-09-07T00:00:03.000Z", kind: "TASK_STARTED", task_id: "BE-1" },
    { ts: "2026-09-07T00:00:04.000Z", kind: "TASK_AGENT_DONE", task_id: "BE-1" },
    { ts: "2026-09-07T00:00:05.000Z", kind: "GATE_RESULT", task_id: "BE-1", result: "passed", summary: "typecheck" },
    { ts: "2026-09-07T00:00:06.000Z", kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha: "c".repeat(40) },
  ];

  async function withRoot<T>(body: (root: string) => T | Promise<T>): Promise<T> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-retired-wave-"));
    try {
      return await body(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("projects into ledger vocabulary and reports the legacy journal as its authority", async () => {
    await withRoot((root) => {
      writeLegacyWaveRun(root, manifest(), RECORDS);
      const projection = projectWaveRun(root, RUN_ID, {
        taskOwners: new Map([["BE-1", AgentStage.BACKEND_ENGINEER]]),
      });
      expect(projection.run.run_id).toBe(RUN_ID);
      expect(projection.tasks[0]).toMatchObject({ task_id: "BE-1", status: "CHECKPOINTED" });
      expect(projection.checkpoints[0]?.sha).toBe("c".repeat(40));
      expect(resolveExecutionAuthority({ projectRoot: root, runId: RUN_ID, ledgerHasRun: false })).toMatchObject({
        authority: "legacy-wave-journal",
      });
      // The ledger wins the moment it holds the run; there is no tie-break.
      expect(resolveExecutionAuthority({ projectRoot: root, runId: RUN_ID, ledgerHasRun: true })).toMatchObject({
        authority: "ledger",
      });
    });
  });

  it("refuses to claim state for a run id neither store holds", async () => {
    await withRoot((root) => {
      expect(() => resolveExecutionAuthority({ projectRoot: root, runId: RUN_ID, ledgerHasRun: false }))
        .toThrow(LedgerAdapterError);
    });
  });

  it("stays byte-identical after being read, because no writer exists to append to it", async () => {
    await withRoot(async (root) => {
      writeLegacyWaveRun(root, manifest({ target_root: root, knowledge_root: root }), RECORDS);
      const paths = runArtifactPaths(root, RUN_ID);
      const before = { manifest: fs.readFileSync(paths.manifest), journal: fs.readFileSync(paths.journal) };

      projectWaveRun(root, RUN_ID, { taskOwners: new Map([["BE-1", AgentStage.BACKEND_ENGINEER]]) });
      await observeRuns(root);

      expect(fs.readFileSync(paths.manifest).equals(before.manifest)).toBe(true);
      expect(fs.readFileSync(paths.journal).equals(before.journal)).toBe(true);
    });
  });
});
