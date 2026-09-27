import { createHash } from "node:crypto";
import { z } from "zod";
import { PlanTaskSchema } from "../docs/planTask.js";
import { AgentStage } from "../types.js";
import { DesignEvidenceRefSchema } from "../docs/designEvidence.js";

const text = z.string().min(1);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RevisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const TaskContractSchema = PlanTaskSchema.omit({ status: true });
export const SourceHashSchema = z.strictObject({ source: text, hash: Sha256Schema });
export const SelectedTraceSchema = z.strictObject({ id: text, source: text, text, hash: Sha256Schema });
export const DependencySchema = z.strictObject({
  task_id: text, produces: z.array(text),
  edges: z.array(z.enum(["declared", "contract", "phase"])).min(1),
});
export const DependencyEvidenceSchema = z.strictObject({
  task_id: text, status: z.literal("complete"), source: text, hash: Sha256Schema,
  outputs: z.array(SourceHashSchema),
});
export const RetrievalCandidateSchema = z.strictObject({
  path: text, symbol: text.optional(), provenance: text, revision: RevisionSchema, hash: Sha256Schema,
});
export const VerificationSchema = z.object({
  status: z.enum(["selected", "full-order", "deferred"]), levels: z.array(text), reason: text,
  // V13 TASK-017 — `warn` is deleted: a required check that produced no
  // evidence blocks. A persisted task still carrying `warn` fails this schema
  // and must be recompiled, exactly as an explicit cutover demands.
  enforcement: z.literal("enforce").optional(), task_types: z.array(text).optional(),
  selection_source: z.enum(["task-classification", "change-scope", "full-order"]).optional(),
});

/** Sorted object keys, significant array order; no locale or clock input. */
export function stableHash(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, normalize(val)])) : v;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
export function contentHash(text: string | Buffer): string { return createHash("sha256").update(text).digest("hex"); }

/** Public, reproducible config identity used by compilation and preview drift checks. */
export function packetConfigHash(input: {
  config: unknown;
  guards: { allow: readonly string[]; deny: readonly string[] };
  verification: z.infer<typeof VerificationSchema>;
  roots: readonly string[];
}): string {
  return stableHash({
    config: input.config,
    guards: { allow: [...input.guards.allow], deny: [...input.guards.deny] },
    verification: input.verification,
    roots: [...input.roots],
  });
}

export const RoleContractDigestSchema = z.strictObject({
  name: text,
  role: text,
  version: z.string().optional(),
  digest: Sha256Schema,
  constraints: z.array(text).optional(),
  tools: z.array(text).optional(),
});

export const ExpectedOutputSchema = z.strictObject({
  artifact_type: text,
  doc_path: text.optional(),
  schema_name: text.optional(),
  required_sections: z.array(text).optional(),
});

export const PacketFieldsSchema = z.strictObject({
  version: z.literal(2), attempt: z.number().int().positive(), task_id: text,
  stage: z.enum(AgentStage), role: text,
  contract: TaskContractSchema,
  dependencies: z.array(DependencySchema.extend({ evidence: DependencyEvidenceSchema })),
  selected_traces: z.array(SelectedTraceSchema).min(1),
  /** Optional only so persisted pre-T-V8-007 v2 packets remain audit-readable. New compilation always supplies it. */
  design_evidence: z.array(DesignEvidenceRefSchema).optional(),
  scope: z.strictObject({ roots: z.array(text), allow: z.array(text), deny: z.array(text) }),
  retrieval_candidates: z.array(RetrievalCandidateSchema),
  required_verification: VerificationSchema,
  stop_conditions: z.array(text).min(1),
  expansion_pointers: z.array(text).min(1),
  stage_instructions: z.string(),
  /** Rendered code-intelligence evidence block (`resolver.ts`'s `renderEvidenceBlock`), guardrail sentences included verbatim. Empty when code-intel did not hit. */
  code_intel_evidence: z.string().default(""),
  // Only bounded verification evidence is a supplement; authored planning prose
  // is selected above, never appended again as whole source documents.
  verification_context: z.array(z.strictObject({ source: z.literal("qa-evidence"), content: text })),
  identity: z.strictObject({
    task_hash: Sha256Schema, plan_hash: Sha256Schema, artifact_hashes: z.array(SourceHashSchema).min(2),
    config_hash: Sha256Schema, compiler_version: z.literal("v8-packet-2"), compiler_hash: Sha256Schema, base_revision: RevisionSchema,
  }),
  /** V13 TASK-020 — self-contained role contract binding, rules, knowledge, expected output and correlation. */
  role_contract: RoleContractDigestSchema.optional(),
  rules: z.array(text).optional(),
  relevant_knowledge: z.array(text).optional(),
  expected_output: ExpectedOutputSchema.optional(),
  correlation_id: text.optional(),
});
export type PacketFields = z.infer<typeof PacketFieldsSchema>;
export type DependencyEvidence = z.infer<typeof DependencyEvidenceSchema>;

/** Both compilation and schema verification use this exact field-once renderer. */
export function renderPacketSections(packet: PacketFields): string[] {
  const t = packet.contract;
  const section = (title: string, body: string) => `## ${title}\n${body}`;
  const list = (xs: readonly string[]) => xs.length ? xs.map(s => `- ${s}`).join("\n") : "none";
  return [
    section("Objective", t.objective), section("Why", t.why),
    section("Task and dependencies", [
      `${t.id} — ${t.title}; phase ${t.phase}; owner ${t.owner}; current stage ${packet.stage}; attempt ${packet.attempt}`,
      `Declared dependencies: ${t.dependsOn.join(", ") || "none"}`,
      ...packet.dependencies.map(d => `${d.task_id} [${d.edges.join(", ")}]: complete; produces ${d.produces.join(", ") || "none"}; evidence ${d.evidence.source} (${d.evidence.hash})\n${list(d.evidence.outputs.map(o => `${o.source} (${o.hash})`))}`),
    ].join("\n")),
    section("Selected requirements, acceptance and design", packet.selected_traces.map(r => `${r.id} — ${r.source}\n${r.text}`).join("\n\n")),
    ...(packet.design_evidence ? [section("Addressable design evidence", list(packet.design_evidence.map(ref => `${ref.id} -> ${ref.claim}: ${ref.state}; ${ref.path}#${ref.symbol}:${ref.line}; revision ${ref.revision}; ${ref.basis}/${ref.tool}; SHA-256 ${ref.hash}`)))] : []),
    section("Contracts", `Produces: ${t.produces.join(", ") || "none"}\nConsumes: ${t.consumes.join(", ") || "none"}`),
    section("Scope and constraints", t.scopeAndConstraints),
    section("Effective stage guard", `Roots:\n${list(packet.scope.roots)}\nAllow:\n${list(packet.scope.allow)}\nDeny:\n${list(packet.scope.deny)}`),
    section("Do not modify", t.doNotModify), section("Compatibility", t.compatibility),
    section("Retrieval hints", t.retrievalHints),
    section("Verified retrieval candidates", list(packet.retrieval_candidates.map(c => `${c.path}${c.symbol ? `#${c.symbol}` : ""} — ${c.provenance}; revision ${c.revision}; SHA-256 ${c.hash}`))),
    section("Required implementation behavior", t.acceptanceCriteria),
    section("Validation and expected evidence", `${t.validationAndEvidence}\n\nLevels: ${packet.required_verification.levels.join(", ") || "none resolved"}\nVerification policy: ${packet.required_verification.status}; enforcement: ${packet.required_verification.enforcement ?? "unspecified"}`),
    section("Risk and human gates", `Risk: ${t.risk.join(", ")}\nHuman gates: ${t.humanGate.join(", ") || "none"}`),
    section("Stop conditions", list(packet.stop_conditions)),
    section("Expansion pointers", list(packet.expansion_pointers)),
    ...(packet.stage_instructions ? [section("Stage instructions", packet.stage_instructions)] : []),
    // Already a self-contained markdown block with its own heading and
    // source-of-truth guardrail (`resolver.ts`'s `renderEvidenceBlock`) — not
    // wrapped in another `section()` heading.
    ...(packet.code_intel_evidence ? [packet.code_intel_evidence] : []),
    ...packet.verification_context.map(c => section("Verification evidence", c.content)),
    ...(packet.role_contract ? [
      section("Role contract", [
        `${packet.role_contract.name} (${packet.role_contract.role}) — contract digest: ${packet.role_contract.digest}`,
        ...(packet.role_contract.version ? [`Version: ${packet.role_contract.version}`] : []),
        ...(packet.role_contract.tools && packet.role_contract.tools.length ? [`Tools: ${packet.role_contract.tools.join(", ")}`] : []),
        ...(packet.role_contract.constraints && packet.role_contract.constraints.length ? [`Constraints:\n${list(packet.role_contract.constraints)}`] : []),
      ].join("\n")),
    ] : []),
    ...(packet.rules && packet.rules.length ? [section("Rules and constraints", list(packet.rules))] : []),
    ...(packet.relevant_knowledge && packet.relevant_knowledge.length ? [section("Relevant knowledge", list(packet.relevant_knowledge))] : []),
    ...(packet.expected_output ? [
      section("Expected output", [
        `Artifact type: ${packet.expected_output.artifact_type}`,
        ...(packet.expected_output.doc_path ? [`Knowledge path: ${packet.expected_output.doc_path}`] : []),
        ...(packet.expected_output.schema_name ? [`Schema: ${packet.expected_output.schema_name}`] : []),
        ...(packet.expected_output.required_sections && packet.expected_output.required_sections.length ? [`Required sections:\n${list(packet.expected_output.required_sections)}`] : []),
      ].join("\n")),
    ] : []),
    ...(packet.correlation_id ? [section("Correlation ID", packet.correlation_id)] : []),
  ];
}

export function renderPacketText(packet: PacketFields): string { return renderPacketSections(packet).join("\n\n"); }
