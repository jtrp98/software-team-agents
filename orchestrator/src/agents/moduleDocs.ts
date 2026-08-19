import * as fs from "node:fs";
import * as path from "node:path";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";

/**
 * Bridges the real pipeline's Markdown docs (`_docs/module/<name>/review.md`,
 * `security.md` — written by the actual `qa-engineer`/`security` subagents
 * per `.claude/shared/conventions.md`) into the structured artifacts the
 * orchestrator's gates (gates/gatePolicy.ts) require. Regex-based, same
 * spirit and same limits as `.claude/scripts/check-schema-contract.js` and
 * `check-status-sync.js`: a helper that reads the convention's own markers
 * (✅/⚠️/❌, `(FULL)`/`(TARGETED)`, 🔴/🟠/🟡, 🔵/🟣/✅/⚪), not a Markdown
 * parser and not a substitute for a human reading the doc.
 */

export function moduleDocPath(projectRoot: string, moduleName: string, filename: string): string {
  return path.join(projectRoot, "_docs", "module", moduleName, filename);
}

export function readModuleDoc(projectRoot: string, moduleName: string, filename: string): string | null {
  const file = moduleDocPath(projectRoot, moduleName, filename);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The current round is everything after the last `## `-level round/heading before EOF — good enough for the markers this reads. */
function tailSection(markdown: string, headingPattern: RegExp): string {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) start = i;
  }
  return lines.slice(start).join("\n");
}

function bulletsUnder(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##+\\s+${heading}\\b`, "i");
  const idx = lines.findIndex((l) => headingRe.test(l.trim()));
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (/^[-*]\s+/.test(trimmed)) out.push(trimmed.replace(/^[-*]\s+/, ""));
  }
  return out;
}

export interface ParsedQaReport {
  artifact: QaReportArtifact;
  /** True when the mode marker `(FULL)`/`(TARGETED)` could not be found — defaulted to TARGETED (fails closed on deploy gate) rather than guessed. */
  modeInferred: boolean;
}

/**
 * Parses `review.md`'s current round into a QaReportArtifact. Never invents a
 * PASS: absence of a recognizable ✅ with no ⚠️/❌ in the current round reads
 * as FAIL, since a doc this parser can't confidently read is not evidence of
 * success.
 */
export function parseQaReport(taskId: string, reviewMd: string): ParsedQaReport {
  const round = tailSection(reviewMd, /^##\s+.*(round|verify|Round)/i) || reviewMd;

  const hasFail = /❌/.test(round);
  const hasWarn = /⚠️/.test(round);
  const hasPass = /✅/.test(round);
  const status: "PASS" | "FAIL" = hasPass && !hasFail && !hasWarn ? "PASS" : "FAIL";

  const modeMatch = round.match(/\((FULL|TARGETED)\)/);
  const mode: "FULL" | "TARGETED" = (modeMatch?.[1] as "FULL" | "TARGETED") ?? "TARGETED";

  const testMatch = round.match(/(\d+)\s+passed/i);
  const failMatch = round.match(/(\d+)\s+failed/i);
  const passed = testMatch ? Number(testMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : 0;
  const hasAutomatedTests = passed + failed > 0;

  let unverifiedBehaviour = bulletsUnder(reviewMd, "Unverified Behaviour[^\\n]*");
  if (!hasAutomatedTests && unverifiedBehaviour.length === 0) {
    unverifiedBehaviour = [
      "no `## Unverified Behaviour` section found in review.md — automated tests are absent, " +
        "but the section this bridge relies on to list what was only read, not run, is missing or empty",
    ];
  }

  let evidence = round
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .slice(0, 20);
  if (evidence.length === 0) {
    evidence = [`parsed from review.md (task ${taskId}) — no bulleted evidence lines found in the current round`];
  }

  const artifact: QaReportArtifact = {
    taskId,
    status,
    mode,
    requirements: {},
    tests: { passed, failed },
    evidence,
    risks: [],
    hasAutomatedTests,
    unverifiedBehaviour,
  };

  return { artifact, modeInferred: modeMatch === null };
}

const SEVERITY_MAP: Record<string, "CRITICAL" | "HIGH" | "LOW"> = {
  "🔴": "CRITICAL",
  "🟠": "HIGH",
  "🟡": "LOW",
};

const STATUS_MAP: Record<string, "OPEN" | "FIX_CLAIMED" | "FIXED" | "ACCEPTED"> = {
  "🔵": "OPEN",
  "🟣": "FIX_CLAIMED",
  "✅": "FIXED",
  "⚪": "ACCEPTED",
};

/**
 * Parses `security.md`'s `Open Findings — all rounds` (or the whole doc, if
 * that heading isn't found) into a SecurityReportArtifact. Only lines
 * carrying both a severity emoji and a status emoji are read as findings —
 * `conventions.md`'s own vocabulary, nothing invented here.
 */
export function parseSecurityReport(taskId: string, securityMd: string): SecurityReportArtifact {
  const section = (() => {
    const lines = securityMd.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^##\s+Open Findings/i.test(l.trim()));
    if (idx === -1) return securityMd;
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(idx, end).join("\n");
  })();

  const findings: SecurityReportArtifact["findings"] = [];
  const lines = section.split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const severityEmoji = Object.keys(SEVERITY_MAP).find((e) => line.includes(e));
    const statusEmoji = Object.keys(STATUS_MAP).find((e) => line.includes(e));
    if (!severityEmoji || !statusEmoji) continue;
    n += 1;
    const idMatch = line.match(/\b([A-Z]{1,4}-?\d+)\b/);
    findings.push({
      id: idMatch?.[1] ?? `F${n}`,
      severity: SEVERITY_MAP[severityEmoji],
      status: STATUS_MAP[statusEmoji],
      description: line.replace(/^[-*]\s*/, "").trim() || `finding ${n} (see security.md)`,
    });
  }

  const blocking = findings.some(
    (f) => (f.severity === "CRITICAL" || f.severity === "HIGH") && f.status !== "ACCEPTED" && f.status !== "FIXED",
  );
  return {
    taskId,
    findings,
    overallStatus: blocking ? "FAIL" : "PASS",
  };
}
