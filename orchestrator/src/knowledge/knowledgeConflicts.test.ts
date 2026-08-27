import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase, checkKnowledge } from "./knowledgeBase.js";
import { makeItem, sampleKnowledge } from "./sampleKnowledge.js";
import { writeKnowledgeItem } from "./knowledgeStore.js";
import {
  type Conflict,
  type ConflictResolution,
  ConflictResolutionError,
  conflictId,
  conflictsDir,
  describeConflict,
  detectConflicts,
  loadResolutions,
  reportConflicts,
  resolutionPath,
  writeResolution,
} from "./knowledgeConflicts.js";

const NOW = "2026-08-20T09:00:00Z";

function model(id: string, name: string, targetIds?: string[]) {
  return makeItem("db-schema", id, {
    model: name,
    fields: [{ name: "id", type: "String", optional: false }],
    relations: [],
  }, targetIds ? { target_ids: targetIds } : {});
}

function term(id: string, word: string) {
  return makeItem("domain", id, { term: word, definition: `definition of ${word}`, aliases: [] });
}

function endpoint(id: string, method: "GET" | "POST", p: string) {
  return makeItem("api", id, { method, path: p, contract_name: null, request_shape: null, response_shape: null });
}

function resolutionFor(conflict: Conflict, overrides: Partial<ConflictResolution> = {}): ConflictResolution {
  return {
    schema_version: 1,
    id: conflict.id,
    conflict_kind: conflict.kind,
    items: conflict.items,
    decision: "keep the sales-crm definition; the other was a copy",
    decided_by: "Jaturapat",
    decided_at: NOW,
    ...overrides,
  };
}

describe("conflict ids", () => {
  it("are stable and order-independent, so a decision made last month still matches", () => {
    expect(conflictId("declared", ["REQ-002", "REQ-001"])).toBe(conflictId("declared", ["REQ-001", "REQ-002"]));
  });

  it("differ by kind, because the same pair can conflict in more than one way", () => {
    expect(conflictId("declared", ["DB-A", "DB-B"])).not.toBe(conflictId("duplicate-model", ["DB-A", "DB-B"]));
  });

  it("look like an id", () => {
    expect(conflictId("declared", ["REQ-001", "REQ-002"])).toMatch(/^CONF-[a-f0-9]{10}$/);
  });
});

describe("detectConflicts", () => {
  it("finds nothing in a consistent base", () => {
    expect(detectConflicts(new KnowledgeBase(sampleKnowledge()))).toEqual([]);
  });

  it("picks up a conflicts-with relation somebody wrote, and marks it declared", () => {
    const a = makeItem(
      "requirement",
      "REQ-001",
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      { relations: [{ type: "conflicts-with", to: "REQ-002", note: "the doc says 30 days, the code does 90" }] },
    );
    const b = makeItem("requirement", "REQ-002", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false });
    const [conflict] = detectConflicts(new KnowledgeBase([a, b]));
    expect(conflict.declared).toBe(true);
    expect(conflict.summary).toBe("the doc says 30 days, the code does 90");
    expect(conflict.items).toEqual(["REQ-001", "REQ-002"]);
  });

  it("does not report the same declared conflict twice when both sides record it", () => {
    const a = makeItem("requirement", "REQ-001", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
      relations: [{ type: "conflicts-with", to: "REQ-002" }],
    });
    const b = makeItem("requirement", "REQ-002", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
      relations: [{ type: "conflicts-with", to: "REQ-001" }],
    });
    expect(detectConflicts(new KnowledgeBase([a, b]))).toHaveLength(1);
  });

  it("ignores a conflicts-with pointing at nothing — that is a broken link, not a disagreement", () => {
    const a = makeItem("requirement", "REQ-001", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
      relations: [{ type: "conflicts-with", to: "REQ-404" }],
    });
    expect(detectConflicts(new KnowledgeBase([a]))).toEqual([]);
  });

  it("finds two records defining one model", () => {
    const conflicts = detectConflicts(new KnowledgeBase([model("DB-Shift", "Shift"), model("DB-Shift2", "Shift")]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("duplicate-model");
    expect(conflicts[0].declared).toBe(false);
  });

  it("does not treat the same model name in different explicit Targets as a duplicate", () => {
    const conflicts = detectConflicts(new KnowledgeBase([
      model("DB-app-Note", "Note", ["app"]),
      model("DB-admin-Note", "Note", ["admin"]),
    ]));
    expect(conflicts).toEqual([]);
  });

  it("still treats the same model name in the same Target as a duplicate", () => {
    const conflicts = detectConflicts(new KnowledgeBase([
      model("DB-app-Note-a", "Note", ["app"]),
      model("DB-app-Note-b", "Note", ["app"]),
    ]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "duplicate-model", items: ["DB-app-Note-a", "DB-app-Note-b"] });
  });

  it("keeps an explicit conflicts-with relation across different Targets", () => {
    const a = makeItem(
      "requirement",
      "REQ-app",
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      { target_ids: ["app"], relations: [{ type: "conflicts-with", to: "REQ-admin" }] },
    );
    const b = makeItem(
      "requirement",
      "REQ-admin",
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      { target_ids: ["admin"] },
    );
    expect(detectConflicts(new KnowledgeBase([a, b]))).toMatchObject([
      { kind: "declared", declared: true, items: ["REQ-admin", "REQ-app"] },
    ]);
  });

  it("finds two records defining one endpoint", () => {
    const conflicts = detectConflicts(
      new KnowledgeBase([endpoint("API-a", "GET", "/api/shifts"), endpoint("API-b", "GET", "/api/shifts")]),
    );
    expect(conflicts[0].kind).toBe("duplicate-endpoint");
  });

  it("does not confuse two methods on one path", () => {
    expect(
      detectConflicts(new KnowledgeBase([endpoint("API-a", "GET", "/api/shifts"), endpoint("API-b", "POST", "/api/shifts")])),
    ).toEqual([]);
  });

  it("finds one term defined twice, whatever the casing", () => {
    const conflicts = detectConflicts(new KnowledgeBase([term("DOM-001", "Shift"), term("DOM-002", "shift")]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("duplicate-term");
  });

  it("is deterministic — the same base gives the same conflicts with the same ids", () => {
    const items = [model("DB-Shift", "Shift"), model("DB-Shift2", "Shift")];
    expect(detectConflicts(new KnowledgeBase(items))).toEqual(detectConflicts(new KnowledgeBase([...items].reverse())));
  });
});

describe("resolutions on disk", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-conflicts-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const conflict = { id: conflictId("duplicate-model", ["DB-Shift", "DB-Shift2"]), kind: "duplicate-model" as const, items: ["DB-Shift", "DB-Shift2"], summary: "x", declared: false };

  it("round-trips a resolution", () => {
    writeResolution(resolutionFor(conflict), root);
    const loaded = loadResolutions(root);
    expect(loaded.problems).toEqual([]);
    expect(loaded.resolutions[0].decided_by).toBe("Jaturapat");
  });

  it("refuses a resolution with no decider — the point of the record is that a person decided", () => {
    expect(() => writeResolution(resolutionFor(conflict, { decided_by: "" }), root)).toThrow(ConflictResolutionError);
  });

  it("rejects a file whose id does not match the conflict it claims to be about", () => {
    fs.mkdirSync(conflictsDir(root), { recursive: true });
    const wrong = resolutionFor(conflict, { items: ["DB-Other", "DB-Another"] });
    fs.writeFileSync(
      resolutionPath(wrong.id, root),
      `schema_version: 1\nid: ${wrong.id}\nconflict_kind: duplicate-model\nitems: [DB-Other, DB-Another]\ndecision: x\ndecided_by: someone\ndecided_at: "${NOW}"\n`,
      "utf8",
    );
    expect(loadResolutions(root).problems.join("\n")).toContain("would close a conflict it is not about");
  });

  it("reports no _conflicts/ directory as nothing to load, not as a problem", () => {
    expect(loadResolutions(root)).toEqual({ resolutions: [], problems: [] });
  });
});

describe("reportConflicts", () => {
  const declared = makeItem("requirement", "REQ-001", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
    relations: [{ type: "conflicts-with", to: "REQ-002" }],
  });
  const other = makeItem("requirement", "REQ-002", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false });

  it("separates the blocking kind from the suggestion kind", () => {
    const kb = new KnowledgeBase([declared, other, model("DB-Shift", "Shift"), model("DB-Shift2", "Shift")]);
    const report = reportConflicts(kb, []);
    expect(report.unresolvedDeclared).toHaveLength(1);
    expect(report.unresolvedDetected).toHaveLength(1);
    expect(report.unresolvedDetected[0].kind).toBe("duplicate-model");
  });

  it("moves a conflict to resolved once a person has decided", () => {
    const kb = new KnowledgeBase([declared, other]);
    const [conflict] = detectConflicts(kb);
    const report = reportConflicts(kb, [resolutionFor(conflict)]);
    expect(report.unresolvedDeclared).toEqual([]);
    expect(report.resolved[0].resolution.decided_by).toBe("Jaturapat");
  });

  it("lists a decision about a conflict that no longer exists — the fix worked", () => {
    const kb = new KnowledgeBase([declared, other]);
    const gone = resolutionFor({ ...conflictOf("duplicate-model", ["DB-A", "DB-B"]) });
    expect(reportConflicts(kb, [gone]).staleResolutions).toHaveLength(1);
  });
});

function conflictOf(kind: "duplicate-model", items: string[]): Conflict {
  return { id: conflictId(kind, items), kind, items, summary: "", declared: false };
}

describe("describeConflict", () => {
  it("puts what a person needs to decide in front of them", () => {
    const kb = new KnowledgeBase([model("DB-Shift", "Shift"), model("DB-Shift2", "Shift")]);
    const text = describeConflict(detectConflicts(kb)[0], kb);
    expect(text).toContain("DB-Shift");
    expect(text).toContain("owner system-analyst");
    expect(text).toContain("a person decides");
  });

  it("says so when one side is not in the base, rather than printing nothing", () => {
    const kb = new KnowledgeBase([model("DB-Shift", "Shift")]);
    const text = describeConflict(conflictOf("duplicate-model", ["DB-Shift", "DB-Ghost"]), kb);
    expect(text).toContain("DB-Ghost (not in the knowledge base)");
  });
});

describe("checkKnowledge with conflicts", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-conflicts-check-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails on an undecided declared conflict", () => {
    const a = makeItem("requirement", "REQ-001", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
      owner: AgentStage.BUSINESS_ANALYST,
      relations: [{ type: "conflicts-with", to: "REQ-002" }],
    });
    const b = makeItem("requirement", "REQ-002", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
      owner: AgentStage.BUSINESS_ANALYST,
    });
    writeKnowledgeItem(a, root);
    writeKnowledgeItem(b, root);

    const before = checkKnowledge(root);
    expect(before.ok).toBe(false);
    expect(before.problems.join("\n")).toContain("a person decides");

    writeResolution(resolutionFor(detectConflicts(new KnowledgeBase([a, b]))[0]), root);
    expect(checkKnowledge(root).ok).toBe(true);
  });

  it("only notes a detected duplicate — a heuristic that can fail CI is one that gets deleted", () => {
    writeKnowledgeItem(model("DB-Shift", "Shift"), root);
    writeKnowledgeItem(model("DB-Shift2", "Shift"), root);
    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.notes.join("\n")).toContain("possible conflict");
  });
});
