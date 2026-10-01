import { resolveMaxTurnsFromProject } from "../runtime/turnLimits.js";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { RuntimeAgentRequest, RuntimeAgentResult, RuntimeGuardReport, RuntimeUsage, RuntimeWorkRoot } from "../runtime/runtimeAdapter.js";
import { roleEnv } from "../runtime/runtimeAdapter.js";
import { serializeGuardTargetWorkRoots, targetStackPathRules } from "../agents/pathPermissions.js";
import { resolveWritableTargetWorkRoots, WritableTargetRequestError } from "../targetcli/roleWorkspace.js";
import type { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { executorPortFor } from "../runtime/executorPort.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import {
  guardsFor,
  PolicyRefusal,
  resolveLimits,
  resolvePermissions,
  resolveWorkRoots,
  resolveWorkspace,
  type ExecutionLimits,
  type Permissions,
} from "./policy.js";
import { newRunId, RunStore, type ApprovalState, type RunError, type RunRecord } from "./runStore.js";

/**
 * `sta.execute()` — the one execution primitive.
 *
 *   controller → sta.execute() → runtime adapter → result → controller
 *
 * A caller names a runtime and a task; STA resolves the run's workspace,
 * permissions and limits, records the run in the run tree, invokes the
 * adapter, and hands back a normalized result. It never decides what happens
 * next — that is the caller's job. Nothing here asks which product the caller
 * is, or whether it is "a controller": a run that delegates is simply the
 * parent of the runs it starts, and the same runtime may appear anywhere in a
 * tree.
 *
 * Nesting is the same call again. An executor process delegates by running
 * `sta execute` (its environment carries `STA_RUN_ID`/`STA_RUN_STORE`); an
 * in-process executor passes `parentRunId`. Either way the child is checked
 * against its parent's permissions and the root's limits, and a pending
 * approval anywhere below a run surfaces as that run's `needs_approval`.
 *
 * Workflows (`sta run`, `sta bounded-run`) are optional helpers above this:
 * their stages go through the same run tree via `openRunEnv`, so a workflow
 * stage can delegate exactly like a direct run.
 */

/** Environment a run's executor receives, and the one a nested `sta execute` reads its parent from. */
export const RUN_ID_ENV = "STA_RUN_ID";
export const RUN_STORE_ENV = "STA_RUN_STORE";

export interface ExecuteRequest {
  /** A registered runtime id: `claude-code`, `codex`, `antigravity`, `zcode`, `opencode`, or any adapter the registry holds. */
  runtime: string;
  task: string;
  /** Absolute directory the run works in. Default: the parent's workspace, else the caller's cwd. */
  workspace?: string;
  /** Optional persona from the runtime's binding (`backend-engineer`, ...). An instruction set, not an authority. */
  role?: string;
  /**
   * Target repositories the run may write besides its workspace, by Target id
   * or mapped path (`--writable-target`). A root run may name only Targets its
   * workspace's `.workflow/targets.local.yaml` maps; a child only Targets its
   * parent holds. The run still executes in its workspace, so the role's
   * definition and guard wiring come from there (the Knowledge workspace), and
   * the workspace itself is read-only unless `writePaths` say otherwise.
   * Implies `write`, and needs a `role`.
   */
  writableTargets?: readonly string[];
  /** Extra context appended to the task. */
  context?: string;
  /** The run this one is delegated from. Default: the caller's `STA_RUN_ID`, if any. */
  parentRunId?: string;
  permissions?: Permissions;
  limits?: ExecutionLimits;
  /**
   * Side effects beyond editing the workspace that the task will perform —
   * `production-deploy`, `migration`, `force-push`, `external-side-effect`,
   * ... Each needs a human approval before the run may start.
   */
  actions?: readonly string[];
  model?: string;
  effort?: string;
}

export interface RunRef {
  runId: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  runtime: string;
}

export interface ChildSummary {
  runId: string;
  runtime: string;
  status: RunRecord["status"];
  error?: RunError;
}

export interface Evidence {
  attempts: number;
  usage?: RuntimeUsage;
  diagnostics: readonly string[];
  guards?: RuntimeGuardReport;
  children: readonly ChildSummary[];
}

export interface ApprovalRequest {
  /** The run that asked. May be a descendant of the run this result is for. */
  runId: string;
  requestId: string;
  actions: readonly string[];
  reason: string;
  /** Run ids from the returning run down to the one that asked. */
  chain: readonly string[];
}

interface ResultBase {
  run: RunRef;
  evidence: Evidence;
  /** Advisory notes — nothing here blocked the run. */
  warnings: readonly string[];
}

export type ExecuteResult =
  | (ResultBase & { status: "completed"; output: string })
  | (ResultBase & { status: "partial"; output: string; remainingWork: string })
  | (ResultBase & { status: "needs_approval"; request: ApprovalRequest })
  | (ResultBase & { status: "failed"; error: RunError });

export interface ApproveInput {
  runId: string;
  requestId: string;
  approved: boolean;
  /** The person who decided, as the relaying caller reports it. */
  by: string;
  note?: string;
  /** The run the approving caller is itself inside, if any. Default: the caller's `STA_RUN_ID`. */
  callerRunId?: string;
}

export type ApproveResult = { ok: true; runId: string; approved: boolean } | { ok: false; runId: string; reason: string };

export interface ResumeOptions {
  /** The run resuming this one. Default: the caller's `STA_RUN_ID`. */
  parentRunId?: string;
  context?: string;
}

export interface StaOptions {
  registry: RuntimeRegistry;
  /** Where the run tree lives. Default: the caller's `STA_RUN_STORE`, else `<cwd>/.workflow/runs`. */
  runStore?: RunStore | string;
  /** The caller's environment. A `STA_RUN_ID` in it marks this call as nested inside that run. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  /** How an executor calls STA back — shown in its prompt. */
  staCommand?: string;
  /** Resolves a root run's `writableTargets` against its workspace's Target mapping. Test seam; defaults to the one `open --writable-target` uses. */
  resolveWritableTargets?: (input: { knowledgeRoot: string; workspaceRoot: string; requests: readonly string[] }) => readonly RuntimeWorkRoot[];
}

export interface Sta {
  readonly store: RunStore;
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
  resume(runId: string, options?: ResumeOptions): Promise<ExecuteResult>;
  approve(input: ApproveInput): ApproveResult;
  run(runId: string): RunRecord | null;
  /** The whole tree `runId` belongs to, oldest first. */
  tree(runId: string): RunRecord[];
}

const DETAIL_LIMIT = 2000;
const REMAINING = /^REMAINING:\s*(.+)$/gm;

export function defaultRunStoreDir(env: NodeJS.ProcessEnv, cwd: string): string {
  return env[RUN_STORE_ENV] || path.join(cwd, ".workflow", "runs");
}

/**
 * Records a new run in its tree, or refuses it on the tree's limits. Counted
 * after the exclusive create, so two racing siblings are refused rather than
 * both admitted.
 */
function admit(store: RunStore, run: RunRecord, parent: RunRecord | null): { code: string; message: string } | null {
  store.create(run);
  if (store.tree(run.rootRunId).length > run.limits.maxTotalRuns) {
    store.release(run);
    return { code: "budget_exceeded", message: `run tree ${run.rootRunId} already holds max_total_runs ${run.limits.maxTotalRuns} runs` };
  }
  if (parent && store.children(parent).length > run.limits.maxChildren) {
    store.release(run);
    return { code: "max_children_exceeded", message: `run ${parent.runId} already started max_children ${run.limits.maxChildren} runs` };
  }
  return null;
}

/** The identity half of a run's environment: who it is, and where its tree lives. */
function runIdentityEnv(run: RunRecord, store: RunStore): Record<string, string> {
  return { [RUN_ID_ENV]: run.runId, [RUN_STORE_ENV]: store.dir };
}

function ref(run: RunRecord): RunRef {
  return { runId: run.runId, parentRunId: run.parentRunId, rootRunId: run.rootRunId, depth: run.depth, runtime: run.runtime };
}

/**
 * The environment a run's executor gets: its own run identity, the shared
 * store, and its own write roots. Every guard channel a parent stage may have
 * set is overwritten, so nothing is inherited through the process
 * environment that the run's own permissions did not grant.
 */
export function runEnv(run: RunRecord, store: RunStore): Record<string, string> {
  const targets = run.workRoots ?? [];
  const writable = run.permissions.write
    ? [...(run.permissions.writePaths.length > 0 ? [run.workspace] : []), ...targets.map((root) => root.path)]
    : [];
  return {
    ...runIdentityEnv(run, store),
    ...roleEnv(run.role),
    STA_WRITABLE_WORK_ROOTS: JSON.stringify(writable),
    // A Target-writing run executes in the Knowledge workspace: name its Targets
    // for the guard, hand it each Target's stack layout for the role, and name the
    // workspace as the Knowledge root so an implementation role is refused the
    // documents there exactly as an orchestrated stage is.
    STA_TARGET_WORK_ROOTS: targets.length > 0 ? serializeGuardTargetWorkRoots(targets) : "",
    STA_STACK_PATH_RULES: targets.length > 0 && run.role ? stackPathRulesFor(run.role, targets, run.workspace) : "",
    STA_KNOWLEDGE_ROOT: targets.length > 0 ? run.workspace : "",
    STA_KNOWLEDGE_ROOT_NAME: "",
  };
}

/**
 * The stack layout globs for `role` across the run's Targets, as the guard's
 * `{write, deny}` channel — resolved per Target the way an orchestrated stage
 * resolves its execution root's, and unioned, since the guard applies them to
 * each path relative to whichever Target holds it. A Target whose profile does
 * not resolve contributes nothing, so its paths fall to the contract alone and
 * the guard over-restricts rather than letting a path through.
 *
 * Profiles are read from `workspace` — the synced Knowledge workspace the run
 * executes in — because a Target checkout carries no `stacks/`; the Target's
 * `type` comes from the same workspace's `targets.yaml`. A source root of `.`
 * expands to `**`; it is dropped here exactly as `targetPathRules` drops it,
 * since a root binding alone grants no path, and unioned across Targets it
 * would open every other bound Target whole. A single-role Target's own `**`
 * is kept: its type, not its binding, granted it.
 */
function stackPathRulesFor(role: string, targets: readonly RuntimeWorkRoot[], workspace: string): string {
  const write = new Set<string>();
  const deny = new Set<string>();
  for (const target of targets) {
    try {
      const rules = targetStackPathRules({ role, targetRoot: target.path, stacksRoot: workspace, registryRoot: workspace });
      for (const glob of rules.write) if (rules.wholeTarget || glob !== "**") write.add(glob);
      for (const glob of rules.deny) deny.add(glob);
    } catch {
      // a broken profile must not stop the run; see above
    }
  }
  return write.size > 0 || deny.size > 0 ? JSON.stringify({ write: [...write], deny: [...deny] }) : "";
}

export function createSta(options: StaOptions): Sta {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const now = options.now ?? Date.now;
  const store = options.runStore instanceof RunStore ? options.runStore : new RunStore(options.runStore ?? defaultRunStoreDir(env, cwd));
  const staCommand = options.staCommand ?? "sta";
  const resolveTargets = options.resolveWritableTargets ?? resolveWritableTargetWorkRoots;

  function error(run: Pick<RunRecord, "runId" | "runtime" | "task" | "parentRunId">, code: string, message: string, extra: Partial<RunError> = {}): RunError {
    return { code, message, runId: run.runId, runtime: run.runtime, task: run.task, parentRunId: run.parentRunId, ...extra };
  }

  function evidence(run: RunRecord, result?: RuntimeAgentResult): Evidence {
    return {
      attempts: run.attempts,
      ...(run.usage ? { usage: run.usage } : {}),
      diagnostics: run.diagnostics ?? [],
      ...(result ? { guards: result.guards } : {}),
      children: store.children(run).map((c) => ({ runId: c.runId, runtime: c.runtime, status: c.status, ...(c.error ? { error: c.error } : {}) })),
    };
  }

  /** A refusal before any run exists: nothing is recorded, nothing spawned. */
  function refused(request: ExecuteRequest, parent: RunRecord | null, code: string, message: string): ExecuteResult {
    const runId = newRunId(now());
    const run: RunRef = {
      runId,
      parentRunId: parent?.runId ?? null,
      rootRunId: parent?.rootRunId ?? runId,
      depth: parent ? parent.depth + 1 : 0,
      runtime: request.runtime,
    };
    return {
      status: "failed",
      run,
      error: { code, message, runId, runtime: request.runtime, task: request.task, parentRunId: run.parentRunId },
      evidence: { attempts: 0, diagnostics: [], children: [] },
      warnings: [],
    };
  }

  function chainTo(run: RunRecord, requester: RunRecord): string[] {
    const chain = [requester.runId];
    let cursor = requester;
    while (cursor.parentRunId !== null && cursor.runId !== run.runId) {
      const parent = store.load(cursor.parentRunId);
      if (!parent) break;
      chain.unshift(parent.runId);
      cursor = parent;
    }
    return chain;
  }

  function approvalRequest(run: RunRecord, requester: RunRecord): ApprovalRequest {
    const approval = requester.approval!;
    return { runId: requester.runId, requestId: approval.requestId, actions: approval.actions, reason: approval.reason, chain: chainTo(run, requester) };
  }

  /** The first run below `run` holding an undecided approval of its own. */
  function pendingBelow(run: RunRecord): RunRecord | undefined {
    return store.descendants(run).find((d) => d.approval !== null && d.approval.decision === null);
  }

  function deepestFailure(run: RunRecord): RunError | undefined {
    const failed = store.descendants(run).filter((d) => d.status === "failed" && d.error);
    return failed.sort((a, b) => b.depth - a.depth)[0]?.error;
  }

  function prompt(run: RunRecord, note?: string): string {
    const lines = [run.task];
    if (run.context) lines.push("", "Context:", run.context);
    if (note) lines.push("", note);
    const targets = run.workRoots ?? [];
    const write = run.permissions.write
      ? targets.length > 0 && run.permissions.writePaths.length === 0
        ? "Targets only — the workspace is read-only"
        : `yes (${run.permissions.writePaths.join(", ")})`
      : "no";
    lines.push("", "---", `STA run ${run.runId} on ${run.runtime}, depth ${run.depth} of max ${run.limits.maxDepth}. Workspace: ${run.workspace}. Write: ${write}.`);
    if (targets.length > 0) {
      // The run executes in the Knowledge workspace, so its cwd is not the code
      // it changes: name the repositories it does change, by absolute path.
      lines.push(
        "Writable Targets — the code this task changes lives here, not in the workspace; read and edit it by these absolute paths:",
        ...targets.map((root) => `  - ${root.targetId}: ${root.path}`),
      );
    }
    if (run.permissions.delegate && run.depth < run.limits.maxDepth) {
      lines.push(
        `You may delegate a sub-task to any runtime (${options.registry.ids().join(", ")}) with:`,
        `  ${staCommand} execute --runtime <id> --task "<sub-task>"${run.permissions.write ? " [--write]" : ""}${targets.length > 0 ? " [--role <role> --writable-target <id>]" : ""}`,
        `It prints a JSON result. If it reports "needs_approval", stop and report that — the decision is made above you.`,
      );
    }
    lines.push("If you cannot finish, end your reply with one line: REMAINING: <what is left>");
    return lines.join("\n");
  }

  function finish(run: RunRecord, result: ExecuteResult): ExecuteResult {
    run.updatedAt = now();
    store.save(run);
    return result;
  }

  async function attempt(run: RunRecord, note?: string): Promise<ExecuteResult> {
    const adapter = options.registry.tryGet(run.runtime);
    if (!adapter) {
      run.status = "failed";
      run.error = error(run, "runtime_not_registered", `runtime "${run.runtime}" is not registered (have: ${options.registry.ids().join(", ")})`);
      return finish(run, { status: "failed", run: ref(run), error: run.error, evidence: evidence(run), warnings: [] });
    }
    run.attempts += 1;
    run.status = "running";
    run.updatedAt = now();
    store.save(run);

    const request: RuntimeAgentRequest = {
      // The attempt identity is the run and attempt number, so two runs of the
      // same task — or a resumed one — are never the same executor attempt.
      taskId: `${run.runId}#${run.attempts}`,
      ...(run.role ? { role: run.role, definitionPath: adapter.binding.definitionPath(run.role) } : {}),
      cwd: run.workspace,
      ...(run.workRoots && run.workRoots.length > 0 ? { workRoots: run.workRoots, knowledgeRoot: run.workspace } : {}),
      // A direct run is the caller prompting a runtime itself: no OS wrapper,
      // the caller's own login; the workspace's guard hooks still apply.
      osIsolation: false,
      prompt: prompt(run, note),
      ...(run.model ? { model: run.model, modelExplicit: true } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
      autonomy: run.permissions.autonomy,
      guards: guardsFor(run.permissions),
      env: runEnv(run, store),
      ...(run.limits.timeoutMs ? { timeoutMs: run.limits.timeoutMs } : {}),
      // Same runaway-turn ceiling as an orchestrated stage (runtime/turnLimits.ts).
      ...withMaxTurns(resolveMaxTurnsFromProject(run.workspace, run.role)),
    };

    let result: RuntimeAgentResult;
    try {
      const port = executorPortFor(adapter);
      result = await port.execute(await port.prepare(request));
    } catch (e) {
      // Adapters are contracted not to throw; one that does still fails only this run.
      run.status = "failed";
      run.error = error(run, "adapter_threw", `runtime "${run.runtime}" threw instead of returning a result: ${String(e)}`);
      return finish(run, { status: "failed", run: ref(run), error: run.error, evidence: evidence(run), warnings: [] });
    }

    run.usage = result.usage;
    run.diagnostics = result.diagnostics;
    const warnings = result.guards.unenforced.length > 0
      ? [`runtime "${run.runtime}" did not enforce: ${result.guards.unenforced.join(", ")}${result.guards.reason ? ` (${result.guards.reason})` : ""}`]
      : [];
    for (const child of store.children(run)) {
      if (child.status === "needs_approval" || child.status === "partial" || child.status === "running") {
        warnings.push(`child run ${child.runId} on ${child.runtime} is still ${child.status}`);
      }
    }

    if (result.status !== "OK") {
      const detail = [result.text, ...result.diagnostics].filter((s) => s.length > 0).join(" | ").slice(0, DETAIL_LIMIT);
      const cause = deepestFailure(run);
      run.status = "failed";
      run.error = error(run, result.status.toLowerCase(), `${run.runtime} run ${run.runId} finished ${result.status} (exit ${result.exitCode ?? "unknown"})`, {
        detail,
        exitCode: result.exitCode,
        ...(cause ? { cause } : {}),
      });
      return finish(run, { status: "failed", run: ref(run), error: run.error, evidence: evidence(run, result), warnings });
    }

    run.output = result.text;
    const pending = pendingBelow(run);
    if (pending) {
      run.status = "needs_approval";
      run.blockedOn = pending.runId;
      return finish(run, { status: "needs_approval", run: ref(run), request: approvalRequest(run, pending), evidence: evidence(run, result), warnings });
    }
    run.blockedOn = null;
    const remaining = [...result.text.matchAll(REMAINING)].pop()?.[1]?.trim();
    if (remaining) {
      run.status = "partial";
      run.remainingWork = remaining;
      return finish(run, { status: "partial", run: ref(run), output: result.text, remainingWork: remaining, evidence: evidence(run, result), warnings });
    }
    run.status = "completed";
    delete run.remainingWork;
    return finish(run, { status: "completed", run: ref(run), output: result.text, evidence: evidence(run, result), warnings });
  }

  function callerRun(explicit: string | undefined): string | null {
    return explicit ?? (env[RUN_ID_ENV] || null);
  }

  async function execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const parentRunId = callerRun(request.parentRunId);
    const parent = parentRunId === null ? null : store.load(parentRunId);
    if (parentRunId !== null && !parent) {
      return refused(request, null, "parent_not_found", `parent run "${parentRunId}" is not in the run store ${store.dir} — pass the parent's STA_RUN_STORE through`);
    }
    if (typeof request.task !== "string" || request.task.trim() === "") return refused(request, parent, "invalid_request", "a run needs a non-empty task");
    const adapter = options.registry.tryGet(request.runtime);
    if (!adapter) {
      return refused(request, parent, "runtime_not_registered", `runtime "${request.runtime}" is not registered (have: ${options.registry.ids().join(", ")})`);
    }
    if (parent && !parent.permissions.delegate) {
      return refused(request, parent, "delegation_not_permitted", `run ${parent.runId} may not start child runs`);
    }

    let workspace: string;
    let permissions: RunRecord["permissions"];
    let workRoots: RuntimeWorkRoot[];
    let limits: RunRecord["limits"];
    try {
      workspace = resolveWorkspace(request.workspace, parent?.workspace ?? null, cwd);
      let requestedRoots: readonly RuntimeWorkRoot[] | undefined;
      const names = request.writableTargets ?? [];
      if (names.length > 0) {
        if (parent) {
          // A child names Targets its parent already holds; anything else is
          // left unmatched for resolveWorkRoots to refuse as an escalation.
          requestedRoots = names.map(
            (name) =>
              parent.workRoots?.find((own) => own.targetId === name || path.resolve(own.path) === path.resolve(name)) ??
              { targetId: name, path: path.resolve(name), access: "write" as const },
          );
        } else {
          try {
            requestedRoots = resolveTargets({ knowledgeRoot: workspace, workspaceRoot: workspace, requests: names });
          } catch (e) {
            if (e instanceof WritableTargetRequestError) return refused(request, parent, "target_not_mapped", e.message);
            throw e;
          }
        }
      }
      const writesTargets = requestedRoots !== undefined ? requestedRoots.length > 0 : (parent?.workRoots?.length ?? 0) > 0;
      const requestedPermissions =
        requestedRoots && requestedRoots.length > 0 ? { ...request.permissions, write: request.permissions?.write ?? true } : request.permissions;
      permissions = resolvePermissions(requestedPermissions, parent, workspace, writesTargets);
      workRoots = resolveWorkRoots(requestedRoots, parent, workspace, permissions.write, request.role);
      limits = resolveLimits(request.limits, parent?.limits ?? null);
    } catch (e) {
      if (e instanceof PolicyRefusal) return refused(request, parent, e.code, e.message);
      throw e;
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > limits.maxDepth) {
      return refused(request, parent, "max_depth_exceeded", `run depth ${depth} exceeds max_depth ${limits.maxDepth}`);
    }
    if (permissions.write && !adapter.capabilities.has(RuntimeCapability.PRE_TOOL_GUARD)) {
      return refused(request, parent, "write_guard_unavailable", `runtime "${adapter.id}" cannot enforce write bounds before a tool runs; grant it read-only or pick a runtime that can`);
    }

    const at = now();
    const runId = newRunId(at);
    const actions = [...new Set(request.actions ?? [])];
    const run: RunRecord = {
      runId,
      parentRunId: parent?.runId ?? null,
      rootRunId: parent?.rootRunId ?? runId,
      depth,
      runtime: adapter.id,
      ...(request.role ? { role: request.role } : {}),
      task: request.task,
      ...(request.context ? { context: request.context } : {}),
      workspace,
      ...(workRoots.length > 0 ? { workRoots } : {}),
      permissions,
      limits,
      actions,
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      status: "running",
      attempts: 0,
      approval: null,
      blockedOn: null,
      createdAt: at,
      updatedAt: at,
    };
    const refusal = admit(store, run, parent);
    if (refusal) return refused(request, parent, refusal.code, refusal.message);

    if (actions.length > 0) {
      run.status = "needs_approval";
      run.approval = {
        requestId: `apr-${randomBytes(6).toString("hex")}`,
        actions,
        reason: `run ${runId} declares side effects that need a human decision: ${actions.join(", ")}`,
        decision: null,
      } satisfies ApprovalState;
      return finish(run, { status: "needs_approval", run: ref(run), request: approvalRequest(run, run), evidence: evidence(run), warnings: [] });
    }
    return attempt(run);
  }

  async function resume(runId: string, resumeOptions: ResumeOptions = {}): Promise<ExecuteResult> {
    const run = store.get(runId);
    const caller = callerRun(resumeOptions.parentRunId);
    if (caller !== null && caller !== run.parentRunId && store.load(caller)?.rootRunId === run.rootRunId) {
      return { status: "failed", run: ref(run), error: error(run, "not_run_owner", `run ${caller} may not resume ${runId}: only its parent, or a caller outside its run tree, may`), evidence: evidence(run), warnings: [] };
    }
    if (run.status === "completed" || run.status === "running") {
      return { status: "failed", run: ref(run), error: error(run, "not_resumable", `run ${runId} is ${run.status}`), evidence: evidence(run), warnings: [] };
    }
    if (run.approval) {
      if (run.approval.decision === null) {
        return { status: "needs_approval", run: ref(run), request: approvalRequest(run, run), evidence: evidence(run), warnings: [] };
      }
      if (!run.approval.decision.approved) {
        return { status: "failed", run: ref(run), error: run.error ?? error(run, "approval_denied", `approval ${run.approval.requestId} was denied`), evidence: evidence(run), warnings: [] };
      }
    }
    if (run.blockedOn) {
      const blocker = store.load(run.blockedOn);
      if (blocker?.approval && blocker.approval.decision === null) {
        return { status: "needs_approval", run: ref(run), request: approvalRequest(run, blocker), evidence: evidence(run), warnings: [] };
      }
    }
    const notes: string[] = [`Resumed run ${runId} (attempt ${run.attempts + 1}).`];
    if (run.remainingWork) notes.push(`Previously remaining: ${run.remainingWork}`);
    for (const child of store.children(run)) {
      const decided = child.approval?.decision ? ` (approval ${child.approval.decision.approved ? "granted" : "denied"})` : "";
      const next = child.status === "needs_approval" || child.status === "partial" ? ` — continue it with \`${staCommand} execute resume ${child.runId}\`` : "";
      notes.push(`Child run ${child.runId} on ${child.runtime}: ${child.status}${decided}${next}`);
    }
    if (resumeOptions.context) notes.push(resumeOptions.context);
    return attempt(run, notes.join("\n"));
  }

  function approve(input: ApproveInput): ApproveResult {
    const run = store.load(input.runId);
    if (!run) return { ok: false, runId: input.runId, reason: `no run "${input.runId}"` };
    if (!run.approval || run.approval.requestId !== input.requestId) {
      return { ok: false, runId: run.runId, reason: `run ${run.runId} has no approval request ${input.requestId}` };
    }
    if (run.approval.decision !== null) return { ok: false, runId: run.runId, reason: `approval ${input.requestId} was already decided` };
    if (!input.by || !input.by.trim()) return { ok: false, runId: run.runId, reason: "an approval names the person who decided (--by)" };
    const caller = callerRun(input.callerRunId);
    if (caller !== null && store.load(caller)?.rootRunId === run.rootRunId) {
      return { ok: false, runId: run.runId, reason: `run ${caller} is inside the same run tree and cannot decide its approvals; the caller that owns the tree relays the human's answer` };
    }
    run.approval = { ...run.approval, decision: { approved: input.approved, by: input.by.trim(), ...(input.note ? { note: input.note } : {}), at: now() } };
    if (!input.approved) {
      run.status = "failed";
      run.error = error(run, "approval_denied", `approval ${input.requestId} was denied by ${input.by.trim()}`);
    }
    run.updatedAt = now();
    store.save(run);
    return { ok: true, runId: run.runId, approved: input.approved };
  }

  return {
    store,
    execute,
    resume,
    approve,
    run: (runId) => store.load(runId),
    tree: (runId) => {
      const run = store.load(runId);
      return run ? store.tree(run.rootRunId) : [];
    },
  };
}

export interface WorkflowStageRun {
  /** The run identity to merge into the stage's adapter environment. Guard channels stay the workflow's own. */
  readonly env: Readonly<Record<string, string>>;
  readonly runId: string;
  /** Records how the stage attempt ended. */
  close(result: Pick<RuntimeAgentResult, "status" | "text" | "usage" | "diagnostics">): void;
}

/**
 * A workflow stage's attempt as a node in the run tree.
 *
 * Workflows are helpers above the execution primitive, not a second engine
 * beside it: each stage attempt is recorded as a run — a child of the run
 * that invoked the workflow, when there is one — and its agent receives the
 * same `STA_RUN_ID`/`STA_RUN_STORE` a direct run does. So a workflow stage can
 * delegate with `sta execute`, its children are held to its own permissions,
 * and a workflow started from inside a run counts against that tree's limits.
 *
 * Returns a refusal only for a tree limit — the one thing that can make a
 * nested workflow stage unsafe to start.
 */
export function openWorkflowStageRun(input: {
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
  runtime: string;
  role: string;
  task: string;
  workspace: string;
  writePaths: readonly string[];
  autonomy: RuntimeAgentRequest["autonomy"];
  now?: () => number;
}): WorkflowStageRun | { refused: string } {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const store = new RunStore(defaultRunStoreDir(env, input.stateRoot));
  const parentRunId = env[RUN_ID_ENV] || null;
  const parent = parentRunId === null ? null : store.load(parentRunId);
  const limits = resolveLimits({}, parent?.limits ?? null);
  const depth = parent ? parent.depth + 1 : 0;
  if (parent && !parent.permissions.delegate) return { refused: `run ${parent.runId} may not start child runs` };
  if (depth > limits.maxDepth) return { refused: `run depth ${depth} exceeds max_depth ${limits.maxDepth}` };
  const at = now();
  const runId = newRunId(at);
  const run: RunRecord = {
    runId,
    parentRunId: parent?.runId ?? null,
    rootRunId: parent?.rootRunId ?? runId,
    depth,
    runtime: input.runtime,
    role: input.role,
    task: input.task,
    workspace: path.resolve(input.workspace),
    permissions: { write: input.writePaths.length > 0, writePaths: input.writePaths, delegate: true, autonomy: input.autonomy },
    limits,
    actions: [],
    status: "running",
    attempts: 1,
    approval: null,
    blockedOn: null,
    createdAt: at,
    updatedAt: at,
  };
  const refusal = admit(store, run, parent);
  if (refusal) return { refused: refusal.message };
  return {
    runId,
    env: runIdentityEnv(run, store),
    close(result) {
      run.status = result.status === "OK" ? "completed" : "failed";
      run.output = result.text;
      run.usage = result.usage;
      run.diagnostics = result.diagnostics;
      if (result.status !== "OK") {
        run.error = { code: result.status.toLowerCase(), message: `${run.runtime} stage ${run.task} finished ${result.status}`, runId, runtime: run.runtime, task: run.task, parentRunId: run.parentRunId };
      }
      run.updatedAt = now();
      store.save(run);
    },
  };
}function withMaxTurns(maxTurns: number | undefined): { maxTurns?: number } {
  return maxTurns === undefined ? {} : { maxTurns };
}
