import * as fs from "node:fs";
import * as path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { fileURLToPath } from "node:url";

/**
 * T53 — a schema per module document type (`requirement.md`, `design.md`, `plan.md`,
 * `review.md`, `security.md`), so a missing required section is a mechanical finding
 * instead of something only caught if a person happens to notice.
 *
 * These documents are prose Markdown, not JSON or YAML, so a JSON Schema can't validate
 * them directly the way `state-view.schema.json`/`agent-contract.schema.json` validate
 * real data files. This module extracts a small, flat, boolean-and-count *structural
 * summary* from each document — "does it have a `## Change Log` section", "how many
 * `## Phase N` headings does it have" — and it's that summary a schema validates. The
 * schema can therefore only ever say "this required section is missing" or "this doc has
 * zero phases" — it says nothing about whether the prose inside a section is any good,
 * the same limit `check-schema-contract.js`/`check-status-sync.js` already live with.
 *
 * Every required section is checked against the exact fixed heading each agent's Output
 * template writes (`.claude/agents/<role>.md`) — a wording drift there and a wording
 * drift here have to be fixed together, the same relationship `.claude/tests/run.js`
 * already has with the hooks it tests.
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
    case "design":
      return {
        hasFeasibilitySummary: has(markdown, /^##\s+Feasibility Summary/im),
        hasFeatureFeasibility: has(markdown, /^##\s+Feature-by-Feature Feasibility/im),
        hasDataModel: has(markdown, /^##\s+Data Model/im),
        hasModules: has(markdown, /^##\s+Modules\s*$/im),
        hasRisks: has(markdown, /^##\s+Risks/im),
        hasOpenQuestions: has(markdown, /^##\s+Unresolved Open Questions/im),
        hasChangeLog: has(markdown, /^##\s+Change Log/im),
      };
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

export interface DocStructureCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
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
  for (const name of modules) {
    for (const docType of Object.keys(DOC_FILENAMES) as DocType[]) {
      const file = path.join(moduleDir, name, DOC_FILENAMES[docType]);
      if (!fs.existsSync(file)) continue;
      const markdown = fs.readFileSync(file, "utf8");
      const result = checkOneDoc(docType, markdown, `${name}/${DOC_FILENAMES[docType]}`);
      problems.push(...result.problems);
    }
  }

  return { ok: problems.length === 0, problems, notes: [] };
}
