import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { checkBudget, DEFAULT_BUDGET } from "../cost/costControl.js";
import type { RunLog } from "../observability/runLog.js";

/** The complete, mutually-exclusive prompt accounting. */
export const CONTEXT_BUDGET_CLASSES = ["base", "task", "safety", "docs", "knowledge", "code", "tool_output", "reserve"] as const;
export type ContextBudgetClass = (typeof CONTEXT_BUDGET_CLASSES)[number];
export type ContextBudgetComposition = Record<ContextBudgetClass, number>;
export type ContextBudgetMode = "warn" | "reject";
export type BudgetRejectionType = "context_chars" | "estimated_tokens" | "task_tokens" | "hard_ceiling";

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
  /** What made the context this large, largest first — present on hard-ceiling rejections. */
  contributors?: string;
  /** What to change so the stage fits — present on hard-ceiling rejections. */
  recommendation?: string;
}

/**
 * Catastrophe ceiling on the effective initial context, enforced in both
 * budget modes. At ~100k estimated tokens before the first model turn, every
 * later turn re-sends at least that much again; no stage in this pipeline
 * needs it, so this is the "fail before invoking the model" floor. A project
 * sets `context_budget.hard_max_estimated_tokens` (0 disables it).
 */
export const DEFAULT_HARD_MAX_ESTIMATED_TOKENS = 100_000;

export interface ResolvedContextBudget {
  chars?: number;
  source?: "role" | "model_context_window";
  /** Optional additive estimate ceiling; character thresholds remain authoritative. */
  estimatedTokens?: number;
}

export interface ContextBudgetAssessment {
  /**
   * The *effective* initial context: the assembled prompt plus the always-on
   * instructions the runtime injects on its own (`alwaysOnChars`). Equal to
   * `promptChars` when no always-on size was measured.
   */
  contextChars: number;
  /** The assembled prompt/execution packet alone — what `composition` accounts for. */
  promptChars: number;
  /** Always-on instruction chars (CLAUDE.md + role definition) the runtime loads outside the prompt; 0 when unmeasured. */
  alwaysOnChars: number;
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

/**
 * Assessment never edits, drops, or otherwise changes a prompt.
 *
 * Budgets are compared against the effective initial context:
 * `promptLength + alwaysOnChars`. The prompt's `composition` still has to
 * account for exactly `promptLength` — always-on instructions are never part
 * of the prompt the framework sends, so adding them here cannot double-count.
 */
export function assessContextBudget(
  promptLength: number,
  composition: ContextBudgetComposition,
  budget: ResolvedContextBudget | null,
  mode: ContextBudgetMode = "warn",
  alwaysOnChars = 0,
): ContextBudgetAssessment {
  assertContextComposition(composition, promptLength);
  if (!Number.isSafeInteger(alwaysOnChars) || alwaysOnChars < 0) throw new Error(`always-on instruction chars must be a non-negative integer (got ${alwaysOnChars})`);
  const effective = promptLength + alwaysOnChars;
  const estimatedInputTokens = estimateInputTokens(effective);
  if (budget === null) return {
    contextChars: effective, promptChars: promptLength, alwaysOnChars, budgetChars: null, budgetSource: null, overflowChars: null,
    estimatedInputTokens, budgetEstimatedTokens: null, overflowEstimatedTokens: null, mode, rejected: false, warning: null,
  };
  const overflowChars = budget.chars === undefined ? null : Math.max(0, effective - budget.chars);
  const overflowEstimatedTokens = budget.estimatedTokens === undefined ? null : Math.max(0, estimatedInputTokens - budget.estimatedTokens);
  return {
    contextChars: effective, promptChars: promptLength, alwaysOnChars, budgetChars: budget.chars ?? null, budgetSource: budget.source ?? null, overflowChars,
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
    reasons.push({ ...scope, budgetType: "context_chars", configuredLimit: assessment.budgetChars, measuredValue: assessment.contextChars, overflow: assessment.overflowChars, reason: assessment.alwaysOnChars > 0 ? "effective initial context (packet + always-on instructions) exceeds configured character budget" : "assembled prompt exceeds configured character budget" });
  }
  if (assessment.overflowEstimatedTokens !== null && assessment.overflowEstimatedTokens > 0 && assessment.budgetEstimatedTokens !== null) {
    reasons.push({ ...scope, budgetType: "estimated_tokens", configuredLimit: assessment.budgetEstimatedTokens, measuredValue: assessment.estimatedInputTokens, overflow: assessment.overflowEstimatedTokens, reason: "estimated input tokens exceed configured context estimate budget" });
  }
  return reasons;
}

/** The UI string is intentionally a projection of the machine-readable reason. */
export function formatBudgetRejection(rejection: BudgetRejection): string {
  return `${rejection.budgetType} budget rejected task ${rejection.taskId}: ${rejection.measuredValue} > ${rejection.configuredLimit} (overflow=${rejection.overflow}); ${rejection.reason}; role=${rejection.role} stage=${rejection.stage} runtime=${rejection.runtime} model=${rejection.model ?? "not reported"}` +
    (rejection.contributors ? `; contributors: ${rejection.contributors}` : "") +
    (rejection.recommendation ? `; recommended: ${rejection.recommendation}` : "");
}

/** `0` disables; missing/invalid configuration keeps the default ceiling. */
export function resolveHardContextCeiling(config: StaConfig | null | undefined): number | null {
  const configured = config?.context_budget?.hard_max_estimated_tokens;
  if (configured === 0) return null;
  return configured ?? DEFAULT_HARD_MAX_ESTIMATED_TOKENS;
}

export function resolveHardContextCeilingFromProject(projectRoot: string): number | null {
  try {
    return resolveHardContextCeiling(loadStaConfig(projectRoot));
  } catch (error) {
    if (error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError) return DEFAULT_HARD_MAX_ESTIMATED_TOKENS;
    throw error;
  }
}

const COMPOSITION_LABEL: Record<ContextBudgetClass, string> = {
  base: "framework base text", task: "task packet", safety: "safety/gates", docs: "module documents",
  knowledge: "knowledge brief", code: "code-intel", tool_output: "prior tool output", reserve: "reserve",
};

/**
 * The hard ceiling as a rejection, with the contributors a person needs to
 * act on it. Null when the ceiling is disabled or the context fits.
 */
export function hardCeilingRejection(
  assessment: ContextBudgetAssessment,
  composition: ContextBudgetComposition,
  ceiling: number | null,
  scope: Omit<BudgetRejection, "budgetType" | "configuredLimit" | "measuredValue" | "overflow" | "reason">,
): BudgetRejection | null {
  if (ceiling === null || assessment.estimatedInputTokens <= ceiling) return null;
  const parts: [string, number][] = [
    ...CONTEXT_BUDGET_CLASSES.map((kind): [string, number] => [COMPOSITION_LABEL[kind], composition[kind]]),
    ["always-on instructions (CLAUDE.md + role definition)", assessment.alwaysOnChars],
  ];
  const contributors = parts
    .filter(([, chars]) => chars > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, chars]) => `${label} ${chars} chars (~${estimateInputTokens(chars)} tokens est.)`)
    .join(", ");
  const docsHeavy = composition.docs + composition.knowledge + composition.code + composition.task > assessment.contextChars / 2;
  return {
    ...scope,
    budgetType: "hard_ceiling",
    configuredLimit: ceiling,
    measuredValue: assessment.estimatedInputTokens,
    overflow: assessment.estimatedInputTokens - ceiling,
    reason: `effective initial context (${assessment.promptChars} packet chars + ${assessment.alwaysOnChars} always-on chars) is estimated above the hard ceiling before the first model turn`,
    contributors,
    recommendation: docsHeavy
      ? "narrow the task's selected REQ/DES references or archive closed design/requirement material (policies/documentation.md §4) so the packet carries sections, not documents; large documents are read by bounded ranges (§10a)"
      : "shrink the task packet or the always-on instructions; raise context_budget.hard_max_estimated_tokens only if this size is genuinely required (0 disables)",
  };
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
