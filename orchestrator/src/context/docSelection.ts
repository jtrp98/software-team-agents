import { AgentStage } from "../types.js";
import { extractIds } from "../traceability/traceability.js";
import { nestedSections, preamble, sectionMap, sectionText, type Section } from "./sections.js";
import { traceVerdict, type TraceabilityScope } from "./traceability.js";
import type { DocKind } from "./contextManager.js";

const ALWAYS_DESIGN = [
  /feature[- ]by[- ]feature|feasibility/i,
  /risks?\s*(&|and)?\s*dependenc/i,
  /open\s+questions?/i,
];

const PLAN_ALWAYS = [/plan\s+summary/i, /sequencing\s+notes?/i, /open\s+questions?/i];

function phaseHeadingMatcher(phase: number): RegExp {
  return new RegExp(`(phase|เฟส)\\s*0*${phase}\\b`, "i");
}

const CHANGE_LOG = /change\s*log/i;
const DATA_MODEL = /data\s*model/i;
const FEASIBILITY_SUMMARY = /feasibility\s+summary/i;
const MODULES_HEADING = /^modules?\b/i;
const OPEN_ISSUES = /open\s+issues?/i;

export interface ContextRequest {
  stage: AgentStage;
  doc: DocKind;
  phases?: number[];
  moduleName?: string;
  traceability?: TraceabilityScope;
}

export interface SelectedContext {
  doc: DocKind;
  text: string;
  kept: string[];
  skipped: string[];
  unknownSections: string[];
  fullDocument: boolean;
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

function readsInFull(req: ContextRequest): string | null {
  if (req.doc === "requirement" && (req.stage === AgentStage.BUSINESS_ANALYST || req.stage === AgentStage.SYSTEM_ANALYST)) {
    return `ยง10: ${req.stage} reads requirement.md in full because it owns or designs across the complete business contract`;
  }
  if (req.doc === "plan" && req.stage === AgentStage.PROJECT_MANAGER) {
    return "ยง10: project-manager owns plan.md and reads it in full when amending, to place new work in the right order";
  }
  if (req.doc === "design" && req.stage === AgentStage.SYSTEM_ANALYST) {
    return "ยง10: system-analyst owns design.md and reads it in full when amending";
  }
  if (req.doc === "security" || req.doc === "deploy" || req.doc === "test-plan") {
    return "ยง10 gives no slicing rule for this document, so it is passed through whole";
  }
  return null;
}

function isAlwaysReadDesignSection(heading: string): boolean {
  if (CHANGE_LOG.test(heading) || FEASIBILITY_SUMMARY.test(heading)) return false;
  return ALWAYS_DESIGN.some((re) => re.test(heading));
}

export type DesignSectionVerdict = "keep" | "drop" | "unknown";

export function keepDesignSection(heading: string, text: string, req: ContextRequest): DesignSectionVerdict {
  if (CHANGE_LOG.test(heading) || FEASIBILITY_SUMMARY.test(heading)) return "drop";
  if (isAlwaysReadDesignSection(heading)) return "keep";

  if (DATA_MODEL.test(heading)) {
    return req.stage === AgentStage.QA_ENGINEER || req.stage === AgentStage.PROJECT_MANAGER ? "keep" : "drop";
  }
  if (MODULES_HEADING.test(heading)) return "keep";

  const explicitPhase = /(phase|เน€เธเธช)\s*0*(\d+)\b/i.exec(heading);
  if (explicitPhase && req.phases && req.phases.length > 0) {
    return req.phases.includes(Number(explicitPhase[2])) ? "keep" : "drop";
  }

  const refs = extractIds(text, "DES");
  const trace = req.traceability;
  if (refs.length > 0 && trace?.usableForDesign) {
    if (refs.some((id) => trace.selectedDesignRefs.has(id))) return "keep";
    if (refs.every((id) => trace.plannedDesignRefs.has(id))) return "drop";
  }
  return "unknown";
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
 * Subset of `selectDocContext`'s fallback conditions that depend only on the
 * document's own headings/ids, not on stage/phase/traceability. Reused by
 * `--check-doc-structure` to flag a doc that would fall back to whole-document
 * context on *any* run, before a real run hits it.
 */
export function structuralFallbackReason(doc: DocKind, markdown: string): string | null {
  if (sectionMap(markdown).length === 0) {
    return "no `## ` headings found — nothing to slice along, so every run reads it whole";
  }
  if (doc === "design" && !sectionMap(markdown).some((s) => isAlwaysReadDesignSection(s.heading))) {
    return "none of §10's always-read sections (Feasibility / Risks / Open Questions) are present — every run reads it whole";
  }
  if (doc === "requirement" && extractIds(markdown, "REQ").length === 0) {
    return "no REQ-NNN rule ids — relevance cannot be established, so every run reads it whole";
  }
  return null;
}

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
      return whole(req.doc, markdown, "no phase given for plan.md — §10 slices by the phases a run touches, and guessing one would hide the work this run is for");
    }
    const matchers = phases.map(phaseHeadingMatcher);
    for (const s of sections) {
      const keep = PLAN_ALWAYS.some((re) => re.test(s.heading)) || matchers.some((re) => re.test(s.heading));
      if (keep) kept.push(s);
      else skipped.push(s.heading);
    }
    if (!matchers.some((re) => sections.some((s) => re.test(s.heading)))) {
      return whole(req.doc, markdown, `plan.md has no section matching phase ${phases.join(", ")} — the slice would silently omit this run's own work, so the document is passed through whole`);
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
      return whole(req.doc, markdown, "design.md has none of §10's always-read sections (Feasibility / Risks / Open Questions) — its structure is not the one this rule was written for, so it is passed through whole");
    }
    if (unknownSections.length / sections.length > 0.4) {
      return whole(req.doc, markdown, `more than 40% of design.md sections have unknown relevance (${unknownSections.length}/${sections.length}) — parser confidence is insufficient, so the document is passed through whole`, unknownSections);
    }
  } else if (req.doc === "requirement") {
    const phases = req.phases ?? [];
    if (phases.length === 0) return whole(req.doc, markdown, "no phase given for requirement.md — traceability slicing cannot safely choose business rules");
    const requirementIds = extractIds(markdown, "REQ");
    if (requirementIds.length === 0) return whole(req.doc, markdown, "requirement.md has no REQ-NNN rule ids — relevance cannot be established, so the document is passed through whole");
    const trace = req.traceability;
    if (!trace?.usableForRequirement) {
      return whole(req.doc, markdown, `requirement traceability is incomplete (${trace?.reason ?? "no relationship graph available"}) — the document is passed through whole`);
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
    const openIssues = sections.filter((s) => OPEN_ISSUES.test(s.heading));
    if (openIssues.length === 0) return whole(req.doc, markdown, "review.md has no `## Open Issues` section — that is the part every run must act on, so nothing is dropped");
    const last = sections[sections.length - 1];
    for (const s of sections) {
      if (OPEN_ISSUES.test(s.heading) || s === last || /unverified\s+behaviour/i.test(s.heading)) kept.push(s);
      else skipped.push(s.heading);
    }
  } else {
    return whole(req.doc, markdown, "no slicing rule for this document");
  }

  if (kept.length === 0) return whole(req.doc, markdown, "every section would have been dropped — that is a rule mismatch, not a small document");

  const parts = [preamble(markdown, sections), ...kept.map((s) => keptText.get(s.start) ?? sectionText(markdown, s))];
  const text = parts.filter((p) => p.trim() !== "").join("\n\n");
  return { doc: req.doc, text, kept: kept.map((s) => s.heading), skipped, unknownSections, fullDocument: false, reason: `§10 slice for ${req.stage}`, bytesBefore: markdown.length, bytesAfter: text.length };
}

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
  if (doc === "design") return isAlwaysReadDesignSection(heading) || MODULES_HEADING.test(heading) || (DATA_MODEL.test(heading) && (stage === AgentStage.QA_ENGINEER || stage === AgentStage.PROJECT_MANAGER));
  if (doc === "requirement") return REQUIREMENT_ALWAYS.some((matcher) => matcher.test(heading));
  if (doc === "plan") return PLAN_ALWAYS.some((matcher) => matcher.test(heading));
  if (doc === "review") return OPEN_ISSUES.test(heading) || /unverified\s+behaviour/i.test(heading) || isLast;
  if (doc === "security") return true;
  return false;
}

export function narrowSelectedContext(normal: SelectedContext, references: readonly string[], stage: AgentStage): SelectedContext {
  if (normal.fullDocument && /owns|reads requirement\.md in full/i.test(normal.reason)) return normal;
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
