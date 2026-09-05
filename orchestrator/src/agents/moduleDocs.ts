import * as fs from "node:fs";
import * as path from "node:path";
import {
  ArtifactType,
  HANDOFF_MAX_BYTES,
  validateArtifact,
  type HandoffArtifact,
  type QaReportArtifact,
  type SecurityReportArtifact,
} from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";
import { firstTable, sections } from "../docs/markdown.js";
import { parsePlanTasks } from "../docs/planGraph.js";
import { buildPlanGraph, type TaskNode } from "../graph/taskGraph.js";
import { extractIds } from "../traceability/traceability.js";

/**
 * Bridges the real pipeline's Markdown docs (`_docs/module/<name>/review.md`,
 * `security.md` — written by the actual `qa-engineer`/`security` subagents
 * per `policies/documentation.md`) into the structured artifacts the
 * orchestrator's gates (gates/gatePolicy.ts) require. Regex-based: a helper
 * that reads the convention's own markers (✅/⚠️/❌, `(FULL)`/`(TARGETED)`,
 * 🔴/🟠/🟡, 🔵/🟣/✅/⚪), not a Markdown parser and not a substitute for a
 * human reading the doc.
 */

/**
 * A module name is untrusted input twice over: it arrives from a CLI flag and
 * from the `module` field of knowledge items that business-analyst wrote. Both
 * feed straight into a path join here, so a name like `../..` would walk this
 * reader out of `_docs/module/` entirely — reading arbitrary files as if they
 * were module documents. Module names are folder names by definition, so the
 * rule is structural and cheap: no separators, no dot segments. Fails closed
 * rather than sanitizing — a mangled name would silently read the wrong
 * module's documents, which is worse than stopping.
 */
export function assertSafeModuleName(moduleName: string): void {
  const unsafe =
    moduleName.length === 0 ||
    /[/\\]/.test(moduleName) ||
    moduleName === "." ||
    moduleName === ".." ||
    /^[A-Za-z]:/.test(moduleName);
  if (unsafe) {
    throw new Error(
      `unsafe module name "${moduleName}" — module names are folder names under _docs/module/, ` +
        "so they cannot contain path separators or dot segments",
    );
  }
}

export function moduleDocPath(projectRoot: string, moduleName: string, filename: string): string {
  assertSafeModuleName(moduleName);
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

/**
 * Reads acceptance criteria from the authored requirement document without
 * interpreting or completing them. The preferred shape is a dedicated
 * `## Acceptance Criteria` section; the Core Features table shape remains
 * supported because existing module documents commonly keep the criterion in
 * a named table column instead.
 *
 * Empty is an honest result. RuntimeTask records the accompanying reason
 * rather than asking a model to invent criteria that a person never wrote.
 */
export function extractAcceptanceCriteria(requirementMd: string): string[] {
  const clean = (value: string): string =>
    value
      .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .replace(/^`|`$/g, "")
      .trim();
  const unique = (values: string[]): string[] => [...new Set(values.map(clean).filter(Boolean))];

  const explicit = sections(requirementMd, 2).find((section) =>
    /^(?:acceptance criteria|เกณฑ์การยอมรับ)\b/i.test(section.title),
  );
  if (explicit) {
    const table = firstTable(explicit.body);
    if (table.rows.length > 0) {
      const criterionIndex = table.header.findIndex((heading) =>
        /acceptance|criteria|criterion|expected|เกณฑ์/i.test(heading),
      );
      const index = criterionIndex >= 0 ? criterionIndex : table.header.length === 1 ? 0 : -1;
      if (index >= 0) return unique(table.rows.map((row) => row[index] ?? ""));
    }
    return unique(
      explicit.body
        .split(/\r?\n/)
        .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)),
    );
  }

  const coreFeatures = sections(requirementMd, 2).find((section) =>
    /^(?:core features?|features?|ความสามารถหลัก)\b/i.test(section.title),
  );
  if (!coreFeatures) return [];
  const table = firstTable(coreFeatures.body);
  const criterionIndex = table.header.findIndex((heading) =>
    /acceptance|criteria|criterion|expected|เกณฑ์/i.test(heading),
  );
  return criterionIndex < 0 ? [] : unique(table.rows.map((row) => row[criterionIndex] ?? ""));
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Lists delivery modules in deterministic folder-name order. A directory is a
 * module only after requirement.md or design.md establishes it; empty/stale
 * folders are not candidates an agent should reason over.
 */
export function listModules(docsRoot: string): string[] {
  const parent = path.join(docsRoot, "_docs", "module");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    if (!fs.existsSync(parent)) return [];
    throw error;
  }

  const modules = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      assertSafeModuleName(name);
      const dir = path.join(parent, name);
      return isFile(path.join(dir, "requirement.md")) || isFile(path.join(dir, "design.md"));
    })
    .sort();
  for (const moduleName of modules) assertSafeModuleName(moduleName);
  return modules;
}

export type ModuleResolution =
  | { status: "one"; module: string; candidates: string[] }
  | { status: "many"; candidates: string[] }
  | { status: "none"; candidates: string[] };

/** Resolves an exact hint or the only available module; never guesses among candidates. */
export function resolveModule(docsRoot: string, hint?: string): ModuleResolution {
  if (hint !== undefined) assertSafeModuleName(hint);
  const candidates = listModules(docsRoot);
  if (hint !== undefined) {
    if (candidates.includes(hint)) {
      assertSafeModuleName(hint);
      return { status: "one", module: hint, candidates };
    }
    return { status: "none", candidates };
  }
  if (candidates.length === 1) {
    assertSafeModuleName(candidates[0]);
    return { status: "one", module: candidates[0], candidates };
  }
  return candidates.length === 0 ? { status: "none", candidates } : { status: "many", candidates };
}

export interface HandoffDerivationOptions {
  taskId?: string;
  phases?: number[];
  budget?: number | null;
}

export interface DerivedHandoff {
  artifact: HandoffArtifact;
  /** Derivation gaps are visible to runtime logs but never copied into the reference record. */
  notes: string[];
  complete: boolean;
}

const HANDOFF_SOURCE: Partial<Record<AgentStage, string>> = {
  [AgentStage.BUSINESS_ANALYST]: "requirement.md",
  [AgentStage.SYSTEM_ANALYST]: "design.md",
  [AgentStage.PROJECT_MANAGER]: "plan.md",
  [AgentStage.TEST_PLANNER]: "test-plan.md",
  [AgentStage.UXUI_DESIGNER]: "uxui/design.md",
};

function compactReference(value: string): string {
  return encodeURIComponent(value.trim().replace(/\s+/g, "-"))
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")
    .replace(/%23/gi, "#");
}

function headingReference(filename: string, heading: string): string {
  return `${filename}#${compactReference(heading)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function minimalHandoff(stage: AgentStage, moduleName: string, opts: HandoffDerivationOptions): HandoffArtifact {
  return {
    task_id: opts.taskId ?? `${stage}:derived`,
    implements: [],
    module: moduleName,
    phase: opts.phases?.length === 1 ? opts.phases[0] : null,
    constraint_refs: [],
    contract_refs: { produces: [], consumes: [] },
    decision_refs: [],
    test_refs: [],
    artifact_refs: [],
    open_findings: [],
    budget: opts.budget ?? null,
  };
}

function openFindings(
  filename: string,
  docText: string,
  headingPattern: RegExp,
  owner: AgentStage,
): HandoffArtifact["open_findings"] {
  const section = sections(docText, 2).find((candidate) => headingPattern.test(candidate.title));
  if (!section) return [];
  const lines = section.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(?:—|-|none\.?|n\/a|ไม่มี)$/i.test(line));
  if (lines.length === 0) return [];
  const count = Math.min(16, Math.max(1, lines.filter((line) => /^[-*]|^\d+[.)]|^\|/.test(line)).length));
  const base = headingReference(filename, section.title);
  return Array.from({ length: count }, (_, index) => ({
    id: `OPEN-${String(index + 1).padStart(3, "0")}`,
    owner,
    summary: `${base}:${index + 1}`,
  }));
}

function capArray<T>(values: T[], maximum: number, label: string, notes: string[]): T[] {
  if (values.length <= maximum) return values;
  notes.push(`${label} derived ${values.length} references; retained the first ${maximum}`);
  return values.slice(0, maximum);
}

function capRecord(record: HandoffArtifact, notes: string[]): HandoffArtifact {
  record.implements = capArray(unique(record.implements), 64, "implements", notes);
  record.constraint_refs = capArray(unique(record.constraint_refs), 32, "constraint_refs", notes);
  record.contract_refs.produces = capArray(unique(record.contract_refs.produces), 32, "contract_refs.produces", notes);
  record.contract_refs.consumes = capArray(unique(record.contract_refs.consumes), 32, "contract_refs.consumes", notes);
  record.decision_refs = capArray(unique(record.decision_refs), 32, "decision_refs", notes);
  record.test_refs = capArray(unique(record.test_refs), 64, "test_refs", notes);
  record.artifact_refs = capArray(unique(record.artifact_refs), 32, "artifact_refs", notes);
  record.open_findings = capArray(record.open_findings, 16, "open_findings", notes);

  const removable: Array<unknown[]> = [
    record.open_findings,
    record.artifact_refs,
    record.decision_refs,
    record.test_refs,
    record.contract_refs.consumes,
    record.contract_refs.produces,
    record.constraint_refs,
    record.implements,
  ];
  let truncatedForBytes = false;
  while (Buffer.byteLength(JSON.stringify(record), "utf8") > HANDOFF_MAX_BYTES) {
    const largest = removable.filter((array) => array.length > 0).sort((a, b) => b.length - a.length)[0];
    if (!largest) break;
    largest.pop();
    truncatedForBytes = true;
  }
  if (truncatedForBytes) notes.push(`reference lists were truncated to the ${HANDOFF_MAX_BYTES}-byte record cap`);
  return validateArtifact(ArtifactType.HANDOFF, record);
}

/**
 * Derives the bounded handoff index from the authoritative document a stage
 * wrote. Agents never author this record. A parser gap returns the minimal
 * schema-valid index plus notes for the runtime log; it does not fail the run.
 */
export function deriveHandoff(
  stage: AgentStage,
  moduleName: string,
  docText: string,
  planText?: string,
  opts: HandoffDerivationOptions = {},
): DerivedHandoff {
  const notes: string[] = [];
  const record = minimalHandoff(stage, moduleName, opts);
  const source = HANDOFF_SOURCE[stage];
  if (!source) {
    notes.push(`${stage} has no authoritative document handoff mapping`);
    return { artifact: capRecord(record, notes), notes, complete: false };
  }

  try {
    if (stage === AgentStage.BUSINESS_ANALYST) {
      record.implements = extractIds(docText, "REQ");
      const ruleSections = sections(docText, 2).filter((section) => /business\s*rules?|core\s+features?|constraints?/i.test(section.title));
      record.constraint_refs = ruleSections.map((section) => headingReference(source, section.title));
      record.open_findings = openFindings(source, docText, /^Open Questions?$/i, AgentStage.BUSINESS_ANALYST);
      if (record.implements.length === 0 || ruleSections.length === 0) {
        notes.push("requirement.md has no derivable REQ ids or business-rule headings; emitted the minimal handoff");
        return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
      }
    } else if (stage === AgentStage.SYSTEM_ANALYST) {
      record.implements = extractIds(docText, "DES");
      const contracts = sections(docText, 2).filter((section) => /contract/i.test(section.title));
      record.contract_refs.produces = contracts.map((section) => headingReference(source, section.title));
      record.decision_refs = unique([...extractIds(docText, "ADR"), ...extractIds(docText, "RULE")]);
      record.open_findings = openFindings(source, docText, /^Unresolved Open Questions?$/i, AgentStage.SYSTEM_ANALYST);
      if (record.implements.length === 0 || contracts.length === 0) {
        notes.push("design.md has no derivable DES ids or contract headings; emitted the minimal handoff");
        return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
      }
    } else if (stage === AgentStage.PROJECT_MANAGER) {
      const parsed = parsePlanTasks(planText ?? docText);
      if (parsed.problems.length > 0 || parsed.tasks.length === 0) {
        notes.push(`plan.md could not be derived cleanly (${parsed.problems.join("; ") || "no task rows"}); emitted the minimal handoff`);
        return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
      }
      const selected = opts.phases?.length ? parsed.tasks.filter((task) => opts.phases!.includes(task.phase)) : parsed.tasks;
      const nodes: TaskNode[] = parsed.tasks.map((task) => ({
        id: task.id,
        phase: task.phase,
        agent: Object.values(AgentStage).includes(task.owner as AgentStage) ? task.owner as AgentStage : undefined,
        dependsOn: task.dependsOn,
        produces: task.produces,
        consumes: task.consumes,
      }));
      const graph = buildPlanGraph(nodes);
      record.implements = unique(selected.flatMap((task) => task.designRefs));
      record.contract_refs.produces = selected.flatMap((task) => graph.nodes.get(task.id)?.produces ?? []).map(compactReference);
      record.contract_refs.consumes = selected.flatMap((task) => graph.nodes.get(task.id)?.consumes ?? []).map(compactReference);
      const phases = unique(selected.map((task) => task.phase));
      record.phase = phases.length === 1 ? phases[0] : record.phase;
    } else if (stage === AgentStage.TEST_PLANNER) {
      record.test_refs = extractIds(docText, "TP");
      if (record.test_refs.length === 0) {
        notes.push("test-plan.md has no TP ids; emitted the minimal handoff");
        return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
      }
    } else if (stage === AgentStage.UXUI_DESIGNER) {
      const uxIds = extractIds(docText, "UX");
      if (uxIds.length === 0) {
        notes.push("uxui/design.md has no UX ids; emitted the minimal handoff");
        return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
      }
      record.artifact_refs = [source, ...uxIds];
    }
    return { artifact: capRecord(record, notes), notes, complete: true };
  } catch (error) {
    notes.push(`handoff derivation failed (${String(error)}); emitted the minimal handoff`);
    return { artifact: capRecord(minimalHandoff(stage, moduleName, opts), notes), notes, complete: false };
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
 * The one verdict line `qa-engineer.md` tells the agent to write literally:
 * `**Status:** ✅ Verified (FULL)` / ⚠️ Partial / ❌ Failed. When it is present
 * it is the answer — no emoji census needed. Absent (older rounds, hand-edited
 * docs), parsing falls back to the emoji heuristic below.
 */
const STATUS_LINE_RE =
  /\*\*Status:\*\*\s*✅\s*Verified\s*\((FULL|TARGETED)\)|\*\*Status:\*\*\s*⚠️\s*Partial\s*\((FULL|TARGETED)\)|\*\*Status:\*\*\s*❌\s*Failed\s*\((FULL|TARGETED)\)/;

/**
 * Parses `review.md`'s current round into a QaReportArtifact. Never invents a
 * PASS: absence of a recognizable verdict — either the exact `**Status:**` line
 * or a bare ✅ with no ⚠️/❌ beside it — reads as FAIL, since a doc this parser
 * can't confidently read is not evidence of success.
 */
export function parseQaReport(taskId: string, reviewMd: string): ParsedQaReport {
  const round = tailSection(reviewMd, /^##\s+.*(round|verify|Round)/i) || reviewMd;

  const statusLine = STATUS_LINE_RE.exec(round);
  let status: "PASS" | "FAIL";
  if (statusLine) {
    status = statusLine[0].includes("✅") ? "PASS" : "FAIL";
  } else {
    const hasFail = /❌/.test(round);
    const hasWarn = /⚠️/.test(round);
    const hasPass = /✅/.test(round);
    status = hasPass && !hasFail && !hasWarn ? "PASS" : "FAIL";
  }

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
 * `policies/documentation.md`'s own vocabulary, nothing invented here.
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
