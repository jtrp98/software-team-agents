import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveLegacyTaskData } from "./legacyCutoverArchive.js";

describe("V13 TASK-023: legacyCutoverArchive", () => {
  it("archives pre-v2 legacy packets into .workflow/archive/ and ignores v2 packets", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sta-archive-test-"));
    try {
      const packetsDir = path.join(tmp, ".workflow", "packets", "T-OLD");
      fs.mkdirSync(packetsDir, { recursive: true });

      const legacyPacket = {
        text: "some old packet text",
        composition: { static_chars: 20, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0 },
        budgetComposition: { base: 20, task: 0, safety: 0, docs: 0, knowledge: 0, code: 0, tool_output: 0, reserve: 0 },
        task_id: "T-OLD",
        stage: "backend-engineer",
        role: "backend-engineer",
        acceptance_criteria: [],
        required_verification: [],
        stop_conditions: [],
        scope: { allow: [], deny: [] },
        sources: [],
      };
      fs.writeFileSync(path.join(packetsDir, "backend-engineer-1.json"), JSON.stringify(legacyPacket, null, 2), "utf8");

      // Also create a v2 packet
      const v2PacketDir = path.join(tmp, ".workflow", "packets", "T-NEW");
      fs.mkdirSync(v2PacketDir, { recursive: true });
      fs.writeFileSync(path.join(v2PacketDir, "backend-engineer-1.json"), JSON.stringify({ version: 2, task_id: "T-NEW" }), "utf8");

      const result = archiveLegacyTaskData(tmp);
      expect(result.archivedPackets).toBe(1);
      expect(result.archivePath).not.toBeNull();
      expect(fs.existsSync(result.archivePath!)).toBe(true);

      const archivedManifest = JSON.parse(fs.readFileSync(result.archivePath!, "utf8"));
      expect(archivedManifest.records).toHaveLength(1);
      expect(archivedManifest.records[0].taskId).toBe("T-OLD");
      expect(archivedManifest.records[0].kind).toBe("packet");
      expect(archivedManifest.records[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns zero counts if no legacy records exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sta-archive-empty-"));
    try {
      const result = archiveLegacyTaskData(tmp);
      expect(result.archivedPackets).toBe(0);
      expect(result.archivedWaveRuns).toBe(0);
      expect(result.archivePath).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
