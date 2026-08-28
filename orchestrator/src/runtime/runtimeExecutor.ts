import * as path from "node:path";
import { AgentStage, TaskLevel } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { getAgent } from "../agents/registry.js";
import { resolveAgentModel, resolveAgentVersion } from "../agents/agentModel.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import {
  buildPromptParts,
  compileExecutionPacket,
  assembleStageContext,
  handoffFromContext,
  failResult,
  qaArtifactResult,
  securityArtifactResult,
  type PromptPartsResult,
  type RunMetrics,
} from "./agentRunAssembly.js";
import type {
  RuntimeAdapter,
  RuntimeAgentResult,
  RuntimeAutonomy,
  RuntimeGuards,
} from "./runtimeAdapter.js";
import type { RuntimeRegistry } from "./runtimeRegistry.js";
import { resolveRuntimeRoute } from "./runtimeRouting.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { checkRoleExecutionGate } from "../roles/roleExecutionGate.js";
import type { PersistedTask } from "../store/taskStore.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import type { ThreeRepoRequestRoots } from "../threeRepo/preflight.js";
import { deriveHandoff } from "../agents/moduleDocs.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { assessContextBudget, resolveContextBudgetFromProject, type ContextBudgetComposition } from "../context/contextBudget.js";
import { writeExecutionPacket } from "../state/runtimeArtifacts.js";

/**
 * An `AgentExecutor` built on a `RuntimeAdapter` (T108).
 *
 * This is the whole point of the interface: the orchestrator gets the same
 * pluggable seam it always had, and what sits behind it is now a choice. Nothing
 * in this file names a runtime, reads a runtime's flag, or parses a runtime's
 * envelope — swap the adapter and every line here still applies.
 *
 * `agents/claudeCliExecutor.ts` remains as it was and is still what `cli.ts`
 * uses. Repointing it is T109's job, together with the Claude Code adapter it
 * would point at; doing both in this task would have removed the only evidence
 * that the extraction into `agentRunAssembly.ts` changed nothing.
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
  guards: (role: string) => RuntimeGuards;
  /** How much autonomy each run gets. Defaults to `propose` — the orchestrator automates handoffs between the pipeline's confirmation points, it does not remove them. */
  autonomy?: RuntimeAutonomy;
  /**
   * Which model a role runs on.
   *
   * Defaults to the role definition's own `model:` frontmatter — T58's answer,
   * and still the only declaration of it. This function is the seam T112 fills
   * when a per-task or per-policy override has to layer over that.
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
  /** T42 � per-stage working directory for a project whose pipeline spans several repos. */
  stageRoots?: Partial<Record<AgentStage, string>>;
  /** Phase 2's fail-closed resolver. When present it runs before adapter start. */
  threeRepoTask?: (taskId: string, stage: AgentStage) => { task: PersistedTask; roots: ThreeRepoRequestRoots };
  /** Stored Phase-1 task contract. Production supplies this for every runnable task. */
  runtimeTask?: (taskId: string) => RuntimeTask | null | undefined;
  /** Optional bounded retention override; the runtime-artifact default otherwise applies. */
  packetRetention?: number;
  /**
   * T114 — make the BA → SA → DEV human handoffs a prerequisite of the lead
   * stages. Off by default so a project that has not adopted V1.5 knowledge
   * workspaces preserves the pre-T114 execution path.
   */
  enforceRoleWorkflow?: boolean;
  /**
   * T112 — when given, a role's runtime and model are resolved per run via
   * `runtimeRouting.ts` (`.sta/config.yaml`'s `model_routing`, extended to a
   * `runtime:model` syntax) instead of always executing on `runtime`. `runtime`
   * stays the fallback a route resolves to when its override names an
   * unregistered runtime, or when there is no override at all. Left unset,
   * behaviour is identical to before T112: every run goes to `runtime` with the
   * model `opts.model` (or the role's own frontmatter) picked.
   *
   * Deliberately opt-in rather than wired into `cli.ts`'s production path — see
   * `HANDOFF_V1.md` §21 for why: routing to a second runtime is only as trustworthy
   * as that runtime's adapter, and `codexAdapter.ts` (T110) is an explicitly
   * partial, unverified implementation. Turning this on for a real pipeline run
   * is a decision for whoever configures `model_routing`, not a default this
   * executor should assume.
   */
  registry?: RuntimeRegistry;
  /** T111's verified capability picture per runtime id, passed through to `resolveRuntimeRoute` so its capability-policy diagnostic uses confirmed facts instead of a static claim, when available. */
  verifiedCapabilities?: Readonly<Record<string, ReadonlySet<RuntimeCapability>>>;
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

/** Maps a runtime's normalised usage onto the fields the run log records (T26/T28). */
function metricsFrom(result: RuntimeAgentResult, declared: {
  model?: string;
  promptVersion?: number;
  context_chars: number;
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
  contextBudget: ReturnType<typeof assessContextBudget>;
  budgetComposition: ContextBudgetComposition;
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
    tokens: (input_tokens ?? 0) + (output_tokens ?? 0),
    // `?? 0` here, unlike the `costUsd?: number` in the envelope: the run log's
    // `cost` is a number by contract, and "this runtime does not report cost" is
    // recorded as the absent COST_REPORTING capability, not as a fake figure in
    // every row.
    cost: result.usage.costUsd ?? 0,
    input_tokens,
    output_tokens,
    cache_read_tokens: result.usage.cachedInputTokens,
    context_chars: declared.context_chars,
    runtime: declared.runtime,
    session_kind: "orchestrated",
    ...declared.composition,
    doc_chars_before: declared.doc_chars_before,
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
    let stageContext;
    try {
      stageContext = sliceDocs
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

    let guards: RuntimeGuards;
    try {
      guards = opts.guards(role);
    } catch (e) {
      // The current role contract is the authority packet scope narrows. A run
      // with no resolved contract must not compile a packet or start an adapter.
      return failResult(`cannot start ${role}: ${String(e)}`);
    }

    const runtimeTask = threeRepo?.task.runtimeTask ?? opts.runtimeTask?.(req.taskId) ?? null;
    let packetPath: string | undefined;
    let promptParts: PromptPartsResult;
    if (runtimeTask) {
      try {
        const packet = compileExecutionPacket({
          req,
          role,
          runtimeTask,
          contractScope: { allow: guards.writeAllow, deny: guards.writeDeny },
          extra: opts.extraInstruction,
          sources: {
            docs: stageContext.docs,
            knowledge: stageContext.knowledge,
            codeIntel: stageContext.codeIntel,
          },
        });
        const runtimeStateRoot = threeRepo?.roots.bindingRoot ?? opts.projectRoot;
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
      // Historical or embedded callers may have no RuntimeTask. Production
      // tasks created since state schema v13 always take the packet path above.
      promptParts = buildPromptParts(req, opts.extraInstruction, {
        docs: stageContext.docs,
        knowledge: stageContext.knowledge,
        codeIntel: stageContext.codeIntel,
      });
    }
    const prompt = promptParts.text;
    const finish = (result: AgentExecutorResult): AgentExecutorResult =>
      packetPath ? { ...result, packetPath } : result;

    // T112: resolve which runtime and model this run actually goes to. Absent
    // `opts.registry`, `activeRuntime`/`activeModel` are exactly `runtime` and
    // `resolveModel(role)` — identical to pre-T112 behaviour.
    let activeRuntime = runtime;
    let activeModel = resolveModel(role);
    const routingDiagnostics: string[] = [];
    if (opts.registry) {
      const route = resolveRuntimeRoute({
        role,
        stage: req.stage,
        projectRoot: opts.projectRoot,
        registry: opts.registry,
        defaultRuntimeId: runtime.id,
        verifiedCapabilities: opts.verifiedCapabilities,
      });
      activeRuntime = route.runtime;
      activeModel = route.model ?? activeModel;
      routingDiagnostics.push(...route.diagnostics);
    }

    const contextBudget = assessContextBudget(
      prompt.length,
      promptParts.budgetComposition,
      resolveContextBudgetFromProject(opts.projectRoot, role, activeModel),
    );
    if (contextBudget.warning) {
      // T-V3TOK-100 is deliberately observation-only. In particular, this
      // happens after assembly and before execution without editing `prompt`.
      console.warn(
        `[orchestrator] WARNING: ${role} context budget exceeded: ${contextBudget.contextChars} chars > ` +
          `${contextBudget.budgetChars} (${contextBudget.budgetSource}); overflow=${contextBudget.overflowChars}. Prompt is unchanged (warning mode).`,
      );
    }

    const declared = {
      model: activeModel,
      promptVersion: resolveAgentVersion(opts.projectRoot, role) ?? undefined,
      context_chars: prompt.length,
      composition: promptParts.composition,
      doc_chars_before: stageContext.docCharsBefore,
      runtime: activeRuntime.id,
      contextBudget,
      budgetComposition: promptParts.budgetComposition,
    };

    let result: RuntimeAgentResult;
    const hasTargetWrite = threeRepo?.roots.workRoots.some((root) => root.access === "write") ?? false;
    if (hasTargetWrite && !activeRuntime.capabilities.has(RuntimeCapability.PRE_TOOL_GUARD)) {
      return finish(failResult(`cannot start ${role}: runtime "${activeRuntime.id}" cannot enforce a pre-tool workspace guard for Target write access`, declared));
    }
    try {
      result = await activeRuntime.executeAgent({
        role,
        // Binding/config lives in the Framework root; workspace access arrives
        // separately so changing cwd cannot widen a task's write scope.
        cwd: threeRepo?.roots.bindingRoot ?? opts.stageRoots?.[req.stage] ?? opts.projectRoot,
        bindingRoot: threeRepo?.roots.bindingRoot,
        knowledgeRoot: threeRepo?.roots.knowledgeRoot,
        workRoots: threeRepo?.roots.workRoots,
        definitionPath: activeRuntime.binding.definitionPath(role),
        prompt,
        model: declared.model,
        autonomy,
        guards,
        // T15: the framework's own channel for telling a guard which role is
        // acting. Set here rather than in an adapter because every runtime's
        // guards need it and none of them can work it out alone — a hook is not
        // told which agent it is guarding. An adapter may add its own variables
        // on top; the contract says it must not drop these.
        env: {
          AGENTCLAUDE_ROLE: role,
          // Guard hooks receive only tool paths, not this task's binding. Give
          // them the canonical write roots resolved by preflight; never derive
          // scope from cwd or an agent-provided path.
          ...(hasTargetWrite ? { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify(threeRepo!.roots.workRoots.filter((root) => root.access === "write").map((root) => root.path)) } : {}),
          // T-WG7 — the read-only Knowledge context, for prompts/hooks that
          // need to name where module documents actually live.
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

    const metrics = metricsFrom(result, declared);

    if (hasTargetWrite && !result.guards.enforced.includes(RuntimeCapability.PRE_TOOL_GUARD)) {
      return finish(failResult(
        `Target-write run of ${role} was rejected because adapter "${activeRuntime.id}" did not confirm pre-tool guard enforcement${result.guards.reason ? `: ${result.guards.reason}` : ""}`,
        metrics,
      ));
    }

    // T-OC7 — the post-hoc half of the exit-check contract. A runtime without
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

    if (result.status === "UNAVAILABLE") {
      return finish({
        ...failResult(describeFailure(activeRuntime.id, role, result, routingDiagnostics), metrics),
        failure: unavailableFailure(activeRuntime.id, result.diagnostics.join("; ") || result.text || "no reason given"),
      });
    }
    if (result.status !== "OK") {
      return finish(failResult(describeFailure(activeRuntime.id, role, result, routingDiagnostics), metrics));
    }

    // qa-engineer and security report their verdict in a document, not in an
    // exit status — read it back through the runtime's own workspace so this
    // works wherever the run happened, not only where the orchestrator's `fs`
    // can reach.
    if (req.stage === AgentStage.QA_ENGINEER) {
      return finish(qaArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "review.md")));
    }
    if (req.stage === AgentStage.SECURITY) {
      return finish(securityArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "security.md")));
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
