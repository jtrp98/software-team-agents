import {
  UNIVERSAL_DENY,
  WORKSPACE_BA_ARTIFACTS,
  WORKSPACE_DEV_ARTIFACTS,
  pathRulesFor,
  readWorkspaceRole,
} from "../agents/pathPermissions.js";
import { ALL_EXIT_CHECKS, type RuntimeGuards } from "./runtimeAdapter.js";

/**
 * Turning a role's contract into the guard set a run is given (T108).
 *
 * The globs already exist in `contracts/<role>.yaml` and are already read by
 * `agents/pathPermissions.ts`; this only reshapes them into the runtime-facing
 * form, so there is still exactly one declaration of what a role may write.
 *
 * `forbidCommands` and `exitChecks` are constants rather than contract fields on
 * purpose. They are not per-role policy — no agent may run state-changing git
 * (`policies/git.md`), and no agent may hand off red code or a hardcoded secret
 * (`policies/coding.md` §5c, `policies/security.md` §5c-1). Making them
 * per-role configuration would invite a contract that switches one off.
 */

/** Commands no run may issue. `git` by name: read-only subcommands are allowed through by the guard's own logic, which is why this is a command name and not a pattern. */
export const FORBIDDEN_COMMANDS: readonly string[] = ["git"];

export class GuardResolutionError extends Error {
  constructor(role: string, cause: unknown) {
    super(
      `cannot resolve guards for role "${role}": ${String(cause)}. ` +
        `A run must not proceed with an unknown write scope — fix contracts/${role}.yaml or pass an explicit guard set.`,
    );
    this.name = "GuardResolutionError";
  }
}

/**
 * The guard set for a role, from its contract.
 *
 * Throws rather than degrading. An unresolvable contract could plausibly be
 * turned into an empty allow-list ("write nothing") or an absent one ("no
 * restriction"), and those are opposite behaviours — a guard that guesses
 * between them is worse than one that stops. Callers that genuinely want no
 * guards say so with `NO_GUARDS`.
 */
export function contractGuards(role: string, projectRoot: string): RuntimeGuards {
  let rules;
  try {
    rules = pathRulesFor(role, projectRoot);
  } catch (e) {
    throw new GuardResolutionError(role, e);
  }
  const wsRole = readWorkspaceRole(projectRoot);
  const workspaceDeny =
    wsRole === "dev"
      ? WORKSPACE_BA_ARTIFACTS
      : wsRole === "ba"
        ? WORKSPACE_DEV_ARTIFACTS
        : [];
  return {
    writeAllow: rules.write,
    // The role's own deny list plus the floor and workspace-role deny rules.
    // Concatenated rather than replaced: the floor holds whatever a contract
    // says, which is the whole reason it is called a floor.
    writeDeny: [...UNIVERSAL_DENY, ...workspaceDeny, ...rules.deny],
    forbidCommands: FORBIDDEN_COMMANDS,
    exitChecks: ALL_EXIT_CHECKS,
  };
}

/** `contractGuards` curried per role, the shape `createRuntimeExecutor` wants. */
export function contractGuardResolver(projectRoot: string): (role: string) => RuntimeGuards {
  return (role) => contractGuards(role, projectRoot);
}
