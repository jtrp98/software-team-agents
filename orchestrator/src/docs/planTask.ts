import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentStage } from "../types.js";
import { firstTable, sections } from "./markdown.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { designEvidenceForClaims, parseDesignEvidence } from "./designEvidence.js";

const text = z.string().trim().min(1);
const taskId = z.string().regex(/^[A-Z][A-Z0-9]*-[A-Za-z0-9][A-Za-z0-9._-]*$/);
const traceId = z.string().regex(/^(?:REQ-\d+|AC-\d+(?:\.\d+)?|DES-\d+|DEC-\d+)$/);
const contractId = z.string().regex(/^Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*$/);
const unique = <T extends z.ZodType>(item: T) => z.array(item).refine(xs => new Set(xs).size === xs.length, "duplicate entry");

/** Internal normalization only. plan.md is the authored authority; no JSON sidecar. */
export const PlanTaskSchema = z.strictObject({
  version: z.literal(1),
  id: taskId,
  phase: z.number().int().positive(),
  title: text,
  objective: text,
  why: text,
  owner: z.enum(Object.values(AgentStage).filter(s => s !== AgentStage.HUMAN) as [string, ...string[]]),
  tier: z.enum(["T2", "T3", "T4", "T5", "T6"]).optional(),
  dependsOn: unique(taskId),
  traceability: unique(traceId).refine(xs => ["REQ-", "AC-", "DES-"].every(prefix => xs.some(x => x.startsWith(prefix))), "requires REQ, AC and DES references"),
  produces: unique(contractId),
  consumes: unique(contractId),
  risk: unique(z.enum(["low", "medium", "high", "critical", "shared-contract", "authorization", "schema", "security", "data-loss", "breaking-contract", "business"])).min(1),
  humanGate: unique(z.enum(["business", "schema", "breaking-contract", "security", "design-ambiguity", "plan-approval", "deployment", "migration"])),
  status: z.enum(["pending", "in_progress", "verified", "blocked"]),
  scopeAndConstraints: text,
  retrievalHints: text,
  doNotModify: text,
  acceptanceCriteria: text,
  validationAndEvidence: text,
  compatibility: text,
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export const PLAN_TASK_FIELD_CONSUMERS: Record<keyof PlanTask, readonly string[]> = {
  version: ["compiler", "migration"], id: ["compiler", "DAG", "run ledger"], phase: ["DAG", "context"],
  title: ["DEV", "QA"], objective: ["DEV", "QA"], why: ["DEV", "QA"], owner: ["compiler", "runtime"],
  tier: ["route resolver"], dependsOn: ["DAG", "readiness", "run ledger"], traceability: ["compiler", "context", "DEV", "QA"],
  produces: ["DAG", "dependency handoff"], consumes: ["DAG", "dependency handoff"], risk: ["gate policy", "QA"],
  humanGate: ["gate policy", "run controller"], status: ["readiness", "QA sync"], scopeAndConstraints: ["compiler", "DEV", "QA"],
  retrievalHints: ["context resolver", "DEV", "QA"], doNotModify: ["compiler", "DEV", "QA"],
  acceptanceCriteria: ["compiler", "DEV", "QA"], validationAndEvidence: ["deterministic verifier", "DEV", "QA"],
  compatibility: ["DEV", "QA", "rollback"],
};
export interface PlanReferences { requirementMd: string; designMd: string }
export interface CanonicalPlan { tasks: PlanTask[]; problems: string[] }

const fields = {
  "Objective": "objective", "Why": "why", "Owner": "owner", "Tier": "tier",
  "Depends on": "dependsOn", "Traceability": "traceability", "Produces": "produces",
  "Consumes": "consumes", "Risk": "risk", "Human gate": "humanGate", "Status": "status",
} as const;
const bodies = {
  "Scope and constraints": "scopeAndConstraints", "Retrieval hints": "retrievalHints",
  "Do not modify": "doNotModify", "Acceptance criteria": "acceptanceCriteria",
  "Required validation and expected evidence": "validationAndEvidence",
  "Rollback/compatibility notes": "compatibility",
} as const;
const listFields = new Set(["dependsOn", "traceability", "produces", "consumes", "risk", "humanGate"]);
export const isCanonicalPlan = (md: string): boolean => /^\s*PlanTask\s+format\b|^#{1,6}\s+Task\b/im.test(md);
const normalize = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/** Strict v1 grammar; unsupported legacy inputs are never promoted with invented intent. */
export function parseCanonicalPlan(markdown: string, refs?: PlanReferences): CanonicalPlan {
  const problems: string[] = [];
  const tasks: PlanTask[] = [];
  const lines = normalize(markdown).split("\n");
  const markers = lines.filter(l => l.startsWith("PlanTask format:"));
  if (markers.length !== 1 || markers[0] !== "PlanTask format: 1") {
    const ids = [...markdown.matchAll(/\b(?:BE|FE|SA|QA)-[A-Za-z0-9._-]+\b/g)].map(m => m[0]);
    return { tasks: [], problems: [`plan/tasks ${[...new Set(ids)].join(", ") || "(unidentified)"}: expected exactly one 'PlanTask format: 1'; legacy tables require explicit migrateLegacyTaskTable or author missing fields using docs/plan-task-v1.md`] };
  }
  let phase: number | undefined;
  let current: Record<string, unknown> | undefined;
  let body: string | undefined;
  let fence: string | undefined;
  const fail = (message: string) => problems.push(`task ${current?.id ?? "(outside task)"}: ${message}`);
  const finish = () => {
    if (!current) return;
    const parsed = PlanTaskSchema.safeParse(current);
    if (parsed.success) tasks.push(parsed.data);
    else for (const issue of parsed.error.issues) fail(`${issue.path.join(".") || "task"}: ${issue.message}`);
    current = undefined; body = undefined;
  };
  const seenPhases = new Set<number>();
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (current && body) current[body] = `${current[body]}\n${line}`;
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      if (current && !body) fail("fenced content is allowed only inside semantic headings");
      fence = fenceMatch[1];
      if (current && body) current[body] = `${current[body]}\n${line}`;
      continue;
    }
    if (/^##? /.test(line)) {
      const priorTask = current?.id;
      finish();
      const m = /^## Phase ([1-9]\d*)(?:\s*[:—].+)?$/.exec(line);
      phase = m ? Number(m[1]) : undefined;
      if (m) { if (seenPhases.has(phase!)) problems.push(`phase ${phase}: duplicate heading`); seenPhases.add(phase!); }
      else if (/^## Phase\b/.test(line)) problems.push(`plan: malformed phase heading '${line}'`);
      else if (!/^# Plan$|^## (?:Plan Summary|Sequencing Notes|Unresolved Open Questions|Change Log)$/.test(line)) problems.push(`task ${priorTask ?? "(outside task)"}: unknown plan heading '${line}'`);
      continue;
    }
    if (/^### Task\b/.test(line)) {
      finish();
      const m = /^### Task ([A-Z][A-Z0-9]*-[A-Za-z0-9][A-Za-z0-9._-]*) — (\S.*)$/.exec(line);
      if (!m) { problems.push(`task heading '${line}': expected '### Task ID — title'`); continue; }
      current = { version: 1, id: m[1], title: m[2], phase };
      continue;
    }
    if (!current) {
      if (phase !== undefined && line.trim()) fail(`unexpected phase content '${line}'; use task sections, not table/checkbox authorities`);
      continue;
    }
    if (line.startsWith("#### ")) {
      const heading = line.slice(5);
      const key = bodies[heading as keyof typeof bodies];
      if (!key) { fail(`unknown heading '${heading}'`); body = undefined; continue; }
      if (Object.hasOwn(current, key)) fail(`duplicate heading '${heading}'`);
      body = key; current[body] = ""; continue;
    }
    if (/^#{3,}/.test(line)) { fail(`unsupported heading '${line}'`); continue; }
    if (body) { current[body] = `${current[body]}\n${line}`; continue; }
    if (!line.trim()) continue;
    const m = /^([^:]+): (.*)$/.exec(line);
    const key = m && fields[m[1] as keyof typeof fields];
    if (!m || !key) { fail(`unknown/malformed field '${line}'`); continue; }
    if (Object.hasOwn(current, key)) fail(`duplicate field '${m[1]}'`);
    current[key] = listFields.has(key) ? (m[2] === "none" ? [] : m[2].split(",").map(v => v.trim())) : m[2];
  }
  if (fence) fail("unclosed fenced block");
  finish();
  if (!tasks.length) problems.push("plan: no valid canonical tasks");
  problems.push(...validateCanonicalReferences(tasks, refs));
  // Partial contracts must not escape into a compiler or run selector.
  return { tasks: problems.length ? [] : tasks, problems };
}

export function validateCanonicalReferences(tasks: readonly PlanTask[], refs?: PlanReferences): string[] {
  const problems: string[] = [];
  const byId = new Map<string, PlanTask>();
  const produced = new Map<string, string>();
  const external = new Set(refs?.designMd.match(/Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*/g) ?? []);
  const reqs = new Set(refs?.requirementMd.match(/\b(?:REQ-\d+|AC-\d+(?:\.\d+)?)\b/g) ?? []);
  const parsedDesign = refs ? parseDesignEvidence(refs.designMd) : undefined;
  if (parsedDesign?.mode === "addressable") problems.push(...parsedDesign.problems);
  const designs = new Set(parsedDesign?.mode === "addressable" ? parsedDesign.claims : refs?.designMd.match(/\b(?:DES|DEC)-\d+\b|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*/g) ?? []);
  const authoredNormativeText = refs ? normalize(`${refs.requirementMd}\n${refs.designMd}`).replace(/\s+/g, " ").toLowerCase() : "";
  for (const t of tasks) {
    const semanticBodies = { objective: t.objective, why: t.why, scopeAndConstraints: t.scopeAndConstraints, retrievalHints: t.retrievalHints, doNotModify: t.doNotModify, acceptanceCriteria: t.acceptanceCriteria, validationAndEvidence: t.validationAndEvidence, compatibility: t.compatibility };
    const normalizedBodies = Object.values(semanticBodies).map(value => value.trim().replace(/\s+/g, " ").toLowerCase());
    if (new Set(normalizedBodies).size !== normalizedBodies.length) problems.push(`task ${t.id}: normative semantic fields must not repeat the same text`);
    if (refs) for (const [field, value] of Object.entries(semanticBodies)) {
      const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
      if (normalized.length >= 20 && authoredNormativeText.includes(normalized)) problems.push(`task ${t.id}: ${field} repeats normative prose from requirement.md/design.md; select IDs and author task-specific interpretation`);
    }
    const selectedAcs = t.traceability.filter(id => id.startsWith("AC-"));
    const authoredAcs = new Set(t.acceptanceCriteria.match(/\bAC-\d+(?:\.\d+)?\b/g) ?? []);
    const validationAcs = new Set(t.validationAndEvidence.match(/\bAC-\d+(?:\.\d+)?\b/g) ?? []);
    for (const id of selectedAcs) {
      if (!authoredAcs.has(id)) problems.push(`task ${t.id}: acceptance criteria omits selected ${id}`);
      if (!validationAcs.has(id)) problems.push(`task ${t.id}: validation/evidence omits selected ${id}`);
    }
    for (const id of authoredAcs) if (!selectedAcs.includes(id)) problems.push(`task ${t.id}: unrelated acceptance ID ${id} is not in Traceability`);
    for (const id of validationAcs) if (!selectedAcs.includes(id)) problems.push(`task ${t.id}: unrelated validation ID ${id} is not in Traceability`);
    const hintParts = ["Hypothesis", "Query", "Provenance"].map(label => new RegExp(`(?:^|\\n|;\\s*)${label}:\\s*\\S`, "im").test(t.retrievalHints));
    if (hintParts.some(found => !found)) problems.push(`task ${t.id}: Retrieval hints requires Hypothesis, Query and Provenance lines; paths/symbols remain hypotheses until resolved`);
    const provenanceLine = /(?:^|\n|;\s*)Provenance:\s*([^\n;]+)/im.exec(t.retrievalHints)?.[1] ?? "";
    const provenanceIds = provenanceLine.match(/\b(?:DES|DEC)-\d+\b|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*/g) ?? [];
    const taskDesignRefs = [...t.traceability.filter(id => /^(?:DES|DEC)-/.test(id)), ...t.produces, ...t.consumes];
    if (provenanceIds.length === 0 || provenanceIds.some(id => !taskDesignRefs.includes(id))) problems.push(`task ${t.id}: Retrieval hint provenance must name only this task's DES/DEC/Contract refs`);
    const requiredRiskGates = new Set<string>();
    if (t.risk.includes("schema")) requiredRiskGates.add("schema");
    if (t.risk.includes("breaking-contract")) requiredRiskGates.add("breaking-contract");
    if (t.risk.includes("business")) requiredRiskGates.add("business");
    if (t.risk.includes("security") && t.risk.includes("critical")) requiredRiskGates.add("security");
    if (t.risk.includes("data-loss")) requiredRiskGates.add("migration");
    for (const gate of requiredRiskGates) if (!t.humanGate.includes(gate as PlanTask["humanGate"][number])) problems.push(`task ${t.id}: risk ${gate} requires human gate ${gate}`);
    if (byId.has(t.id)) problems.push(`task ${t.id}: duplicate task ID`);
    byId.set(t.id, t);
    for (const contract of t.produces) {
      if (produced.has(contract)) problems.push(`task ${t.id}: ambiguous producer of ${contract} (also ${produced.get(contract)})`);
      produced.set(contract, t.id);
    }
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) if (dep === t.id || !byId.has(dep)) problems.push(`task ${t.id}: self/unknown dependency ${dep}`);
    for (const c of t.consumes) if (refs && !produced.has(c) && !external.has(c)) problems.push(`task ${t.id}: unknown consumed contract ${c}; declare a producer or supply design.md definition`);
    if (refs) {
      for (const id of t.traceability) if ((/^(?:DES|DEC)-/.test(id) ? !designs.has(id) : !reqs.has(id))) problems.push(`task ${t.id}: unknown trace reference ${id}`);
      for (const c of [...t.produces, ...t.consumes]) if (!external.has(c)) problems.push(`task ${t.id}: unknown design contract ${c}`);
      if (parsedDesign?.mode === "addressable" && parsedDesign.problems.length === 0) {
        const selected = [...t.traceability.filter(id => /^(?:DES|DEC)-/.test(id)), ...t.produces, ...t.consumes];
        try { designEvidenceForClaims(parsedDesign, selected); }
        catch (error) { problems.push(`task ${t.id}: ${error instanceof Error ? error.message : String(error)}`); }
        const triggers = [...new Set(parsedDesign.sections.filter(section => section.claims.some(id => selected.includes(id))).flatMap(section => section.triggers))];
        const gateFor = { schema: "schema", migration: "migration", "breaking-contract": "breaking-contract", "critical-security": "security", "material-ambiguity": "design-ambiguity" } as const;
        for (const trigger of triggers) {
          const gate = gateFor[trigger];
          if (!t.humanGate.includes(gate)) problems.push(`task ${t.id}: design trigger ${trigger} requires human gate ${gate}`);
        }
      }
    }
  }
  try { taskGraphFromPlan(tasks); }
  catch (error) { problems.push(String(error)); }
  return problems;
}

/** Whitespace at field boundaries/CRLF normalize; all semantic fields and ordering count. */
export function planTaskHash(task: PlanTask): string {
  const { status: _status, ...semantic } = PlanTaskSchema.parse(task);
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

export function renderCanonicalTasks(tasks: readonly PlanTask[]): string {
  const lines = ["# Plan", "", "PlanTask format: 1", ""];
  let phase: number | undefined;
  for (const input of tasks) {
    const t = PlanTaskSchema.parse(input);
    if (t.phase !== phase) { phase = t.phase; lines.push(`## Phase ${phase}`, ""); }
    lines.push(`### Task ${t.id} — ${t.title}`, "");
    for (const [label,key] of Object.entries(fields)) {
      const value = t[key as keyof PlanTask];
      if (value === undefined) continue;
      lines.push(`${label}: ${Array.isArray(value) ? value.join(", ") || "none" : value}`);
    }
    for (const [label,key] of Object.entries(bodies)) lines.push("", `#### ${label}`, "", t[key as keyof PlanTask] as string);
    lines.push("");
  }
  return lines.join("\n");
}

/** Opt-in lossless conversion of expanded legacy tables only; never supplies missing prose. */
export function migrateLegacyTaskTable(markdown: string, refs?: PlanReferences): CanonicalPlan & { markdown?: string } {
  if (isCanonicalPlan(markdown)) return {tasks:[],problems:["migration: already versioned; use parseCanonicalPlan"]};
  const raw: PlanTask[] = [], problems: string[] = [];
  let migrated = markdown;
  const allowed = ["Task", ...Object.keys(fields), ...Object.keys(bodies)];
  for (const section of sections(markdown, 2)) {
    const phase = /^Phase ([1-9]\d*)\b/.exec(section.title);
    if (!phase) continue;
    const table = firstTable(section.body);
    const tableBlocks = section.body.match(/(?:^\|.*\|\r?\n?)+/gm) ?? [];
    if (tableBlocks.length !== 1 || section.body.replace(tableBlocks[0] ?? "", "").trim()) {
      problems.push(`${section.title}: ambiguous table/prose/checkbox content; amend task sections explicitly using docs/plan-task-v1.md`);
    }
    const phaseStart = raw.length;
    if (new Set(table.header).size !== table.header.length || table.header.some(h=>!allowed.includes(h))) problems.push(`${section.title}: duplicate/unknown legacy columns; author canonical sections explicitly`);
    for (const row of table.rows) {
      const values = Object.fromEntries(table.header.map((h,i)=>[h,row[i]]));
      const id = /^([A-Z][A-Z0-9]*-[A-Za-z0-9._-]+) — (.+)$/.exec(values.Task ?? "");
      const label = values.Task || section.title;
      if (!id || row.length !== table.header.length) { problems.push(`task ${label}: ambiguous legacy identity/cells; use docs/plan-task-v1.md`); continue; }
      const obj: Record<string,unknown> = {version:1,id:id[1],title:id[2],phase:Number(phase[1])};
      for (const [label,key] of Object.entries({...fields,...bodies})) {
        const value = values[label];
        if (key === "tier" && !value) continue;
        obj[key] = listFields.has(key) && value !== undefined ? (value === "none" ? [] : value.split(",").map(s=>s.trim())) : value;
      }
      const parsed = PlanTaskSchema.safeParse(obj);
      if (parsed.success) raw.push(parsed.data);
      else for (const issue of parsed.error.issues) problems.push(`task ${id[1]}: legacy ${issue.path.join(".")} missing/ambiguous; author it in plan.md using docs/plan-task-v1.md`);
    }
    const converted = renderCanonicalTasks(raw.slice(phaseStart));
    const taskStart = converted.indexOf("### Task ");
    if (taskStart >= 0 && tableBlocks.length === 1) migrated = migrated.replace(section.body, section.body.replace(tableBlocks[0], converted.slice(taskStart) + "\n"));
  }
  if (!raw.length && !problems.length) problems.push("legacy plan has no complete expanded table; author task sections using docs/plan-task-v1.md");
  if (problems.length) return {tasks:[],problems};
  const rendered = `PlanTask format: 1\n\n${migrated}`;
  const checked = parseCanonicalPlan(rendered, refs);
  return {...checked,...(checked.problems.length ? {} : {markdown:rendered})};
}
