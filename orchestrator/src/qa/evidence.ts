/**
 * QA04 — Evidence-driven QA context, and QA06 — retry/recheck optimization.
 *
 * The evidence package is what a qa-engineer round reads *first*: task
 * intent, acceptance criteria, the change list with a diff summary,
 * deterministic verification results, relevant knowledge, known risks, and —
 * on a retry round — the recheck plan. Source code beyond that is JIT: the
 * prompt names the scope, and the agent opens files when the evidence points
 * at them, not preemptively.
 *
 * The recheck half makes a retry round cheaper than round one without being
 * lighter-weighted where it matters:
 *  - every OPEN finding from the previous round is rechecked first;
 *  - deterministic evidence whose files the fix did not touch stays fresh and
 *    is reused;
 *  - evidence whose files WERE touched is invalidated, never silently kept;
 *  - fix changes outside every finding's file set are a cross-boundary
 *    signal — the plan flags them so mode selection can escalate to FULL.
 */

import type { QaModeDecision } from "./mode.js";
import type { QaEffortDecision } from "./riskGate.js";
import type { DeterministicVerification } from "./deterministic.js";
import { renderDeterministicVerification } from "./deterministic.js";
import type { QaScope } from "./scope.js";
import { renderQaScope } from "./scope.js";

export interface EvidenceRecord {
  id: string;
  kind: "deterministic" | "qa-finding";
  /** Files this evidence speaks about — the freshness key. */
  files: readonly string[];
  summary: string;
  createdAt: number;
}

/** One finding from a previous QA round's Open Issues (`review.md`). */
export interface QaFindingRecord {
  id: string;
  description: string;
  owner: string;
  files: readonly string[];
  createdAt: number;
  status: "OPEN" | "FIX_CLAIMED";
}

function normalize(p: string): string {
  return p.replaceAll("\\", "/");
}

function intersects(files: readonly string[], changed: ReadonlySet<string>): boolean {
  return files.some((f) => changed.has(normalize(f)));
}

export interface RecheckPlan {
  /** Every still-open finding — recheck these first, before anything else. */
  recheckFindings: QaFindingRecord[];
  /** Previous evidence untouched by this round's fix — reuse, do not regenerate. */
  reusableEvidence: EvidenceRecord[];
  /** Previous evidence the fix touched — invalidated; must be produced fresh. */
  invalidatedEvidence: EvidenceRecord[];
  /**
   * Fix-touched files no previous finding mentioned — a cross-boundary signal.
   * Non-empty means the fix may have created impact outside the verified area.
   */
  newFilesOutsideFindings: string[];
}

export function planRecheck(
  findings: readonly QaFindingRecord[],
  evidence: readonly EvidenceRecord[],
  changedFiles: readonly string[],
): RecheckPlan {
  const changed = new Set(changedFiles.map(normalize));
  const findingFiles = new Set(findings.flatMap((f) => [...f.files].map(normalize)));

  const reusableEvidence: EvidenceRecord[] = [];
  const invalidatedEvidence: EvidenceRecord[] = [];
  for (const record of evidence) {
    if (intersects(record.files, changed)) invalidatedEvidence.push(record);
    else reusableEvidence.push(record);
  }

  // Cross-boundary detection needs file data to be honest. When no finding
  // names any file, claiming "everything is new impact" would force FULL on
  // every retry — so absence of data yields no signal, never a false alarm.
  const anyFindingHasFiles = findings.some((f) => f.files.length > 0);

  return {
    recheckFindings: [...findings],
    reusableEvidence,
    invalidatedEvidence,
    newFilesOutsideFindings: anyFindingHasFiles
      ? [...changed].filter((f) => !findingFiles.has(f)).sort()
      : [],
  };
}

export interface EvidencePackageInput {
  taskId: string;
  mode: QaModeDecision;
  /** Model-reasoning effort, independent from mode's verification surface. */
  effort?: QaEffortDecision;
  /** Controls the one mechanical instruction that exists only on the escape-hatch path. */
  deterministicGate?: "enabled" | "disabled";
  scope: QaScope;
  /** One-paragraph statement of what this task was supposed to achieve. */
  taskIntent: string;
  acceptanceCriteria: readonly string[];
  diffSummary: string;
  deterministic?: DeterministicVerification;
  knownRisks: readonly string[];
  recheck?: RecheckPlan;
  /** Hard line cap for the whole package — the bound that keeps it bounded. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 120;

/**
 * The bounded `### qa-evidence` block handed to qa-engineer ahead of any
 * source. Every section is capped; overflow is truncated with an explicit
 * marker rather than silently cut, so the agent knows to ask (JIT) instead
 * of reasoning over a partial picture it believes is whole.
 */
export function buildEvidencePackage(input: EvidencePackageInput): string {
  const cap = input.maxLines ?? DEFAULT_MAX_LINES;
  const sections: string[][] = [
    [`QA evidence package for ${input.taskId} (read this before opening source files)`],
    [
      "## QA policy",
      `- Mode: ${input.mode.mode} — ${input.mode.reasons.join("; ")}`,
      ...(input.effort ? [`- Effort: ${input.effort.effort} — ${input.effort.reasons.join("; ")}`] : []),
    ],
    renderQaScope(input.scope).map((l) => `- ${l}`),
    ["## Task intent", wrap(input.taskIntent)],
    ["## Acceptance criteria", ...input.acceptanceCriteria.map((c) => `- ${c}`)],
    ["## Diff summary", wrap(input.diffSummary || "(none supplied)")],
  ];

  if (input.deterministicGate === "disabled") {
    // T-V5-036 (F-20) — this branch is reached only via the orchestrator's own
    // `--no-deterministic-gate` escape hatch, i.e. a deliberate choice not to
    // run the sweep for this round. It records that fact; it does not ask the
    // LLM to run the sweep itself — a request in a prompt is not a fact, and
    // there is no verified evidence the orchestrator can hand over instead.
    sections.push([
      "## Deterministic gate: disabled",
      "No deterministic sweep result is available for this round (`--no-deterministic-gate` was set for this run). Verify from the evidence in this package and direct inspection; do not treat the absence of a sweep result as a pass.",
    ]);
  } else if (input.deterministicGate === "enabled") {
    sections.push([
      "## Deterministic gate: enabled",
      "Consume the supplied structured verification result; do not re-run the mechanical checks.",
    ]);
  }

  if (input.deterministic) {
    sections.push(["## Deterministic verification (ran before this round)", ...renderDeterministicVerification(input.deterministic)]);
  }
  if (input.knownRisks.length > 0) {
    sections.push(["## Known risks", ...input.knownRisks.map((r) => `- ${r}`)]);
  }
  if (input.recheck) {
    const r = input.recheck;
    const lines: string[] = [];
    lines.push(`Recheck first (${r.recheckFindings.length} open finding(s)):`);
    for (const f of r.recheckFindings) lines.push(`  - [${f.id}] (${f.owner}) ${f.description} — files: ${[...f.files].join(", ")}`);
    lines.push(
      r.reusableEvidence.length === 0
        ? "Reusable evidence (fix did not touch these): none"
        : "Reusable evidence (fix did not touch these) — reuse, do not regenerate:",
    );
    for (const e of r.reusableEvidence) lines.push(`  - [${e.id}] ${e.summary}`);
    lines.push(r.invalidatedEvidence.length === 0 ? "Invalidated evidence: none" : "Invalidated evidence (must be regenerated):");
    for (const e of r.invalidatedEvidence) lines.push(`  - [${e.id}] ${e.summary}`);
    if (r.newFilesOutsideFindings.length > 0) {
      lines.push(
        `CROSS-BOUNDARY SIGNAL — fix touched files outside all previous findings: ${r.newFilesOutsideFindings.join(", ")}. ` +
          "If impact may extend past the recorded scope, escalate to FULL.",
      );
    }
    sections.push(["## Recheck plan (retry round)", ...lines]);
  }

  sections.push([
    "Rules:",
    "- Decide PASS/FAIL from this package when it is sufficient; open source files only where it points.",
    "- If evidence is insufficient, say exactly which file/section you need instead of loading broadly.",
    "- Report your verify mode (FULL/TARGETED) as your contract requires; TARGETED must stay within the scope above or escalate.",
  ]);

  const out: string[] = [];
  outer: for (const section of sections) {
    for (const line of section) {
      if (out.length >= cap) {
        out.push("…(evidence package truncated — request specific sections/files you still need)");
        break outer;
      }
      out.push(line);
    }
  }
  return out.join("\n");
}

function wrap(s: string): string {
  return s.trim() || "(not supplied)";
}
