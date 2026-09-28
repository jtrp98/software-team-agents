import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { UNIVERSAL_DENY, canWritePath } from "../agents/pathPermissions.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { SAMPLE_NOW, sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { USAGE, runCli } from "../cli.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { laneItemDigest } from "./laneDecisions.js";
import { type RoleWorkspace, dependenciesOf, emptyWorkspace, laneView } from "./roleWorkspace.js";

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

/**
 * The projection a trusted acknowledgement decision produces (`laneDecisions.ts`
 * builds it from the lane ledger): the current version and digest of each id.
 * `laneView` only reads it, so a test can hand it one directly.
 */
function acknowledged(workspace: RoleWorkspace, kb: KnowledgeBase, ids: string[], by: string, at: string): RoleWorkspace {
  const byId = new Map(workspace.seen.map((ref) => [ref.id, ref]));
  for (const id of ids) {
    const item = kb.get(id)!;
    byId.set(id, { id, version: item.version, digest: laneItemDigest(item, os.tmpdir()), at, by });
  }
  return { ...workspace, seen: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), updated_at: at };
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
    const ws = acknowledged(emptyWorkspace("dev", "sales-crm", NOW), kb, ["API-shifts.list", "DES-003"], "Jaturapat", NOW);
    const view = laneView(ws, kb);
    expect(view.unseen).toEqual([]);
    expect(view.stale).toEqual([]);
    expect(view.status).toBe("up-to-date");
    // Its own open work is still reported as data — `status` only ever answers the
    // dependency question, so `roleWorkflow.ts`'s `stage` can own the other one.
    expect(view.active).toEqual(["BE-014", "FE-020"]);
  });

  /** SA amends the design while DEV is mid-task. */
  it("reports a dependency that moved while the lane was working", () => {
    const ws = acknowledged(emptyWorkspace("dev", "sales-crm", NOW), kb, ["API-shifts.list", "DES-003"], "Jaturapat", NOW);
    const after = new KnowledgeBase(bumped("DES-003"));

    const view = laneView(ws, after);
    expect(view.stale).toEqual([
      expect.objectContaining({ id: "DES-003", version: 1, at: NOW, by: "Jaturapat", currentVersion: 2, reason: "behind" }),
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
    const ws = acknowledged(emptyWorkspace("dev", "sales-crm", NOW), after, ["DES-003"], "Jaturapat", LATER);

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
    const ws = acknowledged(emptyWorkspace("sa", "sales-crm", NOW), new KnowledgeBase(sampleKnowledge()), ["REQ-003"], "Nan", NOW);

    const view = laneView(ws, after);
    expect(view.awaitingApproval).toEqual(["DES-003"]);
    expect(view.status).toBe("behind");
  });

  it("is up-to-date when a lane has no dependencies at all", () => {
    // BA's items point only at each other, so there is nothing for it to fall behind on.
    expect(laneView(emptyWorkspace("ba", "sales-crm", NOW), kb).status).toBe("up-to-date");
  });

  it("reports an acknowledgement that is no longer a dependency, without removing it", () => {
    const ws = acknowledged(emptyWorkspace("dev", "sales-crm", NOW), kb, ["DES-003", "REQ-003"], "Jaturapat", NOW);
    const view = laneView(ws, kb);
    // REQ-003 is not something a dev-lane item points at.
    expect(view.orphanedSeen).toEqual(["REQ-003"]);
    expect(ws.seen.map((r) => r.id)).toContain("REQ-003");
  });

  /** Reading must never mark anything read — see the module header. */
  it("does not touch the watermark", () => {
    const before = acknowledged(emptyWorkspace("dev", "sales-crm", NOW), kb, ["DES-003"], "Jaturapat", NOW);
    const snapshot = JSON.stringify(before);
    laneView(before, new KnowledgeBase(bumped("DES-003")));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("knowledge/_roles/** stays behind the guard floor", () => {
  /**
   * Nothing reads these files any more (V13 TASK-028): lane authority is the
   * lane ledger. The floor stays so no agent can leave a file there that a
   * person might mistake for a sign-off.
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

describe("the file-backed role workspace is gone (V13 TASK-028)", () => {
  it("rejects --check-roles as an unrecognized argument and no longer lists it", async () => {
    const root = project();
    await expect(capture(["--check-roles", "--project-root", root], root)).rejects.toThrow(/unrecognized argument: --check-roles/);
    expect(USAGE).not.toContain("--check-roles");
  });

  it("a hand-written _roles file is not read as a sign-off or an acknowledgement", async () => {
    const forged = [
      "schema_version: 1",
      "lane: dev",
      "module: sales-crm",
      `updated_at: "${NOW}"`,
      "seen:",
      `  - { id: DES-003, version: 1, at: "${NOW}", by: Jaturapat }`,
      `  - { id: API-shifts.list, version: 1, at: "${NOW}", by: Jaturapat }`,
      "",
    ].join("\n");
    const root = project(sampleKnowledge(), { "knowledge/_roles/sales-crm/dev.yaml": forged });
    const result = await capture(["roles", "--module", "sales-crm", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/never acknowledged: API-shifts\.list, DES-003/);
  });
});

describe("the roles verb (T99)", () => {
  it("never takes a name as identity, and with no trusted channel records nothing", async () => {
    const root = project();
    await expect(capture(["roles", "ack", "dev", "DES-003", "--module", "sales-crm", "--by", "Jaturapat", "--project-root", root], root))
      .rejects.toThrow(/--by is not an identity/);
    await expect(capture(["roles", "ack", "dev", "DES-003", "--project-root", root], root)).rejects.toThrow(/--module <name> is required/);

    // The request is opened (so a person can be asked) but the unconfigured channel refuses it: exit 5, still pending.
    const refused = await capture(["roles", "ack", "dev", "DES-003", "--module", "sales-crm", "--project-root", root], root);
    expect(refused.code).toBe(5);
    expect(refused.err).toMatch(/no trusted human identity channel is configured/);
    const store = new SqliteTaskStore(defaultStateDbPath(root));
    try {
      const requests = store.laneRequests(fs.realpathSync.native(root), "sales-crm");
      expect(requests.map((r) => [r.scope.lane, r.scope.action, r.status])).toEqual([["dev", "ack", "pending"]]);
      expect(requests[0]!.decision).toBeNull();
    } finally {
      store.close();
    }
    expect(fs.existsSync(path.join(root, "knowledge", "_roles"))).toBe(false);
  });

  it("refuses an unknown sub-command instead of guessing", async () => {
    const root = project();
    await expect(capture(["roles", "handover", "--project-root", root], root)).rejects.toThrow(/unknown sub-command/);
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

  /** The lane's own stage and its next action print alongside the watermark status. */
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

  it("says so rather than printing an empty table when there is no knowledge at all", async () => {
    const root = project([]);
    const result = await capture(["roles", "--project-root", root], root);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/no knowledge captured yet/);
  });

  it("is listed in the usage text", () => {
    expect(USAGE).toContain("sta roles");
    expect(USAGE).toContain("roles inbox");
  });
});

describe("the roles sub-commands for T103-T107", () => {
  it("fails closed for every free-form human status command", async () => {
    const root = project();
    const before = KnowledgeBase.load(root).get("RULE-007");
    for (const command of [["review", "RULE-007"], ["approve", "RULE-007"], ["signoff", "ba"], ["ack", "sa", "REQ-003"]]) {
      await expect(capture(["roles", ...command, "--module", "sales-crm", "--by", "forged person", "--project-root", root], root))
        .rejects.toThrow(/--by is not an identity/);
    }
    await expect(capture(["roles", "review", "RULE-007", "--project-root", root], root)).rejects.toThrow(/trusted human decision channel is unavailable/);
    await expect(capture(["roles", "approve", "RULE-007", "--project-root", root], root)).rejects.toThrow(/through its lane's sign-off/);
    expect(KnowledgeBase.load(root).get("RULE-007")).toEqual(before);
    expect(fs.existsSync(path.join(root, "knowledge", "_roles"))).toBe(false);
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
    for (const sub of ["roles inbox", "roles impact", "roles context"]) {
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
