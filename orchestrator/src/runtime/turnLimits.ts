import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";

/**
 * Runaway-loop ceilings on model turns for one orchestrated stage.
 *
 * In Claude Code's `--max-turns`, a "turn" is one assistant response — in
 * practice one tool-call round. These are *runaway* guards, not efficiency
 * targets: every turn re-sends the conversation, so an agent stuck in a
 * read/retry loop multiplies its whole context by the turn count. The values
 * are set well above what a bounded, successful stage uses (a BA/SA amend with
 * section-level retrieval is typically 15-40 tool rounds; an engineer
 * implementing a task with tests commonly 60-120), because a limit that ends
 * legitimate work mid-edit is worse than the cost it saves. Single-digit
 * limits (4-10) would end almost every real stage before its first write.
 *
 * Projects tighten or relax them in `.sta/config.yaml`:
 *
 *     max_turns:
 *       default: 120          # any role not listed below
 *       roles:
 *         system-analyst: 40
 *         backend-engineer: 0 # 0 = no limit for this role
 */
export const DEFAULT_MAX_TURNS_BY_ROLE: Readonly<Record<string, number>> = Object.freeze({
  "business-analyst": 60,
  "system-analyst": 80,
  "project-manager": 60,
  "test-planner": 50,
  "uxui-designer": 50,
  reviewer: 80,
  security: 80,
  "qa-engineer": 120,
  "backend-engineer": 200,
  "frontend-engineer": 200,
  setup: 150,
  devops: 120,
});

/** A role the table does not name (a new role, a direct `sta execute` run). */
export const DEFAULT_MAX_TURNS = 150;

/** `undefined` = no limit (explicit 0). */
export function resolveMaxTurns(config: StaConfig | null | undefined, role: string | undefined): number | undefined {
  const configured = config?.max_turns;
  const roleValue = role === undefined ? undefined : configured?.roles?.[role];
  const value = roleValue ?? configured?.default ?? (role === undefined ? undefined : DEFAULT_MAX_TURNS_BY_ROLE[role]) ?? DEFAULT_MAX_TURNS;
  return value === 0 ? undefined : value;
}

/** Missing/invalid optional configuration keeps the defaults — a broken config never removes the guard. */
export function resolveMaxTurnsFromProject(projectRoot: string, role: string | undefined): number | undefined {
  try {
    return resolveMaxTurns(loadStaConfig(projectRoot), role);
  } catch (error) {
    if (error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError) return resolveMaxTurns(null, role);
    throw error;
  }
}
