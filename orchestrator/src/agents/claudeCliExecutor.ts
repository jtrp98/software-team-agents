import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { getAgent } from "./registry.js";
import { readModuleDoc, parseQaReport, parseSecurityReport } from "./moduleDocs.js";

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
  options: { cwd: string; encoding: "utf8"; input?: string; timeout?: number; maxBuffer?: number },
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
}

interface ClaudeCliJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function buildPrompt(req: AgentExecutorRequest, extra?: string): string {
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

  return function claudeCliExecutor(req: AgentExecutorRequest): AgentExecutorResult {
    const agent = getAgent(req.stage);
    const prompt = buildPrompt(req, opts.extraInstruction);

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

    let proc: SpawnSyncReturns<string>;
    try {
      proc = spawn("claude", args, { cwd: opts.projectRoot, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      return failResult(`failed to spawn \`claude\` CLI for stage ${req.stage}: ${String(e)}`);
    }

    if (proc.error) {
      return failResult(`\`claude\` CLI errored for stage ${req.stage}: ${proc.error.message}`);
    }

    const cli = parseCliOutput(proc.stdout ?? "");
    const tokens = (cli.usage?.input_tokens ?? 0) + (cli.usage?.output_tokens ?? 0);
    const cost = cli.total_cost_usd ?? 0;

    const cliFailed = proc.status !== 0 || cli.is_error === true;
    if (cliFailed) {
      return failResult(
        `\`claude --agent ${agent.role}\` exited ${proc.status ?? "unknown"}: ${(cli.result ?? proc.stderr ?? "").slice(0, 2000)}`,
        tokens,
        cost,
      );
    }

    if (req.stage === AgentStage.QA_ENGINEER) {
      return withQaArtifact(req, tokens, cost, opts.projectRoot, opts.moduleName(req.taskId));
    }
    if (req.stage === AgentStage.SECURITY) {
      return withSecurityArtifact(req, tokens, cost, opts.projectRoot, opts.moduleName(req.taskId));
    }

    return { outcome: { tokens, cost, result: "PASS" } };
  };
}

function failResult(reason: string, tokens = 0, cost = 0): AgentExecutorResult {
  return { outcome: { tokens, cost, result: "FAIL", failure_reason: reason } };
}

function withQaArtifact(
  req: AgentExecutorRequest,
  tokens: number,
  cost: number,
  projectRoot: string,
  moduleName: string,
): AgentExecutorResult {
  const reviewMd = readModuleDoc(projectRoot, moduleName, "review.md");
  if (reviewMd === null) {
    return failResult(
      `qa-engineer reported success but _docs/module/${moduleName}/review.md doesn't exist — cannot confirm the round`,
      tokens,
      cost,
    );
  }
  const { artifact } = parseQaReport(req.taskId, reviewMd);
  return {
    outcome: { tokens, cost, result: artifact.status },
    artifactType: ArtifactType.QA_REPORT,
    artifact,
  };
}

function withSecurityArtifact(
  req: AgentExecutorRequest,
  tokens: number,
  cost: number,
  projectRoot: string,
  moduleName: string,
): AgentExecutorResult {
  const securityMd = readModuleDoc(projectRoot, moduleName, "security.md");
  if (securityMd === null) {
    return failResult(
      `security reported success but _docs/module/${moduleName}/security.md doesn't exist — cannot confirm findings`,
      tokens,
      cost,
    );
  }
  const artifact = parseSecurityReport(req.taskId, securityMd);
  return {
    outcome: { tokens, cost, result: artifact.overallStatus },
    artifactType: ArtifactType.SECURITY_REPORT,
    artifact,
  };
}
