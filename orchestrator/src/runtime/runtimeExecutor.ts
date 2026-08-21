import { AgentStage } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { getAgent } from "../agents/registry.js";
import { resolveAgentModel, resolveAgentVersion } from "../agents/agentModel.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import {
  buildPrompt,
  failResult,
  qaArtifactResult,
  securityArtifactResult,
  sliceModuleDocsFor,
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
  /** T42 — per-stage working directory for a project whose pipeline spans several repos. */
  stageRoots?: Partial<Record<AgentStage, string>>;
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
}): RunMetrics {
  const input_tokens = result.usage.inputTokens ?? 0;
  const output_tokens = result.usage.outputTokens ?? 0;
  return {
    // What the runtime says it used, falling back to what was configured. A
    // runtime that reports its own model is the better source: a routing
    // override or a runtime-side substitution would otherwise be logged as the
    // frontmatter value, which is the one thing the log must not do.
    model: result.model ?? declared.model,
    promptVersion: declared.promptVersion,
    tokens: input_tokens + output_tokens,
    // `?? 0` here, unlike the `costUsd?: number` in the envelope: the run log's
    // `cost` is a number by contract, and "this runtime does not report cost" is
    // recorded as the absent COST_REPORTING capability, not as a fake figure in
    // every row.
    cost: result.usage.costUsd ?? 0,
    input_tokens,
    output_tokens,
    cache_read_tokens: result.usage.cachedInputTokens,
    context_chars: declared.context_chars,
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

    const sliced = sliceDocs
      ? sliceModuleDocsFor(req.stage, {
          projectRoot: opts.projectRoot,
          moduleName,
          phases: opts.phases?.(req.taskId),
        })
      : [];

    const prompt = buildPrompt(req, opts.extraInstruction, sliced);

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

    const declared = {
      model: activeModel,
      promptVersion: resolveAgentVersion(opts.projectRoot, role) ?? undefined,
      context_chars: prompt.length,
    };

    let guards: RuntimeGuards;
    try {
      guards = opts.guards(role);
    } catch (e) {
      // A run whose write scope could not be resolved must not start. This is
      // the one place the executor refuses before reaching the runtime at all.
      return failResult(`cannot start ${role}: ${String(e)}`, declared);
    }

    let result: RuntimeAgentResult;
    try {
      result = await activeRuntime.executeAgent({
        role,
        cwd: opts.stageRoots?.[req.stage] ?? opts.projectRoot,
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
        env: { AGENTCLAUDE_ROLE: role },
        timeoutMs: opts.timeoutMs,
      });
    } catch (e) {
      // `executeAgent` is contracted never to throw. If one does, that is an
      // adapter bug — and it still must not take the task down, so it lands as a
      // FAIL that names the adapter rather than the agent.
      return failResult(`adapter "${activeRuntime.id}" threw instead of returning a result: ${String(e)}`, declared);
    }

    const metrics = metricsFrom(result, declared);

    if (result.status === "UNAVAILABLE") {
      return {
        ...failResult(describeFailure(activeRuntime.id, role, result, routingDiagnostics), metrics),
        failure: unavailableFailure(activeRuntime.id, result.diagnostics.join("; ") || result.text || "no reason given"),
      };
    }
    if (result.status !== "OK") {
      return failResult(describeFailure(activeRuntime.id, role, result, routingDiagnostics), metrics);
    }

    // qa-engineer and security report their verdict in a document, not in an
    // exit status — read it back through the runtime's own workspace so this
    // works wherever the run happened, not only where the orchestrator's `fs`
    // can reach.
    if (req.stage === AgentStage.QA_ENGINEER) {
      return qaArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "review.md"));
    }
    if (req.stage === AgentStage.SECURITY) {
      return securityArtifactResult(req, metrics, moduleName, await readModuleDocVia(activeRuntime, moduleName, "security.md"));
    }

    return { outcome: { ...metrics, result: "PASS" } };
  };
}

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
