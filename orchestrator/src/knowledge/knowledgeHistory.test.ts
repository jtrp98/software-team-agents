import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "./knowledgeModel.js";
import { writeKnowledgeItem } from "./knowledgeStore.js";
import { diffItems, historyOf, isGitRepo, staleReferences } from "./knowledgeHistory.js";

const NOW = "2026-08-20T09:00:00Z";

function requirement(overrides: Partial<KnowledgeItemOf<"requirement">> = {}): KnowledgeItemOf<"requirement"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: "REQ-003",
    kind: "requirement",
    title: "staff see their own shifts",
    body: "",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [{ type: "human", locator: "คุณเอ", captured_at: NOW, digest: null }],
    relations: [],
    payload: { acceptance_criteria: ["own shifts only"], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
    ...overrides,
  };
}

describe("diffItems", () => {
  it("reports nothing for two identical items", () => {
    expect(diffItems(requirement(), requirement())).toEqual([]);
  });

  it("names each changed envelope field, with both values", () => {
    const changes = diffItems(requirement(), requirement({ title: "changed", version: 2 }));
    expect(changes).toEqual([
      { field: "title", from: "staff see their own shifts", to: "changed" },
      { field: "version", from: "1", to: "2" },
    ]);
  });

  it("compares the payload key by key — 'payload changed' tells a reviewer nothing", () => {
    const after = requirement({
      payload: { acceptance_criteria: ["own shifts only", "30 days back"], actors: ["staff"], priority: "should", assumption_unconfirmed: false },
    });
    expect(diffItems(requirement(), after).map((c) => c.field)).toEqual([
      "payload.acceptance_criteria",
      "payload.priority",
    ]);
  });

  it("catches a relation added and a relation removed", () => {
    const after = requirement({ relations: [{ type: "references", to: "DOM-001" }] });
    expect(diffItems(requirement(), after)[0].field).toBe("relations");
    expect(diffItems(after, requirement())[0].to).toBe("[]");
  });
});

describe("staleReferences (the T18 idea, applied to knowledge)", () => {
  const items = [requirement({ version: 4 })];

  it("says nothing when the reference matches", () => {
    expect(staleReferences([{ id: "REQ-003", version: 4 }], items)).toEqual([]);
  });

  it("flags a reference the item has moved past", () => {
    expect(staleReferences([{ id: "REQ-003", version: 2 }], items)).toEqual([
      { id: "REQ-003", version: 2, currentVersion: 4, reason: "behind" },
    ]);
  });

  it("flags a reference to an item that is not there", () => {
    expect(staleReferences([{ id: "REQ-999", version: 1 }], items)[0].reason).toBe("missing");
  });

  it("flags a reference claiming a version the item never reached, rather than reading it as fine", () => {
    expect(staleReferences([{ id: "REQ-003", version: 9 }], items)[0].reason).toBe("ahead");
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

describe("historyOf", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-history-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("says it cannot see the history when there is no repo — not that nothing ever changed", () => {
    writeKnowledgeItem(requirement(), root);
    const history = historyOf(requirement(), root);
    expect(history.available).toBe(false);
    expect(history.entries).toEqual([]);
    expect(history.reason).toContain("not a git repository");
    expect(isGitRepo(root)).toBe(false);
  });

  describe.skipIf(!gitAvailable())("in a git repository", () => {
    function run(args: string[]): void {
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    }
    function commit(message: string): void {
      run(["add", "-A"]);
      run(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message]);
    }

    beforeEach(() => {
      run(["init", "-q"]);
      fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
      commit("seed");
    });

    it("says the item has no history yet when its file is not committed", () => {
      writeKnowledgeItem(requirement(), root);
      const history = historyOf(requirement(), root);
      expect(history.available).toBe(false);
      expect(history.reason).toContain("no commits yet");
    });

    // `--follow` traces the path back past the point where it held a knowledge
    // item at all, which is routine during a legacy import. That could reach
    // `diffItems`, which reads `.payload` off it and would throw a TypeError
    // out of a function whose contract is to report a reason instead.
    it("reports a history rather than throwing when an earlier commit held something else at that path", () => {
      const target = path.join(root, "knowledge", "sales-crm", "requirement");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "REQ-003.yaml"), "some: text\nnot: a knowledge item\n", "utf8");
      commit("something else lived here");

      // `force` is how a migration seeds over legacy content: without it the
      // store refuses, because what is there cannot be read as an item at all.
      writeKnowledgeItem(requirement(), root, { force: true });
      commit("add REQ-003");

      const history = historyOf(requirement(), root);
      expect(history.available).toBe(true);
      expect(history.entries.map((e) => e.subject)).toEqual(["add REQ-003", "something else lived here"]);
      // The unusable revision counts as a commit with no readable version, and
      // nothing can be diffed against it.
      expect(history.entries.map((e) => e.version)).toEqual([1, null]);
      expect(history.entries[0].changes).toEqual([]);
    });

    it("reads the commits that touched the item, newest first, with the version each left behind", () => {
      writeKnowledgeItem(requirement(), root);
      commit("add REQ-003");
      writeKnowledgeItem(requirement({ title: "changed", version: 2, updated_at: "2026-08-21T09:00:00Z" }), root);
      commit("amend REQ-003 title");

      const history = historyOf(requirement(), root);
      expect(history.available).toBe(true);
      expect(history.entries.map((e) => e.subject)).toEqual(["amend REQ-003 title", "add REQ-003"]);
      expect(history.entries.map((e) => e.version)).toEqual([2, 1]);
      expect(history.entries[0].author).toBe("Test");
    });

    it("says what each commit changed, and leaves the first one empty because nothing preceded it", () => {
      writeKnowledgeItem(requirement(), root);
      commit("add REQ-003");
      writeKnowledgeItem(requirement({ title: "changed", version: 2, updated_at: "2026-08-21T09:00:00Z" }), root);
      commit("amend");

      const [newest, oldest] = historyOf(requirement(), root).entries;
      expect(newest.changes.map((c) => c.field).sort()).toEqual(["title", "updated_at", "version"]);
      expect(oldest.changes).toEqual([]);
    });

    it("honours maxEntries, because each entry costs a git show", () => {
      writeKnowledgeItem(requirement(), root);
      commit("v1");
      writeKnowledgeItem(requirement({ version: 2, title: "b", updated_at: "2026-08-21T09:00:00Z" }), root);
      commit("v2");
      writeKnowledgeItem(requirement({ version: 3, title: "c", updated_at: "2026-08-22T09:00:00Z" }), root);
      commit("v3");

      expect(historyOf(requirement(), root, { maxEntries: 2 }).entries).toHaveLength(2);
    });
  });
});
