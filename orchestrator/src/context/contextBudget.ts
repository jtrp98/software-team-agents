import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { checkBudget, DEFAULT_BUDGET } from "../cost/costControl.js";
import type { RunLog } from "../observability/runLog.js";

/** The complete, mutually-exclusive prompt accounting. */
export const CONTEXT_BUDGET_CLASSES = ["base", "task", "safety", "docs", "knowledge", "code", "tool_output", "reserve"] as const;
export type ContextBudgetClass = (typeof CONTEXT_BUDGET_CLASSES)[number];
export type ContextBudgetComposition = Record<ContextBudgetClass, number>;
export type ContextBudgetMode = "warn" | "reject";
export type BudgetRejectionType = "context_chars" | "estimated_tokens" | "task_tokens";

export interface BudgetRejection {
  budgetType: BudgetRejectionType;
  configuredLimit: number;
  measuredValue: number;
  overflow: number;
  reason: string;
  taskId: string;
  role: string;
  stage: string;
  runtime: string;
  model: string | null;
}

export interface ResolvedContextBudget {
  chars?: number;
  source?: "role" | "model_context_window";
  /** Optional additive estimate ceiling; character thresholds remain authoritative. */
  estimatedTokens?: number;
}

export interface ContextBudgetAssessment {
  contextChars: number;
  budgetChars: number | null;
  budgetSource: ResolvedContextBudget["source"] | null;
  overflowChars: number | null;
  /** Approximation from the measured character count, not a provider token count. */
  estimatedInputTokens: number;
  budgetEstimatedTokens: number | null;
  overflowEstimatedTokens: number | null;
  mode: ContextBudgetMode;
  rejected: boolean;
  warning: boolean | null;
}

/** Deterministic approximation shared by pre-spawn accounting and the benchmark. */
export function estimateInputTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

export function emptyContextBudgetComposition(): ContextBudgetComposition {
  return { base: 0, task: 0, safety: 0, docs: 0, knowledge: 0, code: 0, tool_output: 0, reserve: 0 };
}

/** Refuse misleading telemetry at the assembly boundary; every character has exactly one class. */
export function assertContextComposition(composition: ContextBudgetComposition, promptLength: number): void {
  for (const kind of CONTEXT_BUDGET_CLASSES) {
    const value = composition[kind];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`context composition ${kind} must be a non-negative integer (got ${value})`);
  }
  const accounted = CONTEXT_BUDGET_CLASSES.reduce((sum, kind) => sum + composition[kind], 0);
  if (accounted !== promptLength) throw new Error(`context composition invariant failed: ${accounted} accounted chars !== ${promptLength} prompt chars`);
}

/**
 * Resolve only declared project facts. Model aliases such as "opus" do not
 * themselves carry a stable, authoritative character limit.
 */
export function resolveContextBudget(config: StaConfig | null | undefined, role: string, model: string | undefined): ResolvedContextBudget | null {
  const configured = config?.context_budget;
  const roleBudget = configured?.roles?.[role];
  const estimatedTokens = configured?.max_context_estimated_tokens;
  if (roleBudget !== undefined) return { chars: roleBudget, source: "role", ...(estimatedTokens === undefined ? {} : { estimatedTokens }) };
  const modelWindow = model === undefined ? undefined : configured?.model_context_windows?.[model];
  if (modelWindow !== undefined) return { chars: modelWindow, source: "model_context_window", ...(estimatedTokens === undefined ? {} : { estimatedTokens }) };
  return estimatedTokens === undefined ? null : { estimatedTokens };
}

/** Missing/invalid optional configuration must not change a run's prompt behaviour. */
export function resolveContextBudgetFromProject(projectRoot: string, role: string, model: string | undefined): ResolvedContextBudget | null {
  try {
    return resolveContextBudget(loadStaConfig(projectRoot), role, model);
  } catch (error) {
    if (error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError) return null;
    throw error;
  }
}

/** Missing or invalid configuration preserves the pre-enforcement warning mode. */
export function resolveContextBudgetModeFromProject(projectRoot: string): ContextBudgetMode {
  try {
    return loadStaConfig(projectRoot).context_budget?.mode ?? "warn";
  } catch (error) {
    if (error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError) return "warn";
    throw error;
  }
}

/** Assessment never edits, drops, or otherwise changes a prompt. */
export function assessContextBudget(promptLength: number, composition: ContextBudgetComposition, budget: ResolvedContextBudget | null, mode: ContextBudgetMode = "warn"): ContextBudgetAssessment {
  assertContextComposition(composition, promptLength);
  const estimatedInputTokens = estimateInputTokens(promptLength);
  if (budget === null) return {
    contextChars: promptLength, budgetChars: null, budgetSource: null, overflowChars: null,
    estimatedInputTokens, budgetEstimatedTokens: null, overflowEstimatedTokens: null, mode, rejected: false, warning: null,
  };
  const overflowChars = budget.chars === undefined ? null : Math.max(0, promptLength - budget.chars);
  const overflowEstimatedTokens = budget.estimatedTokens === undefined ? null : Math.max(0, estimatedInputTokens - budget.estimatedTokens);
  return {
    contextChars: promptLength, budgetChars: budget.chars ?? null, budgetSource: budget.source ?? null, overflowChars,
    estimatedInputTokens, budgetEstimatedTokens: budget.estimatedTokens ?? null, overflowEstimatedTokens,
    mode,
    rejected: mode === "reject" && (overflowChars !== null && overflowChars > 0 || overflowEstimatedTokens !== null && overflowEstimatedTokens > 0),
    warning: overflowChars !== null && overflowChars > 0 || overflowEstimatedTokens !== null && overflowEstimatedTokens > 0,
  };
}

export function contextBudgetRejections(
  assessment: ContextBudgetAssessment,
  scope: Omit<BudgetRejection, "budgetType" | "configuredLimit" | "measuredValue" | "overflow" | "reason">,
): BudgetRejection[] {
  const reasons: BudgetRejection[] = [];
  if (assessment.overflowChars !== null && assessment.overflowChars > 0 && assessment.budgetChars !== null) {
    reasons.push({ ...scope, budgetType: "context_chars", configuredLimit: assessment.budgetChars, measuredValue: assessment.contextChars, overflow: assessment.overflowChars, reason: "assembled prompt exceeds configured character budget" });
  }
  if (assessment.overflowEstimatedTokens !== null && assessment.overflowEstimatedTokens > 0 && assessment.budgetEstimatedTokens !== null) {
    reasons.push({ ...scope, budgetType: "estimated_tokens", configuredLimit: assessment.budgetEstimatedTokens, measuredValue: assessment.estimatedInputTokens, overflow: assessment.overflowEstimatedTokens, reason: "estimated input tokens exceed configured context estimate budget" });
  }
  return reasons;
}

/** The UI string is intentionally a projection of the machine-readable reason. */
export function formatBudgetRejection(rejection: BudgetRejection): string {
  return `${rejection.budgetType} budget rejected task ${rejection.taskId}: ${rejection.measuredValue} > ${rejection.configuredLimit} (overflow=${rejection.overflow}); ${rejection.reason}; role=${rejection.role} stage=${rejection.stage} runtime=${rejection.runtime} model=${rejection.model ?? "not reported"}`;
}

/** Projects the next input estimate through the one canonical token-budget comparison. */
export function taskTokenBudgetRejection(projectRoot: string, log: RunLog, taskId: string, estimatedInputTokens: number, scope: Omit<BudgetRejection, "budgetType" | "configuredLimit" | "measuredValue" | "overflow" | "reason">): BudgetRejection | null {
  let configuredTokenBudget = DEFAULT_BUDGET.token_budget;
  try { configuredTokenBudget = loadStaConfig(projectRoot).token_budget ?? configuredTokenBudget; }
  catch (error) { if (!(error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError)) throw error; }
  const projectedTotal = log.totalTokens(taskId) + estimatedInputTokens;
  if (checkBudget(log, taskId, { ...DEFAULT_BUDGET, token_budget: configuredTokenBudget }, projectedTotal).withinBudget) return null;
  return { ...scope, budgetType: "task_tokens", configuredLimit: configuredTokenBudget, measuredValue: projectedTotal, overflow: Math.max(0, projectedTotal - configuredTokenBudget), reason: "projected task tokens exceed configured task budget" };
}
