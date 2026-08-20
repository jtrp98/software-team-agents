import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { validateStructuredFailure, type StructuredFailure } from "../orchestrator/failure.js";
import { MAX_RETRY, initTaskRun, recordFailure, type TaskRun } from "../retry/retryPolicy.js";
import { decideRecovery } from "../retry/recoveryPolicy.js";
import { transition } from "../state/taskState.js";
import {
  DEFAULT_ESCALATION_POLICY,
  EscalationPolicyError,
  assertEscalationPolicy,
  checkEscalationPolicy,
  effectiveMaxRetry,
  escalationPolicyPath,
  loadEscalationPolicy,
  policyFor,
  type EscalationPolicy,
} from "./escalationPolicy.js";

const PIPELINE = [
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
];

function failure(over: Partial<StructuredFailure> = {}): StructuredFailure {
  return validateStructuredFailure({
    category: "implementation",
    owner: AgentStage.BACKEND_ENGINEER,
    severity: "high",
    retryable: true,
    reason: "API response mismatch",
    affected: ["BE-004"],
    requiresHuman: false,
    ...over,
  });
}

/** Walks a fresh run forward to QA, then records `failures` QA rounds — the ordinary shape. */
function runAtFailedQa(failures = 1): TaskRun {
  let run = initTaskRun(PIPELINE, false);
  for (const state of [TaskState.REQUIREMENT, TaskState.DESIGN, TaskState.IMPLEMENTATION, TaskState.QA]) {
    run = { ...run, machine: transition(run.machine, state) };
  }
  for (let i = 0; i < failures; i++) {
    run = recordFailure(run, "qa");
    if (run.machine.current === TaskState.IMPLEMENTATION) {
      run = { ...run, machine: transition(run.machine, TaskState.QA) };
    }
  }
  return run;
}

function decide(over: Partial<Parameters<typeof decideRecovery>[0]> = {}) {
  return decideRecovery({
    failure: failure(),
    kind: "qa",
    run: runAtFailedQa(),
    pipeline: PIPELINE,
    currentState: TaskState.QA,
    ...over,
  });
}

const tempDirs: string[] = [];
function tempProject(policy: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-escalation-"));
  tempDirs.push(dir);
  if (policy !== undefined) {
    fs.writeFileSync(escalationPolicyPath(dir), JSON.stringify(policy), "utf8"); // JSON is valid YAML
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("policyFor / effectiveMaxRetry (T40)", () => {
  it("gives each severity the treatment the policy declares", () => {
    expect(policyFor("low").autonomous).toBe(true);
    expect(policyFor("critical").autonomous).toBe(false);
    expect(policyFor("critical").stop_pipeline).toBe(true);
    expect(policyFor("high").approval).toBe(true);
  });

  it("treats an unknown severity as high, not as low", () => {
    // Only ever asked about something that already failed: not knowing how bad it
    // is must not buy the most permissive treatment available.
    expect(policyFor(undefined)).toEqual(DEFAULT_ESCALATION_POLICY.severity.high);
  });

  it("never lets a severity buy more rounds than the global budget", () => {
    const greedy: EscalationPolicy = {
      version: 1,
      severity: {
        ...DEFAULT_ESCALATION_POLICY.severity,
        low: { autonomous: true, max_retry: 99, approval: false, stop_pipeline: false },
      },
    };
    expect(effectiveMaxRetry("low", greedy)).toBe(MAX_RETRY);
  });

  it("gives a blocking issue two rounds, matching the ceiling the rest of the repo already uses", () => {
    expect(effectiveMaxRetry("high")).toBe(2);
  });
});

describe("decideRecovery honours the severity policy (T40)", () => {
  it("stops a critical failure outright, without a single automatic round", () => {
    const action = decide({ failure: failure({ severity: "critical" }), run: runAtFailedQa(1) });
    expect(action.kind).toBe("ESCALATE");
    expect(action.reason).toContain("stops the pipeline");
  });

  it("escalates rather than aborting, so a person's answer can still restart the task", () => {
    // ABORT is reserved for a spent global budget — the difference is what tells a
    // person whether they are being asked a question or told the task is over.
    const action = decide({ failure: failure({ severity: "critical" }) });
    expect(action.kind).not.toBe("ABORT");
  });

  it("still retries a high-severity failure on its first and second rounds", () => {
    expect(decide({ run: runAtFailedQa(1) }).kind).toBe("RETRY");
    expect(decide({ run: runAtFailedQa(2) }).kind).toBe("RETRY");
  });

  it("escalates a high-severity failure on the third round, before the global budget is spent", () => {
    const action = decide({ run: runAtFailedQa(3) });
    expect(action.kind).toBe("ESCALATE");
    expect(action.reason).toContain("at most 2 automatic round(s)");
    // The global budget still had a round left — this stop comes from the severity, not the budget.
    expect(MAX_RETRY).toBeGreaterThan(2);
  });

  it("gives a medium-severity failure the fuller budget a non-blocking issue deserves", () => {
    const action = decide({ failure: failure({ severity: "medium" }), run: runAtFailedQa(3) });
    expect(action.kind).toBe("RETRY");
  });

  it("reports the ceiling that actually applies, not the global one", () => {
    const action = decide();
    expect(action.kind).toBe("RETRY");
    if (action.kind === "RETRY") expect(action.max).toBe(2);
  });

  it("lets the global budget still outrank the severity policy", () => {
    const action = decide({ failure: failure({ severity: "low" }), run: runAtFailedQa(MAX_RETRY + 1) });
    expect(action.kind).toBe("ABORT");
  });

  it("takes an alternative policy, so the rules are data rather than code", () => {
    const strict: EscalationPolicy = {
      version: 1,
      severity: {
        ...DEFAULT_ESCALATION_POLICY.severity,
        high: { autonomous: false, max_retry: 0, approval: true, stop_pipeline: false },
      },
    };
    const action = decide({ escalation: strict });
    expect(action.kind).toBe("ESCALATE");
    expect(action.reason).toContain("never handled autonomously");
  });

  it("changes nothing when the round reported no structured failure", () => {
    // No failure means no severity to apply a policy to — the pre-T06 fallback stands.
    const action = decide({ failure: undefined });
    expect(action.kind).toBe("RETRY");
    if (action.kind === "RETRY") expect(action.max).toBe(MAX_RETRY);
  });
});

describe("checkEscalationPolicy", () => {
  it("passes against this repo's own file, and notes the severity that never retries", () => {
    const result = checkEscalationPolicy();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.includes("critical"))).toBe(true);
  });

  it("this repo's file loads and matches the runtime values field for field", () => {
    const file = loadEscalationPolicy();
    for (const severity of ["low", "medium", "high", "critical"] as const) {
      const { why, ...declared } = file.severity[severity];
      expect(declared).toEqual(DEFAULT_ESCALATION_POLICY.severity[severity]);
      expect(why).toBeTruthy();
    }
  });

  it("fails when the file documents a rule the runtime does not follow", () => {
    const dir = tempProject({
      version: 1,
      severity: {
        ...DEFAULT_ESCALATION_POLICY.severity,
        high: { autonomous: true, max_retry: 3, approval: true, stop_pipeline: false, why: "drifted" },
        low: { ...DEFAULT_ESCALATION_POLICY.severity.low, why: "x" },
        medium: { ...DEFAULT_ESCALATION_POLICY.severity.medium, why: "x" },
        critical: { ...DEFAULT_ESCALATION_POLICY.severity.critical, why: "x" },
      },
    });
    const result = checkEscalationPolicy(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("the file documents a rule the code does not follow");
  });

  it("fails a severity with no stated reason", () => {
    const dir = tempProject({
      version: 1,
      severity: {
        low: { ...DEFAULT_ESCALATION_POLICY.severity.low, why: "x" },
        medium: { ...DEFAULT_ESCALATION_POLICY.severity.medium, why: "x" },
        high: { ...DEFAULT_ESCALATION_POLICY.severity.high, why: "x" },
        critical: DEFAULT_ESCALATION_POLICY.severity.critical, // no `why`
      },
    });
    const result = checkEscalationPolicy(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("no `why`");
  });

  it("fails a file missing a severity outright, rather than defaulting it", () => {
    const dir = tempProject({ version: 1, severity: { low: DEFAULT_ESCALATION_POLICY.severity.low } });
    const result = checkEscalationPolicy(dir);
    expect(result.ok).toBe(false);
  });

  it("fails when there is no file at all", () => {
    const dir = tempProject(undefined);
    expect(checkEscalationPolicy(dir).problems.join("\n")).toContain("no file at");
    expect(() => loadEscalationPolicy(dir)).toThrow(EscalationPolicyError);
  });

  it("assertEscalationPolicy passes for this repo", () => {
    expect(() => assertEscalationPolicy()).not.toThrow();
  });
});
