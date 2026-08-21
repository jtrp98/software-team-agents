import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * The seam between this framework and the AI runtime that actually executes an
 * agent (T108) — `claude` today, `codex` next, without the orchestrator core
 * learning either name.
 *
 * WHY THIS EXISTS WHEN `AgentExecutor` ALREADY DID
 *
 * `orchestrator/orchestrator.ts`'s `AgentExecutor` is already runtime-neutral:
 * the core hands it a stage and takes back an outcome, and nothing in
 * `orchestrator.ts` contains the string "claude". So swapping runtimes never
 * required a new seam — it required splitting the *one* implementation of that
 * seam (`agents/claudeCliExecutor.ts`) into the part that is about this
 * framework and the part that is about Claude Code, because those were welded
 * together in one 318-line file.
 *
 * This interface is only the second part. Everything runtime-neutral —
 * assembling the prompt, slicing module docs to the sections a stage may read
 * (policies/documentation.md §10), reading `review.md`/`security.md` back into
 * artifacts, mapping metrics into `RunOutcome` — lives in
 * `runtime/agentRunAssembly.ts` and is shared by every adapter. An adapter that
 * found itself needing to re-do any of that would be a sign the split is in the
 * wrong place.
 *
 * WHAT AN ADAPTER IS *NOT* RESPONSIBLE FOR
 *
 * Resolving what a role is. `.claude/agents/<role>.md` is a document this
 * framework owns; Claude Code merely happens to be able to load it natively.
 * Each runtime gets its own *binding* — the same role definitions rendered into
 * that runtime's native shape, committed to the project by `sta init` — so an
 * adapter is handed a role name and a path, never asked to parse frontmatter or
 * decide what `qa-engineer` means. That is why there is no `systemPrompt` field
 * anywhere below: an earlier draft had one, so that a runtime with no named-agent
 * concept could be passed the prompt by value, and the binding layer made it
 * unnecessary for both runtimes this framework targets.
 */

/** Where a runtime's binding lives in the project, and how a role is addressed inside it. */
export interface RuntimeBinding {
  /**
   * Repo-relative root of this runtime's binding — `.claude`, `.codex`.
   *
   * A directory rather than a set of files because `--check-bindings` (T111)
   * needs somewhere to look, and because it is the unit `sta init` writes and
   * `sta upgrade` diffs.
   */
  readonly dir: string;
  /** Repo-relative path of one role's agent definition inside this binding. */
  definitionPath(role: string): string;
  /**
   * Repo-relative path of the file that wires this runtime's guards up, or
   * `null` for a runtime with no such mechanism.
   *
   * `null` is a real answer, not a missing one: it is what forces T111 to cover
   * those guards post-hoc instead of assuming the runtime is holding them.
   */
  readonly guardConfigPath: string | null;
}

/**
 * How much autonomy one run gets, in this framework's terms.
 *
 * Four levels, not each runtime's own flag vocabulary — Claude Code's
 * `--permission-mode` has six values and Codex's sandbox has its own set, and an
 * interface that named either would have to be rewritten for the other. Each
 * adapter maps these onto its own flags; nothing outside an adapter ever sees
 * those flags.
 */
export type RuntimeAutonomy =
  /** Read and analyse only. No file may change. */
  | "read-only"
  /** May propose changes but must get permission for each one. */
  | "propose"
  /** May change files within what `guards` allows, without asking each time. */
  | "edit"
  /** Asks nothing. Only for a deliberately unattended run. */
  | "full";

/** A check that must pass before a run is allowed to be considered finished. */
export type RuntimeExitCheck =
  /** `typecheck`/`lint` are green on a run that touched app code (policies/coding.md §5c). */
  | "code-green"
  /** No hardcoded secret in a file this run changed (policies/security.md §5c-1). */
  | "no-hardcoded-secret";

export const ALL_EXIT_CHECKS: readonly RuntimeExitCheck[] = ["code-green", "no-hardcoded-secret"];

/**
 * What must not happen during a run.
 *
 * Stated as *what*, never as *by which mechanism* — no field here names a hook,
 * an event, or an exit code, because that is precisely what would make this
 * interface Claude-Code-shaped. An adapter enforces what its runtime can and
 * reports the rest back in `RuntimeAgentResult.guards`, so T111 knows what it
 * has left to check itself.
 */
export interface RuntimeGuards {
  /** Globs this role may write, from `contracts/<role>.yaml`. */
  readonly writeAllow: readonly string[];
  /** Globs nobody may write, whatever the allow-list says (`pathPermissions.UNIVERSAL_DENY` plus the role's own deny list). */
  readonly writeDeny: readonly string[];
  /** Commands this run must never issue — `git` for the no-git rule, by command name rather than by full command line. */
  readonly forbidCommands: readonly string[];
  /** Conditions checked at the end of the run. */
  readonly exitChecks: readonly RuntimeExitCheck[];
}

/** A canonical workspace granted to one task after three-repo preflight. */
export interface RuntimeWorkRoot {
  readonly targetId: string;
  readonly path: string;
  readonly access: "read" | "write";
}

/** An explicitly empty guard set, for a test or a mock. Named so that no caller reaches it by forgetting to pass one. */
export const NO_GUARDS: RuntimeGuards = Object.freeze({
  writeAllow: [],
  writeDeny: [],
  forbidCommands: [],
  exitChecks: [],
});

export interface RuntimeAgentRequest {
  /** This framework's own name for the role — `AGENT_REGISTRY[stage].role`, which is also how the binding addresses it. */
  readonly role: string;
  /** Absolute directory the run happens in. Honours `stageRoots` for a multi-repo project (T42). */
  readonly cwd: string;
  /** Framework, Knowledge and Target roots are explicit; cwd is never scope. */
  readonly bindingRoot?: string;
  readonly knowledgeRoot?: string;
  readonly workRoots?: readonly RuntimeWorkRoot[];
  /** Repo-relative path of this role's definition in this runtime's binding, resolved by `RuntimeBinding.definitionPath`. */
  readonly definitionPath: string;
  /** The task instruction, already assembled and sliced by `agentRunAssembly.ts`. */
  readonly prompt: string;
  /** Model to run on, or undefined to take the runtime's own default. The field T112 fills. */
  readonly model?: string;
  readonly autonomy: RuntimeAutonomy;
  readonly guards: RuntimeGuards;
  /** Extra environment for the run. An adapter may add to it; it must not drop what it is given. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type RuntimeRunStatus =
  /** The agent ran and finished normally. Says nothing about whether its *work* was correct. */
  | "OK"
  /** The agent ran and failed. A real task failure. */
  | "ERROR"
  /** The run exceeded its time budget. */
  | "TIMEOUT"
  /**
   * The runtime itself could not be used — binary missing, not authenticated,
   * spawn refused.
   *
   * Split from ERROR deliberately. `claudeCliExecutor` currently turns a failed
   * spawn into a plain `FAIL`, which spends the task's retry budget and can
   * trigger recovery for something the task did nothing to cause. Separating the
   * two lets the retry policy leave the budget alone, and lets T112 try the other
   * runtime instead of failing the task.
   */
  | "UNAVAILABLE";

export interface RuntimeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  /** Undefined, not 0, when the runtime does not report cost — see `RuntimeCapability.COST_REPORTING`. 0 would claim the run was free. */
  readonly costUsd?: number;
}

/**
 * Which guards this run actually had in-band, and which the framework has to
 * cover itself.
 *
 * This is the field T111 reads, and the reason it survived a round of trimming:
 * with both target runtimes having full guard mechanisms, it looked redundant.
 * It is not, because enforcement is a property of the *installed version and the
 * invocation*, not of the product — hooks are reported not to dispatch under
 * `codex exec` on some builds, and `codex exec` is what the orchestrator uses.
 * A run that silently enforced nothing while looking identical to one that
 * enforced everything is the same fail-open failure the hooks themselves are
 * warned about in policies/security.md §5d.
 */
export interface RuntimeGuardReport {
  /** Guard capabilities that were actually active for this run. */
  readonly enforced: readonly RuntimeCapability[];
  /** Guards the framework asked for that this run did not enforce. T111 must cover these post-hoc. */
  readonly unenforced: readonly RuntimeCapability[];
  /** Why something is unenforced. Human-readable; ends up in the run log, so it has to say something a person can act on. */
  readonly reason?: string;
}

/** Nothing was asked of the runtime, so nothing is missing. For a doc-only stage or a mock. */
export const NO_GUARDS_REPORT: RuntimeGuardReport = Object.freeze({ enforced: [], unenforced: [] });

export interface RuntimeAgentResult {
  readonly status: RuntimeRunStatus;
  readonly exitCode: number | null;
  /** The agent's final message, whatever the runtime calls that field. */
  readonly text: string;
  readonly usage: RuntimeUsage;
  /** The model the runtime says it actually used, when it says. Not the one that was requested. */
  readonly model?: string;
  readonly guards: RuntimeGuardReport;
  /** Anything the adapter wants a person to see in the log — a parse that fell back, a flag it had to drop. */
  readonly diagnostics: readonly string[];
  /**
   * The untouched payload, for logs and debugging. No framework logic may read
   * it: the point of normalising into the fields above is that nothing outside an
   * adapter depends on a runtime's envelope shape. It is here because both
   * runtimes' envelopes are still moving, and a tolerant parser that keeps the
   * original is how a field that turns out to be named differently gets fixed
   * without a re-run.
   */
  readonly raw?: unknown;
}

/** Whether this runtime can be used on this machine right now. */
export interface RuntimeProbe {
  readonly available: boolean;
  readonly version?: string;
  /** Why it cannot be used. Required in spirit whenever `available` is false — a probe that fails without saying why makes a person guess at their own installation. */
  readonly reason?: string;
}

export interface RuntimeCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute, or relative to the workspace root when omitted. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface RuntimeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Files and commands, in the place the agent's work actually lives.
 *
 * Async throughout even though both current implementations are local and
 * synchronous. Not speculative generality: the framework reads `review.md` and
 * `security.md` back through this after every QA/security run, and T111 runs
 * `typecheck` through it — if a runtime is ever driven somewhere the
 * orchestrator's own `fs` cannot see, a synchronous signature could not follow,
 * and every caller would have to change. One `await` now, or every call site
 * later.
 */
export interface RuntimeWorkspace {
  /** `null` for a file that does not exist — the same convention `agents/moduleDocs.ts` already uses, so a missing doc stays distinguishable from an empty one without exceptions. */
  readFile(relPath: string): Promise<string | null>;
  writeFile(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  /** Runs a command where the work is. This is "call tool" in the only sense the framework needs one: `typecheck`, the static-analysis gate, `git` for history. */
  runCommand(spec: RuntimeCommand): Promise<RuntimeCommandResult>;
}

export interface RuntimeAdapter {
  /** Stable identifier — `claude-code`, `codex`. Used as the registry key and written into logs, so it must not change once a run has recorded it. */
  readonly id: string;
  readonly displayName: string;
  readonly binding: RuntimeBinding;
  /** What this runtime claims it can do. A claim: T111 checks it against the installation. */
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  /**
   * Models reachable through this runtime.
   *
   * This is what T112 routes on, and the reason that task needed re-thinking:
   * with both runtimes having the same capabilities, "pick a runtime by
   * capability" selects on nothing. The real reason to cross runtimes is that the
   * model a role is configured for lives behind one of them — which is exactly
   * T58's per-role model choice, extended one step.
   */
  readonly models: ReadonlySet<string>;
  readonly workspace: RuntimeWorkspace;
  /** Never throws — an unusable runtime is a `{available: false, reason}`, because "cannot tell" and "not installed" need different handling upstream. */
  probe(): Promise<RuntimeProbe>;
  /** Never throws — a spawn failure is a result with status `UNAVAILABLE`. A task must never fail because an adapter threw where a caller expected a verdict. */
  executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult>;
}
