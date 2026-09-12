import * as fs from "node:fs";
import { ExecutionPacketSchema, type ExecutionPacket } from "../artifacts/schemas.js";
import { contentHash, renderPacketSections, renderPacketText } from "../artifacts/executionPacket.js";
import { planTaskHash, type PlanTask } from "../docs/planTask.js";

export const GENERATED_VIEW_AUTHORITY = {
  kind: "generated-view" as const,
  source: "canonical-plan-task+execution-packet" as const,
  mutable: false as const,
  controls_status: false as const,
  controls_readiness: false as const,
};

export const CHECKLIST_SOURCE_FIELDS = [
  "acceptanceCriteria",
  "validationAndEvidence",
  "humanGate",
  "compatibility",
] as const;
export type ChecklistSourceField = (typeof CHECKLIST_SOURCE_FIELDS)[number];

export interface GeneratedChecklistItem {
  id: string;
  source_field: ChecklistSourceField;
  source_path: string;
  text: string;
}

export interface GeneratedChecklistView {
  authority: typeof GENERATED_VIEW_AUTHORITY;
  task_id: string;
  task_hash: string;
  items: GeneratedChecklistItem[];
}

function semanticLines(value: string): string[] {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.map(line => line.replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, ""));
}

/** A disposable checklist: no checked state is accepted or stored here. */
export function generateChecklist(task: Omit<PlanTask, "status">): GeneratedChecklistView {
  const items: GeneratedChecklistItem[] = [];
  const add = (sourceField: ChecklistSourceField, values: readonly string[]) => {
    for (const [index, text] of values.entries()) {
      items.push({
        id: `${task.id}:${sourceField}:${String(index + 1).padStart(3, "0")}`,
        source_field: sourceField,
        source_path: sourceField === "humanGate" ? `contract.humanGate[${index}]` : `contract.${sourceField}`,
        text,
      });
    }
  };
  add("acceptanceCriteria", semanticLines(task.acceptanceCriteria));
  add("validationAndEvidence", semanticLines(task.validationAndEvidence));
  add("humanGate", task.humanGate.map(gate => `Observe existing human gate: ${gate}; this view cannot approve it.`));
  add("compatibility", semanticLines(task.compatibility));
  return {
    authority: GENERATED_VIEW_AUTHORITY,
    task_id: task.id,
    task_hash: planTaskHash({ ...task, status: "pending" }),
    items,
  };
}

const PACKET_SECTION_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "Objective": ["contract.objective"],
  "Why": ["contract.why"],
  "Task and dependencies": ["contract.id", "contract.title", "contract.phase", "contract.owner", "attempt", "dependencies"],
  "Selected requirements, acceptance and design": ["selected_traces"],
  "Addressable design evidence": ["design_evidence"],
  "Contracts": ["contract.produces", "contract.consumes"],
  "Scope and constraints": ["contract.scopeAndConstraints"],
  "Effective stage guard": ["scope"],
  "Do not modify": ["contract.doNotModify"],
  "Compatibility": ["contract.compatibility"],
  "Retrieval hints": ["contract.retrievalHints"],
  "Verified retrieval candidates": ["retrieval_candidates"],
  "Required implementation behavior": ["contract.acceptanceCriteria"],
  "Validation and expected evidence": ["contract.validationAndEvidence", "required_verification"],
  "Risk and human gates": ["contract.risk", "contract.humanGate"],
  "Stop conditions": ["stop_conditions"],
  "Expansion pointers": ["expansion_pointers"],
  "Stage instructions": ["stage_instructions"],
  "Verification evidence": ["verification_context"],
};

export interface PromptSourceMapEntry {
  section: string;
  packet_fields: readonly string[];
  byte_start: number;
  byte_length: number;
}

export interface PromptPreviewIdentityInput {
  current_revision?: string;
  current_config_hash?: string;
  current_compiler_hash?: string;
  current_plan_hash?: string;
  read_source?: (source: string) => string | Buffer;
}

export interface GeneratedPromptPreview {
  authority: typeof GENERATED_VIEW_AUTHORITY;
  task_id: string;
  state: "executable" | "stale";
  stale_reasons: string[];
  unresolved_retrieval: boolean;
  source_hashes: {
    plan: string;
    artifacts: ExecutionPacket["identity"]["artifact_hashes"];
    config: string;
    compiler: string;
    target_revision: string;
  };
  prompt: { text: string; bytes: number; hash: string };
  persisted_packet: { text_bytes: number; text_hash: string; packet_hash: string };
  source_map: PromptSourceMapEntry[];
}

function promptSourceMap(packet: ExecutionPacket): PromptSourceMapEntry[] {
  let byteStart = 0;
  return renderPacketSections(packet).map((rendered, index) => {
    const section = /^## ([^\n]+)/.exec(rendered)?.[1] ?? "";
    const packetFields = PACKET_SECTION_SOURCES[section];
    if (!packetFields) throw new Error(`generated prompt section has no packet-field source mapping: ${section || "(untitled)"}`);
    if (index > 0) byteStart += Buffer.byteLength("\n\n");
    const entry = { section, packet_fields: packetFields, byte_start: byteStart, byte_length: Buffer.byteLength(rendered) };
    byteStart += entry.byte_length;
    return entry;
  });
}

/**
 * Builds an exact prompt preview and checks it against current source
 * identities. Any unavailable or changed identity marks the preview stale;
 * callers must recompile rather than treating a view as an execution authority.
 */
export function generatePromptPreview(packetInput: ExecutionPacket, current: PromptPreviewIdentityInput): GeneratedPromptPreview {
  const packet = ExecutionPacketSchema.parse(packetInput);
  const rendered = renderPacketText(packet);
  if (rendered !== packet.text) throw new Error("prompt preview diverges from persisted packet text");
  const stale: string[] = [];
  const compare = (label: string, actual: string | undefined, expected: string) => {
    if (actual === undefined) stale.push(`${label} is unavailable; recompile before execution`);
    else if (actual !== expected) stale.push(`${label} drift: expected ${expected}, current ${actual}`);
  };
  compare("target revision", current.current_revision, packet.identity.base_revision);
  compare("config hash", current.current_config_hash, packet.identity.config_hash);
  compare("compiler hash", current.current_compiler_hash, packet.identity.compiler_hash);
  compare("plan hash", current.current_plan_hash, packet.identity.plan_hash);
  const readSource = current.read_source ?? ((source: string) => fs.readFileSync(source));
  for (const source of packet.identity.artifact_hashes) {
    try {
      const actual = contentHash(readSource(source.source));
      if (actual !== source.hash) stale.push(`source hash drift: ${source.source}; expected ${source.hash}, current ${actual}`);
    } catch (error) {
      stale.push(`source unavailable: ${source.source}; ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const candidate of packet.retrieval_candidates) {
    if (candidate.revision !== current.current_revision) stale.push(`retrieval revision drift: ${candidate.path}`);
    try {
      if (contentHash(readSource(candidate.path)) !== candidate.hash) stale.push(`retrieval source hash drift: ${candidate.path}`);
    } catch (error) {
      stale.push(`retrieval source unavailable: ${candidate.path}; ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const bytes = Buffer.byteLength(rendered);
  const hash = contentHash(rendered);
  return {
    authority: GENERATED_VIEW_AUTHORITY,
    task_id: packet.task_id,
    state: stale.length === 0 ? "executable" : "stale",
    stale_reasons: stale,
    unresolved_retrieval: packet.retrieval_candidates.length === 0,
    source_hashes: {
      plan: packet.identity.plan_hash,
      artifacts: packet.identity.artifact_hashes,
      config: packet.identity.config_hash,
      compiler: packet.identity.compiler_hash,
      target_revision: packet.identity.base_revision,
    },
    prompt: { text: rendered, bytes, hash },
    persisted_packet: { text_bytes: Buffer.byteLength(packet.text), text_hash: contentHash(packet.text), packet_hash: packet.packet_hash },
    source_map: promptSourceMap(packet),
  };
}

export interface GeneratedTaskViews {
  authority: typeof GENERATED_VIEW_AUTHORITY;
  checklist: GeneratedChecklistView;
  prompt_preview: GeneratedPromptPreview;
}

export function generateTaskViews(packet: ExecutionPacket, current: PromptPreviewIdentityInput): GeneratedTaskViews {
  return {
    authority: GENERATED_VIEW_AUTHORITY,
    checklist: generateChecklist(packet.contract),
    prompt_preview: generatePromptPreview(packet, current),
  };
}

export function renderGeneratedTaskViews(view: GeneratedTaskViews): string {
  const preview = view.prompt_preview;
  return [
    "# Generated task views (read-only)",
    "",
    "This disposable view does not control task status, readiness, gates, or approval.",
    `State: ${preview.state}; unresolved retrieval: ${preview.unresolved_retrieval ? "yes" : "no"}`,
    `Task hash: ${view.checklist.task_hash}`,
    `Plan hash: ${preview.source_hashes.plan}`,
    `Config hash: ${preview.source_hashes.config}`,
    `Compiler hash: ${preview.source_hashes.compiler}`,
    `Target revision: ${preview.source_hashes.target_revision}`,
    ...preview.stale_reasons.map(reason => `Stale: ${reason}`),
    "",
    "## Generated checklist",
    "",
    ...view.checklist.items.map(item => `- [ ] [${item.source_path}] ${item.text}`),
    "",
    "## Exact prompt preview",
    "",
    preview.prompt.text,
  ].join("\n");
}
