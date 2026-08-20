import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { getAgent } from "./registry.js";
import { resolveAgentModel, resolveAgentVersion } from "./agentModel.js";
import { readModuleDoc, parseQaReport, parseSecurityReport } from "./moduleDocs.js";
import { ContextManager, type SelectedContext } from "../context/contextManager.js";
import { classifyQaFailure, classifySecurityFailure } from "../orchestrator/failureClassifier.js";

/**
 * The concrete `AgentExecutor` (orchestrator/orchestrator.ts's pluggable
 * seam, item 13) that actually runs this repo's real `.claude/agents/*.md`
 * subagents instead of a caller-supplied stub. This is what turns the
 * orchestrator from a simulation of CLAUDE.md's pipeline into something that
 * drives it: `claude -p --agent <role>` in the project directory resolves
 * the exact same `.claude/agents/<role>.md` file the interactive session
 * would, so `AGENT_REGISTRY`'s `role` field (agents/registry.ts) IS the
 * `--agent` value, not a separate mapping to keep in sync.
 *
 * `qa-engineer` and `security` don't emit the orchestrator's structured
 * artifacts directly — they write `review.md`/`security.md` in prose, per
 * convention. This executor reads those files back with
 * `agents/moduleDocs.ts` after the CLI run finishes, so the gate context
 * (gates/gatePolicy.ts) gets real evidence instead of a guess.
 */

export type SpawnSync = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    input?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
) => SpawnSyncReturns<string>;

export interface ClaudeCliExecutorOptions {
  /** Root of the target project — where `.claude/agents/<role>.md` and `_docs/` live. */
  projectRoot: string;
  /** Resolves a task to the `_docs/module/<name>/` folder its docs live under. Required for QA/security artifact parsing; other stages don't need it. */
  moduleName: (taskId: string) => string;
  /** `claude -p` permission mode. Defaults to "manual" — this executor never bypasses the pipeline's own confirmation points, it only automates the handoff between them (CLAUDE.md's opt-in autonomous mode). */
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
  /** Per-call timeout in ms. A subagent run can be long — default is generous, not absent. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Extra instruction appended to every stage's prompt, e.g. a link to a ticket. */
  extraInstruction?: string;
  /**
   * Which phases of `plan.md` this task touches, used to slice the module docs
   * down to the sections this run needs (`policies/documentation.md` §10). Returning
   * undefined is safe: the plan then comes through whole rather than sliced
   * wrong.
   */
  phases?: (taskId: string) => number[] | undefined;
  /**
   * Set false to send no module-doc context at all and let the agent read the
   * docs itself, as it did before T05. On by default: the whole point is that
   * an agent starting from a fresh context should not pay to re-read a 900-line
   * plan to implement one phase of it.
   */
  sliceModuleDocs?: boolean;
  /**
   * T42: per-stage working directory override, for a project whose pipeline
   * spans more than one repo (a frontend repo, a backend repo, an infra
   * repo). A stage missing from this map — or the map itself being absent —
   * spawns `claude` in `projectRoot`, exactly as before T42. `_docs/` and
   * `.claude/agents/` are still only ever resolved against `projectRoot`:
   * only the working directory `claude` actually runs in moves.
   */
  stageRoots?: Partial<Record<AgentStage, string>>;
}

interface ClaudeCliJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

/**
 * Renders the sliced module docs, and — just as importantly — says what was cut.
 *
 * An agent that is handed a subset with no note of what is missing cannot tell a
 * section that was dropped from one that never existed, so it cannot ask for it.
 * Naming the skipped headings and the file they came from keeps the filter an
 * optimization the agent can undo, rather than a silent edit of its inputs.
 */
function renderSlicedDocs(selected: SelectedContext[], cm: ContextManager): string[] {
  if (selected.length === 0) return [];

  const parts: string[] = ["", "Module documents, sliced to what this stage needs (`policies/documentation.md` §10):"];
  for (const s of selected) {
    parts.push("", `### ${s.doc}.md`);
    if (!s.fullDocument && s.skipped.length > 0) {
      parts.push(
        `_Sections not included: ${s.skipped.join(", ")}. ` +
          `The full file is at \`${cm.path(s.doc)}\` — read it if one of those turns out to matter._`,
        "",
      );
    }
    parts.push(s.text);
  }
  return parts;
}

/**
 * T44 — what `req.deployPhase` means for the one stage that gets it (devops). The orchestrator
 * has already enforced the structural half (execute is unreachable without the DEPLOY approval
 * gate having passed — see `isAgentAssignedAt` in taskStatus.ts); this only tells the agent which
 * of the two runs it's in, since devops.md's own rules read differently depending on which.
 */
const DEPLOY_PHASE_INSTRUCTION: Record<"prepare" | "execute", string> = {
  prepare:
    "Deploy phase: PREPARE. Do only what's safe to run unattended — Dockerfile/CI workflow/config, a migration dry-run, and — if this deploy includes a migration against a shared or production database — take and record a real, restorable backup before this run ends (T46: no backup, no migration). " +
    "Do NOT run the actual deploy or migration command in this run; that happens in a separate EXECUTE run, after the orchestrator's own human approval gate.",
  execute:
    "Deploy phase: EXECUTE. The orchestrator's structural approval gate for this deploy has already been granted — this run is what actually issues the deploy/migration command, then verifies the result (service health, and — for a migration — the schema/data actually match what was intended, T46). " +
    "Still follow your own agent instructions for what to confirm and verify; the gate having passed doesn't relax those. Report failure plainly if verification doesn't pass — do not soften it into a success.",
};

function buildPrompt(req: AgentExecutorRequest, extra?: string, sliced?: string[]): string {
  const parts: string[] = [
    `Task ${req.taskId} — you are running as the \`${req.stage}\` stage of this repo's pipeline (see CLAUDE.md).`,
    "",
  ];
  if (req.context.length === 0) {
    parts.push("No prior-stage context was supplied for this task — proceed from the repo's own docs (`_docs/status.md` first, per convention).");
  } else {
    parts.push("Context assembled for you by the orchestrator (already filtered to what this stage may read):");
    for (const item of req.context) {
      parts.push("", `### ${item.source}`, item.content);
    }
  }
  if (sliced && sliced.length > 0) parts.push(...sliced);
  if (req.deployPhase) parts.push("", DEPLOY_PHASE_INSTRUCTION[req.deployPhase]);
  if (extra) parts.push("", extra);
  parts.push(
    "",
    "Finish by stating clearly what you completed and, per convention, what should happen next — the orchestrator reads your exit status and the docs you wrote, not a special reply format.",
  );
  return parts.join("\n");
}

function parseCliOutput(raw: string): ClaudeCliJsonResult {
  try {
    return JSON.parse(raw) as ClaudeCliJsonResult;
  } catch {
    return {};
  }
}

/** Creates the real executor. Throws nothing itself — a spawn failure or non-JSON output becomes a FAIL outcome, since a task that can't tell what happened must not silently look like a PASS. */
export function createClaudeCliExecutor(opts: ClaudeCliExecutorOptions): AgentExecutor {
  const spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
  const permissionMode = opts.permissionMode ?? "manual";
  const timeout = opts.timeoutMs ?? 30 * 60_000;

  const sliceDocs = opts.sliceModuleDocs ?? true;

  return function claudeCliExecutor(req: AgentExecutorRequest): AgentExecutorResult {
    const agent = getAgent(req.stage);

    // Additive context. Anything that goes wrong resolving or reading the docs
    // leaves the prompt exactly as it was before T05 — the agent then reads them
    // itself, which is slower but never wrong.
    let sliced: string[] = [];
    if (sliceDocs) {
      try {
        const cm = new ContextManager({ projectRoot: opts.projectRoot, moduleName: opts.moduleName(req.taskId) });
        sliced = renderSlicedDocs(cm.forStage(req.stage, opts.phases?.(req.taskId)), cm);
      } catch {
        sliced = [];
      }
    }

    const prompt = buildPrompt(req, opts.extraInstruction, sliced);
    const model = resolveAgentModel(opts.projectRoot, agent.role) ?? undefined;
    const promptVersion = resolveAgentVersion(opts.projectRoot, agent.role) ?? undefined;
    const context_chars = prompt.length;

    const args = [
      "-p",
      "--agent",
      agent.role,
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      prompt,
    ];

    const cwd = opts.stageRoots?.[req.stage] ?? opts.projectRoot;

    let proc: SpawnSyncReturns<string>;
    try {
      proc = spawn("claude", args, {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        // T15: the one way a PreToolUse hook can know which agent is writing.
        // Hooks get no subagent identity of their own, so the orchestrator — which
        // does know, because it chose the role — passes it down. Without this the
        // path guard can only enforce the universal floor.
        env: { ...process.env, AGENTCLAUDE_ROLE: agent.role },
      });
    } catch (e) {
      return failResult(`failed to spawn \`claude\` CLI for stage ${req.stage}: ${String(e)}`, { model, promptVersion, context_chars });
    }

    if (proc.error) {
      return failResult(`\`claude\` CLI errored for stage ${req.stage}: ${proc.error.message}`, { model, promptVersion, context_chars });
    }

    const cli = parseCliOutput(proc.stdout ?? "");
    const input_tokens = cli.usage?.input_tokens ?? 0;
    const output_tokens = cli.usage?.output_tokens ?? 0;
    const metrics: Metrics = {
      model,
      promptVersion,
      tokens: input_tokens + output_tokens,
      cost: cli.total_cost_usd ?? 0,
      input_tokens,
      output_tokens,
      cache_read_tokens: cli.usage?.cache_read_input_tokens,
      context_chars,
    };

    const cliFailed = proc.status !== 0 || cli.is_error === true;
    if (cliFailed) {
      return failResult(
        `\`claude --agent ${agent.role}\` exited ${proc.status ?? "unknown"}: ${(cli.result ?? proc.stderr ?? "").slice(0, 2000)}`,
        metrics,
      );
    }

    if (req.stage === AgentStage.QA_ENGINEER) {
      return withQaArtifact(req, metrics, opts.projectRoot, opts.moduleName(req.taskId));
    }
    if (req.stage === AgentStage.SECURITY) {
      return withSecurityArtifact(req, metrics, opts.projectRoot, opts.moduleName(req.taskId));
    }

    return { outcome: { ...metrics, result: "PASS" } };
  };
}

/** Everything T26/T28/T57 want logged, threaded as one bundle instead of a growing positional-argument list. */
interface Metrics {
  model?: string;
  promptVersion?: number;
  tokens: number;
  cost: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  context_chars: number;
}

function failResult(reason: string, metrics: Partial<Metrics> = {}): AgentExecutorResult {
  return { outcome: { tokens: 0, cost: 0, context_chars: 0, ...metrics, result: "FAIL", failure_reason: reason } };
}

function withQaArtifact(
  req: AgentExecutorRequest,
  metrics: Metrics,
  projectRoot: string,
  moduleName: string,
): AgentExecutorResult {
  const reviewMd = readModuleDoc(projectRoot, moduleName, "review.md");
  if (reviewMd === null) {
    return failResult(
      `qa-engineer reported success but _docs/module/${moduleName}/review.md doesn't exist — cannot confirm the round`,
      metrics,
    );
  }
  const { artifact } = parseQaReport(req.taskId, reviewMd);
  return {
    outcome: { ...metrics, result: artifact.status },
    artifactType: ArtifactType.QA_REPORT,
    artifact,
    // T06: on a failed round, hand the orchestrator the owner qa-engineer already
    // wrote in `## Open Issues`, so a schema gap does not get routed to an
    // engineer as though it were a bug. Undefined when the doc names no owner —
    // the classifier escalates rather than guessing, and an absent failure keeps
    // the pre-T06 fallback.
    failure: artifact.status === "FAIL" ? (classifyQaFailure(reviewMd) ?? undefined) : undefined,
  };
}

function withSecurityArtifact(
  req: AgentExecutorRequest,
  metrics: Metrics,
  projectRoot: string,
  moduleName: string,
): AgentExecutorResult {
  const securityMd = readModuleDoc(projectRoot, moduleName, "security.md");
  if (securityMd === null) {
    return failResult(
      `security reported success but _docs/module/${moduleName}/security.md doesn't exist — cannot confirm findings`,
      metrics,
    );
  }
  const artifact = parseSecurityReport(req.taskId, securityMd);
  return {
    outcome: { ...metrics, result: artifact.overallStatus },
    artifactType: ArtifactType.SECURITY_REPORT,
    artifact,
    failure:
      artifact.overallStatus === "FAIL" ? (classifySecurityFailure(securityMd, req.taskId) ?? undefined) : undefined,
  };
}
