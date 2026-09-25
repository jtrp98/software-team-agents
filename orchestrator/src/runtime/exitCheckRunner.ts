import * as fs from "node:fs";
import * as path from "node:path";
import { captureChangeSetFingerprint, type ChangeSetFingerprint } from "../qa/changeSource.js";
import { createProjectRunner } from "../qa/projectRunner.js";
import { LocalWorkspace } from "./localWorkspace.js";
import type { RuntimeExitCheck } from "./runtimeAdapter.js";

export interface ExitCheckRootBaseline {
  readonly root: string;
  readonly fingerprint: ChangeSetFingerprint;
}

export interface ExitCheckResult {
  readonly check: RuntimeExitCheck;
  readonly root: string;
  readonly status: "PASS" | "FAIL" | "ERROR";
  readonly diagnostic: string;
}

export interface ExitCheckReport {
  readonly ok: boolean;
  readonly results: readonly ExitCheckResult[];
}

export type ExitCheckRunner = (
  baselines: readonly ExitCheckRootBaseline[],
  checks: readonly RuntimeExitCheck[],
) => Promise<ExitCheckReport>;

const NON_CODE = [
  /^_docs\//,
  /^\.claude\//,
  /^\.codex\//,
  /^\.agent-team\//,
  /^[^/]*\.md$/i,
  /^\.gitignore$/,
];

const EXCLUDE_SECRET_EXACT = new Set([".env"]);
const EXCLUDE_SECRET_DIRS = [/^node_modules\//, /^\.git\//, /^dist\//, /^\.next\//, /^\.workflow\//, /^\.claude\//];
const PLACEHOLDER_VALUE = /^(changeme|change_me|change-me|placeholder|your[-_]?\w*|example\w*|xxx+|dummy|fake|test|password\d*|secret)$/i;

const SECRET_PATTERNS: readonly {
  readonly name: string;
  readonly pattern?: RegExp;
  readonly find?: (line: string) => string | null;
}[] = [
  { name: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", pattern: /-----BEGIN\s?(RSA|EC|DSA|OPENSSH|PGP)?\s?PRIVATE KEY-----/ },
  {
    name: "database connection string with an embedded, non-placeholder password",
    find: (line) => {
      const match = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\/\s'"]+:([^@\/\s'"]+)@/.exec(line);
      if (!match || PLACEHOLDER_VALUE.test(match[1]!)) return null;
      return match[1]!;
    },
  },
  {
    name: "hardcoded secret-shaped value",
    find: (line) => {
      const match = /(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i.exec(line);
      if (!match) return null;
      const value = match[1]!;
      if (PLACEHOLDER_VALUE.test(value) || /^\$\{.*\}$|process\.env\./.test(value)) return null;
      return /^[A-Za-z0-9_\-/+.=]+$/.test(value) ? value : null;
    },
  },
];

/** Captures the dirty-tree content before provider invocation, so pre-existing user changes are never attributed to the agent run. */
export async function captureExitCheckBaseline(roots: readonly string[]): Promise<ExitCheckRootBaseline[]> {
  const uniqueRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  return Promise.all(uniqueRoots.map(async (root) => ({ root, fingerprint: await captureChangeSetFingerprint(root) })));
}

/**
 * Provider-neutral, fail-closed exit enforcement.
 *
 * Native Stop hooks remain useful for interactive runtimes, but headless
 * adapters cannot claim they fired merely because a config file exists. This
 * runner compares the pre-spawn snapshot with the post-exit tree, then runs the
 * two framework exit contracts against only files changed by this invocation.
 */
export const runExitChecks: ExitCheckRunner = async (baselines, checks) => {
  const results: ExitCheckResult[] = [];
  for (const baseline of baselines) {
    let current: ChangeSetFingerprint;
    try {
      current = await captureChangeSetFingerprint(baseline.root);
    } catch (error) {
      for (const check of checks) {
        results.push({
          check,
          root: baseline.root,
          status: "ERROR",
          diagnostic: `cannot capture the post-run change set: ${message(error)}`,
        });
      }
      continue;
    }

    const changed = changedByRun(baseline.fingerprint, current);
    for (const check of checks) {
      if (check === "code-green") results.push(await runCodeGreenExitCheck(baseline.root, changed));
      else results.push(runSecretExitCheck(baseline.root, changed));
    }
  }
  return { ok: results.every((result) => result.status === "PASS"), results };
};

function changedByRun(before: ChangeSetFingerprint, after: ChangeSetFingerprint): string[] {
  const files = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...files].filter((file) => before.files[file] !== after.files[file]).sort();
}

export async function runCodeGreenExitCheck(root: string, changed: readonly string[]): Promise<ExitCheckResult> {
  const code = changed.filter((file) => !NON_CODE.some((pattern) => pattern.test(normalize(file))));
  if (code.length === 0) return { check: "code-green", root, status: "PASS", diagnostic: "no application-code changes in this run" };

  try {
    const workspace = new LocalWorkspace({ root });
    const gate = path.join(root, ".claude", "scripts", "static-analysis-gate.js");
    const runner = createProjectRunner({ root, workspace, staticGatePath: fs.existsSync(gate) ? gate : undefined });
    const checks = await Promise.all([runner("typecheck"), runner("lint")]);
    const executed = checks.filter((result) => result !== null);
    if (executed.length === 0) {
      return { check: "code-green", root, status: "PASS", diagnostic: "no configured typecheck or lint command applies" };
    }
    const failures = executed.filter((result) => result.status === "FAIL");
    if (failures.length > 0) {
      return {
        check: "code-green",
        root,
        status: "FAIL",
        diagnostic: bounded(redactSensitive(failures.map((result) => `${result.id}: ${result.outputSummary}`).join("\n"))),
      };
    }
    return {
      check: "code-green",
      root,
      status: "PASS",
      diagnostic: executed.map((result) => `${result.id}: PASS`).join(", "),
    };
  } catch (error) {
    return { check: "code-green", root, status: "ERROR", diagnostic: `exit-check runner failed: ${message(error)}` };
  }
}

export function runSecretExitCheck(root: string, changed: readonly string[]): ExitCheckResult {
  const hits: string[] = [];
  try {
    for (const rel of changed.map(normalize)) {
      if (EXCLUDE_SECRET_EXACT.has(path.basename(rel)) || EXCLUDE_SECRET_DIRS.some((pattern) => pattern.test(rel))) continue;
      const full = path.resolve(root, rel);
      if (!inside(root, full)) throw new Error(`changed path escapes the checked root: ${rel}`);
      let text: string;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        for (const entry of SECRET_PATTERNS) {
          const found = entry.pattern ? (entry.pattern.lastIndex = 0, entry.pattern.test(line)) : entry.find?.(line) !== null;
          if (found) hits.push(`${rel}:${index + 1} — ${entry.name}`);
        }
      });
    }
  } catch (error) {
    return { check: "no-hardcoded-secret", root, status: "ERROR", diagnostic: `secret scan failed: ${message(error)}` };
  }
  if (hits.length > 0) {
    return {
      check: "no-hardcoded-secret",
      root,
      status: "FAIL",
      diagnostic: bounded(`hardcoded-secret patterns found:\n${hits.slice(0, 20).join("\n")}${hits.length > 20 ? `\n…+${hits.length - 20} more` : ""}`),
    };
  }
  return { check: "no-hardcoded-secret", root, status: "PASS", diagnostic: `${changed.length} run-changed file(s) scanned` };
}

function normalize(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function bounded(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max - 24)}\n…(diagnostic truncated)`;
}

/** Check output may echo source lines; redact the same secret shapes before they reach a run log. */
function redactSensitive(value: string): string {
  return value
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\/\s'"]+:)[^@\/\s'"]+(@)/gi, "$1[REDACTED]$2")
    .replace(/((?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"`])([^'"`]{12,})(['"`])/gi, "$1[REDACTED]$3");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
