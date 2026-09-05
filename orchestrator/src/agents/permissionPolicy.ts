import { AgentStage } from "../types.js";
import { Permission } from "./permissions.js";
import { getAgent } from "./registry.js";

export class PermissionDeniedError extends Error {
  constructor(
    public readonly stage: AgentStage,
    public readonly permission: Permission,
  ) {
    super(`${stage} does not have permission "${permission}"`);
    this.name = "PermissionDeniedError";
  }
}

export function hasPermission(stage: AgentStage, permission: Permission): boolean {
  return getAgent(stage).permissions.includes(permission);
}

/**
 * The actual enforcement point: an orchestrator calls this before letting a
 * role perform a permission-gated action (deploy, write_code, ...). Bound to
 * the registry, so a role's permission list is defined in exactly one place.
 * Agents never call this on themselves — the point is that they can't grant
 * themselves a permission by deciding to.
 */
export function assertPermission(stage: AgentStage, permission: Permission): void {
  if (!hasPermission(stage, permission)) {
    throw new PermissionDeniedError(stage, permission);
  }
}
