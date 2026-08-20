import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { KnowledgeStatus } from "./knowledgeModel.js";
import { KnowledgeBase, checkKnowledge } from "./knowledgeBase.js";
import { writeKnowledgeItem } from "./knowledgeStore.js";
import { makeItem, sampleKnowledge } from "./sampleKnowledge.js";
import {
  ALLOWED_OWNERS,
  StatusTransitionError,
  applyTransition,
  canTransition,
  checkOwnership,
  deprecatedStillDependedOn,
  mayOwn,
} from "./ownership.js";

const NOW = "2026-08-21T09:00:00Z";

function item(status: KnowledgeStatus, owner = AgentStage.BUSINESS_ANALYST) {
  return makeItem(
    "requirement",
    "REQ-003",
    { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
    { status, owner },
  );
}

describe("who may own what", () => {
  it("lets a person own anything", () => {
    expect(mayOwn("decision", AgentStage.HUMAN)).toBe(true);
    expect(mayOwn("db-schema", AgentStage.HUMAN)).toBe(true);
  });

  it("keeps each kind with the role that does that work", () => {
    expect(mayOwn("requirement", AgentStage.BUSINESS_ANALYST)).toBe(true);
    expect(mayOwn("requirement", AgentStage.BACKEND_ENGINEER)).toBe(false);
    expect(mayOwn("db-schema", AgentStage.SYSTEM_ANALYST)).toBe(true);
    expect(mayOwn("task", AgentStage.FRONTEND_ENGINEER)).toBe(true);
  });

  it("gives a decision no agent owner at all — an ADR is a person's call", () => {
    expect(ALLOWED_OWNERS.decision).toEqual([]);
    expect(mayOwn("decision", AgentStage.SYSTEM_ANALYST)).toBe(false);
  });

  it("checkOwnership names the item and what was expected", () => {
    const problems = checkOwnership([item("draft", AgentStage.DEVOPS)]);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("business-analyst");
  });

  it("passes the sample graph, so the fixture is not quietly wrong", () => {
    expect(checkOwnership(sampleKnowledge())).toEqual([]);
  });
});

describe("status transitions", () => {
  it("lets anyone but the owner move a draft to reviewed", () => {
    expect(canTransition(item("draft"), "reviewed", AgentStage.SYSTEM_ANALYST).allowed).toBe(true);
  });

  it("refuses to let the owner review their own item", () => {
    const verdict = canTransition(item("draft"), "reviewed", AgentStage.BUSINESS_ANALYST);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("cannot review it");
  });

  it("lets a person do it anyway, because every rule here constrains agents", () => {
    expect(canTransition(item("draft"), "reviewed", AgentStage.HUMAN).allowed).toBe(true);
  });

  it("refuses draft -> approved: the shortcut that makes review optional", () => {
    const verdict = canTransition(item("draft"), "approved", AgentStage.HUMAN);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("can only go to reviewed, deprecated");
  });

  it("lets only a person approve", () => {
    expect(canTransition(item("reviewed"), "approved", AgentStage.HUMAN).allowed).toBe(true);
    const verdict = canTransition(item("reviewed"), "approved", AgentStage.SYSTEM_ANALYST);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("only a person");
  });

  it("lets a review send an item back to draft", () => {
    expect(canTransition(item("reviewed"), "draft", AgentStage.QA_ENGINEER).allowed).toBe(true);
  });

  it("reopens an approved item to draft, so it stops being binding while it changes", () => {
    expect(canTransition(item("approved"), "draft", AgentStage.BUSINESS_ANALYST).allowed).toBe(true);
    expect(canTransition(item("approved"), "reviewed", AgentStage.BUSINESS_ANALYST).allowed).toBe(false);
  });

  it("lets only the owner (or a person) deprecate", () => {
    expect(canTransition(item("approved"), "deprecated", AgentStage.BUSINESS_ANALYST).allowed).toBe(true);
    expect(canTransition(item("approved"), "deprecated", AgentStage.DEVOPS).allowed).toBe(false);
  });

  it("revives a deprecated item to draft and nowhere else", () => {
    expect(canTransition(item("deprecated"), "draft", AgentStage.BUSINESS_ANALYST).allowed).toBe(true);
    expect(canTransition(item("deprecated"), "approved", AgentStage.HUMAN).allowed).toBe(false);
  });

  it("says 'already' rather than pretending a no-op is a transition", () => {
    expect(canTransition(item("draft"), "draft", AgentStage.HUMAN)).toEqual({
      allowed: false,
      reason: "REQ-003 is already draft",
    });
  });
});

describe("applyTransition", () => {
  it("bumps the version, because status is content", () => {
    const after = applyTransition(item("reviewed"), "approved", AgentStage.HUMAN, NOW);
    expect(after.status).toBe("approved");
    expect(after.version).toBe(2);
    expect(after.updated_at).toBe(NOW);
  });

  it("throws with the refusal's own reason rather than a generic message", () => {
    expect(() => applyTransition(item("draft"), "approved", AgentStage.HUMAN, NOW)).toThrow(StatusTransitionError);
    try {
      applyTransition(item("draft"), "approved", AgentStage.HUMAN, NOW);
    } catch (e) {
      expect((e as StatusTransitionError).verdict.allowed).toBe(false);
    }
  });

  it("leaves the original untouched", () => {
    const before = item("reviewed");
    applyTransition(before, "approved", AgentStage.HUMAN, NOW);
    expect(before.status).toBe("reviewed");
  });
});

describe("deprecated knowledge something still relies on", () => {
  it("lists the citations that need re-pointing before the item can go", () => {
    const items = sampleKnowledge().map((i) => (i.id === "DES-003" ? { ...i, status: "deprecated" as const } : i));
    const result = deprecatedStillDependedOn(new KnowledgeBase(items));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("DES-003");
    expect(result[0].dependents.sort()).toEqual(["ADR-003", "API-shifts.list", "BE-014", "DB-Shift", "FE-020"]);
  });

  it("says nothing when nothing is deprecated", () => {
    expect(deprecatedStillDependedOn(new KnowledgeBase(sampleKnowledge()))).toEqual([]);
  });

  it("does not count the item that superseded it — that link is the record working", () => {
    const old = makeItem(
      "decision",
      "ADR-001",
      { adr_status: "superseded", date: "2026-01-01", supersedes: null, superseded_by: "ADR-002" },
      { module: null, owner: AgentStage.HUMAN, status: "deprecated" },
    );
    const replacement = makeItem(
      "decision",
      "ADR-002",
      { adr_status: "accepted", date: "2026-02-01", supersedes: "ADR-001", superseded_by: null },
      { module: null, owner: AgentStage.HUMAN, relations: [{ type: "supersedes", to: "ADR-001" }] },
    );
    expect(deprecatedStillDependedOn(new KnowledgeBase([old, replacement]))).toEqual([]);
  });
});

/**
 * T65's rules were written, tested, and then never called by anything that
 * runs. These lock them into the check CI actually executes — a rule nobody
 * runs is documentation, which is the T40 `severity` failure one level up.
 */
describe("ownership reaches --check-knowledge", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-ownership-check-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails the check when an item is owned by a role that does not do that kind of work", () => {
    writeKnowledgeItem(item("draft", AgentStage.DEVOPS), root);
    const report = checkKnowledge(root);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("which does not own requirement items");
  });

  it("passes for an owner the kind allows", () => {
    writeKnowledgeItem(item("draft", AgentStage.BUSINESS_ANALYST), root);
    expect(checkKnowledge(root).ok).toBe(true);
  });

  it("notes a deprecated item something still cites, without failing on it", () => {
    for (const entry of sampleKnowledge()) {
      writeKnowledgeItem(entry.id === "DES-003" ? { ...entry, status: "deprecated" } : entry, root, { force: true });
    }
    const report = checkKnowledge(root);
    expect(report.notes.join("\n")).toContain("DES-003 is deprecated but still cited by");
    expect(report.problems.filter((p) => p.includes("deprecated"))).toEqual([]);
  });
});
