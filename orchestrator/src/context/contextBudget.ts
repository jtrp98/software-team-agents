import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";

/** The complete, mutually-exclusive prompt accounting used by T-V3TOK-100. */
export const CONTEXT_BUDGET_CLASSES = ["base", "task", "safety", "docs", "knowledge", "code", "tool_output", "reserve"] as const;
export type ContextBudgetClass = (typeof CONTEXT_BUDGET_CLASSES)[number];
export type ContextBudgetComposition = Record<ContextBudgetClass, number>;

export interface ResolvedContextBudget {
  chars: number;
  source: "role" | "model_context_window";
}

export interface ContextBudgetAssessment {
  contextChars: number;
  budgetChars: number | null;
  budgetSource: ResolvedContextBudget["source"] | null;
  overflowChars: number | null;
  warning: boolean | null;
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
  if (roleBudget !== undefined) return { chars: roleBudget, source: "role" };
  const modelWindow = model === undefined ? undefined : configured?.model_context_windows?.[model];
  return modelWindow === undefined ? null : { chars: modelWindow, source: "model_context_window" };
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

/** Warning-mode assessment only: it never edits, drops, rejects, or otherwise changes a prompt. */
export function assessContextBudget(promptLength: number, composition: ContextBudgetComposition, budget: ResolvedContextBudget | null): ContextBudgetAssessment {
  assertContextComposition(composition, promptLength);
  if (budget === null) return { contextChars: promptLength, budgetChars: null, budgetSource: null, overflowChars: null, warning: null };
  const overflowChars = Math.max(0, promptLength - budget.chars);
  return { contextChars: promptLength, budgetChars: budget.chars, budgetSource: budget.source, overflowChars, warning: overflowChars > 0 };
}
