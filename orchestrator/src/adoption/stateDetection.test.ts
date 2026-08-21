import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { newPersistedTask } from "../store/taskStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { detectExistingState } from "./stateDetection.js";

const roots: string[] = [];

function project(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-detect-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) {
    // Tolerant on purpose: one test hands `detectExistingState` a file that is
    // not a database, and better-sqlite3 opens the handle before it discovers
    // that — so on Windows the temp file can still be locked here. The lock is
    // a test-teardown problem, not something the detection does wrong.
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* left for the OS to clean up */
    }
  }
});

/** A real store with one task in it, at the state the test names. */
function withTask(root: string, taskId: string, current: TaskState): void {
  const dbPath = defaultStateDbPath(root);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new SqliteTaskStore(dbPath);
  const sequence = [TaskState.CREATED, TaskState.IMPLEMENTATION, TaskState.QA, TaskState.DEPLOYED];
  const task = newPersistedTask({
    taskId,
    now: 1,
    classification: {
      level: TaskLevel.MEDIUM,
      pipeline: [AgentStage.BACKEND_ENGINEER],
      requiresHumanApproval: false,
      sensitiveGate: false,
      reasons: [],
    },
    machine: {
      pipeline: [AgentStage.BACKEND_ENGINEER],
      requiresHumanApproval: false,
      sequence,
      current,
      history: [TaskState.CREATED],
    },
  });
  store.createTask(task);
  store.close();
}

describe("detectExistingState — the orchestrator's own state", () => {
  it("says there is nothing to collide with when the project never ran this framework", () => {
    const detected = detectExistingState(project());

    expect(detected.blockers).toEqual([]);
    expect(detected.notes.some((n) => n.includes("no `.workflow/state.db`"))).toBe(true);
  });

  it("blocks on a task that is part-way through the pipeline", () => {
    const root = project();
    withTask(root, "orders-1", TaskState.QA);

    const detected = detectExistingState(root);

    expect(detected.blockers).toEqual([expect.stringContaining('task "orders-1" is at QA')]);
  });

  it("does not block on a task that already shipped", () => {
    const root = project();
    withTask(root, "orders-1", TaskState.DEPLOYED);

    const detected = detectExistingState(root);

    expect(detected.blockers).toEqual([]);
    expect(detected.notes.some((n) => n.includes("none of them open"))).toBe(true);
  });

  it("blocks when the store exists but cannot be read, rather than assuming it is empty", () => {
    const root = project();
    const dbPath = defaultStateDbPath(root);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "this is not a database", "utf8");

    const detected = detectExistingState(root);

    expect(detected.blockers).toEqual([expect.stringContaining("could not be read")]);
  });
});

describe("detectExistingState — the legacy documents", () => {
  it("blocks on a plan task somebody is working on right now", () => {
    const root = project({
      "_docs/module/m/plan.md":
        "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | in_progress | backend-engineer | — |\n| BE-002 — b | verified | backend-engineer | — |\n",
    });

    const detected = detectExistingState(root);

    expect(detected.blockers).toEqual([expect.stringContaining("1 task(s) marked in_progress: BE-001 — a")]);
  });

  it("finds in_progress tasks across every phase, not just the first table", () => {
    const root = project({
      "_docs/module/m/plan.md":
        "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | verified | be | — |\n\n" +
        "## Phase 2: y\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-002 — b | in_progress | be | — |\n",
    });

    expect(detectExistingState(root).blockers[0]).toContain("BE-002 — b");
  });

  it("blocks on open QA issues, counting table rows and not prose", () => {
    const withIssues = project({
      "_docs/module/m/review.md":
        "# Review\n\n## Open Issues — all phases\n| Issue | Routes to |\n|---|---|\n| total is wrong | backend-engineer |\n\n## Verification Summary\nx\n",
    });
    const withProse = project({
      "_docs/module/m/review.md": "# Review\n\n## Open Issues — all phases\nNone outstanding.\n\n## Verification Summary\nx\n",
    });

    expect(detectExistingState(withIssues).blockers).toEqual([expect.stringContaining("1 open QA issue(s)")]);
    expect(detectExistingState(withProse).blockers).toEqual([]);
  });

  it("blocks on a security finding still open or fix-claimed, because only `security` may close one", () => {
    const root = project({
      "_docs/module/m/security.md": "# Security\n\n## Open Findings\n| id | status |\n|---|---|\n| S-1 | 🔵 Open |\n| S-2 | 🟣 Fix claimed |\n",
    });

    expect(detectExistingState(root).blockers).toEqual([expect.stringContaining("2 finding(s) still open or fix-claimed")]);
  });

  it("does not block on findings that are all closed or accepted", () => {
    const root = project({
      "_docs/module/m/security.md": "# Security\n\n## Open Findings\n| id | status |\n|---|---|\n| S-1 | ✅ Fixed |\n| S-2 | ⚪ Accepted |\n",
    });

    expect(detectExistingState(root).blockers).toEqual([]);
  });

  it("reports what it checked and found clean, so an empty blocker list is not mistaken for a check that never ran", () => {
    const root = project({
      "_docs/module/m/plan.md": "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | verified | be | — |\n",
      "_docs/module/m/review.md": "## Open Issues\nNone.\n",
      "_docs/module/m/security.md": "## Summary\nClean.\n",
    });

    const detected = detectExistingState(root);

    expect(detected.blockers).toEqual([]);
    expect(detected.notes).toEqual([
      expect.stringContaining("no `.workflow/state.db`"),
      "m/plan.md has no in_progress task",
      "m/review.md lists no open QA issue",
      "m/security.md has no open or fix-claimed finding",
    ]);
  });

  it("checks every module, not just the first", () => {
    const root = project({
      "_docs/module/a/plan.md": "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | in_progress | be | — |\n",
      "_docs/module/b/plan.md": "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| FE-001 — b | in_progress | fe | — |\n",
    });

    expect(detectExistingState(root).blockers).toHaveLength(2);
  });

  it("checks a nested docsRoot, and does not see the same module docs at the default one (T113 pilot finding)", () => {
    const root = project({
      "_docs/hkt/module/crm/plan.md":
        "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | in_progress | be | — |\n",
    });

    const nested = detectExistingState(root, path.join(root, "_docs", "hkt"));
    const atDefault = detectExistingState(root);

    expect(nested.blockers).toHaveLength(1);
    expect(atDefault.blockers).toEqual([]);
  });
});
