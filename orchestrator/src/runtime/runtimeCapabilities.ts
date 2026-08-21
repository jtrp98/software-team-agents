/**
 * What a runtime is able to do (T108).
 *
 * A closed enum, for the same reason `agents/capabilities.ts` is one: a
 * capability exists to be *matched*, and free text cannot be matched — `hooks`,
 * `hook support` and `pre-tool-hook` would be three names for one fact, and a
 * typo would read as "this runtime can't do it".
 *
 * WHAT THIS SET IS FOR, AND WHAT IT IS NOT FOR
 *
 * It is deliberately much shorter than the first T108 draft. That draft assumed
 * the two runtimes this framework targets would differ widely, so it enumerated
 * every axis they might differ on. They don't: Claude Code and Codex both have
 * project-level guard wiring, pre/post tool interception, stop hooks, named
 * agents and model selection. A capability nothing ever branches on is not
 * documentation, it is a value that can go stale without anyone noticing.
 *
 * So every member below earns its place one of two ways:
 *
 *   1. Something branches on it (`PER_AGENT_EXIT_GUARD`, `COST_REPORTING`,
 *      `INTERACTIVE_PROMPTS`).
 *   2. T111 validates it against the real installation and must fail loudly
 *      when the installed version doesn't have it.
 *
 * The second reason is why this set survives despite the parity: parity is a
 * fact about the *products*, not about the *version installed here*. Both known
 * gaps at the time of writing are version-dependent — `apply_patch` not firing
 * `PostToolUse` on some Codex builds, and hooks reportedly not dispatching under
 * `codex exec` on some builds. `codex exec` is exactly what the orchestrator's
 * autonomous mode uses, so "this runtime can intercept tool calls" is a claim
 * that has to be checked per installation, not read off a compatibility table.
 */
export enum RuntimeCapability {
  /**
   * Can load a role's agent definition by name/path from the project's own
   * binding, instead of needing the prompt passed inline on every run.
   */
  NAMED_AGENTS = "named-agents",
  /** The caller can choose the model per run, rather than taking the runtime's configured default. */
  MODEL_SELECTION = "model-selection",
  /** Can inspect a tool call *before* it runs and refuse it. What `writeDeny`/`forbidCommands` need to be enforcement rather than instruction. */
  PRE_TOOL_GUARD = "pre-tool-guard",
  /** Can inspect a tool call after it ran. Weaker than PRE_TOOL_GUARD — it catches, it does not prevent. */
  POST_TOOL_GUARD = "post-tool-guard",
  /** Can refuse to let a run *finish* — where `exitChecks` (typecheck green, no leaked secret) are enforced. */
  EXIT_GUARD = "exit-guard",
  /**
   * EXIT_GUARD that fires per agent, not only per session.
   *
   * Split from EXIT_GUARD because it is the one place the two runtimes are
   * known to differ in a way that changes behaviour. This framework wires its
   * two exit checks to Claude Code's `Stop` *and* `SubagentStop`, because the
   * rule is "this engineer must not hand off red code" — not "the session must
   * not end red". Codex's documented event list has `Stop` with no subagent
   * counterpart. Under the orchestrator that difference is invisible (one
   * process per role, so `Stop` *is* per-role), but in an interactive session
   * that delegates to a subagent it means the check fires once at the end
   * instead of at each handoff — which is exactly the cost the check exists to
   * avoid. Whoever implements a binding must state which of the two it has.
   */
  PER_AGENT_EXIT_GUARD = "per-agent-exit-guard",
  /** Guard wiring can be declared in a file committed to the project, so `sta init` can ship enforcement with the repo instead of relying on each person's machine-global config. */
  PROJECT_LEVEL_BINDING = "project-level-binding",
  /** A headless run returns a machine-readable envelope, not just free text on stdout. */
  STRUCTURED_RESULT = "structured-result",
  /** That envelope reports what the run cost. Without it `RunOutcome.cost` is 0 for every task on this runtime, and the budget guard (cost/costControl.ts) has nothing to count. */
  COST_REPORTING = "cost-reporting",
  /** An agent can put a question to a person mid-run. `business-analyst` interviews a human; a runtime without this cannot run that stage as designed. */
  INTERACTIVE_PROMPTS = "interactive-prompts",
  /** More than one agent run at a time is safe against this runtime. Reserved for T35's file-level locking work; nothing schedules on it yet. */
  PARALLEL_EXECUTION = "parallel-execution",
}

export const ALL_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = Object.values(RuntimeCapability);

/**
 * The capabilities this framework's design depends on. A runtime missing one of
 * these can still be driven, but something the pipeline promises stops being
 * true — so T111 reports each absence rather than letting it pass.
 *
 * `PER_AGENT_EXIT_GUARD` is intentionally *not* here: it is required for an
 * interactive session that delegates, and irrelevant under the orchestrator.
 * Listing it as universally required would make a correct autonomous-only setup
 * look broken.
 */
export const REQUIRED_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.NAMED_AGENTS,
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.EXIT_GUARD,
  RuntimeCapability.PROJECT_LEVEL_BINDING,
  RuntimeCapability.STRUCTURED_RESULT,
];

/** Which of `REQUIRED_RUNTIME_CAPABILITIES` a runtime does not declare. Empty means nothing the design assumes is missing. */
export function missingRequiredCapabilities(
  declared: ReadonlySet<RuntimeCapability>,
): RuntimeCapability[] {
  return REQUIRED_RUNTIME_CAPABILITIES.filter((c) => !declared.has(c));
}
