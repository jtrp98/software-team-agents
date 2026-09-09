import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sections } from "./markdown.js";

const claim = z.string().regex(/^(?:DES-\d+|DEC-\d+|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*)$/);
const revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeRelativePath = z.string().min(1).refine(value => {
  const normalized = value.replace(/\\/g, "/");
  return !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && normalized.split("/").every(part => part !== "" && part !== "." && part !== "..");
}, "must be a safe repository-relative path");

export const DesignEvidenceRefSchema = z.strictObject({
  id: z.string().regex(/^EVD-\d+$/),
  claim,
  state: z.enum(["confirmed", "inferred", "unresolved"]),
  path: safeRelativePath,
  symbol: z.string().min(1),
  line: z.number().int().positive(),
  revision,
  basis: z.enum(["source", "schema", "compiler", "test", "graph", "lsp"]),
  tool: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/),
  hash: sha256,
}).superRefine((ref, ctx) => {
  if ((ref.basis === "graph" || ref.basis === "lsp") && ref.state !== "inferred") {
    ctx.addIssue({ code: "custom", path: ["state"], message: "graph/LSP evidence must remain inferred until current source confirms the relationship" });
  }
});
export type DesignEvidenceRef = z.infer<typeof DesignEvidenceRefSchema>;

export const DesignGateTriggerSchema = z.enum([
  "schema", "migration", "breaking-contract", "critical-security", "material-ambiguity",
]);
export type DesignGateTrigger = z.infer<typeof DesignGateTriggerSchema>;

export const DesignGateAssessmentSchema = z.strictObject({
  mode: z.enum(["addressable", "legacy"]),
  triggers: z.array(DesignGateTriggerSchema),
  canProceedWithoutConfirmation: z.boolean(),
  migrationRequired: z.boolean(),
  unresolvedClaims: z.array(claim),
  inferredClaims: z.array(claim),
});
export type DesignGateAssessment = z.infer<typeof DesignGateAssessmentSchema>;

const DesignDecisionsSchema = z.strictObject({
  compatibility: z.enum(["unchanged", "additive-internal", "additive-external", "breaking"]),
  schema: z.enum(["unchanged", "additive", "breaking"]),
  migration: z.enum(["none", "required", "destructive"]),
  security: z.enum(["none", "sensitive", "critical"]),
  fallback: z.string().min(1).refine(value => !/^(?:none|tbd|unknown)$/i.test(value.trim()), "must name an executable fallback"),
  ambiguity: z.enum(["none", "unresolved"]),
});
export type DesignDecisions = z.infer<typeof DesignDecisionsSchema>;

export interface AddressableDesignSection {
  heading: string;
  claims: string[];
  evidence: DesignEvidenceRef[];
  decisions: DesignDecisions;
  triggers: DesignGateTrigger[];
}

export interface ParsedDesignEvidence {
  mode: "addressable" | "legacy";
  claims: string[];
  evidence: DesignEvidenceRef[];
  sections: AddressableDesignSection[];
  gate: DesignGateAssessment;
  problems: string[];
}

const marker = "Design evidence format: 1";
const lineValue = (body: string, label: string): string[] => body.split(/\r?\n/).flatMap(line => {
  const match = new RegExp(`^${label.replace("/", "\\/")}:\\s*(.+)$`, "i").exec(line.trim());
  return match ? [match[1].trim()] : [];
});

function evidenceLine(line: string): { value?: DesignEvidenceRef; problems: string[] } | null {
  const match = /^\s*(?:[-*]\s+)?Evidence\s+(EVD-\d+):\s*(.+)$/.exec(line);
  if (!match) return null;
  const entries = match[2].split(/\s+\|\s+/).map(part => /^([a-z]+)=(.+)$/.exec(part));
  const problems: string[] = [];
  if (entries.some(entry => !entry)) return { problems: [`${match[1]}: expected key=value fields separated by ' | '`] };
  const fields = Object.fromEntries(entries.map(entry => [entry![1], entry![2]]));
  const expected = ["claim", "state", "path", "symbol", "line", "revision", "basis", "tool", "hash"];
  const unknown = Object.keys(fields).filter(key => !expected.includes(key));
  const missing = expected.filter(key => !(key in fields));
  if (unknown.length || missing.length || Object.keys(fields).length !== entries.length) {
    problems.push(`${match[1]}: evidence fields must occur exactly once; missing [${missing.join(", ")}], unknown/duplicate [${unknown.join(", ")}]`);
  }
  const parsed = DesignEvidenceRefSchema.safeParse({ id: match[1], ...fields, line: Number(fields.line) });
  if (!parsed.success) problems.push(...parsed.error.issues.map(issue => `${match[1]}.${issue.path.join(".")}: ${issue.message}`));
  return parsed.success && problems.length === 0 ? { value: parsed.data, problems } : { problems };
}

function sectionTriggers(decisions: DesignDecisions): DesignGateTrigger[] {
  const triggers: DesignGateTrigger[] = [];
  if (decisions.schema !== "unchanged") triggers.push("schema");
  if (decisions.migration !== "none") triggers.push("migration");
  if (decisions.compatibility === "breaking") triggers.push("breaking-contract");
  if (decisions.security === "critical") triggers.push("critical-security");
  if (decisions.ambiguity === "unresolved") triggers.push("material-ambiguity");
  return triggers;
}

/** Parses the compact design-evidence contract. Missing format stays an explicit legacy fallback. */
export function parseDesignEvidence(markdown: string): ParsedDesignEvidence {
  const markers = markdown.replace(/\r\n?/g, "\n").split("\n").filter(line => line.startsWith("Design evidence format:"));
  if (markers.length === 0) {
    const gate = DesignGateAssessmentSchema.parse({ mode: "legacy", triggers: [], canProceedWithoutConfirmation: false, migrationRequired: true, unresolvedClaims: [], inferredClaims: [] });
    return { mode: "legacy", claims: [], evidence: [], sections: [], gate, problems: [] };
  }
  const problems: string[] = [];
  if (markers.length !== 1 || markers[0] !== marker) problems.push(`design: expected exactly one '${marker}'`);
  const parsedSections: AddressableDesignSection[] = [];
  const allClaims: string[] = [];
  const allEvidence: DesignEvidenceRef[] = [];
  const seenClaims = new Set<string>();
  const seenEvidence = new Set<string>();

  for (const section of sections(markdown, 2).filter(section => /^DES-\d+\b/.test(section.title))) {
    const desId = /^(DES-\d+)\b/.exec(section.title)![1];
    const contracts = section.body.split(/\r?\n/).flatMap(line => /^(Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*)\b/.exec(line.trim())?.[1] ?? []);
    const decisions = section.body.split(/\r?\n/).flatMap(line => /^(DEC-\d+)\b/.exec(line.trim())?.[1] ?? []);
    if (contracts.length === 0) problems.push(`${desId}: expected at least one stable Contract:Name.vN declaration`);
    if (decisions.length !== 1) problems.push(`${desId}: expected exactly one stable DEC-NNN declaration; found ${decisions.length}`);
    const claims = [desId, ...contracts, ...decisions];
    for (const id of claims) {
      if (seenClaims.has(id)) problems.push(`${desId}: duplicate design claim ${id}`);
      seenClaims.add(id); allClaims.push(id);
    }

    const evidence: DesignEvidenceRef[] = [];
    for (const line of section.body.split(/\r?\n/)) {
      const parsed = evidenceLine(line);
      if (!parsed) continue;
      problems.push(...parsed.problems.map(problem => `${desId}: ${problem}`));
      if (!parsed.value) continue;
      if (seenEvidence.has(parsed.value.id)) problems.push(`${desId}: duplicate evidence ID ${parsed.value.id}`);
      seenEvidence.add(parsed.value.id);
      if (!claims.includes(parsed.value.claim)) problems.push(`${desId}: ${parsed.value.id} claims ${parsed.value.claim}, which is not declared in this section`);
      evidence.push(parsed.value); allEvidence.push(parsed.value);
    }
    for (const id of claims) if (!evidence.some(ref => ref.claim === id)) problems.push(`${desId}: ${id} has no EVD-NNN evidence reference`);

    const values = {
      compatibility: lineValue(section.body, "Compatibility"),
      schema: lineValue(section.body, "Data/schema"),
      migration: lineValue(section.body, "Migration/backfill"),
      security: lineValue(section.body, "Security"),
      fallback: lineValue(section.body, "Fallback"),
      ambiguity: lineValue(section.body, "Material ambiguity"),
    };
    for (const [label, rows] of Object.entries(values)) if (rows.length !== 1) problems.push(`${desId}: ${label} decision must occur exactly once; found ${rows.length}`);
    const parsedDecisions = DesignDecisionsSchema.safeParse(Object.fromEntries(Object.entries(values).map(([key, rows]) => [key, rows[0]])));
    if (!parsedDecisions.success) {
      problems.push(...parsedDecisions.error.issues.map(issue => `${desId}.${issue.path.join(".")}: ${issue.message}`));
      continue;
    }
    parsedSections.push({ heading: section.title, claims, evidence, decisions: parsedDecisions.data, triggers: sectionTriggers(parsedDecisions.data) });
  }
  if (parsedSections.length === 0) problems.push("design: addressable format has no '## DES-NNN — title' sections");
  const triggers = [...new Set(parsedSections.flatMap(section => section.triggers))];
  const unresolvedClaims = [...new Set(allEvidence.filter(ref => ref.state === "unresolved").map(ref => ref.claim))];
  const inferredClaims = [...new Set(allEvidence.filter(ref => ref.state === "inferred").map(ref => ref.claim))];
  const gate = DesignGateAssessmentSchema.parse({ mode: "addressable", triggers, canProceedWithoutConfirmation: triggers.length === 0, migrationRequired: false, unresolvedClaims, inferredClaims });
  return { mode: "addressable", claims: allClaims, evidence: allEvidence, sections: parsedSections, gate, problems };
}

/** Returns only the evidence for exact task refs; legacy design cannot feed unattended execution. */
export function designEvidenceForClaims(parsed: ParsedDesignEvidence, claims: readonly string[]): DesignEvidenceRef[] {
  if (parsed.mode === "legacy") throw new Error("design evidence migration required: migrate to Design evidence format 1 before unattended execution");
  if (parsed.problems.length) throw new Error(`invalid design evidence: ${parsed.problems.join("; ")}`);
  const wanted = new Set(claims);
  for (const id of wanted) if (!parsed.claims.includes(id)) throw new Error(`design evidence has no addressable claim ${id}`);
  return parsed.evidence.filter(ref => wanted.has(ref.claim));
}

/** Verifies immutable provenance against the current Target without changing either source or design. */
export function verifyDesignEvidence(refs: readonly DesignEvidenceRef[], input: { targetRoot: string; currentRevision: string; allowContentStableRevision?: boolean }): string[] {
  const problems: string[] = [];
  const root = path.resolve(input.targetRoot);
  for (const ref of refs) {
    const file = path.resolve(root, ...ref.path.replace(/\\/g, "/").split("/"));
    if (file !== root && !file.startsWith(root + path.sep)) { problems.push(`${ref.id}: path escapes Target root`); continue; }
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { problems.push(`${ref.id}: evidence path is unreadable: ${ref.path}`); continue; }
    const actualHash = createHash("sha256").update(text).digest("hex");
    if (actualHash !== ref.hash) problems.push(`${ref.id}: content hash drift for ${ref.path}`);
    if (ref.revision !== input.currentRevision && !(input.allowContentStableRevision && actualHash === ref.hash)) {
      problems.push(`${ref.id}: stale revision ${ref.revision}; current revision is ${input.currentRevision}`);
    }
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (ref.line > lines.length) problems.push(`${ref.id}: line ${ref.line} is outside ${ref.path} (${lines.length} lines)`);
    if (!text.includes(ref.symbol)) problems.push(`${ref.id}: symbol ${ref.symbol} is absent from ${ref.path}`);
  }
  return problems;
}
