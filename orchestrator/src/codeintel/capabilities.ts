import { AgentStage } from "../types.js";
import { CapabilityDeniedError, CodeIntelOperation } from "./provider.js";

/**
 * Who may ask the code-intelligence provider for anything.
 *
 * The matrix lives HERE, at rollout-config level, not in `contracts/*.yaml`:
 * contracts describe what a role writes and reads in a workspace; this is about
 * an optional tool the orchestrator may consult on a role's behalf.
 *
 * No-bypass is enforced one layer down: even an allowed role only ever sees
 * candidates whose paths survive the same permission/workspace-root filter every
 * other read goes through (resolver.ts). The matrix decides *whether to ask*;
 * it never widens *what may come back*.
 */

/** Roles the benchmark targets. Everyone else — BA, PM, setup, devops… — gets nothing. */
const ALLOWED_ROLES: readonly AgentStage[] = [
  AgentStage.SYSTEM_ANALYST,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
];

export function canUseCodeIntelligence(role: AgentStage): boolean {
  return ALLOWED_ROLES.includes(role);
}

/**
 * Throws rather than returning false: a denied query is a caller bug worth one
 * loud audit record, not a silent empty result someone might misread as "the
 * graph has no answer".
 */
export function assertOperationAllowed(role: AgentStage, operation: CodeIntelOperation): void {
  if (!canUseCodeIntelligence(role)) {
    throw new CapabilityDeniedError(`role "${role}" is not permitted to use code intelligence (${operation})`);
  }
}
