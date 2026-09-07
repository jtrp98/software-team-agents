import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendJournalRecord, writeRunManifest, type RunManifest } from "../../run/journal.js";
import { runStatusVerb } from "./status.js";

describe("T-V7-030 — sta status bounded runs", () => {
  it("lists active and halted runs with derived next human actions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-status-run-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const runId = "01J00000000000000000000064";
      const manifest: RunManifest = {
        run_id: runId, created_at: "2026-09-07T00:00:00.000Z", target_root: root, target_id: "target",
        knowledge_root: root, module: "orders", wave: 2, plan_hash: "hash", task_order: ["BE-1"],
        base_branch: "main", base_sha: "a".repeat(40), run_branch: `sta/run/orders/${runId}`,
        runtime_id: "claude-code", tier: "T2", model: "opus", max_tasks: 1, sta_version: "1.1.0",
      };
      writeRunManifest(root, manifest);
      appendJournalRecord(root, runId, { ts: "2026-09-07T00:00:00.000Z", kind: "RUN_STARTED" });
      appendJournalRecord(root, runId, { ts: "2026-09-07T00:00:01.000Z", kind: "RUN_ISOLATED" });
      appendJournalRecord(root, runId, { ts: "2026-09-07T00:00:02.000Z", kind: "TASK_READY", task_id: "BE-1" });
      appendJournalRecord(root, runId, { ts: "2026-09-07T00:00:03.000Z", kind: "RUN_HALTED", reason: "gate unavailable" });
      const activeId = "01J00000000000000000000065";
      writeRunManifest(root, { ...manifest, run_id: activeId, run_branch: `sta/run/orders/${activeId}` });
      appendJournalRecord(root, activeId, { ts: "2026-09-07T00:01:00.000Z", kind: "RUN_STARTED" });
      appendJournalRecord(root, activeId, { ts: "2026-09-07T00:01:01.000Z", kind: "RUN_ISOLATED" });
      appendJournalRecord(root, activeId, { ts: "2026-09-07T00:01:02.000Z", kind: "TASK_READY", task_id: "BE-1" });
      appendJournalRecord(root, activeId, { ts: "2026-09-07T00:01:03.000Z", kind: "TASK_STARTED", task_id: "BE-1" });

      expect(await runStatusVerb(["--project-root", root], root)).toBe(0);
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain(`bounded run ${runId}: HALTED module=orders wave=2`);
      expect(output).toContain(`bounded run ${activeId}: TASK_RUNNING module=orders wave=2`);
      expect(output).toContain("next required human action:");
      expect(output).toContain("--resume-run");
    } finally {
      log.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
