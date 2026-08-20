import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { readBootstrapState } from "./bootstrapStore.js";
import {
  BootstrapNotSettledError,
  BootstrapNotStartedError,
  UnknownBootstrapStageError,
  initBootstrap,
  recordHumanValidation,
  runBootstrapStage,
  type DiscoveryStage,
} from "./bootstrapRunner.js";

const NOW = "2026-08-20T09:00:00Z";

function requirement(id: string): KnowledgeItemOf<"requirement"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind: "requirement",
    title: id,
    body: "",
    repo: null,
    module: null,
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [{ type: "code", locator: "src/routes/shifts.ts", captured_at: NOW, digest: null }],
    relations: [],
    payload: { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
  };
}

function stubStage(id: DiscoveryStage["id"], items: KnowledgeItemOf<"requirement">[] = [], skipped = false): DiscoveryStage {
  return {
    id,
    discover: () => ({ items, sources: [], skipped }),
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-bootstrap-run-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("initBootstrap", () => {
  it("creates a fresh state on first call", () => {
    const state = initBootstrap(null, root, NOW);
    expect(state.status).toBe("discovering");
  });

  it("is idempotent — a second call returns the existing state untouched", () => {
    const first = initBootstrap("sales-crm", root, NOW);
    const second = initBootstrap("sales-crm", root, "2026-09-01T00:00:00Z");
    expect(second).toEqual(first);
  });
});

describe("runBootstrapStage", () => {
  it("throws BootstrapNotStartedError if init was never called", async () => {
    await expect(runBootstrapStage(stubStage("repository"), root, NOW)).rejects.toThrow(BootstrapNotStartedError);
  });

  it("writes the stage's items into knowledge/ and records their ids on the stage", async () => {
    initBootstrap(null, root, NOW);
    const items = [requirement("REQ-001"), requirement("REQ-002")];
    const state = await runBootstrapStage(stubStage("repository", items), root, NOW);

    const repoStage = state.stages.find((s) => s.id === "repository")!;
    expect(repoStage.status).toBe("done");
    expect(repoStage.knowledge_ids.sort()).toEqual(["REQ-001", "REQ-002"]);

    expect(fs.existsSync(path.join(root, "knowledge", "_project", "requirement", "REQ-001.yaml"))).toBe(true);
  });

  it("marks a stage skipped when the discovery result says so, and still settles it", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(stubStage("api", [], true), root, NOW);
    expect(state.stages.find((s) => s.id === "api")!.status).toBe("skipped");
  });

  it("rejects a stage id the bootstrap isn't tracking", async () => {
    initBootstrap(null, root, NOW);
    await expect(runBootstrapStage(stubStage("not-a-real-stage" as DiscoveryStage["id"]), root, NOW)).rejects.toThrow(
      UnknownBootstrapStageError,
    );
  });

  it("moves overall status to pending_validation once every stage has run", async () => {
    initBootstrap(null, root, NOW);
    for (const id of ["repository", "documentation", "db-schema", "api", "architecture", "human-input"] as const) {
      await runBootstrapStage(stubStage(id, [], true), root, NOW);
    }
    const { state } = readBootstrapState(root);
    expect(state!.status).toBe("pending_validation");
  });
});

describe("recordHumanValidation", () => {
  it("refuses to validate while stages are still open", async () => {
    initBootstrap(null, root, NOW);
    await runBootstrapStage(stubStage("repository", [], true), root, NOW);
    expect(() => recordHumanValidation("Nok", root, NOW)).toThrow(BootstrapNotSettledError);
  });

  it("moves status to ready once every stage is settled and a name is recorded", async () => {
    initBootstrap(null, root, NOW);
    for (const id of ["repository", "documentation", "db-schema", "api", "architecture", "human-input"] as const) {
      await runBootstrapStage(stubStage(id, [], true), root, NOW);
    }
    const state = recordHumanValidation("Nok", root, NOW);
    expect(state.status).toBe("ready");
    expect(state.validated_by).toBe("Nok");
  });
});

describe("checkKnowledge integration", () => {
  it("reports the bootstrap status as a note and flags a stage claiming an item that does not exist", async () => {
    initBootstrap(null, root, NOW);
    await runBootstrapStage(stubStage("repository", [requirement("REQ-010")]), root, NOW);

    const clean = checkKnowledge(root);
    expect(clean.notes.some((n) => n.includes("bootstrap (T73) status: discovering"))).toBe(true);
    expect(clean.problems).toEqual([]);

    // Corrupt the state file to claim an item that was never written.
    const { state } = readBootstrapState(root);
    state!.stages.find((s) => s.id === "documentation")!.knowledge_ids = ["REQ-999"];
    state!.stages.find((s) => s.id === "documentation")!.status = "done";
    state!.stages.find((s) => s.id === "documentation")!.completed_at = NOW;
    fs.writeFileSync(
      path.join(root, "knowledge", "_bootstrap", "STATE.yaml"),
      JSON.stringify(state), // valid YAML is valid JSON
      "utf8",
    );

    const dirty = checkKnowledge(root);
    expect(dirty.problems.some((p) => p.includes('claims item "REQ-999"'))).toBe(true);
  });
});
