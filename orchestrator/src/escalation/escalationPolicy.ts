import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { MAX_RETRY } from "../retry/retryPolicy.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

/**
 * What a failure's severity is allowed to do without a person (T40).
 *
 * THE GAP THIS CLOSES
 *
 * `severity` has been a field on every `StructuredFailure` since T06. It was
 * parsed, stored, resumed, and displayed — and never once read by anything that
 * made a decision. A spacing bug and an open CRITICAL security finding got the
 * same three automatic rounds and the same routing, because the only inputs
 * `decideRecovery` actually consulted were the retry count, the current state,
 * and the owner.
 *
 * WHY THE CONSTANT BELOW IS THE AUTHORITY, AND THE YAML IS THE CHECKED COPY
 *
 * The same arrangement as `workflows/*.yml` against the classifier, for the same
 * reason and one more. The general reason: something that has to read a file at
 * decision time can fail at decision time, and `decideRecovery` is pure — it
 * takes a run and returns an action, with no I/O anywhere in the path. The
 * specific reason: this policy decides what happens when things are *already*
 * going wrong. A missing or malformed `escalation-policy.yaml` must not be able
 * to turn a failed round into a crash, or worse, into a silently permissive
 * default. So the values live in code, the file documents and mirrors them, and
 * `--check-escalation-policy` fails when the two drift apart.
 */

export type Severity = StructuredFailure["severity"];

export interface SeverityPolicy {
  /** May the orchestrator retry this by itself at all? */
  autonomous: boolean;
  /** Automatic rounds this severity gets, at most. The global MAX_RETRY still outranks it. */
  max_retry: number;
  /** When it stops, is a person formally asked (an approval record), or does the task just go quiet? */
  approval: boolean;
  /** Stop the task outright rather than routing the failure to an owner. */
  stop_pipeline: boolean;
  why?: string;
}

export interface EscalationPolicy {
  version: number;
  severity: Record<Severity, SeverityPolicy>;
}

/**
 * The runtime authority. `escalation-policy.yaml` carries the same values plus
 * the reasoning; that file explains at length why `high` keeps its automatic
 * rounds instead of taking TASKS.md's sketch literally.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  version: 1,
  severity: {
    low: { autonomous: true, max_retry: 3, approval: false, stop_pipeline: false },
    medium: { autonomous: true, max_retry: 3, approval: false, stop_pipeline: false },
    // Two, not three: CLAUDE.md's "a fix that fails twice gets escalated, not
    // re-sent", and failureClassifier.ts's REROUTE_CEILING. The runtime budget
    // was the one place still saying three.
    high: { autonomous: true, max_retry: 2, approval: true, stop_pipeline: false },
    critical: { autonomous: false, max_retry: 0, approval: true, stop_pipeline: true },
  },
};

/**
 * The policy for one severity.
 *
 * An unknown or absent severity falls back to `high` rather than to `low`: this
 * is only ever called about something that already failed, and the safe default
 * when you do not know how bad it is is to treat it as blocking. Defaulting to
 * `low` would mean an unrecognised severity quietly bought itself the most
 * permissive treatment available.
 */
export function policyFor(severity: Severity | undefined, policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY): SeverityPolicy {
  return (severity && policy.severity[severity]) || policy.severity.high;
}

/** The rounds a severity actually gets: its own ceiling, capped by the global budget it can never exceed. */
export function effectiveMaxRetry(
  severity: Severity | undefined,
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): number {
  return Math.min(policyFor(severity, policy).max_retry, MAX_RETRY);
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "escalation-policy.schema.json",
);

export function escalationPolicyPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "escalation-policy.yaml");
}

export class EscalationPolicyError extends Error {
  constructor(public readonly issues: string[]) {
    super(`escalation-policy.yaml is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "EscalationPolicyError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/**
 * Reads and validates the file.
 *
 * Nothing in the decision path calls this — `decideRecovery` uses the constant.
 * This exists for the checker, and for a caller that deliberately wants the
 * file's values (a report, a tool that shows the policy to a person).
 */
export function loadEscalationPolicy(projectRoot: string = defaultProjectRoot()): EscalationPolicy {
  const file = escalationPolicyPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new EscalationPolicyError([`no file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new EscalationPolicyError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new EscalationPolicyError(
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }
  return parsed as EscalationPolicy;
}

export interface EscalationPolicyCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

const COMPARED_FIELDS = ["autonomous", "max_retry", "approval", "stop_pipeline"] as const;

/**
 * The check `--check-escalation-policy` runs: the file parses, and it says the
 * same thing the code will actually do.
 *
 * The second half is the point. A policy file that documents a rule the runtime
 * does not follow is worse than no file — it is a written answer that is wrong,
 * and the next person to read it has no way to tell.
 */
export function checkEscalationPolicy(projectRoot: string = defaultProjectRoot()): EscalationPolicyCheckResult {
  let file: EscalationPolicy;
  try {
    file = loadEscalationPolicy(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof EscalationPolicyError ? e.issues : [String(e)], notes: [] };
  }

  const problems: string[] = [];
  const notes: string[] = [];

  for (const [severity, code] of Object.entries(DEFAULT_ESCALATION_POLICY.severity) as [Severity, SeverityPolicy][]) {
    const declared = file.severity[severity];
    for (const field of COMPARED_FIELDS) {
      if (declared[field] !== code[field]) {
        problems.push(
          `severity "${severity}": escalation-policy.yaml says ${field}=${String(declared[field])}, ` +
            `but the runtime uses ${field}=${String(code[field])} — the file documents a rule the code does not follow`,
        );
      }
    }
    if (!declared.why) {
      problems.push(`severity "${severity}" has no \`why\` — a policy with no reason is one nobody can argue an exception against`);
    }
    if (declared.max_retry > MAX_RETRY) {
      problems.push(
        `severity "${severity}" asks for ${declared.max_retry} retries, above the global ceiling of ${MAX_RETRY} — ` +
          "a severity policy can only ever be stricter than the budget, never a way to buy extra rounds",
      );
    }
  }

  if (file.version !== DEFAULT_ESCALATION_POLICY.version) {
    problems.push(
      `escalation-policy.yaml is version ${file.version} and this build expects ${DEFAULT_ESCALATION_POLICY.version}`,
    );
  }

  // Worth seeing on a green run: a severity that can never retry is a real
  // constraint on how the pipeline behaves, not a detail.
  for (const [severity, policy] of Object.entries(file.severity) as [Severity, SeverityPolicy][]) {
    if (!policy.autonomous || policy.stop_pipeline) {
      notes.push(`severity "${severity}" always stops for a person — no automatic round runs for it`);
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

export class EscalationPolicyMismatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`escalation-policy.yaml has problems:\n- ${problems.join("\n- ")}`);
    this.name = "EscalationPolicyMismatchError";
  }
}

export function assertEscalationPolicy(projectRoot: string = defaultProjectRoot()): void {
  const result = checkEscalationPolicy(projectRoot);
  if (!result.ok) throw new EscalationPolicyMismatchError(result.problems);
}
