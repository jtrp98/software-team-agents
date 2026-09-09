import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash, renderPacketSections } from "../artifacts/executionPacket.js";
import { AgentStage } from "../types.js";
import { compileExecutionPacket, packetCompilerHash } from "../runtime/agentRunAssembly.js";
import { FIXTURE_REVISION, packetFixture, runtimeTaskFixture } from "../runtime/packetFixture.testSupport.js";
import { readExecutionPacket, writeExecutionPacket } from "../state/runtimeArtifacts.js";
import {
  CHECKLIST_SOURCE_FIELDS,
  generateChecklist,
  generatePromptPreview,
  generateTaskViews,
  renderGeneratedTaskViews,
} from "./generatedTaskViews.js";

const roots: string[] = [];
const tempRoot = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-generated-views-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function current(packet: ReturnType<typeof packetFixture>) {
  return {
    current_revision: packet.identity.base_revision,
    current_config_hash: packet.identity.config_hash,
    current_compiler_hash: packetCompilerHash(),
    current_plan_hash: packet.identity.plan_hash,
  };
}

describe("T-V8-010 generated checklist and exact prompt preview", () => {
  it("generates a deterministic read-only checklist from only canonical PlanTask fields", () => {
    const packet = packetFixture(tempRoot());
    const contract = { ...packet.contract, humanGate: ["migration" as const] };
    const first = generateChecklist(contract);
    expect(generateChecklist(contract)).toEqual(first);
    expect(first.authority).toEqual({
      kind: "generated-view",
      source: "canonical-plan-task+execution-packet",
      mutable: false,
      controls_status: false,
      controls_readiness: false,
    });
    expect([...new Set(first.items.map(item => item.source_field))].sort()).toEqual([...CHECKLIST_SOURCE_FIELDS].sort());
    expect(first.items.map(item => item.source_path)).toEqual([
      "contract.acceptanceCriteria",
      "contract.validationAndEvidence",
      "contract.humanGate[0]",
      "contract.compatibility",
    ]);
    expect(first.items.map(item => item.text)).toEqual([
      "AC-007.2: An empty order returns the documented zero total without an exception.",
      "Verify AC-007.2 with the empty-order regression and existing serializer tests. Record commands, exit codes and response assertions.",
      "Observe existing human gate: migration; this view cannot approve it.",
      "Preserve existing nonempty-order serialization. The patch can be removed independently.",
    ]);
  });

  it("uses the packet renderer once, maps every emitted section, and has no orphan section", () => {
    const packet = packetFixture(tempRoot(), { stage: AgentStage.QA_ENGINEER });
    const preview = generatePromptPreview(packet, current(packet));
    expect(preview.state).toBe("executable");
    expect(preview.prompt.text).toBe(packet.text);
    expect(preview.prompt.bytes).toBe(preview.persisted_packet.text_bytes);
    expect(preview.prompt.hash).toBe(preview.persisted_packet.text_hash);
    expect(preview.source_map.map(entry => entry.section)).toEqual(
      renderPacketSections(packet).map(section => /^## ([^\n]+)/.exec(section)![1]),
    );
    for (const entry of preview.source_map) {
      expect(entry.packet_fields.length, entry.section).toBeGreaterThan(0);
      expect(entry.byte_length, entry.section).toBeGreaterThan(0);
    }
  });

  it("marks source, revision, config, compiler and plan drift stale instead of changing the packet", () => {
    const packet = packetFixture(tempRoot());
    for (const [field, value, expected] of [
      ["current_revision", "b".repeat(40), "target revision drift"],
      ["current_config_hash", "b".repeat(64), "config hash drift"],
      ["current_compiler_hash", "b".repeat(64), "compiler hash drift"],
      ["current_plan_hash", "b".repeat(64), "plan hash drift"],
    ] as const) {
      const preview = generatePromptPreview(packet, { ...current(packet), [field]: value });
      expect(preview.state, field).toBe("stale");
      expect(preview.stale_reasons.join("\n"), field).toContain(expected);
      expect(preview.prompt.text, field).toBe(packet.text);
    }
    fs.appendFileSync(packet.identity.artifact_hashes[0].source, "\ndrift");
    const sourceDrift = generatePromptPreview(packet, current(packet));
    expect(sourceDrift.state).toBe("stale");
    expect(sourceDrift.stale_reasons.join("\n")).toContain("source hash drift");
  });

  it("labels unresolved retrieval without fabricating candidates", () => {
    const root = tempRoot();
    const packet = packetFixture(root);
    expect(generatePromptPreview(packet, current(packet)).unresolved_retrieval).toBe(true);
    const task = runtimeTaskFixture(root);
    const file = path.join(root, "candidate.ts");
    fs.writeFileSync(file, "export const candidate = true;\n");
    const candidatePacket = compileExecutionPacket({
      req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] },
      role: AgentStage.BACKEND_ENGINEER,
      runtimeTask: task,
      baseRevision: FIXTURE_REVISION,
      contractScope: { allow: ["server/**"], deny: [".git/**"] },
      retrievalCandidates: [{
        path: file,
        symbol: "candidate",
        provenance: "fixture current source",
        revision: FIXTURE_REVISION,
        hash: contentHash(fs.readFileSync(file)),
      }],
    });
    expect(generatePromptPreview(candidatePacket, current(candidatePacket)).unresolved_retrieval).toBe(false);
  });

  it("keeps preview bytes equal after immutable persistence and renders explicit non-authority labels", () => {
    const runtimeRoot = tempRoot();
    const packet = packetFixture(tempRoot());
    const persisted = writeExecutionPacket({ projectRoot: runtimeRoot, packet });
    const fromDisk = readExecutionPacket(persisted.path);
    const views = generateTaskViews(fromDisk, current(fromDisk));
    expect(views.prompt_preview.prompt.text).toBe(fromDisk.text);
    expect(views.prompt_preview.prompt.hash).toBe(contentHash(fromDisk.text));
    const rendered = renderGeneratedTaskViews(views);
    expect(rendered).toContain("Generated task views (read-only)");
    expect(rendered).toContain("does not control task status, readiness, gates, or approval");
    expect(rendered.endsWith(fromDisk.text)).toBe(true);
  });
});
