import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { UNIVERSAL_DENY, canWritePath } from "../agents/pathPermissions.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { RESERVED_DIRS, writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import type { KnowledgeItem, KnowledgeItemOf, RequirementPayload } from "../knowledge/knowledgeModel.js";
import { SAMPLE_NOW, sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { USAGE, parseArgs, runCli } from "../cli.js";
import {
  AcknowledgementError,
  PROJECT_WIDE_DIR,
  ROLES_DIRNAME,
  type RoleWorkspace,
  RoleWorkspaceError,
  acknowledge,
  checkRoleWorkspaces,
  dependenciesOf,
  emptyWorkspace,
  laneView,
  listRoleWorkspaceFiles,
  loadRoleWorkspace,
  readRoleWorkspaceFile,
  relativePathForWorkspace,
  renderRoleWorkspace,
  roleWorkspacePath,
  writeRoleWorkspace,
} from "./roleWorkspace.js";

const NOW = "2026-08-21T10:00:00Z";
const LATER = "2026-08-21T18:00:00Z";

const roots: string[] = [];

/** A temp project with `items` written under knowledge/, plus whatever extra raw files are named. */
function project(items: KnowledgeItem[] = sampleKnowledge(), extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-workspace-"));
  roots.push(root);
  for (const item of items) writeKnowledgeItem(item, root, { force: true });
  for (const [rel, content] of Object.entries(extra)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

function bumped(id: string, items: KnowledgeItem[] = sampleKnowledge()): KnowledgeItem[] {
  return items.map((i) => (i.id === id ? { ...i, version: i.version + 1, updated_at: LATER } : i));
}

afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* left for the OS */
    }
  }
});

describe("relativePathForWorkspace (T99)", () => {
  it("puts a project-wide lane under _project/, the same convention items use", () => {
    expect(relativePathForWorkspace("ba", null)).toBe(`${ROLES_DIRNAME}/${PROJECT_WIDE_DIR}/ba.yaml`);
    expect(relativePathForWorkspace("dev", "sales-crm")).toBe(`${ROLES_DIRNAME}/sales-crm/dev.yaml`);
  });

  it("is a reserved directory, so the knowledge item walk skips it", () => {
    expect(RESERVED_DIRS).toContain(ROLES_DIRNAME);
  });
});

describe("dependenciesOf", () => {
  const kb = new KnowledgeBase(sampleKnowledge());

  it("is what this lane's own items point at, in another lane", () => {
    // BE-014 implements DES-003 and API-shifts.list, both owned by system-analyst.
    expect(dependenciesOf("dev", "sales-crm", kb)).toEqual(["API-shifts.list", "DES-003"]);
  });

  it("excludes same-lane relations — a lane does not acknowledge its own work", () => {
    // FE-020 depends-on BE-014, both in the dev lane.
    expect(dependenciesOf("dev", "sales-crm", kb)).not.toContain("BE-014");
    // RULE-007 refines REQ-003, both owned by business-analyst.
    expect(dependenciesOf("ba", "sales-crm", kb)).toEqual([]);
  });

  it("excludes a human-owned item, which belongs to no lane", () => {
    // ADR-003 constrains DES-003, but the ADR is the item pointing outward, not DES-003.
    expect(dependenciesOf("sa", "sales-crm", kb)).toEqual(["REQ-003"]);
  });

  it("ignores a relation whose target does not exist rather than inventing a dependency", () => {
    const items = sampleKnowledge().map((i) =>
      i.id === "BE-014" ? { ...i, relations: [{ type: "implements" as const, to: "API-nope" }] } : i,
    );
    expect(dependenciesOf("dev", "sales-crm", new KnowledgeBase(items))).toEqual(["DES-003"]);
  });
});

describe("laneView", () => {
  const kb = new KnowledgeBase(sampleKnowledge());

  /**
   * The trap this whole design exists to avoid: a lane that has acknowledged
   * nothing has two real dependencies it has never looked at, and reporting
   * that as "idle" would hide every change that ever mattered to it.
   */
  it("reports an empty watermark as behind, not idle", () => {
    const view = laneView(emptyWorkspace("dev", "sales-crm", NOW), kb);
    expect(view.unseen).toEqual(["API-shifts.list", "DES-003"]);
    expect(view.stale).toEqual([]);
    expect(view.status).toBe("behind");
  });

  it("goes quiet once everything it depends on is acknowledged", () => {
    const ws = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["API-shifts.list", "DES-003"], "Jaturapat", NOW);
    const view = laneView(ws, kb);
    expect(view.unseen).toEqual([]);
    expect(view.stale).toEqual([]);
    expect(view.status).toBe("up-to-date");
    // Its own open work is still reported as data — `status` only ever answers the
    // dependency question, so `roleWorkflow.ts`'s `stage` can own the other one.
    expect(view.active).toEqual(["BE-014", "FE-020"]);
  });

  /** The V1.5 case in one test: SA amends the design while DEV is mid-task. */
  it("reports a dependency that moved while the lane was working", () => {
    const ws = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["API-shifts.list", "DES-003"], "Jaturapat", NOW);
    const after = new KnowledgeBase(bumped("DES-003"));

    const view = laneView(ws, after);
    expect(view.stale).toEqual([
      { id: "DES-003", version: 1, at: NOW, by: "Jaturapat", currentVersion: 2, reason: "behind" },
    ]);
    expect(view.status).toBe("behind");
  });

  /**
   * Acknowledging late is not the same as never acknowledging: the lane catches
   * up to whatever the current version is, and the report goes quiet — it does
   * not stay stuck at the version that was current when the change landed.
   */
  it("catches up when the lane acknowledges after the change", () => {
    const after = new KnowledgeBase(bumped("DES-003"));
    const ws = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), after, ["DES-003"], "Jaturapat", LATER);

    expect(ws.seen.find((r) => r.id === "DES-003")?.version).toBe(2);
    expect(laneView(ws, after).stale).toEqual([]);
  });

  it("lists what only a person can move on, without folding it into the verdict", () => {
    const items = sampleKnowledge().map((i) => (i.id === "RULE-007" ? { ...i, status: "reviewed" as const } : i));
    const view = laneView(emptyWorkspace("ba", "sales-crm", NOW), new KnowledgeBase(items));
    expect(view.awaitingApproval).toEqual(["RULE-007"]);
    // BA has no cross-lane dependencies, so nothing it relies on can be behind.
    expect(view.status).toBe("up-to-date");
  });

  it("says behind even while its own work is waiting on a person", () => {
    const items = bumped("REQ-003").map((i) => (i.id === "DES-003" ? { ...i, status: "reviewed" as const } : i));
    const after = new KnowledgeBase(items);
    const ws = acknowledge(emptyWorkspace("sa", "sales-crm", NOW), new KnowledgeBase(sampleKnowledge()), ["REQ-003"], "Nan", NOW);

    const view = laneView(ws, after);
    expect(view.awaitingApproval).toEqual(["DES-003"]);
    expect(view.status).toBe("behind");
  });

  it("is up-to-date when a lane has no dependencies at all", () => {
    // BA's items point only at each other, so there is nothing for it to fall behind on.
    expect(laneView(emptyWorkspace("ba", "sales-crm", NOW), kb).status).toBe("up-to-date");
  });

  it("reports an acknowledgement that is no longer a dependency, without removing it", () => {
    const ws = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["DES-003", "REQ-003"], "Jaturapat", NOW);
    const view = laneView(ws, kb);
    // REQ-003 is not something a dev-lane item points at.
    expect(view.orphanedSeen).toEqual(["REQ-003"]);
    expect(ws.seen.map((r) => r.id)).toContain("REQ-003");
  });

  /** Reading must never mark anything read — see the module header. */
  it("does not touch the watermark", () => {
    const before = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["DES-003"], "Jaturapat", NOW);
    const snapshot = JSON.stringify(before);
    laneView(before, new KnowledgeBase(bumped("DES-003")));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("acknowledge", () => {
  const kb = new KnowledgeBase(sampleKnowledge());
  const base = emptyWorkspace("dev", "sales-crm", NOW);

  it("refuses an acknowledgement with nobody attached", () => {
    expect(() => acknowledge(base, kb, ["DES-003"], "   ", NOW)).toThrow(AcknowledgementError);
    expect(() => acknowledge(base, kb, ["DES-003"], "", NOW)).toThrow(/name of the person/);
  });

  it("refuses an empty list rather than recording a person doing nothing", () => {
    expect(() => acknowledge(base, kb, [], "Jaturapat", NOW)).toThrow(/nothing to acknowledge/);
  });

  it("refuses an id no knowledge item has", () => {
    expect(() => acknowledge(base, kb, ["REQ-999"], "Jaturapat", NOW)).toThrow(/REQ-999/);
  });

  it("takes the version from the knowledge base, not from the caller", () => {
    const ws = acknowledge(base, new KnowledgeBase(bumped("DES-003")), ["DES-003"], "Jaturapat", NOW);
    expect(ws.seen).toEqual([{ id: "DES-003", version: 2, at: NOW, by: "Jaturapat" }]);
  });

  it("replaces an existing entry instead of appending a second one", () => {
    const once = acknowledge(base, kb, ["DES-003"], "Jaturapat", NOW);
    const twice = acknowledge(once, new KnowledgeBase(bumped("DES-003")), ["DES-003"], "Nan", LATER);
    expect(twice.seen).toEqual([{ id: "DES-003", version: 2, at: LATER, by: "Nan" }]);
  });

  it("keeps seen sorted by id, so two people's diffs merge", () => {
    const ws = acknowledge(base, kb, ["DES-003", "API-shifts.list"], "Jaturapat", NOW);
    expect(ws.seen.map((r) => r.id)).toEqual(["API-shifts.list", "DES-003"]);
  });

  it("does not mutate the workspace it was given", () => {
    acknowledge(base, kb, ["DES-003"], "Jaturapat", NOW);
    expect(base.seen).toEqual([]);
    expect(base.updated_at).toBe(NOW);
  });
});

describe("the store", () => {
  it("round-trips through YAML", () => {
    const root = project();
    const kb = KnowledgeBase.load(root);
    const ws = acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["DES-003"], "Jaturapat", NOW);

    writeRoleWorkspace(ws, root);
    expect(loadRoleWorkspace("dev", "sales-crm", root)).toEqual(ws);
    expect(fs.existsSync(roleWorkspacePath("dev", "sales-crm", root))).toBe(true);
  });

  it("treats a missing file and an empty lane as the same thing", () => {
    const root = project();
    expect(loadRoleWorkspace("ba", "sales-crm", root, NOW)).toEqual(emptyWorkspace("ba", "sales-crm", NOW));
  });

  it("writes a project-wide lane under _project/", () => {
    const root = project();
    writeRoleWorkspace(emptyWorkspace("sa", null, NOW), root);
    expect(listRoleWorkspaceFiles(root)).toEqual([`${ROLES_DIRNAME}/${PROJECT_WIDE_DIR}/sa.yaml`]);
    expect(loadRoleWorkspace("sa", null, root).module).toBeNull();
  });

  it("reads one named file, and says which file when it cannot", () => {
    const root = project();
    expect(() => readRoleWorkspaceFile(roleWorkspacePath("dev", "sales-crm", root))).toThrow(/no file at/);
  });

  it("refuses a file that acknowledges one item twice", () => {
    const root = project([], {
      [`knowledge/${ROLES_DIRNAME}/sales-crm/dev.yaml`]: renderRoleWorkspace({
        schema_version: 1,
        lane: "dev",
        module: "sales-crm",
        seen: [
          { id: "DES-003", version: 1, at: NOW, by: "Jaturapat" },
          { id: "DES-003", version: 2, at: LATER, by: "Nan" },
        ],
        updated_at: LATER,
      }),
    });
    expect(() => loadRoleWorkspace("dev", "sales-crm", root)).toThrow(/more than once/);
  });

  it("names an unresolved merge as a merge, not as a YAML typo", () => {
    const root = project([], {
      [`knowledge/${ROLES_DIRNAME}/sales-crm/dev.yaml`]: "lane: dev\n<<<<<<< HEAD\nmodule: a\n=======\nmodule: b\n>>>>>>> x\n",
    });
    expect(() => loadRoleWorkspace("dev", "sales-crm", root)).toThrow(/conflict marker/);
  });

  it("rejects an unknown field rather than silently dropping it", () => {
    const root = project([], {
      [`knowledge/${ROLES_DIRNAME}/sales-crm/dev.yaml`]:
        "schema_version: 1\nlane: dev\nmodule: sales-crm\nseen: []\nupdated_at: 2026-08-21T10:00:00Z\napprovals: []\n",
    });
    // `approvals` is T103's field and does not exist yet — a slot that validated
    // nothing would look enforced and would not be.
    expect(() => loadRoleWorkspace("dev", "sales-crm", root)).toThrow(/approvals/);
  });

  it("rejects an acknowledgement with no name in it, at the schema level too", () => {
    const root = project([], {
      [`knowledge/${ROLES_DIRNAME}/sales-crm/dev.yaml`]:
        "schema_version: 1\nlane: dev\nmodule: sales-crm\nupdated_at: 2026-08-21T10:00:00Z\n" +
        'seen:\n  - id: DES-003\n    version: 1\n    at: 2026-08-21T10:00:00Z\n    by: ""\n',
    });
    expect(() => loadRoleWorkspace("dev", "sales-crm", root)).toThrow(RoleWorkspaceError);
  });
});

describe("checkRoleWorkspaces", () => {
  it("reports no _roles/ as a note, not a problem", () => {
    const result = checkRoleWorkspaces(project());
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toMatch(/no role workspace has been opened yet/);
  });

  it("passes a lane that is fully caught up", () => {
    const root = project();
    const kb = KnowledgeBase.load(root);
    writeRoleWorkspace(
      acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["API-shifts.list", "DES-003"], "Jaturapat", NOW),
      root,
    );
    const result = checkRoleWorkspaces(root);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports a behind lane as a note — being told is the check working", () => {
    const root = project(bumped("DES-003"));
    const before = new KnowledgeBase(sampleKnowledge());
    writeRoleWorkspace(acknowledge(emptyWorkspace("dev", "sales-crm", NOW), before, ["DES-003"], "Jaturapat", NOW), root);

    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toMatch(/DEV on sales-crm is behind: 1 changed, 1 never acknowledged/);
  });

  it("fails a watermark pointing at an item that no longer exists", () => {
    const root = project(sampleKnowledge().filter((i) => i.id !== "DES-003"));
    fs.mkdirSync(path.join(root, "knowledge", ROLES_DIRNAME, "sales-crm"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "knowledge", ROLES_DIRNAME, "sales-crm", "dev.yaml"),
      renderRoleWorkspace({
        schema_version: 1,
        lane: "dev",
        module: "sales-crm",
        seen: [{ id: "DES-003", version: 1, at: NOW, by: "Jaturapat" }],
        updated_at: NOW,
      }),
      "utf8",
    );

    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/acknowledges DES-003, which no longer exists/);
  });

  it("fails a watermark claiming a version the item never reached", () => {
    const root = project();
    writeRoleWorkspace(
      {
        schema_version: 1,
        lane: "dev",
        module: "sales-crm",
        seen: [{ id: "DES-003", version: 9, at: NOW, by: "Jaturapat" }],
        updated_at: NOW,
      },
      root,
    );
    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/only reached v1 — the two are not talking about the same item/);
  });

  it("fails a file whose contents disagree with its own path", () => {
    const root = project([], {
      // A dev-lane file sitting where the ba lane's file belongs.
      [`knowledge/${ROLES_DIRNAME}/sales-crm/ba.yaml`]: renderRoleWorkspace(emptyWorkspace("dev", "sales-crm", NOW)),
    });
    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/belongs at knowledge\/_roles\/sales-crm\/dev\.yaml/);
  });

  it("fails a file that is not one of the three lanes", () => {
    const root = project([], {
      [`knowledge/${ROLES_DIRNAME}/sales-crm/pm.yaml`]: renderRoleWorkspace(emptyWorkspace("sa", "sales-crm", NOW)),
    });
    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/"pm\.yaml" is not one of ba\.yaml, sa\.yaml, uxui\.yaml, dev\.yaml/);
  });

  it("fails a loose file sitting directly under _roles/", () => {
    const root = project([], { [`knowledge/${ROLES_DIRNAME}/notes.md`]: "stray\n" });
    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/belongs to no lane/);
  });

  /**
   * Two ways to reach this, and the note must not assume the wrong one: a
   * leftover acknowledgement, or a handoff the lane accepted before writing
   * anything that cites it — which is the normal state right after `roles ack`.
   */
  it("reports an acknowledgement nothing points at, without telling anyone to delete it", () => {
    const root = project();
    const kb = KnowledgeBase.load(root);
    writeRoleWorkspace(acknowledge(emptyWorkspace("dev", "sales-crm", NOW), kb, ["REQ-003"], "Jaturapat", NOW), root);

    const result = checkRoleWorkspaces(root);
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toMatch(/acknowledges REQ-003, which nothing this lane owns points at/);
    expect(result.notes.join(" ")).not.toMatch(/safe to drop/);
  });

  it("passes against this repo", () => {
    expect(checkRoleWorkspaces(defaultProjectRoot()).ok).toBe(true);
  });
});

describe("no agent may write a role workspace", () => {
  /**
   * The floor, not a per-contract rule: an agent that could write one of these
   * could mark a change acknowledged on a person's behalf, which is exactly what
   * V1.5's human-in-the-loop design forbids.
   */
  it("is in UNIVERSAL_DENY", () => {
    expect(UNIVERSAL_DENY).toContain("knowledge/_roles/**");
  });

  it("is denied even to a role whose contract allows all of knowledge/", () => {
    const decision = canWritePath(
      { write: ["knowledge/**"], deny: [], read: [] },
      "knowledge/_roles/sales-crm/ba.yaml",
    );
    expect(decision).toMatchObject({ allowed: false, rule: "universal-deny" });
  });

  it("still lets an agent write an ordinary knowledge item", () => {
    const decision = canWritePath(
      { write: ["knowledge/**"], deny: [], read: [] },
      "knowledge/sales-crm/requirement/REQ-003.yaml",
    );
    expect(decision.allowed).toBe(true);
  });

  it("mirrors the hook's copy of the list", () => {
    const hook = fs.readFileSync(
      path.join(defaultProjectRoot(), ".claude", "hooks", "block-path-permissions.js"),
      "utf8",
    );
    for (const pattern of UNIVERSAL_DENY) expect(hook).toContain(`'${pattern}'`);
  });
});

describe("runCli --check-roles (T99)", () => {
  it("reports a clean project and exits 0", async () => {
    const root = project();
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      expect(await runCli(["--check-roles", "--project-root", root], root)).toBe(0);
    } finally {
      console.log = realLog;
    }
    expect(logged.join("\n")).toMatch(/every role workspace agrees with knowledge\//);
  });

  it("exits 1 and names the problem", async () => {
    const root = project([], { [`knowledge/${ROLES_DIRNAME}/sales-crm/pm.yaml`]: "schema_version: 1\n" });
    const errored: string[] = [];
    const realError = console.error;
    const realLog = console.log;
    console.error = (...args: unknown[]) => void errored.push(args.join(" "));
    console.log = () => {};
    try {
      expect(await runCli(["--check-roles", "--project-root", root], root)).toBe(1);
    } finally {
      console.error = realError;
      console.log = realLog;
    }
    expect(errored.join("\n")).toMatch(/is not one of ba\.yaml/);
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-roles"], "/repo").checkRoles).toBe(true);
    expect(USAGE).toContain("--check-roles");
  });
});

/** Captures stdout/stderr around one runCli call, so a verb's output can be asserted. */
async function capture(argv: string[], root: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await runCli(argv, root);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

describe("the roles verb (T99)", () => {
  it("is the only writer of a role workspace, and writes one", async () => {
    const root = project();
    const result = await capture(
      ["roles", "ack", "dev", "DES-003,API-shifts.list", "--by", "Jaturapat", "--module", "sales-crm", "--project-root", root],
      root,
    );
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/DEV on sales-crm: Jaturapat acknowledged/);

    const saved = loadRoleWorkspace("dev", "sales-crm", root);
    expect(saved.seen.map((r) => r.id)).toEqual(["API-shifts.list", "DES-003"]);
    expect(saved.seen.every((r) => r.by === "Jaturapat")).toBe(true);
  });

  it("refuses to acknowledge without --by", async () => {
    const root = project();
    await expect(capture(["roles", "ack", "dev", "DES-003", "--project-root", root], root)).rejects.toThrow(/--by/);
  });

  it("refuses a lane that is not one of the three", async () => {
    const root = project();
    await expect(capture(["roles", "ack", "pm", "DES-003", "--by", "X", "--project-root", root], root)).rejects.toThrow(
      /one of ba, sa, uxui, dev/,
    );
  });

  it("refuses an unknown sub-command instead of guessing", async () => {
    const root = project();
    await expect(capture(["roles", "handover", "--project-root", root], root)).rejects.toThrow(/unknown sub-command/);
  });

  it("exits 1 with the reason when the id does not exist, rather than writing a broken watermark", async () => {
    const root = project();
    const result = await capture(["roles", "ack", "dev", "REQ-999", "--by", "X", "--project-root", root], root);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/REQ-999/);
    expect(fs.existsSync(roleWorkspacePath("dev", "sales-crm", root))).toBe(false);
  });

  it("shows every lane of every module when --module is omitted", async () => {
    const root = project();
    const result = await capture(["roles", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toContain("sales-crm");
    expect(result.out).toContain("(project-wide)");
    expect(result.out).toMatch(/DEV\s+drafting\s+deps: behind/);
    expect(result.out).toMatch(/never acknowledged: API-shifts\.list, DES-003/);
  });

  /** T100: the lane's own stage and its next action print alongside T99's watermark status. */
  it("prints the BA lane's stage and next action", async () => {
    const root = project();
    const result = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    expect(result.out).toMatch(/BA\s+drafting/);
    expect(result.out).toMatch(/next \(agent\): RULE-007 are draft/);
  });

  it("prints a stage and a next action for all three lanes", async () => {
    const root = project();
    const result = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    for (const lane of ["BA", "SA", "DEV"]) {
      expect(result.out).toMatch(new RegExp(`${lane}\\s+\\w`));
    }
    expect(result.out.match(/next \(/g)).toHaveLength(4);
    expect(result.out).not.toMatch(/no lane workflow defined/);
  });

  it("goes quiet for a lane that has caught up", async () => {
    const root = project();
    await capture(
      ["roles", "ack", "dev", "DES-003", "API-shifts.list", "--by", "Jaturapat", "--module", "sales-crm", "--project-root", root],
      root,
    );
    const result = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    // DEV is the last lane printed, so everything after its heading is its own detail.
    const devSection = result.out.slice(result.out.indexOf("DEV"));
    expect(devSection).toMatch(/deps: up-to-date/);
    expect(devSection).not.toMatch(/never acknowledged/);
    // SA is still behind, and that must keep showing — catching one lane up is not catching all of them up.
    expect(result.out).toMatch(/SA.*deps: behind/);
  });

  it("says so rather than printing an empty table when there is no knowledge at all", async () => {
    const root = project([]);
    const result = await capture(["roles", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/no knowledge captured yet/);
  });

  it("is listed in the usage text", () => {
    expect(USAGE).toContain("orchestrate roles");
    expect(USAGE).toContain("roles ack");
  });
});

describe("the roles sub-commands for T103-T107", () => {
  /** Walks the BA lane the way a person would, and checks each gate refuses to be skipped. */
  it("runs a whole lane from review to signed-off handoff", async () => {
    const root = project();

    // RULE-007 is draft. Approving it before review is refused by T65.
    const early = await capture(["roles", "approve", "RULE-007", "--by", "Jaturapat", "--project-root", root], root);
    expect(early.code).toBe(1);
    expect(early.err).toMatch(/cannot go draft -> approved/);

    const reviewed = await capture(["roles", "review", "RULE-007", "--as", "system-analyst", "--project-root", root], root);
    expect(reviewed.code).toBe(0);
    // The checklist is what makes "reviewed" mean the same thing twice.
    expect(reviewed.out).toMatch(/It confirmed:/);
    expect(reviewed.out).toMatch(/enforcement` says where it is actually held/);

    expect((await capture(["roles", "approve", "RULE-007", "--by", "Jaturapat", "--project-root", root], root)).code).toBe(0);

    // Everything approved, but the lane gate is still shut.
    const beforeSignoff = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    expect(beforeSignoff.out).toMatch(/BA\s+awaiting-signoff/);

    const signoff = await capture(["roles", "signoff", "ba", "--by", "Jaturapat", "--module", "sales-crm", "--project-root", root], root);
    expect(signoff.code).toBe(0);
    expect(signoff.out).toMatch(/BA on sales-crm: Jaturapat signed off REQ-003, RULE-007/);

    const after = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    expect(after.out).toMatch(/BA\s+ready/);
    expect(after.out).toMatch(/sta roles ack sa REQ-003,RULE-007/);
  });

  it("refuses a review by the owner, and by a role that cannot see the kind", async () => {
    const root = project();
    const byOwner = await capture(["roles", "review", "RULE-007", "--as", "business-analyst", "--project-root", root], root);
    expect(byOwner.code).toBe(1);
    expect(byOwner.err).toMatch(/owns RULE-007 and cannot review it/);

    const blind = await capture(["roles", "review", "RULE-007", "--as", "devops", "--project-root", root], root);
    expect(blind.code).toBe(1);
    expect(blind.err).toMatch(/does not see business-rule items/);
  });

  it("refuses a sign-off with no name, and one over a standing blocker", async () => {
    const root = project();
    await expect(
      capture(["roles", "signoff", "ba", "--module", "sales-crm", "--project-root", root], root),
    ).rejects.toThrow(/--by <name> is required/);

    // Approve REQ-003's sibling and strip REQ-003's acceptance criteria: a blocker.
    const kb = KnowledgeBase.load(root);
    const req = kb.get("REQ-003") as KnowledgeItemOf<"requirement">;
    writeKnowledgeItem(
      { ...req, version: req.version + 1, payload: { ...(req.payload as RequirementPayload), acceptance_criteria: [] } },
      root,
    );
    const rule = kb.get("RULE-007") as KnowledgeItem;
    writeKnowledgeItem({ ...rule, status: "approved", version: rule.version + 1 }, root);

    const blocked = await capture(["roles", "signoff", "ba", "--by", "X", "--module", "sales-crm", "--project-root", root], root);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toMatch(/cannot be signed off while these stand/);
    expect(blocked.err).toMatch(/no acceptance criteria/);
  });

  it("records a rejection as an answer that stops the lane", async () => {
    const root = project();
    const kb = KnowledgeBase.load(root);
    const rule = kb.get("RULE-007") as KnowledgeItem;
    writeKnowledgeItem({ ...rule, status: "approved", version: rule.version + 1 }, root);

    const rejected = await capture(
      ["roles", "signoff", "ba", "--reject", "--by", "Nan", "--note", "scope is too wide", "--module", "sales-crm", "--project-root", root],
      root,
    );
    expect(rejected.code).toBe(0);
    expect(rejected.out).toMatch(/Nan rejected/);

    const after = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    expect(after.out).toMatch(/BA\s+rejected/);
    expect(after.out).toMatch(/scope is too wide/);
    expect(after.out).toMatch(/a rejection is an answer, not an absence/);
  });

  it("shows an inbox per lane, and every lane is asked", async () => {
    const root = project();
    const result = await capture(["roles", "inbox", "--module", "sales-crm", "--project-root", root], root);
    expect(result.code).toBe(0);
    for (const lane of ["BA", "SA", "DEV"]) expect(result.out).toContain(`${lane} — `);
    expect(result.out).toMatch(/\[never-acknowledged\] DEV depends on DES-003/);
  });

  it("answers what changing an item would reach, before it is changed", async () => {
    const root = project();
    const result = await capture(["roles", "impact", "REQ-003", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/BA\s+REQ-003/);
    expect(result.out).toMatch(/DEV\s+BE-014, FE-020/);
  });

  it("exits 1 on an impact query for an id that does not exist", async () => {
    const root = project();
    const result = await capture(["roles", "impact", "REQ-999", "--project-root", root], root);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/REQ-999/);
  });

  it("shows a lane its context, naming the role each item came through", async () => {
    const root = project();
    const result = await capture(["roles", "context", "dev", "--module", "sales-crm", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/the DEV lane sees \d+ item\(s\)/);
    expect(result.out).toMatch(/RULE-007\s+business-rule\s+via /);
  });

  /** Withheld is not an error: the lane asked a fair question and the answer is "not for you". */
  it("says withheld and exits 0, distinctly from an id that does not exist", async () => {
    const root = project();
    const withheld = await capture(["roles", "context", "ba", "BE-014", "--project-root", root], root);
    expect(withheld.code).toBe(0);
    expect(withheld.out).toMatch(/BE-014: withheld — no role in the BA lane sees task items/);

    const missing = await capture(["roles", "context", "ba", "REQ-999", "--project-root", root], root);
    expect(missing.code).toBe(1);
  });

  it("lists every sub-command in the usage text", () => {
    for (const sub of ["roles ack", "roles signoff", "roles review", "roles approve", "roles inbox", "roles impact", "roles context"]) {
      expect(USAGE).toContain(sub);
    }
  });
});

describe("SAMPLE_NOW stays the fixture's clock", () => {
  it("is not today", () => {
    // Guards against a fixture edit that quietly made these tests time-dependent.
    expect(SAMPLE_NOW).toBe("2026-08-20T09:00:00Z");
  });
});
