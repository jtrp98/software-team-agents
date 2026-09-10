import * as path from "node:path";
import { AgentStage, TaskLevel } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { getAgent } from "../agents/registry.js";
import { GUARD_STACK_RULES_ENV } from "../agents/pathPermissions.js";
import { resolveStackPathRules } from "../profile/projectProfile.js";
import { loadTargetConfig } from "../targetcli/targetMeta.js";
import { resolveAgentEffort, resolveAgentModel, resolveAgentVersion } from "../agents/agentModel.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import {
  buildPromptParts,
  compileExecutionPacket,
  assembleStageContext,
  handoffFromContext,
  failResult,
  qaArtifactResult,
  securityArtifactResult,
  suppressRawHandoffWhenNarrowed,
  measureRolePrefixChars,
  type PromptPartsResult,
  type RunMetrics,
} from "./agentRunAssembly.js";
import { codeIntelContext as defaultCodeIntelContext, retrievalCandidatesForPacket, type CodeIntelSliceDeps } from "./codeIntelAssembly.js";
import { buildTaskRetrievalQuery } from "../context/retrievalQuery.js";
import type {
  RuntimeAdapter,
  RuntimeAgentResult,
  RuntimeAutonomy,
  RuntimeGuards,
} from "./runtimeAdapter.js";
import type { RuntimeRegistry } from "./runtimeRegistry.js";
import {
  requiredCapabilitiesFor,
  resolveRuntimeRoute,
  type RuntimeRouteAttempt,
  type RuntimeRouteCandidate,
  type RuntimeRouteFlags,
} from "./runtimeRouting.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { QaRiskSignals } from "../qa/mode.js";
import { checkRoleExecutionGate } from "../roles/roleExecutionGate.js";
import type { PersistedTask } from "../store/taskStore.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import type { ThreeRepoRequestRoots } from "../threeRepo/preflight.js";
import { deriveHandoff } from "../agents/moduleDocs.js";
import { parseDesignEvidence } from "../docs/designEvidence.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { generatePromptPreview } from "../views/generatedTaskViews.js";
import { assessContextBudget, contextBudgetRejections, formatBudgetRejection, resolveContextBudgetFromProject, resolveContextBudgetModeFromProject, taskTokenBudgetRejection, type ContextBudgetComposition } from "../context/contextBudget.js";
import { RunLog } from "../observability/runLog.js";
import { writeExecutionPacket, nextExecutionPacketAttempt } from "../state/runtimeArtifacts.js";
import { resolveTargetRevision } from "../codeintel/targetRevision.js";
import type { DependencyEvidence } from "../artifacts/executionPacket.js";
import { formatModelPolicyBasis } from "./tierRouting.js";
import type { ModelTierPolicy } from "./modelTiers.js";
import { captureChangeSetFingerprint } from "../qa/changeSource.js";

/**
 * An `AgentExecutor` built on a `RuntimeAdapter`.
 *
 * This is the whole point of the interface: the orchestrator gets the same
 * pluggable seam it always had, and what sits behind it is now a choice. Nothing
 * in this file names a runtime, reads a runtime's flag, or parses a runtime's
 * envelope — swap the adapter and every line here still applies.
 *
 * `cli.ts` constructs this executor with the runtime selected for the task.
 */

export interface RuntimeExecutorOptions {
  /** The runtime that actually runs the agent. */
  runtime: RuntimeAdapter;
  /** Root of the target project — where the role definitions and `_docs/` live. */
  projectRoot: string;
  /** Resolves a task to the `_docs/module/<name>/` folder its docs live under. */
  moduleName: (taskId: string) => string;
  /**
   * The guard set for a role.
   *
   * Required, with no default. A default would have to invent a write scope, and
   * the two plausible inventions ("everything" and "nothing") are opposite
   * mistakes — see `runtimeGuards.ts`. Use `contractGuardResolver(projectRoot)`
   * for the real thing, or `() => NO_GUARDS` in a test that is explicitly not
   * testing guards.
   */
  guards: (role: string, layoutRoot?: string) => RuntimeGuards;
  /** How much autonomy each run gets. Defaults to `propose` — the orchestrator automates handoffs between the pipeline's confirmation points, it does not remove them. */
  autonomy?: RuntimeAutonomy;
  /**
   * Which model a role runs on.
   *
   * Embedded compatibility only. Production registry routing resolves the V8
   * policy; callers without a registry retain the role definition's model.
   */
  model?: (role: string) => string | undefined;
  timeoutMs?: number;
  extraInstruction?: string;
  phases?: (taskId: string) => number[] | undefined;
  sliceModuleDocs?: boolean;
  /**
   * T-UX12 — the task's classification level, when the caller knows it. Fed to
   * the role-execution gate so TRIVIAL/SMALL frontend work is not blocked on a
   * UX-artifact precondition the classifier deliberately skipped for it.
   */
  taskLevel?: (taskId: string) => TaskLevel | undefined;
  /** Per-stage working directory for a project whose pipeline spans several repos. */
  stageRoots?: Partial<Record<AgentStage, string>>;
  /** Phase 2's fail-closed resolver. When present it runs before adapter start. */
  threeRepoTask?: (taskId: string, stage: AgentStage) => { task: PersistedTask; roots: ThreeRepoRequestRoots };
  /** Stored Phase-1 task contract. Production supplies this for every runnable task. */
  runtimeTask?: (taskId: string) => RuntimeTask | null | undefined;
  dependencyEvidence?: (taskId: string) => readonly DependencyEvidence[];
  /** Fixture seam; production always resolves the actual current checkout. */
  packetBaseRevision?: (root: string) => Promise<string>;
  /** Optional bounded retention override; the runtime-artifact default otherwise applies. */
  packetRetention?: number;
  /**
   * Makes the BA → SA → DEV human handoffs a prerequisite of the lead stages.
   * Off by default so a project that has not adopted knowledge workspaces
   * preserves the prior execution path.
   */
  enforceRoleWorkflow?: boolean;
  /**
   * Production routing. When present, runtime/model selection, cached
   * availability, support policy and write-stage capabilities are resolved per
   * run. Left unset only for embedded compatibility callers and focused tests.
   */
  registry?: RuntimeRegistry;
  /** Explicit CLI runner/model constraints (precedence level 1). */
  routingFlags?: RuntimeRouteFlags;
  classification?: (taskId: string) => ClassificationResult | undefined;
  riskSignals?: (taskId: string) => QaRiskSignals | undefined;
  /** Existing task telemetry, used only for pre-spawn task-token projection. */
  taskRunLog?: (taskId: string) => RunLog;
  /** The verified capability picture per runtime id, passed through to `resolveRuntimeRoute` so its capability-policy diagnostic uses confirmed facts instead of a static claim, when available. */
  verifiedCapabilities?: Readonly<Record<string, ReadonlySet<RuntimeCapability>>>;
  /** Optional canonical task Tier lookup. */
  planTier?: (taskId: string) => string | undefined;
  /** Policy fixture seam; production loads model-tiers.yaml when this is undefined. */
  modelPolicy?: ModelTierPolicy | null;
  /** Replays persisted runtime/model/effort without consulting the current policy/frontmatter. */
  frozenModelRoute?: boolean;
  /** Original persisted winner basis for a frozen route. */
  frozenRoutingBasis?: string;
  /**
   * T-V8-011 — files already known changed for this task/round (e.g. a QA
   * repair round's real diff), fed into the task-specific retrieval query.
   * Absent by default: a fresh DEV round has no diff yet, and that is a fact,
   * not a failure.
   */
  changedFiles?: (taskId: string) => Promise<string[]>;
  /** Test seam; production always uses the real `codeIntelAssembly.codeIntelContext` (OFF unless `STA_CODE_INTEL=on`). */
  codeIntelContext?: (input: Parameters<typeof defaultCodeIntelContext>[0], deps?: CodeIntelSliceDeps) => ReturnType<typeof defaultCodeIntelContext>;
}

/**
 * A runtime that cannot be used is not the task's fault.
 *
 * `RunOutcome` only has PASS and FAIL, so an unavailable runtime still surfaces
 * as a FAIL — but attaching this failure means `routeFailure` escalates it to a
 * person instead of spending a retry on a binary that isn't installed. That is
 * the behavioural payoff of separating `UNAVAILABLE` from `ERROR` in the result
 * envelope; without it the two are the same `FAIL` and the retry budget drains
 * for no reason.
 */
/**
 * The stack layout globs a guard hook cannot resolve for itself, packed for
 * the environment channel that already carries `AGENTCLAUDE_ROLE`.
 *
 * Returns nothing at all for a role no stack profile scopes, so a non-engineer
 * stage's environment is unchanged. `read` is deliberately not sent: reading is
 * not enforced as a block anywhere, and a hook has no use for it.
 */
export function resolveGuardStackRules(role: string, guardRoot: string): Record<string, string> {
  let rules;
  try {
    const stack = loadTargetConfig(guardRoot)?.stack;
    rules = resolveStackPathRules({ role, projectRoot: guardRoot, profile: stack?.profile, sourceRoots: stack?.source_roots });
  } catch {
    return {}; // a broken profile must not stop a run; the orchestrator's own assertCanWrite still applies
  }
  if (rules.write.length === 0 && rules.deny.length === 0) return {};
  return { [GUARD_STACK_RULES_ENV]: JSON.stringify({ write: rules.write, deny: rules.deny }) };
}

function unavailableFailure(runtimeId: string, reason: string): StructuredFailure {
  return {
    category: "infrastructure",
    owner: AgentStage.HUMAN,
    severity: "high",
    retryable: false,
    reason: `runtime "${runtimeId}" is unavailable: ${reason}`,
    affected: [],
    requiresHuman: true,
  };
}

/** Maps a runtime's normalised usage onto the fields the run log records. */
function metricsFrom(result: RuntimeAgentResult, declared: {
  model?: string;
  promptVersion?: number;
  effort?: string;
  context_chars: number;
  estimated_input_tokens: number;
  composition: {
    static_chars: number;
    handoff_chars: number;
    doc_chars: number;
    knowledge_chars: number;
    code_intel_chars: number;
    tool_output_chars: number;
  };
  doc_chars_before: number;
  runtime: string;
  requested_runtime?: string;
  requested_model?: string;
  routing_basis?: string;
  fallback_reason?: string;
  fallback_count?: number;
  contextBudget: ReturnType<typeof assessContextBudget>;
  budgetComposition: ContextBudgetComposition;
  /** T-V8-012 — measured once per attempt by `measureRolePrefixChars`; null when unmeasurable, never fabricated as 0. */
  role_prefix_chars: number | null;
}): RunMetrics {
  const input_tokens = result.usage.inputTokens;
  const output_tokens = result.usage.outputTokens;
  return {
    // What the runtime says it used, falling back to what was configured. A
    // runtime that reports its own model is the better source: a routing
    // override or a runtime-side substitution would otherwise be logged as the
    // frontmatter value, which is the one thing the log must not do.
    model: result.model ?? declared.model,
    promptVersion: declared.promptVersion,
    // T-V8-012: same requested/observed split `model` already had — the
    // runtime rarely echoes effort back today (see `RuntimeAgentResult.effort`),
    // so this reads identically to before until an adapter starts reporting one.
    effort: result.effort ?? declared.effort,
    requested_effort: declared.effort,
    tokens: (input_tokens ?? 0) + (output_tokens ?? 0),
    // `?? 0` here, unlike the `costUsd?: number` in the envelope: the run log's
    // `cost` is a number by contract, and "this runtime does not report cost" is
    // recorded as the absent COST_REPORTING capability, not as a fake figure in
    // every row.
    cost: result.usage.costUsd ?? 0,
    input_tokens,
    output_tokens,
    cache_read_tokens: result.usage.cachedInputTokens,
    cache_creation_tokens: result.usage.cacheCreationInputTokens,
    context_chars: declared.context_chars,
    estimated_input_tokens: declared.estimated_input_tokens,
    runtime: declared.runtime,
    requested_runtime: declared.requested_runtime,
    requested_model: declared.requested_model,
    routing_basis: declared.routing_basis,
    fallback_reason: declared.fallback_reason,
    fallback_count: declared.fallback_count,
    session_kind: "orchestrated",
    ...declared.composition,
    doc_chars_before: declared.doc_chars_before,
    instruction_surface_bytes: declared.role_prefix_chars ?? undefined,
    context_budget_chars: declared.contextBudget.budgetChars ?? undefined,
    context_budget_source: declared.contextBudget.budgetSource ?? undefined,
    context_overflow_chars: declared.contextBudget.overflowChars ?? undefined,
    context_budget_warning: declared.contextBudget.warning ?? undefined,
    context_base_chars: declared.budgetComposition.base,
    context_task_chars: declared.budgetComposition.task,
    context_safety_chars: declared.budgetComposition.safety,
    context_docs_chars: declared.budgetComposition.docs,
    context_knowledge_chars: declared.budgetComposition.knowledge,
    context_code_chars: declared.budgetComposition.code,
    context_tool_output_chars: declared.budgetComposition.tool_output,
    context_reserve_chars: declared.budgetComposition.reserve,
  };
}

function describeFailure(runtimeId: string, role: string, result: RuntimeAgentResult, routingDiagnostics: readonly string[] = []): string {
  const detail = [result.text, ...result.diagnostics, ...routingDiagnostics].filter((s) => s.length > 0).join(" | ").slice(0, 2000);
  const exit = result.exitCode === null ? "unknown" : String(result.exitCode);
  return `${runtimeId} run of \`${role}\` finished ${result.status} (exit ${exit}): ${detail}`;
}

/** Capture the source state at a document verdict without making the verdict depend on runtime identity. */
async function fingerprintVerdict(result: AgentExecutorResult, projectRoot: string): Promise<AgentExecutorResult> {
  if (!result.artifactType) return result;
  try {
    return {
      ...result,
      outcome: { ...result.outcome, verification_fingerprint: await captureChangeSetFingerprint(projectRoot) },
    };
  } catch {
    // A non-git legacy workspace retains its established verdict behaviour.
    return result;
  }
}

/**
 * A route with no `routing.order` resolves one candidate, so there is no hop to
 * describe. The two fields stay in the run log (`fallback_reason` absent,
 * `fallback_count` 0) so existing rows, readers and the reporting schema keep
 * their shape.
 */
const NO_FALLBACK_HOPS = 0;

/**
 * T-V8-011 — the packet's `retrieval_candidates` (`artifacts/executionPacket.ts`
 * `RetrievalCandidateSchema`), populated from a task-specific query instead of
 * the bare module name. Historically this field was never populated at all —
 * `compileExecutionPacket` always saw `retrievalCandidates: undefined` here —
 * so PM's authored `Query:` retrieval hint never reached an actual lookup.
 *
 * Additive by design, same posture as every other optional enrichment in this
 * file: OFF by default (`STA_CODE_INTEL`), and any missing input or failure
 * answers `[]` rather than blocking packet compilation. A v1/legacy
 * RuntimeTask has no `contract` to query from, so it answers `[]` too — the
 * legacy compatibility path already refuses to reach this branch at all
 * (`RuntimeTaskV2Schema.safeParse` inside `compileExecutionPacket`).
 */
async function packetRetrievalCandidates(
  opts: RuntimeExecutorOptions,
  req: AgentExecutorRequest,
  runtimeTask: RuntimeTask,
  moduleName: string,
  targetRoot: string,
  targetId: string | undefined,
  baseRevision: string,
): Promise<ReturnType<typeof retrievalCandidatesForPacket> | undefined> {
  if (!("version" in runtimeTask) || runtimeTask.version !== 2) return undefined;
  try {
    const changedFiles = await opts.changedFiles?.(req.taskId).catch(() => []) ?? [];
    const query = buildTaskRetrievalQuery(runtimeTask.contract, { moduleName, changedFiles });
    const codeIntel = opts.codeIntelContext ?? defaultCodeIntelContext;
    const result = await codeIntel({ stage: req.stage, taskId: req.taskId, moduleName, targetRoot, targetId, query, revision: baseRevision });
    if (result.candidates.length === 0) return undefined;
    return retrievalCandidatesForPacket(result.candidates, targetRoot, baseRevision);
  } catch {
    // Discovery enrichment must never block packet compilation.
    return undefined;
  }
}

/**
 * `ADR-025` #4 — an automatic camp switch inside a `🔒 Security gate` phase
 * invalidates that phase's earlier `qa-engineer` / `security` passes.
 *
 * Returns a reason when the note could not be written, and the caller refuses
 * the hop on it: a switch nobody recorded would launder the verdict, which is
 * the one outcome automation is not allowed to produce here.
 */
async function recordCampSwitchInvalidation(
  runtime: RuntimeAdapter,
  moduleName: string,
  entry: string,
): Promise<string | null> {
  const relPath = `_docs/module/${moduleName}/review.md`;
  try {
    const existing = await runtime.workspace.readFile(relPath);
    const head = existing === null || existing.trim() === "" ? `# review.md — ${moduleName}\n` : existing.replace(/\s*$/, "\n");
    await runtime.workspace.writeFile(relPath, `${head}\n${entry}\n`);
    return null;
  } catch (e) {
    return `cannot record the ADR-025 #4 camp-switch invalidation in ${relPath}: ${String(e)}`;
  }
}

export function createRuntimeExecutor(opts: RuntimeExecutorOptions): AgentExecutor {
  const { runtime } = opts;
  const autonomy = opts.autonomy ?? "propose";
  const sliceDocs = opts.sliceModuleDocs ?? true;
  const resolveModel = opts.model ?? ((role: string) => resolveAgentModel(opts.projectRoot, role) ?? undefined);

  return async function runtimeExecutor(req: AgentExecutorRequest): Promise<AgentExecutorResult> {
    const role = getAgent(req.stage).role;
    const moduleName = opts.moduleName(req.taskId);
    const phases = opts.phases?.(req.taskId);

    let threeRepo: { task: PersistedTask; roots: ThreeRepoRequestRoots } | undefined;
    if (opts.threeRepoTask) {
      try {
        threeRepo = opts.threeRepoTask(req.taskId, req.stage);
      } catch (e) {
        return failResult(`cannot start ${role}: three-repo preflight failed: ${String(e)}`);
      }
    }

    if (opts.enforceRoleWorkflow) {
      // In three-repo mode the workflow and UX artifacts live in Knowledge,
      // never beside framework bindings. Preflight is read-only and runs before
      // any adapter work, so resolving it first cannot create side effects.
      const handoff = checkRoleExecutionGate(threeRepo?.roots.knowledgeRoot ?? opts.projectRoot, moduleName, req.stage, undefined, { level: opts.taskLevel?.(req.taskId) });
      if (!handoff.allowed) return failResult(handoff.reason ?? `cannot start ${role}: role workflow gate failed`);
    }

    const workRoot = threeRepo?.roots.workRoots.find((root) => root.access === "write") ?? threeRepo?.roots.workRoots[0];
    let incomingHandoff;
    try {
      incomingHandoff = handoffFromContext(req.context);
    } catch (error) {
      return failResult(`cannot use prior-stage handoff: ${String(error)}`);
    }
    const runtimeTask = threeRepo?.task.runtimeTask ?? opts.runtimeTask?.(req.taskId) ?? null;
    let stageContext;
    try {
      stageContext = sliceDocs && !(runtimeTask && "version" in runtimeTask && runtimeTask.version === 2)
        ? await assembleStageContext(req.stage, {
            projectRoot: opts.projectRoot,
            docsRoot: threeRepo?.roots.knowledgeRoot ?? opts.projectRoot,
            knowledgeRoot: threeRepo?.roots.knowledgeRoot,
            moduleName,
            phases,
            taskId: req.taskId,
            handoff: incomingHandoff ?? undefined,
            targetRoot: workRoot?.path,
            targetId: workRoot?.targetId,
          })
        : {
            docs: [], knowledge: [], codeIntel: [], selected: [], docCharsBefore: 0,
            savings: { bytesBefore: 0, bytesAfter: 0, savedPct: 0 },
            directFileReads: 0,
          };
    } catch (error) {
      return failResult(`cannot assemble authorized handoff context: ${String(error)}`);
    }

    const executionRoot = workRoot?.path ?? threeRepo?.roots.bindingRoot ?? opts.stageRoots?.[req.stage] ?? opts.projectRoot;
    let guards: RuntimeGuards;
    try {
      guards = opts.guards(role, executionRoot);
    } catch (e) {
      // The current role contract is the authority packet scope narrows. A run
      // with no resolved contract must not compile a packet or start an adapter.
      return failResult(`cannot start ${role}: ${String(e)}`);
    }

    let packetPath: string | undefined;
    let promptParts: PromptPartsResult;
    if (runtimeTask) {
      try {
        const runtimeStateRoot = threeRepo?.roots.bindingRoot ?? opts.projectRoot;
        const baseRevision = await (opts.packetBaseRevision ?? resolveTargetRevision)(executionRoot);
        const packet = compileExecutionPacket({
          req,
          role,
          runtimeTask,
          contractScope: { allow: guards.writeAllow, deny: guards.writeDeny },
          attempt: nextExecutionPacketAttempt(runtimeStateRoot, req.taskId, req.stage),
          baseRevision,
          config: { target: loadTargetConfig(executionRoot), guardStackRules: resolveGuardStackRules(role, executionRoot) },
          dependencyEvidence: opts.dependencyEvidence?.(req.taskId),
          retrievalCandidates: await packetRetrievalCandidates(opts, req, runtimeTask, moduleName, executionRoot, workRoot?.targetId, baseRevision),
          extra: opts.extraInstruction,
        });
        if (JSON.stringify([...packet.scope.allow].sort()) !== JSON.stringify([...new Set(guards.writeAllow)].sort())) throw new Error("packet scope differs from the enforced stage contract; recompile with current stage grants");
        const expectedRoots = threeRepo ? threeRepo.roots.workRoots.filter(root => root.access === "write").map(root => path.resolve(root.path)) : [path.resolve(executionRoot)];
        if (JSON.stringify(packet.scope.roots.map(root => path.resolve(root)).sort()) !== JSON.stringify(expectedRoots.sort())) throw new Error("packet work roots differ from effective stage guard roots; recompile");
        const preview = generatePromptPreview(packet, {
          current_revision: packet.identity.base_revision,
          current_config_hash: packet.identity.config_hash,
          current_compiler_hash: packet.identity.compiler_hash,
          current_plan_hash: packet.identity.plan_hash,
        });
        if (preview.state !== "executable" || preview.prompt.text !== packet.text || preview.prompt.hash !== preview.persisted_packet.text_hash) {
          throw new Error(`generated prompt preview drift: ${preview.stale_reasons.join("; ") || "prompt bytes differ"}`);
        }
        guards = { ...guards, writeAllow: packet.scope.allow, writeDeny: packet.scope.deny };
        const persisted = writeExecutionPacket({
          projectRoot: runtimeStateRoot,
          packet,
          forbiddenRoots: threeRepo
            ? [threeRepo.roots.knowledgeRoot, ...threeRepo.roots.workRoots.map((root) => root.path)]
            : [],
          maxRunsPerTask: opts.packetRetention,
        });
        packetPath = path.relative(runtimeStateRoot, persisted.path).replace(/\\/g, "/");
        promptParts = packet;
      } catch (error) {
        return failResult(`cannot compile or persist execution packet for ${role}: ${String(error)}`);
      }
    } else {
      if (opts.runtimeTask || threeRepo) return failResult(`task ${req.taskId}: missing semantic RuntimeTask; author canonical task fields and explicitly recompile before execution`);
      // Historical or embedded callers may have no RuntimeTask. Production
      // tasks created since state schema v13 always take the packet path above.
      // T-V8-011: once a doc slice was already narrowed using this HANDOFF, its
      // provenance is visible in the kept text — printing the same references
      // again as raw JSON would be duplication, not context.
      const promptReq = { ...req, context: suppressRawHandoffWhenNarrowed(req.context, stageContext.selected) };
      promptParts = buildPromptParts(promptReq, opts.extraInstruction, {
        docs: stageContext.docs,
        knowledge: stageContext.knowledge,
        codeIntel: stageContext.codeIntel,
      });
    }
    const prompt = promptParts.text;
    const finish = (result: AgentExecutorResult): AgentExecutorResult =>
      packetPath ? { ...result, packetPath } : result;

    // Production routing remains above the orchestrator seam. Embedded callers
    // that do not supply a registry retain the fixed-runtime compatibility
    // behaviour.
    const hasTargetWrite = threeRepo?.roots.workRoots.some((root) => root.access === "write") ?? false;
    const requiresInteractivity = requiredCapabilitiesFor(
      req.stage,
      false,
      req.businessInput,
    ).includes(RuntimeCapability.INTERACTIVE_PROMPTS);
    let activeRuntime = runtime;
    let activeModel = resolveModel(role);
    // Whether `activeModel` is an operator-visible override (CLI
    // `--model` / `.sta/config.yaml` routing) rather than the frontmatter
    // default, plus any effort named with it. The registry route is the only
    // channel that can set these; the embedded compatibility path below never
    // forwards a model past an adapter that ignores it, exactly as before.
    let activeModelExplicit = false;
    let activeEffort: string | undefined = opts.registry ? undefined : resolveAgentEffort(opts.projectRoot, role) ?? undefined;
    // Legacy frontmatter effort was telemetry-only before V8. Keep that
    // compatibility contract while forwarding centrally resolved or operator
    // effort to adapters.
    let activeAdapterEffort: string | undefined;
    let routeAvailability: Readonly<Record<string, { available: boolean; reason?: string }>> = {};
    const routingDiagnostics: string[] = [];
    let requestedRuntime: string | undefined;
    let requestedModel: string | undefined;
    let routingBasis: string | undefined;
    /** Entries after the selected one, reachable only by an `UNAVAILABLE` hop. */
    let fallbackQueue: RuntimeRouteCandidate[] = [];
    /** Entries the route already refused before the selected one. */
    let preRouteSkips: readonly RuntimeRouteAttempt[] = [];
    const classification = opts.classification?.(req.taskId);
    if (opts.registry) {
      const tierId = opts.planTier?.(req.taskId);
      routeAvailability = await opts.registry.probeAll();
      const route = resolveRuntimeRoute({
        role,
        stage: req.stage,
        projectRoot: opts.projectRoot,
        registry: opts.registry,
        defaultRuntimeId: runtime.id,
        flags: opts.routingFlags,
        classification,
        riskSignals: opts.riskSignals?.(req.taskId),
        availability: routeAvailability,
        hasTargetWrite,
        businessInput: req.businessInput,
        verifiedCapabilities: opts.verifiedCapabilities,
        modelPolicy: opts.frozenModelRoute ? null : opts.modelPolicy,
        taskTier: opts.frozenModelRoute ? undefined : tierId,
        allowLegacyPolicyCompatibility: !opts.frozenModelRoute,
      });
      routingDiagnostics.push(...route.diagnostics);
      requestedRuntime = route.requested.runtimeId;
      requestedModel = route.requested.model;
      routingBasis = opts.frozenRoutingBasis ?? (route.selected
        ? `level-${route.precedenceLevel};${formatModelPolicyBasis(route.selected.policyResolution)}`
        : `level-${route.precedenceLevel}`);
      if (route.error || !route.selected) {
        const routeFailure = [route.error ?? "runtime route resolved no selected candidate", ...route.diagnostics].join(" | ");
        const failed = failResult(
          `cannot start ${role}: ${routeFailure}`,
          {
            requested_runtime: requestedRuntime,
            requested_model: requestedModel,
            routing_basis: routingBasis,
            fallback_count: 0,
          },
        );
        // An order exhausted entirely by availability probes is an outage, not a
        // task failure, so it escalates rather than spending a retry budget.
        const everyEntryUnavailable = route.attempts.length > 0 && route.attempts.every((attempt) => attempt.unavailable);
        return finish(everyEntryUnavailable
          ? { ...failed, failure: unavailableFailure(requestedRuntime ?? runtime.id, routeFailure) }
          : failed);
      }
      activeRuntime = route.selected.runtime;
      activeModel = route.selected.model ?? activeModel;
      activeModelExplicit = route.selected.modelExplicit ?? false;
      activeEffort = route.effort;
      activeAdapterEffort = route.selected.policyResolution.effortBasis === "legacy-frontmatter"
        ? undefined
        : route.effort;
      fallbackQueue = route.candidates.slice(1);
      // A candidate the route filtered out before reaching the selected one is a
      // hop too: the stage left the runtime the log records as requested.
      const selectedAt = route.attempts.findIndex((attempt) => attempt.runtime === route.selected!.runtime && !attempt.skipReason);
      preRouteSkips = selectedAt <= 0 ? [] : route.attempts.slice(0, selectedAt);
    }

    const contextBudgetMode = resolveContextBudgetModeFromProject(opts.projectRoot);
    let contextBudget = assessContextBudget(
      prompt.length,
      promptParts.budgetComposition,
      resolveContextBudgetFromProject(opts.projectRoot, role, activeModel),
      contextBudgetMode,
    );

    const candidateBudgetRejections = (): ReturnType<typeof contextBudgetRejections> => {
      const budgetScope = { taskId: req.taskId, role, stage: req.stage, runtime: activeRuntime.id, model: activeModel ?? null };
      const rejections = contextBudgetRejections(contextBudget, budgetScope);
      const taskBudgetRejection = opts.taskRunLog
        ? taskTokenBudgetRejection(opts.projectRoot, opts.taskRunLog(req.taskId), req.taskId, contextBudget.estimatedInputTokens, budgetScope)
        : null;
      if (taskBudgetRejection) rejections.push(taskBudgetRejection);
      return rejections;
    };
    // A Target-writing stage must start in its canonical Target root.  The
    // Framework binding remains explicit below, but a Framework cwd makes an
    // agent inspect the wrong repository and can turn an otherwise valid
    // packet into a no-change run.  The guard's stack rules must follow the
    // same execution root.
    const guardRoot = executionRoot;
    const guardStackRules = resolveGuardStackRules(role, guardRoot);
    // T-V8-012: measured once — role and binding root are fixed for the whole
    // retry loop below; only runtime/model/effort change across a fallback hop.
    const rolePrefixChars = measureRolePrefixChars(threeRepo?.roots.bindingRoot ?? opts.projectRoot, req.stage);

    let fallbackReason: string | undefined;
    let fallbackCount: number | undefined = opts.registry ? NO_FALLBACK_HOPS : undefined;
    const unavailableAttempts: string[] = [];

    /**
     * One camp switch: the run-log fields, plus the `ADR-025` #4 invalidation
     * note when the phase carries a `🔒` gate. A returned string is a refusal —
     * the note could not be written, so the switch must not proceed.
     */
    const recordHop = async (fromId: string, to: RuntimeAdapter, cause: string): Promise<string | null> => {
      let hop = `runtime "${fromId}" was not usable (${cause}) — routing.order moved this stage to "${to.id}"`;
      if (classification?.sensitiveGate) {
        hop += "; prior qa-engineer and security passes for this 🔒 phase no longer apply to code produced after the switch (ADR-025 #4)";
        const unrecorded = await recordCampSwitchInvalidation(
          to,
          moduleName,
          `## Camp switch — verification invalidated\n\n- task: ${req.taskId}\n- stage: ${role}\n- switched: ${fromId} → ${to.id}\n- cause: ${cause}\n- effect: code produced after this switch does not inherit this phase's earlier \`qa-engineer\` or \`security\` pass (ADR-025 #4). Re-verify the phase.`,
        );
        if (unrecorded) return unrecorded;
      }
      fallbackCount = (fallbackCount ?? 0) + 1;
      fallbackReason = fallbackReason ? `${fallbackReason} | ${hop}` : hop;
      return null;
    };

    for (const skipped of preRouteSkips) {
      const unrecorded = await recordHop(skipped.runtimeId, activeRuntime, skipped.skipReason ?? "no reason recorded");
      if (unrecorded) {
        return finish(failResult(`refusing the routing.order hop for ${role}: ${unrecorded}`, {
          requested_runtime: requestedRuntime,
          requested_model: requestedModel,
          routing_basis: routingBasis,
          fallback_reason: fallbackReason,
          fallback_count: fallbackCount,
        }));
      }
    }

    let result!: RuntimeAgentResult;
    let metrics!: RunMetrics;
    for (;;) {
      contextBudget = assessContextBudget(
        prompt.length,
        promptParts.budgetComposition,
        resolveContextBudgetFromProject(opts.projectRoot, role, activeModel),
        contextBudgetMode,
      );
      if (contextBudget.warning && !contextBudget.rejected) {
        // Deliberately observation-only: happens after assembly and before
        // execution without editing `prompt`.
        console.warn(
          `[orchestrator] WARNING: ${role} context budget exceeded: ${contextBudget.contextChars} chars > ` +
            `${contextBudget.budgetChars} (${contextBudget.budgetSource}); overflow=${contextBudget.overflowChars}. Prompt is unchanged (warning mode).`,
        );
      }

      // Budget admissibility is evaluated for the candidate about to run. It
      // never looks for another runtime to try — `UNAVAILABLE` is the only
      // trigger that moves a stage, so an inadmissible candidate fails the
      // stage closed with every rejection recorded, hop or no hop.
      const budgetRejections = candidateBudgetRejections();
      if (contextBudgetMode === "reject" && budgetRejections.length > 0) {
        return finish(failResult(
          budgetRejections.map(formatBudgetRejection).join(" | "),
          {
            model: activeModel,
            promptVersion: resolveAgentVersion(opts.projectRoot, role) ?? undefined,
            effort: activeEffort,
            requested_effort: activeEffort,
            context_chars: prompt.length,
            estimated_input_tokens: contextBudget.estimatedInputTokens,
            ...promptParts.composition,
            doc_chars_before: stageContext.docCharsBefore,
            instruction_surface_bytes: rolePrefixChars ?? undefined,
            runtime: activeRuntime.id,
            requested_runtime: requestedRuntime,
            requested_model: requestedModel,
            routing_basis: routingBasis,
            fallback_reason: fallbackReason,
            fallback_count: fallbackCount,
            context_budget_chars: contextBudget.budgetChars ?? undefined,
            context_budget_source: contextBudget.budgetSource ?? undefined,
            context_overflow_chars: contextBudget.overflowChars ?? undefined,
            context_budget_warning: true,
            context_base_chars: promptParts.budgetComposition.base,
            context_task_chars: promptParts.budgetComposition.task,
            context_safety_chars: promptParts.budgetComposition.safety,
            context_docs_chars: promptParts.budgetComposition.docs,
            context_knowledge_chars: promptParts.budgetComposition.knowledge,
            context_code_chars: promptParts.budgetComposition.code,
            context_tool_output_chars: promptParts.budgetComposition.tool_output,
            context_reserve_chars: promptParts.budgetComposition.reserve,
          },
        ));
      }

      const declared = {
        model: activeModel,
        promptVersion: resolveAgentVersion(opts.projectRoot, role) ?? undefined,
        effort: activeEffort,
        context_chars: prompt.length,
        estimated_input_tokens: contextBudget.estimatedInputTokens,
        composition: promptParts.composition,
        doc_chars_before: stageContext.docCharsBefore,
        role_prefix_chars: rolePrefixChars,
        runtime: activeRuntime.id,
        requested_runtime: requestedRuntime,
        requested_model: requestedModel,
        routing_basis: routingBasis,
        fallback_reason: fallbackReason,
        fallback_count: fallbackCount,
        contextBudget,
        budgetComposition: promptParts.budgetComposition,
      };

      // A guard gap refuses; it never hops. Landing the same Target-write stage
      // on the next camp would only move an unguarded run somewhere else.
      if (hasTargetWrite && !activeRuntime.capabilities.has(RuntimeCapability.PRE_TOOL_GUARD)) {
        return finish(failResult(`cannot start ${role}: runtime "${activeRuntime.id}" cannot enforce a pre-tool workspace guard for Target write access`, declared));
      }
      // Second gate, deliberately worded differently: this is not a safety gap,
      // it is a stage whose work — the interview — this runtime cannot do at
      // all. `resolveRuntimeRoute` already skips an incapable candidate inside a
      // configured `routing.order`'s walk; this is the defense-in-depth refusal
      // for whatever reached here regardless (an explicitly named runtime, or a
      // caller bypassing routing with a fixed `runtime` and no registry).
      if (requiresInteractivity && !activeRuntime.capabilities.has(RuntimeCapability.INTERACTIVE_PROMPTS)) {
        return finish(failResult(`cannot start ${role}: runtime "${activeRuntime.id}" cannot receive interactive prompts required by this stage`, declared));
      }
      const activeProbe = routeAvailability[activeRuntime.id];
      if (activeProbe?.available === false) {
        result = {
          status: "UNAVAILABLE",
          exitCode: null,
          text: "",
          usage: {},
          guards: { enforced: [], unenforced: [] },
          diagnostics: [activeProbe.reason ?? "availability probe reported no reason"],
        };
      } else try {
        result = await activeRuntime.executeAgent({
          role,
          // `cwd` selects the repository the agent works in; scope stays
          // independently bounded by canonical workRoots below.
          cwd: executionRoot,
          bindingRoot: threeRepo?.roots.bindingRoot,
          knowledgeRoot: threeRepo?.roots.knowledgeRoot,
          workRoots: threeRepo?.roots.workRoots,
          definitionPath: activeRuntime.binding.definitionPath(role),
          prompt,
          model: declared.model,
          modelExplicit: activeModelExplicit,
          effort: activeAdapterEffort,
          autonomy,
          guards,
          // The framework's own channel for telling a guard which role is
          // acting. Set here rather than in an adapter because every runtime's
          // guards need it and none of them can work it out alone — a hook is not
          // told which agent it is guarding. An adapter may add its own variables
          // on top; the contract says it must not drop these.
          env: {
            AGENTCLAUDE_ROLE: role,
          ...guardStackRules,
            // Guard hooks receive only tool paths, not this task's binding. Give
            // them the canonical write roots resolved by preflight; never derive
            // scope from cwd or an agent-provided path.
            ...(hasTargetWrite ? { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify(threeRepo!.roots.workRoots.filter((root) => root.access === "write").map((root) => root.path)) } : {}),
            // The read-only Knowledge context, for prompts/hooks that need to
            // name where module documents actually live.
            ...(threeRepo?.roots.knowledgeRoot ? { AGENTCLAUDE_KNOWLEDGE_ROOT: threeRepo.roots.knowledgeRoot } : {}),
          },
          timeoutMs: opts.timeoutMs,
        });
      } catch (e) {
        // `executeAgent` is contracted never to throw. If one does, that is an
        // adapter bug — and it still must not take the task down, so it lands as a
        // FAIL that names the adapter rather than the agent.
        return finish(failResult(`adapter "${activeRuntime.id}" threw instead of returning a result: ${String(e)}`, declared));
      }

      metrics = metricsFrom(result, declared);

      if (result.status !== "UNAVAILABLE" && hasTargetWrite && !result.guards.enforced.includes(RuntimeCapability.PRE_TOOL_GUARD)) {
        return finish(failResult(
          `Target-write run of ${role} was rejected because adapter "${activeRuntime.id}" did not confirm pre-tool guard enforcement${result.guards.reason ? `: ${result.guards.reason}` : ""}`,
          metrics,
        ));
      }

      // The post-hoc half of the exit-check contract. A runtime without
      // an in-band exit guard (OpenCode today, Codex on every build) finishes
      // runs that requested `code-green`/`no-hardcoded-secret` with nobody
      // having run them. The gap must be loud where a person reads the run, not
      // silently absorbed into a PASS: QA's own round is what covers it until a
      // cross-stack mechanical runner exists.
      if (guards.exitChecks.length > 0 && result.guards.unenforced.includes(RuntimeCapability.EXIT_GUARD)) {
        console.error(
          `[orchestrator] GUARD GAP: ${role} requested exit checks (${guards.exitChecks.join(", ")}) but runtime ` +
            `"${activeRuntime.id}" enforces none in-band${result.guards.reason ? ` — ${result.guards.reason}` : ""}. ` +
            `They are NOT verified for this stage; qa-engineer's round and human review are the coverage.`,
        );
      }

      if (result.status !== "UNAVAILABLE") break;

      // `UNAVAILABLE` is the only status that moves a stage (`ADR-025` #3): the
      // runtime could not be used, so nothing about the task has been judged
      // yet. `ERROR` and `TIMEOUT` fall through the break above.
      const reason = `${result.diagnostics.join("; ") || result.text || "no reason given"}.`;
      unavailableAttempts.push(`${activeRuntime.id}: ${reason}`);
      const next = fallbackQueue.shift();
      if (!next) {
        const exhausted = unavailableAttempts.length > 1
          ? ` | routing.order is exhausted — every configured runtime was unavailable: ${unavailableAttempts.join(" ")}`
          : "";
        return finish({
          ...failResult(`${describeFailure(activeRuntime.id, role, result, routingDiagnostics)}${exhausted}`, {
            ...metrics,
            fallback_reason: fallbackReason,
            fallback_count: fallbackCount,
          }),
          failure: unavailableFailure(activeRuntime.id, `${reason}${exhausted}`),
        });
      }

      const unrecorded = await recordHop(activeRuntime.id, next.runtime, reason);
      if (unrecorded) {
        return finish(failResult(
          `refusing the routing.order hop for ${role}: ${unrecorded}`,
          { ...metrics, fallback_reason: fallbackReason, fallback_count: fallbackCount },
        ));
      }
      activeRuntime = next.runtime;
      activeModel = next.model ?? resolveModel(role);
      activeModelExplicit = next.modelExplicit ?? false;
      activeEffort = next.effort;
      activeAdapterEffort = next.policyResolution.effortBasis === "legacy-frontmatter"
        ? undefined
        : next.effort;
      routingBasis = routingBasis?.split(";")[0] + `;${formatModelPolicyBasis(next.policyResolution)}`;
    }

    if (result.status !== "OK") {
      return finish(failResult(describeFailure(activeRuntime.id, role, result, routingDiagnostics), metrics));
    }

    // qa-engineer and security report their verdict in a document, not in an
    // exit status — read it back through the runtime's own workspace so this
    // works wherever the run happened, not only where the orchestrator's `fs`
    // can reach.
    if (req.stage === AgentStage.QA_ENGINEER) {
      return finish(await fingerprintVerdict(
        qaArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "review.md")),
        opts.projectRoot,
      ));
    }
    if (req.stage === AgentStage.SECURITY) {
      return finish(await fingerprintVerdict(
        securityArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "security.md")),
        opts.projectRoot,
      ));
    }

    // The five doc-producing stages each own exactly one module document. Exit 0
    // alone is not success for them — an agent that answered every question with
    // prose but never wrote its artifact would otherwise sail through as PASS,
    // and the next stage would build (or refuse to build) against a document
    // that does not exist. Same fail-closed rule as the verdict documents above:
    // a deliverable nobody can read is not a deliverable.
    const ownedDoc = OWNED_MODULE_DOC[req.stage];
    if (ownedDoc) {
      const doc = await readModuleDocVia(activeRuntime, moduleName, ownedDoc);
      if (doc === null || doc.trim() === "") {
        return finish(failResult(
          `${role} reported success but _docs/module/${moduleName}/${ownedDoc} doesn't exist (or is empty) — ` +
            `cannot confirm the stage produced its artifact`,
          metrics,
        ));
      }
      let gateEvidence: AgentExecutorResult["gateEvidence"];
      if (req.stage === AgentStage.SYSTEM_ANALYST) {
        const design = parseDesignEvidence(doc);
        if (design.mode === "addressable" && design.problems.length > 0) {
          return finish(failResult(
            `system-analyst produced invalid addressable design evidence: ${design.problems.join("; ")}`,
            metrics,
          ));
        }
        gateEvidence = { designAssessment: design.gate };
      }
      const handoff = deriveHandoff(req.stage, moduleName, doc, ownedDoc === "plan.md" ? doc : undefined, {
        taskId: req.taskId,
        phases,
      });
      for (const note of handoff.notes) {
        console.error(`[orchestrator] HANDOFF NOTE (${role}): ${note}`);
      }
      return finish({
        outcome: { ...metrics, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: handoff.artifact,
        gateEvidence,
      });
    }

    return finish({ outcome: { ...metrics, result: "PASS" } });
  };
}

/**
 * The module document each non-reviewer doc stage must leave behind for its run
 * to count as successful (`policies/documentation.md` §1). Engineers are
 * deliberately absent: their deliverable is code across many paths, and their
 * mechanical gates (typecheck/lint at Stop, QA's own round) are what verify it.
 */
const OWNED_MODULE_DOC: Partial<Record<AgentStage, string>> = {
  [AgentStage.BUSINESS_ANALYST]: "requirement.md",
  [AgentStage.SYSTEM_ANALYST]: "design.md",
  [AgentStage.PROJECT_MANAGER]: "plan.md",
  [AgentStage.TEST_PLANNER]: "test-plan.md",
  // The same artifact path `roleExecutionGate.ts` requires to be present and
  // signed off before frontend work may start — the two must name one file.
  [AgentStage.UXUI_DESIGNER]: "uxui/design.md",
};

/** The module-doc path convention (`policies/documentation.md` §1), read through the workspace rather than off disk directly. */
async function readModuleDocVia(runtime: RuntimeAdapter, moduleName: string, filename: string): Promise<string | null> {
  try {
    return await runtime.workspace.readFile(`_docs/module/${moduleName}/${filename}`);
  } catch {
    // A workspace that cannot answer is the same situation as a missing
    // document, and both fail closed one layer up: a round nobody can read is
    // not a round that passed.
    return null;
  }
}
