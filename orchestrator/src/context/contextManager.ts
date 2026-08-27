import { AgentStage } from "../types.js";
import { ArtifactType, type HandoffArtifact } from "../artifacts/schemas.js";
import { moduleDocPath, readModuleDoc } from "../agents/moduleDocs.js";
import { CONTEXT_POLICY, ContextLeakageError, type ContextCategory } from "./contextSelection.js";
import { parsePlanTasks } from "../docs/planGraph.js";
import { buildTraceChain, extractIds } from "../traceability/traceability.js";

/**
 * Cuts a module document down to the part one agent's run actually needs.
 *
 * `contextSelection.ts` already answers "which documents may this role read at
 * all?". That is a whitelist at document granularity, and it stops being enough
 * the moment a project is large: `design.md` and `plan.md` grow without bound,
 * every agent starts from a fresh context, and each run pays to re-read the
 * whole thing. Reading a 900-line plan to implement one phase is the single
 * most repeated waste in this pipeline.
 *
 * The rule for what to keep is not invented here — `policies/documentation.md` §10
 * §10 already states it per document and per role. What §10 could not do is
 * enforce it: it is prose, so it binds an agent that reads and remembers it, and
 * costs nothing to ignore. This module makes the same rule executable, so the
 * orchestrator can hand a stage its slice instead of hoping the stage slices
 * correctly.
 *
 * FAILING OPEN IS THE WHOLE SAFETY MODEL
 *
 * Slicing is an optimization; completeness is a correctness requirement. Those
 * are not equal, so the failure modes are not treated equally: when a document
 * does not have the structure this expects — headings renamed, written in Thai
 * per §11, a phase block that isn't there — it returns the document whole and
 * says why. Sending too much costs tokens. Dropping the one business rule that
 * mattered costs a wrong implementation that QA may not catch, because nothing
 * downstream can tell a missing rule from a rule that never existed.
 */

/** The module documents this understands. `test-plan`/`security`/`deploy` have no §10 slicing rule, so they pass through whole. */
export type DocKind = "requirement" | "design" | "plan" | "test-plan" | "review" | "security" | "deploy";

export const DOC_FILENAME: Record<DocKind, string> = {
  requirement: "requirement.md",
  design: "design.md",
  plan: "plan.md",
  "test-plan": "test-plan.md",
  review: "review.md",
  security: "security.md",
  deploy: "deploy.md",
};

/** Which document backs each category a role's context policy may allow. */
export const CATEGORY_TO_DOC: Partial<Record<ContextCategory, DocKind>> = {
  [ArtifactType.REQUIREMENTS]: "requirement",
  [ArtifactType.DESIGN]: "design",
  [ArtifactType.PLAN]: "plan",
  [ArtifactType.TEST_PLAN]: "test-plan",
  [ArtifactType.QA_REPORT]: "review",
  [ArtifactType.SECURITY_REPORT]: "security",
  // HANDOFF intentionally has no entry: it indexes authoritative documents,
  // but is not itself a module document for §10 slicing.
};

const DOC_TO_CATEGORY: Partial<Record<DocKind, ArtifactType>> = {
  requirement: ArtifactType.REQUIREMENTS,
  design: ArtifactType.DESIGN,
  plan: ArtifactType.PLAN,
  "test-plan": ArtifactType.TEST_PLAN,
  review: ArtifactType.QA_REPORT,
  security: ArtifactType.SECURITY_REPORT,
};

export type ReferencedSections = Partial<Record<DocKind, string[]>>;

/**
 * Resolves only the three reference fields P6 authorizes for document
 * narrowing. An explicit filename outside the role's policy is an attempted
 * authorization expansion and fails closed. Unqualified semantic references
 * are ignored when their default document is not already permitted.
 */
export function handoffReferencedSections(stage: AgentStage, handoff: HandoffArtifact): ReferencedSections {
  const policy = CONTEXT_POLICY[stage];
  if (!policy) return {};
  const out: ReferencedSections = {};
  const qualifiedDocs = (Object.keys(DOC_FILENAME) as DocKind[])
    .filter((doc) => doc !== "deploy")
    .sort((a, b) => DOC_FILENAME[b].length - DOC_FILENAME[a].length);

  const add = (reference: string, fallback: DocKind): void => {
    const qualified = qualifiedDocs.find((doc) => reference.startsWith(`${DOC_FILENAME[doc]}#`));
    const doc = qualified ?? fallback;
    const category = DOC_TO_CATEGORY[doc];
    if (!category) return;
    if (!policy.reads.includes(category)) {
      if (qualified) throw new ContextLeakageError(stage, category);
      return;
    }
    (out[doc] ??= []).push(reference);
  };

  for (const reference of handoff.constraint_refs) add(reference, "requirement");
  for (const reference of [...handoff.contract_refs.produces, ...handoff.contract_refs.consumes]) add(reference, "design");
  for (const reference of handoff.test_refs) add(reference, "test-plan");
  for (const [doc, references] of Object.entries(out) as Array<[DocKind, string[]]>) out[doc] = [...new Set(references)];
  return out;
}

export interface Section {
  heading: string;
  /** `##` -> 2, `###` -> 3. Only `##` starts a new top-level section; deeper ones stay inside their parent. */
  level: number;
  /** Line index of the heading itself, and of the first line after this section. */
  start: number;
  end: number;
}

/**
 * The `Grep -n "^## "` step §10 tells an agent to run, done once and returned
 * as data. Only `##` boundaries are used: `###` subsections belong to the `##`
 * they sit under, and splitting on them would hand out half a contract.
 */
export function sectionMap(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let fenced = false;

  for (let i = 0; i < lines.length; i++) {
    // A `## ` inside a fenced block is sample content, not a heading — policies/documentation.md
    // itself contains exactly that, and treating it as a boundary would split a code block.
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;

    const m = /^(#{2,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (!m || m[1].length !== 2) continue;

    if (sections.length > 0) sections[sections.length - 1].end = i;
    sections.push({ heading: m[2].trim(), level: 2, start: i, end: lines.length });
  }
  return sections;
}

/** Text of everything before the first `## ` — the title and any preamble, always kept. */
function preamble(markdown: string, sections: Section[]): string {
  const lines = markdown.split(/\r?\n/);
  const end = sections.length > 0 ? sections[0].start : lines.length;
  return lines.slice(0, end).join("\n");
}

function sectionText(markdown: string, s: Section): string {
  return markdown.split(/\r?\n/).slice(s.start, s.end).join("\n");
}

/**
 * Matchers for the headings §10 names. Written as patterns rather than exact
 * strings because §11 has every document authored in Thai with technical terms
 * left in English — so the English anchor word is what survives translation,
 * and an exact-string match would miss almost every real document.
 */
const ALWAYS_DESIGN = [
  /feature[- ]by[- ]feature|feasibility/i,
  /risks?\s*(&|and)?\s*dependenc/i,
  /open\s+questions?/i,
];

const PLAN_ALWAYS = [/plan\s+summary/i, /sequencing\s+notes?/i, /open\s+questions?/i];

/** `## Phase 3: ...`, `## Phase 3 — ...`, `## เฟส 3`, with or without a trailing 🔒 Security gate marker. */
function phaseHeadingMatcher(phase: number): RegExp {
  return new RegExp(`(phase|เฟส)\\s*0*${phase}\\b`, "i");
}

function moduleHeadingMatcher(moduleName: string): RegExp {
  return new RegExp(moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

const CHANGE_LOG = /change\s*log/i;
const DATA_MODEL = /data\s*model/i;
const FEASIBILITY_SUMMARY = /feasibility\s+summary/i;
const MODULES_HEADING = /^modules?\b/i;
const OPEN_ISSUES = /open\s+issues?/i;

export interface ContextRequest {
  stage: AgentStage;
  doc: DocKind;
  /** The phase this run touches. §10 allows several — pass every phase the run covers. */
  phases?: number[];
  /** The module folder's name, used to keep this module's entry under `## Modules` and drop the others. */
  moduleName?: string;
  /** Positive repository-supported REQ/DES/plan relationships; absent means relevance is unknown. */
  traceability?: TraceabilityScope;
}

export interface SelectedContext {
  doc: DocKind;
  text: string;
  kept: string[];
  skipped: string[];
  /** Sections retained because repository relationships could not prove relevance either way. */
  unknownSections: string[];
  /** True when the whole document was returned — either by rule, or because slicing was not safe. */
  fullDocument: boolean;
  /** Why this came back the way it did. Always populated; a slice that cannot explain itself is not auditable. */
  reason: string;
  bytesBefore: number;
  bytesAfter: number;
}

function whole(doc: DocKind, markdown: string, reason: string, unknownSections: string[] = []): SelectedContext {
  return {
    doc,
    text: markdown,
    kept: sectionMap(markdown).map((s) => s.heading),
    skipped: [],
    unknownSections,
    fullDocument: true,
    reason,
    bytesBefore: markdown.length,
    bytesAfter: markdown.length,
  };
}

/**
 * The roles §10 exempts, each because it owns the document and has to see all
 * of it to place new work correctly against what is already there.
 */
function readsInFull(req: ContextRequest): string | null {
  if (req.doc === "requirement" && (req.stage === AgentStage.BUSINESS_ANALYST || req.stage === AgentStage.SYSTEM_ANALYST)) {
    return `§10: ${req.stage} reads requirement.md in full because it owns or designs across the complete business contract`;
  }
  if (req.doc === "plan" && req.stage === AgentStage.PROJECT_MANAGER) {
    return "§10: project-manager owns plan.md and reads it in full when amending, to place new work in the right order";
  }
  if (req.doc === "design" && req.stage === AgentStage.SYSTEM_ANALYST) {
    return "§10: system-analyst owns design.md and reads it in full when amending";
  }
  if (req.doc === "security" || req.doc === "deploy" || req.doc === "test-plan") {
    return "§10 gives no slicing rule for this document, so it is passed through whole";
  }
  return null;
}

function needsTraceability(stage: AgentStage, doc: DocKind): boolean {
  if (doc === "design") return stage !== AgentStage.SYSTEM_ANALYST;
  if (doc === "requirement") return stage !== AgentStage.BUSINESS_ANALYST && stage !== AgentStage.SYSTEM_ANALYST;
  return false;
}

export interface TraceabilityScope {
  usableForDesign: boolean;
  usableForRequirement: boolean;
  reason: string;
  selectedTaskIds: Set<string>;
  selectedDesignRefs: Set<string>;
  plannedDesignRefs: Set<string>;
  relevantRequirementIds: Set<string>;
  plannedRequirementIds: Set<string>;
}

function unavailableTrace(reason: string): TraceabilityScope {
  return {
    usableForDesign: false,
    usableForRequirement: false,
    reason,
    selectedTaskIds: new Set(),
    selectedDesignRefs: new Set(),
    plannedDesignRefs: new Set(),
    relevantRequirementIds: new Set(),
    plannedRequirementIds: new Set(),
  };
}

/** Builds only the REQ → DES → plan relationships the repository already supports. */
export function traceabilityScopeFor(
  requirementMd: string | null,
  designMd: string | null,
  planMd: string | null,
  phases: readonly number[] | undefined,
  taskId?: string,
): TraceabilityScope {
  if (!requirementMd || !designMd || !planMd) return unavailableTrace("requirement.md, design.md, or plan.md is missing");
  if (!phases || phases.length === 0) return unavailableTrace("no phase was supplied");
  const parsed = parsePlanTasks(planMd);
  if (parsed.problems.length > 0) return unavailableTrace(`plan.md task structure is not reliable: ${parsed.problems[0]}`);
  const exactTask = taskId ? parsed.tasks.find((task) => task.id === taskId) : undefined;
  const selectedTasks = exactTask ? [exactTask] : parsed.tasks.filter((task) => phases.includes(task.phase));
  if (selectedTasks.length === 0) return unavailableTrace(`plan.md has no parseable task in phase ${phases.join(", ")}`);
  if (selectedTasks.some((task) => task.designRefs.length === 0)) {
    return unavailableTrace("at least one selected plan task has no DES-NNN relationship");
  }

  const selectedDesignRefs = new Set(selectedTasks.flatMap((task) => task.designRefs));
  const plannedDesignRefs = new Set(parsed.tasks.flatMap((task) => task.designRefs));
  const chain = buildTraceChain({ requirementMd, designMd, planMd });
  const relevantRequirementIds = new Set(
    chain
      .filter((entry) => entry.design.some((id) => selectedDesignRefs.has(id)))
      .map((entry) => entry.requirement),
  );
  const plannedRequirementIds = new Set(chain.filter((entry) => entry.tasks.length > 0).map((entry) => entry.requirement));
  const everySelectedDesignMapsToRequirement = [...selectedDesignRefs].every((id) =>
    chain.some((entry) => entry.design.includes(id)),
  );
  return {
    usableForDesign: true,
    usableForRequirement: everySelectedDesignMapsToRequirement && relevantRequirementIds.size > 0,
    reason: everySelectedDesignMapsToRequirement
      ? "traceability relationships resolved"
      : "a selected DES-NNN has no same-line REQ-NNN relationship in design.md",
    selectedTaskIds: new Set(selectedTasks.map((task) => task.id)),
    selectedDesignRefs,
    plannedDesignRefs,
    relevantRequirementIds,
    plannedRequirementIds,
  };
}

/**
 * The always-read set, with the two §10 exclusions applied first.
 *
 * Order matters here and got this wrong once: "Feasibility Summary" contains
 * "feasibility", so an always-read check that runs first keeps the one section
 * §10 explicitly says to skip — an executive summary of sections being read
 * anyway. Exclusions are checked before inclusions, not after.
 */
function isAlwaysReadDesignSection(heading: string): boolean {
  if (CHANGE_LOG.test(heading) || FEASIBILITY_SUMMARY.test(heading)) return false;
  return ALWAYS_DESIGN.some((re) => re.test(heading));
}

export type DesignSectionVerdict = "keep" | "drop" | "unknown";

/** Three-way decision: only a positive relationship may produce `drop`. */
export function keepDesignSection(heading: string, text: string, req: ContextRequest): DesignSectionVerdict {
  if (CHANGE_LOG.test(heading) || FEASIBILITY_SUMMARY.test(heading)) return "drop";
  if (isAlwaysReadDesignSection(heading)) return "keep";

  if (DATA_MODEL.test(heading)) {
    // §7: qa-engineer reads the Data Model in full every round, and project-manager
    // needs the model list because it writes one task per model/migration.
    return req.stage === AgentStage.QA_ENGINEER || req.stage === AgentStage.PROJECT_MANAGER ? "keep" : "drop";
  }
  if (MODULES_HEADING.test(heading)) return "keep";

  const explicitPhase = /(phase|เฟส)\s*0*(\d+)\b/i.exec(heading);
  if (explicitPhase && req.phases && req.phases.length > 0) {
    return req.phases.includes(Number(explicitPhase[2])) ? "keep" : "drop";
  }

  const refs = extractIds(text, "DES");
  const trace = req.traceability;
  if (refs.length > 0 && trace?.usableForDesign) {
    if (refs.some((id) => trace.selectedDesignRefs.has(id))) return "keep";
    // A design that no plan task references may be future work; absence from
    // this phase is not proof of irrelevance. Every ref must be known-planned.
    if (refs.every((id) => trace.plannedDesignRefs.has(id))) return "drop";
  }
  return "unknown";
}

interface NestedSection {
  heading: string;
  start: number;
  end: number;
}

function nestedSections(markdown: string, level: number): NestedSection[] {
  const lines = markdown.split(/\r?\n/);
  const out: NestedSection[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{2,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (!match || match[1].length !== level) continue;
    if (out.length > 0) out[out.length - 1].end = i;
    out.push({ heading: match[2].trim(), start: i, end: lines.length });
  }
  return out;
}

function normalizedModuleHeading(heading: string): string {
  return heading.replace(/^module\s*[:—-]\s*/i, "").replace(/^`|`$/g, "").trim().toLowerCase();
}

function sliceModulesSection(markdown: string, moduleName: string | undefined): { text: string; skipped: string[] } | null {
  if (!moduleName) return null;
  const entries = nestedSections(markdown, 3);
  if (entries.length === 0) return null;
  const matches = entries.filter((entry) => normalizedModuleHeading(entry.heading) === moduleName.toLowerCase());
  if (matches.length !== 1) return null;
  const lines = markdown.split(/\r?\n/);
  const prefix = lines.slice(0, entries[0].start).join("\n");
  const selected = lines.slice(matches[0].start, matches[0].end).join("\n");
  return {
    text: [prefix, selected].filter((part) => part.trim() !== "").join("\n"),
    skipped: entries.filter((entry) => entry !== matches[0]).map((entry) => `Modules > ${entry.heading}`),
  };
}

const REQUIREMENT_ALWAYS = [/\bscope\b|ขอบเขต|mvp|nice[- ]to[- ]have/i, /references?|อ้างอิง/i, /open\s+questions?|คำถาม/i];

interface TraceSlice {
  verdict: DesignSectionVerdict;
  text: string;
  skipped: string[];
}

function traceVerdict(ids: string[], relevant: Set<string>, planned: Set<string>): DesignSectionVerdict {
  if (ids.some((id) => relevant.has(id))) return "keep";
  if (ids.length > 0 && ids.every((id) => planned.has(id))) return "drop";
  return "unknown";
}

/**
 * Slices a mixed requirement section only when its complete row/subsection
 * structure is parseable. Any prose outside that structure makes the section
 * unknown and therefore kept whole.
 */
function sliceRequirementSection(markdown: string, trace: TraceabilityScope): TraceSlice {
  const relevant = trace.relevantRequirementIds;
  const planned = trace.plannedRequirementIds;
  const wholeIds = extractIds(markdown, "REQ");
  if (wholeIds.length === 0) return { verdict: "unknown", text: markdown, skipped: [] };

  const subsections = nestedSections(markdown, 3);
  if (subsections.length > 0) {
    const lines = markdown.split(/\r?\n/);
    const kept = [lines.slice(0, subsections[0].start).join("\n")];
    const skipped: string[] = [];
    let unknown = false;
    for (const subsection of subsections) {
      const text = lines.slice(subsection.start, subsection.end).join("\n");
      const verdict = traceVerdict(extractIds(text, "REQ"), relevant, planned);
      if (verdict === "drop") skipped.push(`${subsection.heading} (${extractIds(text, "REQ").join(", ")})`);
      else {
        kept.push(text);
        if (verdict === "unknown") unknown = true;
      }
    }
    if (subsections.some((subsection) => extractIds(lines.slice(subsection.start, subsection.end).join("\n"), "REQ").length === 0)) {
      return { verdict: "unknown", text: markdown, skipped: [] };
    }
    return { verdict: unknown ? "unknown" : "keep", text: kept.filter((part) => part.trim() !== "").join("\n\n"), skipped };
  }

  const lines = markdown.split(/\r?\n/);
  const body = lines.slice(1);
  const nonblank = body.map((line, index) => ({ line, index })).filter(({ line }) => line.trim() !== "");
  const tableLines = nonblank.filter(({ line }) => line.trim().startsWith("|"));
  if (tableLines.length > 0 && tableLines.length === nonblank.length && tableLines.length >= 3) {
    const rows = tableLines.map(({ line }) => line);
    const data = rows.slice(2);
    const delimiterCells = rows[1].split("|").map((cell) => cell.trim()).filter(Boolean);
    const validDelimiter = delimiterCells.length > 0 && delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell));
    if (validDelimiter && data.every((row) => extractIds(row, "REQ").length > 0)) {
      const keptRows: string[] = [];
      const skipped: string[] = [];
      let unknown = false;
      for (const row of data) {
        const ids = extractIds(row, "REQ");
        const verdict = traceVerdict(ids, relevant, planned);
        if (verdict === "drop") skipped.push(ids.join(", "));
        else {
          keptRows.push(row);
          if (verdict === "unknown") unknown = true;
        }
      }
      return {
        verdict: unknown ? "unknown" : "keep",
        text: [lines[0], rows[0], rows[1], ...keptRows].join("\n"),
        skipped,
      };
    }
  }

  // A simple list is safe only when every substantive block starts with a
  // bullet carrying its own REQ id. Continuation prose is kept with that row.
  const bulletStarts = body.map((line, index) => (/^\s*[-*]\s+/.test(line) ? index : -1)).filter((index) => index >= 0);
  const proseBeforeFirst = bulletStarts.length > 0 ? body.slice(0, bulletStarts[0]).some((line) => line.trim() !== "") : true;
  if (bulletStarts.length > 0 && !proseBeforeFirst) {
    const blocks = bulletStarts.map((start, index) => body.slice(start, bulletStarts[index + 1] ?? body.length).join("\n"));
    if (blocks.every((block) => extractIds(block, "REQ").length > 0)) {
      const kept: string[] = [lines[0]];
      const skipped: string[] = [];
      let unknown = false;
      for (const block of blocks) {
        const ids = extractIds(block, "REQ");
        const verdict = traceVerdict(ids, relevant, planned);
        if (verdict === "drop") skipped.push(ids.join(", "));
        else {
          kept.push(block);
          if (verdict === "unknown") unknown = true;
        }
      }
      return { verdict: unknown ? "unknown" : "keep", text: kept.join("\n"), skipped };
    }
  }

  const verdict = traceVerdict(wholeIds, relevant, planned);
  return { verdict, text: markdown, skipped: [] };
}

/**
 * Applies §10 to one document. Returns the whole thing, with a reason, whenever
 * the structure it expects is not there — see the header on why that asymmetry
 * is deliberate.
 */
export function selectDocContext(req: ContextRequest, markdown: string): SelectedContext {
  const full = readsInFull(req);
  if (full) return whole(req.doc, markdown, full);

  const sections = sectionMap(markdown);
  if (sections.length === 0) {
    return whole(req.doc, markdown, "no `## ` headings found — nothing to slice along, so the document is passed through whole");
  }

  const kept: Section[] = [];
  const skipped: string[] = [];
  const unknownSections: string[] = [];
  const keptText = new Map<number, string>();

  if (req.doc === "plan") {
    const phases = req.phases ?? [];
    if (phases.length === 0) {
      return whole(
        req.doc,
        markdown,
        "no phase given for plan.md — §10 slices by the phases a run touches, and guessing one would hide the work this run is for",
      );
    }
    const matchers = phases.map(phaseHeadingMatcher);
    for (const s of sections) {
      const keep = PLAN_ALWAYS.some((re) => re.test(s.heading)) || matchers.some((re) => re.test(s.heading));
      if (keep) kept.push(s);
      else skipped.push(s.heading);
    }
    if (!matchers.some((re) => sections.some((s) => re.test(s.heading)))) {
      return whole(
        req.doc,
        markdown,
        `plan.md has no section matching phase ${phases.join(", ")} — the slice would silently omit this run's own work, so the document is passed through whole`,
      );
    }
  } else if (req.doc === "design") {
    for (const s of sections) {
      const original = sectionText(markdown, s);
      const verdict = keepDesignSection(s.heading, original, req);
      if (verdict === "keep") {
        kept.push(s);
        if (MODULES_HEADING.test(s.heading)) {
          const sliced = sliceModulesSection(original, req.moduleName);
          if (sliced) {
            keptText.set(s.start, sliced.text);
            skipped.push(...sliced.skipped);
          } else {
            unknownSections.push(s.heading);
          }
        }
      } else if (verdict === "drop") skipped.push(s.heading);
      else {
        kept.push(s);
        unknownSections.push(s.heading);
      }
    }
    if (!sections.some((s) => isAlwaysReadDesignSection(s.heading))) {
      return whole(
        req.doc,
        markdown,
        "design.md has none of §10's always-read sections (Feasibility / Risks / Open Questions) — its structure is not the one this rule was written for, so it is passed through whole",
      );
    }
    if (unknownSections.length / sections.length > 0.4) {
      return whole(
        req.doc,
        markdown,
        `more than 40% of design.md sections have unknown relevance (${unknownSections.length}/${sections.length}) — parser confidence is insufficient, so the document is passed through whole`,
        unknownSections,
      );
    }
  } else if (req.doc === "requirement") {
    const phases = req.phases ?? [];
    if (phases.length === 0) {
      return whole(req.doc, markdown, "no phase given for requirement.md — traceability slicing cannot safely choose business rules");
    }
    const requirementIds = extractIds(markdown, "REQ");
    if (requirementIds.length === 0) {
      return whole(req.doc, markdown, "requirement.md has no REQ-NNN rule ids — relevance cannot be established, so the document is passed through whole");
    }
    const trace = req.traceability;
    if (!trace?.usableForRequirement) {
      return whole(
        req.doc,
        markdown,
        `requirement traceability is incomplete (${trace?.reason ?? "no relationship graph available"}) — the document is passed through whole`,
      );
    }
    for (const s of sections) {
      const original = sectionText(markdown, s);
      if (REQUIREMENT_ALWAYS.some((matcher) => matcher.test(s.heading))) {
        kept.push(s);
        continue;
      }
      if (CHANGE_LOG.test(s.heading)) {
        skipped.push(s.heading);
        continue;
      }
      const sliced = sliceRequirementSection(original, trace);
      if (sliced.verdict === "drop") {
        skipped.push(`${s.heading}${sliced.skipped.length > 0 ? ` (${sliced.skipped.join(", ")})` : ""}`);
      } else {
        kept.push(s);
        keptText.set(s.start, sliced.text);
        skipped.push(...sliced.skipped.map((name) => `${s.heading} > ${name}`));
        if (sliced.verdict === "unknown") unknownSections.push(s.heading);
      }
    }
  } else if (req.doc === "review") {
    // §10: Open Issues first — for most runs the only part to act on — then the current round.
    const openIssues = sections.filter((s) => OPEN_ISSUES.test(s.heading));
    if (openIssues.length === 0) {
      return whole(
        req.doc,
        markdown,
        "review.md has no `## Open Issues` section — that is the part every run must act on, so nothing is dropped",
      );
    }
    const last = sections[sections.length - 1];
    for (const s of sections) {
      if (OPEN_ISSUES.test(s.heading) || s === last || /unverified\s+behaviour/i.test(s.heading)) kept.push(s);
      else skipped.push(s.heading);
    }
  } else {
    return whole(req.doc, markdown, "no slicing rule for this document");
  }

  if (kept.length === 0) {
    return whole(req.doc, markdown, "every section would have been dropped — that is a rule mismatch, not a small document");
  }

  const parts = [preamble(markdown, sections), ...kept.map((s) => keptText.get(s.start) ?? sectionText(markdown, s))];
  const text = parts.filter((p) => p.trim() !== "").join("\n\n");

  return {
    doc: req.doc,
    text,
    kept: kept.map((s) => s.heading),
    skipped,
    unknownSections,
    fullDocument: false,
    reason: `§10 slice for ${req.stage}`,
    bytesBefore: markdown.length,
    bytesAfter: text.length,
  };
}

/** Above this heading ratio the reference index costs more complexity than it saves. */
export const HANDOFF_REFERENCE_MAX_SECTION_RATIO = 0.6;

function decodedReferencePart(reference: string): string {
  const part = reference.includes("#") ? reference.slice(reference.indexOf("#") + 1) : reference;
  try {
    return decodeURIComponent(part).replace(/:\d+$/, "");
  } catch {
    return part;
  }
}

function comparableReference(value: string): string {
  return decodedReferencePart(value).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function sectionMatchesReference(markdown: string, section: Section, references: readonly string[]): boolean {
  const heading = comparableReference(section.heading);
  const text = sectionText(markdown, section);
  return references.some((reference) => {
    const needle = comparableReference(reference);
    if (needle !== "" && (heading === needle || heading.includes(needle) || needle.includes(heading))) return true;
    const ids = [...reference.matchAll(/\b(?:REQ|DES|TP)-[A-Za-z0-9._-]+\b/gi)].map((match) => match[0]);
    return ids.some((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  });
}

function isHandoffAlwaysRead(doc: DocKind, heading: string, stage: AgentStage, isLast: boolean): boolean {
  if (doc === "design") {
    return isAlwaysReadDesignSection(heading) || MODULES_HEADING.test(heading) ||
      (DATA_MODEL.test(heading) && (stage === AgentStage.QA_ENGINEER || stage === AgentStage.PROJECT_MANAGER));
  }
  if (doc === "requirement") return REQUIREMENT_ALWAYS.some((matcher) => matcher.test(heading));
  if (doc === "plan") return PLAN_ALWAYS.some((matcher) => matcher.test(heading));
  if (doc === "review") return OPEN_ISSUES.test(heading) || /unverified\s+behaviour/i.test(heading) || isLast;
  // security.md has no safe section-level rule in §10, so a handoff never
  // narrows it. The normal whole-document result remains the ceiling and floor.
  if (doc === "security") return true;
  return false;
}

/**
 * Intersects the normal §10 result with handoff references. Positive P3/P3B
 * selections and the always-read set remain mandatory; only unknown or
 * whole-document excess can be removed. Any ambiguity falls back to `normal`.
 */
function narrowSelectedContext(
  normal: SelectedContext,
  references: readonly string[],
  stage: AgentStage,
): SelectedContext {
  if (normal.fullDocument && /owns|reads requirement\.md in full/i.test(normal.reason)) return normal;
  // A minimal/incomplete handoff proves no section irrelevant. Treat it as an
  // unresolved index and preserve the exact normal slice.
  if (references.length === 0) return normal;
  const source = normal.text;
  const mapped = sectionMap(source);
  if (mapped.length === 0) return normal;

  const normalUnknown = new Set(normal.unknownSections);
  const referenceMatched = mapped.filter((section) => sectionMatchesReference(source, section, references));
  if (references.length > 0 && referenceMatched.length === 0) return normal;
  if (referenceMatched.length / mapped.length > HANDOFF_REFERENCE_MAX_SECTION_RATIO) return normal;
  const kept = mapped.filter((section, index) => {
    const always = isHandoffAlwaysRead(normal.doc, section.heading, stage, index === mapped.length - 1);
    const positivelySelected = !normal.fullDocument && normal.kept.includes(section.heading) && !normalUnknown.has(section.heading);
    return always || positivelySelected || sectionMatchesReference(source, section, references);
  });
  if (kept.length === 0) return normal;

  const narrowedOut = mapped.filter((section) => !kept.includes(section)).map((section) => section.heading);
  const parts = [preamble(source, mapped), ...kept.map((section) => sectionText(source, section))];
  const text = parts.filter((part) => part.trim() !== "").join("\n\n");
  if (text.length >= normal.text.length) return normal;
  return {
    ...normal,
    text,
    kept: kept.map((section) => section.heading),
    skipped: [...new Set([...normal.skipped, ...narrowedOut])],
    unknownSections: normal.unknownSections.filter((heading) => kept.some((section) => section.heading === heading)),
    fullDocument: false,
    reason: `${normal.reason}; narrowed by HANDOFF references within CONTEXT_POLICY`,
    bytesAfter: text.length,
  };
}

export interface ContextManagerOptions {
  projectRoot: string;
  moduleName: string;
}

export class ContextManager {
  private lastReadCount = 0;

  constructor(private readonly opts: ContextManagerOptions) {}

  path(doc: DocKind): string {
    return moduleDocPath(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]);
  }

  /** One document, sliced. Null when the document does not exist — a missing doc is a fact for the caller, not an empty string to reason over. */
  read(stage: AgentStage, doc: DocKind, phases?: number[], taskId?: string, traceability?: TraceabilityScope): SelectedContext | null {
    const cache = new Map<DocKind, string | null>();
    const load = (kind: DocKind): string | null => {
      if (!cache.has(kind)) cache.set(kind, readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[kind]));
      return cache.get(kind)!;
    };
    const markdown = load(doc);
    if (markdown === null) {
      this.lastReadCount = cache.size;
      return null;
    }
    const trace = traceability ?? (needsTraceability(stage, doc) ? this.traceability(phases, taskId, load) : unavailableTrace("this document/owner does not need traceability slicing"));
    this.lastReadCount = cache.size;
    return selectDocContext({ stage, doc, phases, moduleName: this.opts.moduleName, traceability: trace }, markdown);
  }

  private traceability(phases?: number[], taskId?: string, load?: (doc: DocKind) => string | null): TraceabilityScope {
    if (!phases || phases.length === 0) return unavailableTrace("no phase was supplied");
    const read = load ?? ((doc: DocKind) => readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]));
    return traceabilityScopeFor(
      read("requirement"),
      read("design"),
      read("plan"),
      phases,
      taskId,
    );
  }

  /**
   * Everything one stage may read, already sliced: the category policy decides
   * which documents, §10 decides how much of each. This is the composition T05
   * asks for — a role gets its relevant context, not the project's.
   */
  forStage(stage: AgentStage, phases?: number[], taskId?: string, referencedSections?: ReferencedSections): SelectedContext[] {
    const policy = CONTEXT_POLICY[stage];
    if (!policy) return [];

    const cache = new Map<DocKind, string | null>();
    const load = (doc: DocKind): string | null => {
      if (!cache.has(doc)) cache.set(doc, readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]));
      return cache.get(doc)!;
    };
    const out: SelectedContext[] = [];
    const policyDocs = policy.reads.map((category) => CATEGORY_TO_DOC[category]).filter((doc): doc is DocKind => doc !== undefined);
    const traceability = policyDocs.some((doc) => needsTraceability(stage, doc))
      ? this.traceability(phases, taskId, load)
      : unavailableTrace("this stage's documents do not need traceability slicing");
    for (const category of policy.reads) {
      const doc = CATEGORY_TO_DOC[category];
      if (!doc) continue; // code/infra categories are not module documents
      const markdown = load(doc);
      if (markdown !== null) {
        const normal = selectDocContext({ stage, doc, phases, moduleName: this.opts.moduleName, traceability }, markdown);
        out.push(referencedSections === undefined ? normal : narrowSelectedContext(normal, referencedSections[doc] ?? [], stage));
      }
    }
    this.lastReadCount = cache.size;
    return out;
  }

  /** Unique module-document read attempts made by the last read/forStage call. */
  directFileReads(): number {
    return this.lastReadCount;
  }

  /** What the slicing saved, for the run log. Reported rather than assumed: a filter nobody measures is a filter nobody notices breaking. */
  savings(selected: SelectedContext[]): { bytesBefore: number; bytesAfter: number; savedPct: number } {
    const bytesBefore = selected.reduce((n, s) => n + s.bytesBefore, 0);
    const bytesAfter = selected.reduce((n, s) => n + s.bytesAfter, 0);
    const savedPct = bytesBefore === 0 ? 0 : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 100);
    return { bytesBefore, bytesAfter, savedPct };
  }
}
