import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { KnowledgeContext } from "./knowledgeContext.js";
import { type KnowledgePolicy, DEFAULT_KNOWLEDGE_POLICY } from "./knowledgePolicy.js";
import { sampleKnowledge } from "./sampleKnowledge.js";
import { laneGet } from "../roles/laneContext.js";
import { renderKnowledgeRetrieval } from "./retrievalRender.js";

const restrictiveDevPolicy: KnowledgePolicy = {
  ...DEFAULT_KNOWLEDGE_POLICY,
  roles: {
    [AgentStage.BACKEND_ENGINEER]: { sensitive: "redacted", hideFields: ["relations"] },
    [AgentStage.FRONTEND_ENGINEER]: { sensitive: "redacted", hideFields: ["relations"] },
    [AgentStage.QA_ENGINEER]: { sensitive: "redacted", hideFields: ["relations"] },
    [AgentStage.DEVOPS]: { sensitive: "redacted", hideFields: ["relations"] },
    [AgentStage.SECURITY]: { sensitive: "redacted", hideFields: ["relations"] },
  },
};

function context(): KnowledgeContext {
  const items = sampleKnowledge().map((item) => item.id === "DB-Shift"
    ? { ...item, title: "private schedule model", body: "secret shift schedule" }
    : item,
  );
  return new KnowledgeContext(new KnowledgeBase(items), {
    now: "2026-08-27T00:00:00Z",
    policy: restrictiveDevPolicy,
  });
}

describe("renderKnowledgeRetrieval", () => {
  it("never emits withheld values in either text or JSON", () => {
    const rendered = renderKnowledgeRetrieval("dev", "DB-Shift", laneGet("dev", context(), "DB-Shift"));
    const text = rendered.text;
    const json = JSON.stringify(rendered.json);
    for (const output of [text, json]) {
      expect(output).not.toContain("secret shift schedule");
      expect(output).not.toContain("staff Staff");
      expect(output).not.toContain("shift-service");
      expect(output).toContain("body");
      expect(output).toContain("payload");
      expect(output).not.toContain("derived-from");
    }
    expect(rendered.json).not.toHaveProperty("body");
    expect(rendered.json).not.toHaveProperty("payload");
    expect(rendered.json).not.toHaveProperty("relations");
  });

  it("keeps sensitive-item policy and a permitted non-sensitive payload intact", () => {
    const sensitive = renderKnowledgeRetrieval("dev", "DB-Shift", laneGet("dev", context(), "DB-Shift"));
    expect(sensitive.json.withheld_fields).toEqual(expect.arrayContaining(["body", "payload", "sources"]));

    const permitted = renderKnowledgeRetrieval("dev", "REQ-003", laneGet("dev", context(), "REQ-003"));
    expect(permitted.json).toMatchObject({ body: "", payload: { priority: "must" } });
  });

  it("reports a withheld item without mistaking it for not-found", () => {
    const rendered = renderKnowledgeRetrieval("ba", "BE-014", laneGet("ba", context(), "BE-014"));
    expect(rendered.json).toMatchObject({ id: "BE-014", status: "withheld" });
    expect(rendered.text).toContain("withheld");
  });
});
