import * as fs from "node:fs";
import * as path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { fileURLToPath } from "node:url";
import { sectionMap, sectionText } from "../context/sections.js";
import { structuralFallbackReason } from "../context/docSelection.js";
import { extractIds } from "../traceability/traceability.js";

/**
 * A schema per module document type (`requirement.md`, `design.md`, `plan.md`,
 * `review.md`, `security.md`), so a missing required section is a mechanical finding
 * instead of something only caught if a person happens to notice.
 *
 * These documents are prose Markdown, not JSON or YAML, so a JSON Schema can't validate
 * them directly. This module extracts a small, flat, boolean-and-count *structural
 * summary* from each document — "does it have a `## Change Log` section", "how many
 * `## Phase N` headings does it have" — and it's that summary a schema validates. The
 * schema can therefore only ever say "this required section is missing" or "this doc has
 * zero phases" — it says nothing about whether the prose inside a section is any good.
 *
 * Every required section is checked against the exact fixed heading each agent's Output
 * template writes (`.claude/agents/<role>.md`) — a wording drift there and a wording
 * drift here have to be fixed together.
 */

export type DocType = "requirement" | "design" | "plan" | "review" | "security";

export const DOC_FILENAMES: Record<DocType, string> = {
  requirement: "requirement.md",
  design: "design.md",
  plan: "plan.md",
  review: "review.md",
  security: "security.md",
};

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

function schemaFile(docType: DocType): string {
  return path.join(SCHEMA_DIR, `${docType}.schema.json`);
}

function has(markdown: string, pattern: RegExp): boolean {
  return pattern.test(markdown);
}

function count(markdown: string, pattern: RegExp): number {
  return [...markdown.matchAll(pattern)].length;
}

/**
 * design.md's schema-known `##` headings, keyed by the schema property each one
 * satisfies. `extractStructure` and `checkDesignContractSections` below both read this
 * one map (presence vs. exclusion) so they can't name the headings differently; the
 * assertion right after it fails loudly if this map and the schema's `required` list
 * ever disagree.
 */
const DESIGN_HEADING_PATTERN: Record<string, RegExp> = {
  hasFeasibilitySummary: /^##\s+Feasibility Summary/im,
  hasFeatureFeasibility: /^##\s+Feature-by-Feature Feasibility/im,
  hasDataModel: /^##\s+Data Model/im,
  hasModules: /^##\s+Modules\s*$/im,
  hasRisks: /^##\s+Risks/im,
  hasOpenQuestions: /^##\s+Unresolved Open Questions/im,
  hasChangeLog: /^##\s+Change Log/im,
};

{
  const required = JSON.parse(fs.readFileSync(schemaFile("design"), "utf8")).required as string[];
  const known = Object.keys(DESIGN_HEADING_PATTERN);
  const missing = required.filter((key) => !known.includes(key));
  const extra = known.filter((key) => !required.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `design.schema.json's required list and DESIGN_HEADING_PATTERN have drifted — ` +
        `schema has no pattern for [${missing.join(", ")}], DESIGN_HEADING_PATTERN has no schema requirement for [${extra.join(", ")}]`,
    );
  }
}

/** The structural summary each doc type's schema validates. Shape differs per type. */
export function extractStructure(docType: DocType, markdown: string): Record<string, unknown> {
  switch (docType) {
    case "requirement":
      return {
        hasOverview: has(markdown, /^##\s+Overview\s*$/im),
        hasTargetUsers: has(markdown, /^##\s+Target Users/im),
        hasCoreFeatures: has(markdown, /^##\s+Core Features/im),
        hasScope: has(markdown, /^##\s+Scope\s*$/im),
        hasConstraints: has(markdown, /^##\s+Constraints/im),
        hasOpenQuestions: has(markdown, /^##\s+Open Questions/im),
        hasDeclined: has(markdown, /^##\s+Declined/im),
        hasReferences: has(markdown, /^##\s+References/im),
        hasChangeLog: has(markdown, /^##\s+Change Log/im),
      };
    case "design": {
      const out: Record<string, unknown> = {};
      for (const [key, pattern] of Object.entries(DESIGN_HEADING_PATTERN)) out[key] = has(markdown, pattern);
      return out;
    }
    case "plan":
      return {
        hasPlanSummary: has(markdown, /^##\s+Plan Summary/im),
        hasSequencingNotes: has(markdown, /^##\s+Sequencing Notes/im),
        hasOpenQuestions: has(markdown, /^##\s+Unresolved Open Questions/im),
        hasChangeLog: has(markdown, /^##\s+Change Log/im),
        phaseCount: count(markdown, /^##\s*Phase\s*\d+/gim),
      };
    case "review":
      return {
        hasOpenIssues: has(markdown, /^##\s+Open Issues/im),
        hasVerificationSummary: has(markdown, /^##\s+Verification Summary/im),
        hasChangeLog: has(markdown, /^##\s+Change Log/im),
        reviewOutcomeCount: count(markdown, /^##\s*Review Outcome/gim),
      };
    case "security":
      return {
        hasOpenFindings: has(markdown, /^##\s+Open Findings/im),
        hasSummary: has(markdown, /^##\s+Summary\s*$/im),
        hasChangeLog: has(markdown, /^##\s+Change Log/im),
      };
  }
}

const compiled = new Map<DocType, ValidateFunction>();

function validator(docType: DocType): ValidateFunction {
  let v = compiled.get(docType);
  if (!v) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    v = ajv.compile(JSON.parse(fs.readFileSync(schemaFile(docType), "utf8")));
    compiled.set(docType, v);
  }
  return v;
}

export interface DocStructureResult {
  ok: boolean;
  problems: string[];
}

/** Validates one document's text against its type's schema. */
export function checkOneDoc(docType: DocType, markdown: string, label: string): DocStructureResult {
  const structure = extractStructure(docType, markdown);
  const validate = validator(docType);
  if (validate(structure)) return { ok: true, problems: [] };
  const problems = (validate.errors ?? []).map((e) => `${label}: ${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
  return { ok: false, problems };
}

/**
 * Every `##` section outside `DESIGN_HEADING_PATTERN`'s schema-known headings must carry
 * at least one `DES-NNN` somewhere in its text — heading or body, placement is an
 * editorial choice. A document with no contract sections passes trivially.
 */
export function checkDesignContractSections(markdown: string, label: string): DocStructureResult {
  const problems: string[] = [];
  for (const section of sectionMap(markdown)) {
    const headingLine = `## ${section.heading}`;
    const isSchemaKnown = Object.values(DESIGN_HEADING_PATTERN).some((pattern) => pattern.test(headingLine));
    if (isSchemaKnown) continue;
    if (extractIds(sectionText(markdown, section), "DES").length === 0) {
      problems.push(
        `${label} § "${section.heading}": no DES-NNN id — contract sections must carry a traceability id (policies/documentation.md §10)`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

export interface DocStructureCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * Byte ceilings for a module document and for one of its `##` sections, so a
 * document that has grown past the point `sta context` can slice usefully fails
 * a check instead of being read in full by every stage forever.
 *
 * Chosen from a direct measurement of real module documents (not guessed):
 * section bytes p50 3,563 / p90 25,961 / p95 35,684 / p99 63,524 / max 73,565
 * (n=149); document bytes p50 59,421 / p90 184,228 / p95 299,939 / max 420,181
 * (n=13). Both ceilings sit just above the p90–p95 band of that distribution,
 * so they flag genuine outliers without tripping the bulk of ordinary sections.
 */
export const SECTION_SIZE_CEILING_BYTES = 40_000;
export const DOCUMENT_SIZE_CEILING_BYTES = 200_000;

const ARCHIVE_PROCEDURE = "policies/documentation.md §4 (an editorial split — this checker never archives)";

/**
 * Byte-size structural summary, reusing the exact `##` boundaries
 * `context/sections.ts` already computes for slicing — a document too big to
 * slice usefully is the same condition this checker exists to catch.
 */
export function checkOneDocSize(markdown: string, label: string): DocStructureResult {
  const problems: string[] = [];
  const docBytes = Buffer.byteLength(markdown, "utf8");
  if (docBytes > DOCUMENT_SIZE_CEILING_BYTES) {
    problems.push(
      `${label}: whole document is ${docBytes.toLocaleString()} B, over the ${DOCUMENT_SIZE_CEILING_BYTES.toLocaleString()} B ceiling — split it per ${ARCHIVE_PROCEDURE}.`,
    );
  }
  for (const section of sectionMap(markdown)) {
    const bytes = Buffer.byteLength(sectionText(markdown, section), "utf8");
    if (bytes > SECTION_SIZE_CEILING_BYTES) {
      problems.push(
        `${label} § "${section.heading}": ${bytes.toLocaleString()} B, over the ${SECTION_SIZE_CEILING_BYTES.toLocaleString()} B section ceiling — split it per ${ARCHIVE_PROCEDURE}.`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Checks every module document `checkDocStructure` already enumerates —
 * same file set, same existence rule (a document not written yet is skipped,
 * not flagged) — against the byte ceilings above.
 *
 * `moduleName` scopes the measurement to one module (same precedent as
 * `checkPlanGraphs(root, moduleName)` in `--check-plan`) so a BA preflight
 * measures one module's documents, not the whole repository, and stays fast.
 */
export function checkDocSize(projectRoot: string, moduleName?: string): DocStructureCheckResult {
  const moduleDir = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(moduleDir)) {
    return { ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to measure."] };
  }

  const modules = moduleName
    ? [moduleName]
    : fs
        .readdirSync(moduleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  if (!moduleName && modules.length === 0) {
    return { ok: true, problems: [], notes: ["`_docs/module/` has no module folders yet."] };
  }
  if (moduleName && !fs.existsSync(path.join(moduleDir, moduleName))) {
    return { ok: false, problems: [`module "${moduleName}" has no folder under _docs/module/`], notes: [] };
  }

  const problems: string[] = [];
  for (const name of modules) {
    for (const docType of Object.keys(DOC_FILENAMES) as DocType[]) {
      const file = path.join(moduleDir, name, DOC_FILENAMES[docType]);
      if (!fs.existsSync(file)) continue;
      const markdown = fs.readFileSync(file, "utf8");
      const result = checkOneDocSize(markdown, `${name}/${DOC_FILENAMES[docType]}`);
      problems.push(...result.problems);
    }
  }

  return { ok: problems.length === 0, problems, notes: [] };
}

/**
 * Checks every module's documents that exist. A document that doesn't exist yet (a
 * module mid-way through the pipeline, before `design.md` or `plan.md` was written) is
 * skipped, not flagged — this validates structure, not project progress.
 */
export function checkDocStructure(projectRoot: string): DocStructureCheckResult {
  const moduleDir = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(moduleDir)) {
    return { ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to check."] };
  }

  const modules = fs
    .readdirSync(moduleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (modules.length === 0) {
    return { ok: true, problems: [], notes: ["`_docs/module/` has no module folders yet."] };
  }

  const problems: string[] = [];
  const notes: string[] = [];
  for (const name of modules) {
    for (const docType of Object.keys(DOC_FILENAMES) as DocType[]) {
      const file = path.join(moduleDir, name, DOC_FILENAMES[docType]);
      if (!fs.existsSync(file)) continue;
      const markdown = fs.readFileSync(file, "utf8");
      const result = checkOneDoc(docType, markdown, `${name}/${DOC_FILENAMES[docType]}`);
      problems.push(...result.problems);
      // T-V5-035 (F-04) — the structural conditions `context/docSelection.ts`
      // already falls back to a whole document on, reported here so a run
      // never has to hit the fallback to find out.
      if (docType === "requirement" || docType === "design") {
        const reason = structuralFallbackReason(docType, markdown);
        if (reason) notes.push(`${name}/${DOC_FILENAMES[docType]}: would fall back to whole-document context — ${reason}`);
      }
      // Report-only: knowledge-ci.yml's structure-check step already runs with
      // continue-on-error, so a problem here doesn't block CI yet.
      if (docType === "design") {
        const contract = checkDesignContractSections(markdown, `${name}/${DOC_FILENAMES[docType]}`);
        problems.push(...contract.problems);
      }
    }
  }

  return { ok: problems.length === 0, problems, notes };
}
