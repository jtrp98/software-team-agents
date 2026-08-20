import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { moduleDocPath, readModuleDoc } from "../agents/moduleDocs.js";
import { CONTEXT_POLICY, type ContextCategory } from "./contextSelection.js";

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
};

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
}

export interface SelectedContext {
  doc: DocKind;
  text: string;
  kept: string[];
  skipped: string[];
  /** True when the whole document was returned — either by rule, or because slicing was not safe. */
  fullDocument: boolean;
  /** Why this came back the way it did. Always populated; a slice that cannot explain itself is not auditable. */
  reason: string;
  bytesBefore: number;
  bytesAfter: number;
}

function whole(doc: DocKind, markdown: string, reason: string): SelectedContext {
  return {
    doc,
    text: markdown,
    kept: sectionMap(markdown).map((s) => s.heading),
    skipped: [],
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
  if (req.doc === "requirement") {
    return "§10: requirement.md is read in full — it is the shortest of the four, has no per-phase structure to slice along, and the business rule you skipped is the one you would implement wrong";
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

/** Decides, per section, whether a design.md section stays. Returns null when the section is not covered by a rule either way. */
function keepDesignSection(heading: string, req: ContextRequest): boolean | null {
  if (CHANGE_LOG.test(heading) || FEASIBILITY_SUMMARY.test(heading)) return false;
  if (isAlwaysReadDesignSection(heading)) return true;

  if (DATA_MODEL.test(heading)) {
    // §7: qa-engineer reads the Data Model in full every round, and project-manager
    // needs the model list because it writes one task per model/migration.
    return req.stage === AgentStage.QA_ENGINEER || req.stage === AgentStage.PROJECT_MANAGER;
  }
  if (MODULES_HEADING.test(heading)) return true; // the entry is inside; §10 wants this module's, and dropping the heading loses it entirely
  return null;
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
      const verdict = keepDesignSection(s.heading, req);
      if (verdict === true) kept.push(s);
      else if (verdict === false) skipped.push(s.heading);
      else kept.push(s); // a contract section this run may implement — §10 says read it in full
    }
    if (!sections.some((s) => isAlwaysReadDesignSection(s.heading))) {
      return whole(
        req.doc,
        markdown,
        "design.md has none of §10's always-read sections (Feasibility / Risks / Open Questions) — its structure is not the one this rule was written for, so it is passed through whole",
      );
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

  const parts = [preamble(markdown, sections), ...kept.map((s) => sectionText(markdown, s))];
  const text = parts.filter((p) => p.trim() !== "").join("\n\n");

  return {
    doc: req.doc,
    text,
    kept: kept.map((s) => s.heading),
    skipped,
    fullDocument: false,
    reason: `§10 slice for ${req.stage}`,
    bytesBefore: markdown.length,
    bytesAfter: text.length,
  };
}

export interface ContextManagerOptions {
  projectRoot: string;
  moduleName: string;
}

export class ContextManager {
  constructor(private readonly opts: ContextManagerOptions) {}

  path(doc: DocKind): string {
    return moduleDocPath(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]);
  }

  /** One document, sliced. Null when the document does not exist — a missing doc is a fact for the caller, not an empty string to reason over. */
  read(stage: AgentStage, doc: DocKind, phases?: number[]): SelectedContext | null {
    const markdown = readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]);
    if (markdown === null) return null;
    return selectDocContext({ stage, doc, phases, moduleName: this.opts.moduleName }, markdown);
  }

  /**
   * Everything one stage may read, already sliced: the category policy decides
   * which documents, §10 decides how much of each. This is the composition T05
   * asks for — a role gets its relevant context, not the project's.
   */
  forStage(stage: AgentStage, phases?: number[]): SelectedContext[] {
    const policy = CONTEXT_POLICY[stage];
    if (!policy) return [];

    const out: SelectedContext[] = [];
    for (const category of policy.reads) {
      const doc = CATEGORY_TO_DOC[category];
      if (!doc) continue; // code/infra categories are not module documents
      const selected = this.read(stage, doc, phases);
      if (selected) out.push(selected);
    }
    return out;
  }

  /** What the slicing saved, for the run log. Reported rather than assumed: a filter nobody measures is a filter nobody notices breaking. */
  savings(selected: SelectedContext[]): { bytesBefore: number; bytesAfter: number; savedPct: number } {
    const bytesBefore = selected.reduce((n, s) => n + s.bytesBefore, 0);
    const bytesAfter = selected.reduce((n, s) => n + s.bytesAfter, 0);
    const savedPct = bytesBefore === 0 ? 0 : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 100);
    return { bytesBefore, bytesAfter, savedPct };
  }
}
