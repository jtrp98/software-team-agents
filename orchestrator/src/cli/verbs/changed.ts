import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitChangedFiles } from "../../qa/changeSource.js";
import { changedRunSummary, observeRuns, type ChangedRunSummary } from "../../run/observability.js";
import { flagValue } from "../support.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GateResultItem {
  dir?: string;
  check: string;
  status: string;
  command?: string;
  reason?: string;
  output?: string;
}

export interface GateReport {
  ok: boolean;
  status: "passed" | "failed" | "unverified";
  results: GateResultItem[];
  profile?: string;
  message?: string;
}

export interface ChangedSummary {
  projectRoot: string;
  isGit: boolean;
  gitError?: string;
  changedFiles: string[];
  gate: GateReport;
  disclaimer: string;
  run?: ChangedRunSummary;
}

const GATE_DISCLAIMER =
  "Deterministic compiler, linter and test gate only — NOT a QA verdict. QA evaluation is performed by qa-engineer against requirement and design contracts.";

/**
 * Finds the static-analysis-gate script to run: either in the target workspace's
 * synced .claude/scripts or falling back to this framework's own copy.
 */
function resolveGateScript(projectRoot: string): string | null {
  const local = path.join(projectRoot, ".claude", "scripts", "static-analysis-gate.js");
  if (fs.existsSync(local)) return local;
  const fallback = path.resolve(__dirname, "..", "..", "..", "..", ".claude", "scripts", "static-analysis-gate.js");
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

/** Runs the static analysis gate script with --json and returns parsed report. */
async function executeStaticAnalysisGate(projectRoot: string): Promise<GateReport> {
  const scriptPath = resolveGateScript(projectRoot);
  if (!scriptPath) {
    return {
      ok: false,
      status: "unverified",
      results: [],
      message: "no static-analysis-gate.js script found; deterministic sweep could not run",
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(process.execPath, [scriptPath, "--json"], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      resolve({
        ok: false,
        status: "unverified",
        results: [],
        message: `failed to spawn static-analysis-gate: ${err.message}`,
      });
    });

    proc.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout);
        const verification = parsed.verification as "passed" | "failed" | "unverified" | undefined;
        const status = verification ?? (parsed.ok ? "passed" : code === 2 ? "unverified" : "failed");
        resolve({
          ok: Boolean(parsed.ok),
          status,
          results: Array.isArray(parsed.results) ? parsed.results : [],
          profile: parsed.profile,
        });
      } catch {
        resolve({
          ok: code === 0,
          status: code === 0 ? "passed" : code === 2 ? "unverified" : "failed",
          results: [],
          message: stderr.trim() || stdout.trim() || `gate process exited with code ${code}`,
        });
      }
    });
  });
}

/** Computes changed files via read-only git and pairs them with static-analysis-gate output. */
export async function getChangedSummary(projectRoot: string): Promise<ChangedSummary> {
  let isGit = true;
  let gitError: string | undefined;
  let changedFiles: string[] = [];

  try {
    changedFiles = await gitChangedFiles(projectRoot);
  } catch (err) {
    isGit = false;
    gitError = err instanceof Error ? err.message : String(err);
    changedFiles = [];
  }

  const gate = await executeStaticAnalysisGate(projectRoot);
  let run: ChangedRunSummary | undefined;
  try {
    const latest = (await observeRuns(projectRoot))[0];
    if (latest) run = changedRunSummary(latest);
  } catch {}

  return {
    projectRoot,
    isGit,
    gitError,
    changedFiles,
    gate,
    disclaimer: GATE_DISCLAIMER,
    run,
  };
}

/** `changed [--project-root <path>] [--json]` verb. */
export async function runChangedVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  const asJson = rest.includes("--json");

  const summary = await getChangedSummary(projectRoot);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`[orchestrator] target: ${summary.projectRoot}`);

  if (!summary.isGit) {
    console.log(`[orchestrator] git status: not a git repository or inspection failed (${summary.gitError})`);
  } else if (summary.changedFiles.length === 0) {
    console.log("[orchestrator] changed files: none (working tree clean)");
  } else {
    console.log(`[orchestrator] changed files (${summary.changedFiles.length}):`);
    for (const f of summary.changedFiles) {
      console.log(`  ${f}`);
    }
  }

  console.log(`[orchestrator] deterministic gate: ${summary.gate.status.toUpperCase()}`);
  if (summary.gate.profile) {
    console.log(`  profile: ${summary.gate.profile}`);
  }
  if (summary.gate.results.length > 0) {
    for (const r of summary.gate.results) {
      const mark = r.status === "passed" ? "ok  " : r.status === "skipped" ? "skip" : "FAIL";
      const label = r.dir && r.dir !== "." ? `${r.dir} :: ${r.check}` : r.check;
      console.log(`  ${mark}  ${label}${r.reason ? ` (${r.reason})` : ""}`);
    }
  } else if (summary.gate.message) {
    console.log(`  ${summary.gate.message}`);
  }

  if (summary.run) {
    console.log(`[orchestrator] run ${summary.run.run_id} branch=${summary.run.run_branch}`);
    for (const checkpoint of summary.run.checkpoints) {
      console.log(`[orchestrator] ${checkpoint.task_id} CHECKPOINTED at ${checkpoint.sha}: ${checkpoint.subject}`);
    }
    console.log("[orchestrator] notice: deterministic gate only; CHECKPOINTED is not a QA verdict.");
  }

  console.log(`[orchestrator] notice: ${summary.disclaimer}`);
  return 0;
}
