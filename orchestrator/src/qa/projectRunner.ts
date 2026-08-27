import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RuntimeWorkspace } from "../runtime/runtimeAdapter.js";
import { TargetConfigSchema } from "../targetcli/targetMeta.js";
import type { DeterministicCheckId, DeterministicCheckResult, DeterministicRunner } from "./deterministic.js";

/** The machine-readable subset of the existing static-analysis gate report. */
interface StaticGateReport {
  verification?: "passed" | "failed" | "unverified";
  profile?: string;
  results: Array<{ check: string; status: "passed" | "failed" | "skipped"; output?: string }>;
}

export interface ProjectRunnerOptions {
  /** Writable Target root: checks must never accidentally run in the Framework. */
  root: string;
  workspace: RuntimeWorkspace;
  /** Framework-owned gate script. It runs with `root` as its cwd. */
  staticGatePath?: string;
  now?: () => number;
  outputLimit?: number;
  /** Injectable for tests; avoids a Windows `.cmd` shell shim. */
  npmCliPath?: string;
}

const CHECK_FOR: Record<DeterministicCheckId, string> = {
  lint: "lint",
  typecheck: "typecheck",
  "unit-tests": "test",
  "integration-tests": "__never_run_the_same_test_suite_twice__",
  build: "build",
};

/**
 * Turns a Target's configured scripts into the injected QA03 runner.
 *
 * The framework static gate is preferred because it is the existing
 * deterministic implementation and returns all script results in one bounded
 * process.  Its promise is cached so `runDeterministicVerification` does not
 * spawn it once per check.  The package-script fallback exists for Targets
 * which have not installed the framework's `.claude` assets yet.
 */
export function createProjectRunner(opts: ProjectRunnerOptions): DeterministicRunner {
  const now = opts.now ?? Date.now;
  const outputLimit = opts.outputLimit ?? 8_000;
  let gateReport: Promise<StaticGateReport | null> | undefined;
  let scripts: Promise<Record<string, unknown>> | undefined;
  let profileCommands: Promise<Record<string, string> | null> | undefined;

  const summary = (stdout: string, stderr: string): string => tail([stdout, stderr].filter(Boolean).join("\n"), outputLimit);

  const loadGate = async (): Promise<StaticGateReport | null> => {
    if (!opts.staticGatePath) return null;
    try {
      const result = await opts.workspace.runCommand({
        command: process.execPath,
        args: [opts.staticGatePath, "--json"],
        cwd: opts.root,
        timeoutMs: 5 * 60_000,
      });
      const parsed = JSON.parse(result.stdout) as StaticGateReport;
      if (!Array.isArray(parsed.results)) throw new Error("static-analysis gate returned no results array");
      return parsed;
    } catch {
      // A missing/malformed framework gate must not make an absent Target
      // script look red.  Fall back to the Target's own declared scripts.
      return null;
    }
  };

  const loadScripts = async (): Promise<Record<string, unknown>> => {
    if (!scripts) {
      scripts = opts.workspace.readFile("package.json").then((text) => {
        if (!text) return {};
        try {
          const parsed = JSON.parse(text) as { scripts?: unknown };
          return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts as Record<string, unknown> : {};
        } catch {
          return {};
        }
      });
    }
    return scripts;
  };

  const loadProfileCommands = async (): Promise<Record<string, string> | null> => {
    if (!profileCommands) {
      profileCommands = opts.workspace.readFile(".agent-team/config.yaml").then((text) => {
        if (!text) return null;
        try {
          const parsed = TargetConfigSchema.safeParse(parseYaml(text));
          return parsed.success && parsed.data.stack ? parsed.data.stack.commands as Record<string, string> : null;
        } catch {
          return null;
        }
      });
    }
    return profileCommands;
  };

  return async (id): Promise<DeterministicCheckResult | null> => {
    // `npm test` is deliberately the one test check.  A project without a
    // separate integration script has no evidence to claim here, so it stays
    // SKIPPED rather than re-running the same suite or fabricating a PASS.
    if (id === "integration-tests") return null;
    const started = now();
    const gate = gateReport ??= loadGate();
    const report = await gate;
    const check = CHECK_FOR[id];
    if (report) {
      if (report.verification === "unverified") {
        return {
          id,
          status: "FAIL",
          durationMs: now() - started,
          outputSummary: `static-analysis gate: profile ${report.profile ?? "unknown"} is unverified because every verification command was skipped`,
        };
      }
      const rows = report.results.filter((row) => row.check === check);
      if (rows.length === 0 || rows.every((row) => row.status === "skipped")) return null;
      const failures = rows.filter((row) => row.status === "failed");
      return {
        id,
        status: failures.length === 0 ? "PASS" : "FAIL",
        durationMs: now() - started,
        outputSummary: failures.length === 0 ? `static-analysis gate: ${check} passed` : tail(failures.map((row) => row.output ?? `${check} failed`).join("\n"), outputLimit),
      };
    }

    const resolvedCommands = await loadProfileCommands();
    const resolvedCommand = resolvedCommands?.[check];
    if (typeof resolvedCommand === "string") {
      try {
        const shell = process.platform === "win32"
          ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", resolvedCommand] }
          : { command: "/bin/sh", args: ["-c", resolvedCommand] };
        const result = await opts.workspace.runCommand({ ...shell, cwd: opts.root, timeoutMs: 5 * 60_000 });
        return {
          id,
          status: result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL",
          durationMs: now() - started,
          outputSummary: summary(result.stdout, result.stderr) || (result.timedOut ? `${check} timed out` : `${check} exited ${result.exitCode ?? "unknown"}`),
        };
      } catch (error) {
        return { id, status: "FAIL", durationMs: now() - started, outputSummary: `could not run ${check}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    const configured = await loadScripts();
    if (typeof configured[check] !== "string") return null;
    const npmCliPath = opts.npmCliPath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    try {
      const result = await opts.workspace.runCommand({
        command: fs.existsSync(npmCliPath) ? process.execPath : "npm",
        args: fs.existsSync(npmCliPath) ? [npmCliPath, "run", "--silent", check] : ["run", "--silent", check],
        cwd: opts.root,
        timeoutMs: 5 * 60_000,
      });
      return {
        id,
        status: result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL",
        durationMs: now() - started,
        outputSummary: summary(result.stdout, result.stderr) || (result.timedOut ? `${check} timed out` : `${check} exited ${result.exitCode ?? "unknown"}`),
      };
    } catch (error) {
      return { id, status: "FAIL", durationMs: now() - started, outputSummary: `could not run ${check}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

/** Runs each configured Target root without weakening a multi-Target QA gate. */
export function combineProjectRunners(runners: readonly { root: string; runner: DeterministicRunner }[]): DeterministicRunner {
  return async (id) => {
    const results = await Promise.all(runners.map(async ({ root, runner }) => ({ root, result: await runner(id) })));
    const ran = results.filter((entry): entry is { root: string; result: DeterministicCheckResult } => entry.result !== null);
    if (ran.length === 0) return null;
    const failed = ran.filter((entry) => entry.result.status === "FAIL");
    return {
      id,
      status: failed.length === 0 ? "PASS" : "FAIL",
      durationMs: Math.max(...ran.map((entry) => entry.result.durationMs)),
      outputSummary: ran.map(({ root, result }) => `[${root}] ${result.outputSummary}`).join("\n"),
    };
  };
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `…${value.slice(-maxChars)}`;
}
