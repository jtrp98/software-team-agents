import {
  UNIVERSAL_DENY,
  WORKSPACE_BA_ARTIFACTS,
  FRAMEWORK_PAYLOAD_ARTIFACTS,
  deniesKnowledgeArtifacts,
  pathRulesFor,
  targetPathRules,
} from "../agents/pathPermissions.js";
import { ALL_EXIT_CHECKS, type RuntimeGuards } from "./runtimeAdapter.js";

/**
 * Turning a role's contract into the guard set a run is given.
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

/** Which side of the three-repo split a stage's write scope comes from. */
export interface GuardScope {
  /** The stage writes a bound Target checkout, so the Target is the scope. */
  targetSide?: boolean;
}

export type GuardResolver = (role: string, layoutRoot?: string, scope?: GuardScope) => RuntimeGuards;

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
export function contractGuards(
  role: string,
  projectRoot: string,
  layoutRoot: string = projectRoot,
  scope?: GuardScope,
): RuntimeGuards {
  let rules;
  try {
    rules = scope?.targetSide ? targetPathRules(role, projectRoot, layoutRoot) : pathRulesFor(role, projectRoot, layoutRoot);
  } catch (e) {
    throw new GuardResolutionError(role, e);
  }
  // Which repository a stage was launched from decides nothing here: an
  // implementation stage may not write a Knowledge artifact, and after the lane
  // collapse there is no workspace role left to carry that ban (V10 TASK-012).
  const knowledgeDeny = deniesKnowledgeArtifacts(role) ? WORKSPACE_BA_ARTIFACTS : [];
  return {
    writeAllow: rules.write,
    // The role's own deny list plus the floor and the Framework-payload ban.
    // Concatenated rather than replaced: the floor holds whatever a contract
    // says, which is the whole reason it is called a floor.
    writeDeny: [...new Set([...UNIVERSAL_DENY, ...FRAMEWORK_PAYLOAD_ARTIFACTS, ...knowledgeDeny, ...rules.deny])],
    forbidCommands: FORBIDDEN_COMMANDS,
    exitChecks: ALL_EXIT_CHECKS,
  };
}

/** `contractGuards` curried per role, the shape `createRuntimeExecutor` wants. */
export function contractGuardResolver(projectRoot: string): GuardResolver {
  return (role, layoutRoot, scope) => contractGuards(role, projectRoot, layoutRoot, scope);
}
