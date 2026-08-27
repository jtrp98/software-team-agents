import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { measureWorkspaceStatic, recordInteractiveSession } from "./sessionRecord.js";

describe("interactive session observability (T-V3TOK-002)", () => {
  it("keeps always-loaded and role-reachable static bytes distinct, then records their exact footprint", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-session-record-"));
    try {
      fs.mkdirSync(path.join(root, "policies"), { recursive: true });
      fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
      fs.writeFileSync(path.join(root, "CLAUDE.md"), "c".repeat(10));
      fs.writeFileSync(path.join(root, "CLAUDE.local.md"), "ก");
      fs.writeFileSync(path.join(root, "policies", "policy.md"), "p".repeat(20));
      fs.writeFileSync(path.join(root, ".claude", "agents", "backend-engineer.md"), "b".repeat(30));
      fs.writeFileSync(path.join(root, ".claude", "agents", "business-analyst.md"), "a".repeat(40));
      fs.mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", "commands", "example.md"), "---\ndescription: command text\n---\nbody", "utf8");
      const measured = measureWorkspaceStatic(root, "dev");
      expect(measured).toEqual({ always_loaded_chars: 11, instruction_surface_bytes: 13, reachable_static_chars: 62 });
      const store = new MemoryTaskStore();
      recordInteractiveSession({ workspaceRoot: root, role: "dev", runtime: "claude", startedAt: 1, endedAt: 2, store });
      expect(store.allRuns()[0]).toMatchObject({ task_id: "session:dev:1970-01-01T00:00:00.001Z", session_kind: "interactive", static_chars: 73, instruction_surface_bytes: 13, input_tokens: null, output_tokens: null });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("measures the launch runtime's real root instruction bytes without adding context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-session-runtime-"));
    try {
      fs.writeFileSync(path.join(root, "CLAUDE.md"), "claude");
      fs.writeFileSync(path.join(root, "AGENTS.md"), "codex-ก");
      expect(measureWorkspaceStatic(root, "dev", "claude").instruction_surface_bytes).toBe(fs.statSync(path.join(root, "CLAUDE.md")).size);
      expect(measureWorkspaceStatic(root, "dev", "codex").instruction_surface_bytes).toBe(fs.statSync(path.join(root, "AGENTS.md")).size);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
