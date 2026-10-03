import { z } from "zod";
import { classifyRuntimeResult, isFallbackClass, type RuntimeFailureClass } from "../runtime/runtimeFailureClass.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import type { Language, MachineConfig } from "./machineConfig.js";
import type { RuntimeHealthStore } from "./runtimeHealth.js";
import { selectRuntime, type RouteAttempt, type RouteInputs } from "./runtimeRouter.js";
import type { BoundedRunProjection } from "./engineProjection.js";
import type { Handoff, WorkRun } from "./workRunStore.js";

/**
 * The Commander — a ROLE that reasons about a run, filled by whichever pool
 * runtime the commander route selects (Claude Code first by default, never by
 * necessity). It reads a compact, Knowledge-pinned view of the run and
 * answers with one JSON decision from a closed set.
 *
 * It holds no authority. STA Core spawns it (in a child process), STA Core
 * decides whether the advice is admissible against deterministic facts (an
 * engine gate always outranks "continue"; "ready for review" needs the QA
 * boundary actually reached), and STA Core owns every consequence. If the
 * commander runtime runs out of quota mid-run, the Core moves the role to the
 * next runtime with a structured handoff — the run itself never depended on
 * that process.
 */

export const COMMANDER_DECISIONS = {
  start: ["proceed", "hold_for_human"],
  assess: ["ready_for_review", "continue", "hold_for_human"],
} as const;
export type CommanderPhase = keyof typeof COMMANDER_DECISIONS;

const DecisionSchema = z.object({
  decision: z.string().min(1),
  summary: z.string().max(2000).default(""),
  risks: z.array(z.string().max(500)).max(10).default([]),
});
export type CommanderDecision = z.infer<typeof DecisionSchema>;

export interface CommanderContext {
  knowledge: string;
  module: string;
  phase: CommanderPhase;
  scope: WorkRun["scope"];
  boundary: string;
  tasks: Array<{ taskId: string; status: string; stage: string | null; reason: string }>;
  lastSegment: { exitCode: number | null; outcome: string | null } | null;
  openGates: string[];
  recentHandoff: Handoff | null;
  verification: BoundedRunProjection["verification"] | null;
}

/**
 * Built only from the run's own record and its own Knowledge root's
 * projection — nothing here can reach another run or another root.
 */
export function buildCommanderContext(run: WorkRun, phase: CommanderPhase, projection: BoundedRunProjection | null): CommanderContext {
  const last = run.segments.at(-1) ?? null;
  return {
    knowledge: run.knowledge.name,
    module: run.module,
    phase,
    scope: run.scope,
    boundary: run.boundary,
    tasks: (projection?.tasks ?? []).map((task) => ({ taskId: task.taskId, status: task.status, stage: task.stage, reason: task.reason.slice(0, 300) })),
    lastSegment: last ? { exitCode: last.exitCode, outcome: last.outcome } : null,
    openGates: run.humanGates.filter((gate) => gate.resolvedAt === null).map((gate) => `${gate.kind}: ${gate.reason}`.slice(0, 300)),
    recentHandoff: run.handoffs.at(-1) ?? null,
    verification: projection?.verification ?? null,
  };
}

export function commanderPrompt(context: CommanderContext, language: Language): string {
  const allowed = COMMANDER_DECISIONS[context.phase];
  return [
    "You are the Commander role of STA, a deterministic software-delivery orchestrator.",
    "STA Core owns state, processes, permissions and every action. You only advise. Do not edit files, run commands, or call tools.",
    `Knowledge root: ${context.knowledge} (the only Knowledge in scope). Module: ${context.module}.`,
    context.phase === "start"
      ? "Phase: START — assess whether this run should proceed to work its ready tasks until the QA boundary."
      : "Phase: ASSESS — the last work segment ended; assess the result.",
    `Allowed decisions: ${allowed.join(", ")}. push, merge and deploy are never possible.`,
    `Write "summary" in ${language === "th" ? "Thai" : "English"}; keep identifiers, paths and commands verbatim.`,
    "Answer with ONLY one JSON object: {\"decision\": string, \"summary\": string, \"risks\": string[]}.",
    "Run state (JSON):",
    JSON.stringify(context),
  ].join("\n");
}

export function parseCommanderDecision(text: string, phase: CommanderPhase): CommanderDecision {
  const trimmed = text.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (!fenced) throw new Error("commander did not answer with JSON");
    raw = JSON.parse(fenced[1]!);
  }
  const parsed = DecisionSchema.parse(raw);
  if (!(COMMANDER_DECISIONS[phase] as readonly string[]).includes(parsed.decision)) {
    throw new Error(`commander decision "${parsed.decision}" is not one of ${COMMANDER_DECISIONS[phase].join(", ")}`);
  }
  return parsed;
}

/** What the Core may accept, given the deterministic outcome. The more conservative answer always wins. */
export function admitCommanderDecision(
  decision: CommanderDecision,
  facts: { phase: CommanderPhase; boundaryReached: boolean; engineWaiting: boolean },
): { accepted: boolean; note?: string } {
  if (decision.decision === "hold_for_human") return { accepted: true };
  if (facts.phase === "start") return { accepted: decision.decision === "proceed" };
  if (facts.engineWaiting) return { accepted: false, note: "the engine is waiting at a human gate; a commander cannot continue past it" };
  if (decision.decision === "ready_for_review" && !facts.boundaryReached) return { accepted: false, note: "the QA boundary was not reached; not ready for review" };
  if (decision.decision === "continue" && facts.boundaryReached) return { accepted: false, note: "the QA boundary is reached; the run stops for a person" };
  return { accepted: true };
}

export interface CommanderInvocation {
  runtimeId: string;
  prompt: string;
  cwd: string;
  runId: string;
}

/** Runs one commander prompt on one runtime, out of the service's event loop. */
export interface CommanderInvoker {
  invoke(request: CommanderInvocation): Promise<Pick<RuntimeAgentResult, "status" | "text" | "failureClass" | "retryAt" | "diagnostics">>;
}

export interface CommanderOutcome {
  runtimeId: string | null;
  decision: CommanderDecision | null;
  /** Every runtime tried in order, with why it was skipped or failed. */
  attempts: Array<RouteAttempt | { runtimeId: string; outcome: "failed"; reason: string; failureClass: RuntimeFailureClass | null }>;
  fallbacks: Array<{ from: string; to: string | null; failureClass: string; reason: string }>;
  exhausted: boolean;
  recoverable: boolean;
  recoverAt: number | null;
  error?: string;
}

/**
 * Commander failover: walk the commander route, recording a provider failure
 * into runtime health and moving to the next runtime; stop on the first
 * answer. A work failure (bad JSON, an error) does not hop — it is reported,
 * and the Core continues on its deterministic default.
 */
export async function runCommander(input: {
  run: WorkRun;
  phase: CommanderPhase;
  projection: BoundedRunProjection | null;
  config: MachineConfig;
  health: RuntimeHealthStore;
  invoker: CommanderInvoker;
  extraUnavailable?: Record<string, string>;
  eligibility?: RouteInputs["eligibility"];
}): Promise<CommanderOutcome> {
  const attempts: CommanderOutcome["attempts"] = [];
  const fallbacks: CommanderOutcome["fallbacks"] = [];
  const exclude = new Set<string>();
  const prompt = commanderPrompt(buildCommanderContext(input.run, input.phase, input.projection), input.config.language);
  let previousFailure: { from: string; failureClass: string; reason: string } | null = null;
  for (;;) {
    const route = selectRuntime("commander", {
      config: input.config,
      health: input.health.snapshot(input.config.commander.order),
      exclude,
      extraUnavailable: input.extraUnavailable,
      eligibility: input.eligibility,
    });
    if (!route.selected) {
      if (previousFailure) fallbacks.push({ ...previousFailure, to: null });
      // Runtimes tried in this walk were excluded, not cooled: the auto-resume
      // time is the earliest cooldown end anywhere on the commander route.
      const recoverAt = route.recoverAt ?? input.health.earliestRecovery(input.config.commander.order);
      return { runtimeId: null, decision: null, attempts: [...attempts, ...route.attempts.filter((a) => !exclude.has(a.runtimeId))], fallbacks, exhausted: true, recoverable: route.recoverable, recoverAt };
    }
    if (previousFailure) fallbacks.push({ ...previousFailure, to: route.selected });
    previousFailure = null;
    const runtimeId = route.selected;
    const result = await input.invoker.invoke({ runtimeId, prompt, cwd: input.run.knowledge.path, runId: input.run.runId });
    const failureClass = classifyRuntimeResult(result);
    if (result.status === "OK") {
      input.health.recordSuccess(runtimeId, { runId: input.run.runId, role: "commander" });
      try {
        const decision = parseCommanderDecision(result.text, input.phase);
        attempts.push({ runtimeId, outcome: "selected", reason: "answered" });
        return { runtimeId, decision, attempts, fallbacks, exhausted: false, recoverable: true, recoverAt: null };
      } catch (error) {
        attempts.push({ runtimeId, outcome: "failed", reason: String(error), failureClass: "TASK_FAILURE" });
        return { runtimeId, decision: null, attempts, fallbacks, exhausted: false, recoverable: true, recoverAt: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const reason = result.diagnostics.join("; ").slice(0, 500) || result.status;
    input.health.recordFailure({ runtimeId, failureClass: failureClass ?? "EXECUTION_ERROR", reason, ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}), runId: input.run.runId, role: "commander" });
    attempts.push({ runtimeId, outcome: "failed", reason, failureClass });
    exclude.add(runtimeId);
    if (failureClass && (isFallbackClass(failureClass) || failureClass === "TIMEOUT")) {
      previousFailure = { from: runtimeId, failureClass, reason };
      continue;
    }
    return { runtimeId, decision: null, attempts, fallbacks, exhausted: false, recoverable: true, recoverAt: null, error: reason };
  }
}
