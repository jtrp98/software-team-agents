import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest } from "../orchestrator/orchestrator.js";
import { compileAndRegisterPlan } from "../orchestrator/planCompilation.js";
import type { RuntimeTaskWorkRoot } from "../orchestrator/runtimeTask.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import type { LedgerAttempt } from "../ledger/runLedger.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../runtime/mockAdapter.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { contractGuardResolver } from "../runtime/runtimeGuards.js";
import { withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import { boundedRunProject } from "../cli/verbs/boundedRunFixture.testSupport.js";
import { createRunId } from "./journal.js";
import { LedgerAttemptBoundary } from "./ledgerAttemptExecutor.js";

/**
 * V13 TASK-007 — the ledger-attempt boundary's production freeze (moved from
 * the retired `boundedRunServices.prepareTask`): route resolution, packet
 * compile and `freezeAttempt` for an engineer dispatch, the one-writable-
 * Target refusal, and the pass-through of every non-engineer stage. The
 * crash/checkpoint matrix is `boundedRunFaultMatrix.test.ts`.
 */

const roots: string[] = [];
const closers: Array<() => void> = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function register(extraWorkRoots: (targetRoot: string) => readonly RuntimeTaskWorkRoot[] = () => []) {
  const { root, targetRoot } = boundedRunProject(roots, git);
  const store = new SqliteTaskStore(path.join(root, "state.db"));
  const ledger = new SqliteRunLedger(store, { projectRoot: root });
  const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store });
  closers.push(() => registry.close(), () => ledger.close());
  const runId = createRunId();
  const docs = path.join(root, "_docs", "module", "orders");
  const requirementMd = fs.readFileSync(path.join(docs, "requirement.md"), "utf8");
  const designMd = fs.readFileSync(path.join(docs, "design.md"), "utf8");
  const result = compileAndRegisterPlan({
    registry, store, ledger,
    planMarkdown: fs.readFileSync(path.join(docs, "plan.md"), "utf8"),
    references: { requirementMd, designMd },
    scope: { kind: "all" },
    runId, module: "orders", boundary: "done",
    targetId: "target", targetRoot, knowledgeRoot: root,
    baseBranch: "main", baseSha: git(targetRoot, "rev-parse", "HEAD"), runBranch: `sta/run/orders/${runId}`,
    configHash: "a".repeat(64), requirementHash: sha256(requirementMd), designHash: sha256(designMd),
    staVersion: "2.0.0",
    taskContextFor: () => ({
      projectRoot: root,
      docsRoot: root,
      workflow: "bounded-run",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: targetRoot },
        { stage: AgentStage.QA_ENGINEER, targetId: "target", path: targetRoot },
        ...extraWorkRoots(targetRoot),
      ],
    }),
  });
  return { root, targetRoot, store, ledger, run: result.run };
}

function guardedAdapter(): MockRuntimeAdapter {
  return new MockRuntimeAdapter({
    id: "claude-code",
    models: ["sonnet"],
    respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }),
    files: {
      ".mock/guards.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-path-permissions.js" }] }],
          Stop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }] }],
        },
      }),
    },
  });
}

function boundary(f: ReturnType<typeof register>, registry: RuntimeRegistry): LedgerAttemptBoundary {
  const b = new LedgerAttemptBoundary({
    ledger: f.ledger,
    runId: f.run.run_id,
    store: f.store,
    runtimeStateRoot: f.root,
    contractRoot: f.root,
    registry,
    runtimeSelection: () => ({ defaultRuntimeId: "claude-code" }),
    guards: contractGuardResolver(f.root),
    dependencyEvidence: () => [],
    adapterVersion: "test@1",
    secretScanner: () => ({ ok: true, problems: [] }),
  });
  closers.push(() => b.close());
  return b;
}

const engineerRequest: AgentExecutorRequest = { stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] };

describe("V13 TASK-007 — the ledger-attempt boundary on a real registered plan task", () => {
  it("freezes one attempt, runs the inner executor under it, and checkpoints exactly its work", async () => {
    const f = register();
    const b = boundary(f, new RuntimeRegistry([guardedAdapter()]));
    let seenFrozen: LedgerAttempt | undefined;
    const inner: AgentExecutor = (req) => {
      // The runtime executor's `frozenAttemptFor` sees the attempt for exactly this dispatch.
      seenFrozen = b.frozenAttemptFor(req.taskId, req.stage);
      expect(b.frozenAttemptFor(req.taskId, AgentStage.FRONTEND_ENGINEER)).toBeUndefined();
      // README.md is inside the engineer's boundary write list (the retired services test's choice).
      fs.writeFileSync(path.join(f.targetRoot, "README.md"), "# orders\n\nReviewed the empty-order summary path.\n");
      return withRequiredEvidence(req, { outcome: { tokens: 1, cost: 0, result: "PASS" } });
    };
    const result = await b.decorate(inner)(engineerRequest);
    expect(result.outcome.result, result.outcome.failure_reason ?? "").toBe("PASS");
    const attempts = f.ledger.attemptsForTask(f.run.run_id, "BE-004");
    expect(attempts.map((a) => a.status)).toEqual(["SUCCEEDED"]);
    expect(seenFrozen?.attempt_id).toBe(attempts[0]!.attempt_id);
    expect(attempts[0]!.guard_evidence.writable_roots).toEqual([f.targetRoot]);
    expect(b.frozenAttemptFor("BE-004", AgentStage.BACKEND_ENGINEER)).toBeUndefined();
    const checkpoints = f.ledger.checkpointsForRun(f.run.run_id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ task_id: "BE-004", attempt_id: attempts[0]!.attempt_id, packet_hash: attempts[0]!.packet_hash });
    expect(git(f.targetRoot, "rev-list", "--count", f.run.run_branch)).toBe("2");
    // The boundary writes no ledger task status: that is the engine projection's job.
    expect(f.ledger.readTask(f.run.run_id, "BE-004")?.status).toBe("PLANNED");
  }, 30_000);

  it("passes every non-engineer stage straight through: no attempt, no checkpoint, no Git", async () => {
    const f = register();
    const b = boundary(f, new RuntimeRegistry([guardedAdapter()]));
    const seen: AgentStage[] = [];
    const inner: AgentExecutor = (req) => { seen.push(req.stage); return withRequiredEvidence(req, { outcome: { tokens: 1, cost: 0, result: "PASS" } }); };
    for (const stage of [AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY]) {
      expect((await b.decorate(inner)({ stage, taskId: "BE-004", context: [] })).outcome.result).toBe("PASS");
    }
    expect(seen).toEqual([AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY]);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-004")).toEqual([]);
    expect(git(f.targetRoot, "branch", "--list", f.run.run_branch)).toBe("");
  }, 30_000);

  it("refuses with a FAIL result, before any attempt, when no runtime route resolves", async () => {
    const f = register();
    const b = boundary(f, new RuntimeRegistry([]));
    let called = false;
    const result = await b.decorate(() => { called = true; return { outcome: { tokens: 0, cost: 0, result: "PASS" } }; })(engineerRequest);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/no runtime route resolved/);
    expect(result.failure).toMatchObject({ requiresHuman: true, affected: ["BE-004"] });
    expect(called).toBe(false);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-004")).toEqual([]);
  }, 30_000);

  /**
   * V10 TASK-009 decision: widening an engineer's write scope stops at the
   * commit boundary. One `GuardedRunSession` per run holds one Git repository
   * and `freezeAttempt`/`assertTargetAttempt` admit one writable root per
   * attempt, so a second writable Target is refused here - before any adapter
   * runs - rather than after an agent wrote work no checkpoint can commit.
   */
  it("TASK-009 — one Target per attempt: refuses a second writable Target before anything is written", async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "v13-second-target-"));
    roots.push(second);
    const f = register(() => [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "second", path: second, access: "write" }]);
    const adapter = guardedAdapter();
    const b = boundary(f, new RuntimeRegistry([adapter]));
    let called = false;
    const result = await b.decorate(() => { called = true; return { outcome: { tokens: 0, cost: 0, result: "PASS" } }; })(engineerRequest);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/resolves 2 writable Targets for backend-engineer/);
    expect(result.outcome.failure_reason).toMatch(/commits one Target per attempt/);
    expect(called).toBe(false);
    expect(adapter.requests).toHaveLength(0);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(0);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-004")).toHaveLength(0);
  }, 30_000);

  it("TASK-009 regression — a single writable Target still freezes, so the widened scope changes nothing for a one-Target task", async () => {
    const f = register((targetRoot) => [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: targetRoot, access: "write" }]);
    const b = boundary(f, new RuntimeRegistry([guardedAdapter()]));
    const inner: AgentExecutor = (req) => {
      fs.writeFileSync(path.join(f.targetRoot, "README.md"), "# orders\n");
      return withRequiredEvidence(req, { outcome: { tokens: 1, cost: 0, result: "PASS" } });
    };
    expect((await b.decorate(inner)(engineerRequest)).outcome.failure_reason ?? "").not.toMatch(/writable Targets/);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-004")[0]!.guard_evidence.writable_roots).toEqual([f.targetRoot]);
  }, 30_000);
});
