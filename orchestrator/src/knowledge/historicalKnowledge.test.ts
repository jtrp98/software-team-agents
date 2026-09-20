import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { checkKnowledge } from "./knowledgeBase.js";
import { writeKnowledgeItem } from "./knowledgeStore.js";
import { makeItem } from "./sampleKnowledge.js";
import { knowledgeBriefFor } from "../runtime/knowledgeBriefAssembly.js";
import { reconcileKnowledge } from "./reconcile.js";
import { resolveModuleTargets } from "../threeRepo/moduleTargetResolver.js";
import { loadTargetRegistry, TargetRegistryError, assertTargetCanStartNewTask } from "../threeRepo/targets.js";
import { preflightThreeRepoTask } from "../threeRepo/preflight.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, type PersistedTask } from "../store/taskStore.js";
import { declareInstallationConfigOverrideChannelForTest } from "../threeRepo/installation.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DT §5.1/§5.3 — a completed transfer leaves a `retired + released` tombstone
 * in the source root, and the source root's knowledge items keep pointing at
 * its target_id. Those items are historical archived knowledge: kept for
 * audit/query, never orphaned, never rendered into a runtime brief, never
 * reconciled as current Target evidence — and a hand-deleted tombstone turns
 * them back into `unknown target_id` failures. Nothing here copies or moves an
 * item across roots (ข้อยืนยัน 8): archive-in-source is the default.
 */

const roots: string[] = [];
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-historical-"));
  roots.push(root);
  // checkKnowledge wants a coherent policy file; the standalone-repo marker
  // keeps the root bindable as an installation Knowledge root.
  fs.writeFileSync(path.join(root, "knowledge-policy.yaml"), "version: 1\ndefaults:\n  sensitive: full\n  hide_fields: []\nroles: {}\n", "utf8");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
});

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const ACTIVE = "https://github.com/acme/api.git";
const RELEASED_REMOTE = "https://github.com/acme/legacy.git";

function writeRegistry(body: string): void {
  fs.writeFileSync(path.join(root, "targets.yaml"), body, "utf8");
}

/** `api` stays active; `legacy` is the tombstone a finished transfer left. */
function registryWithTombstone(): void {
  writeRegistry(
    `schema_version: 2\ntargets:\n` +
      `  - target_id: api\n    name: api\n    remote_url: ${JSON.stringify(ACTIVE)}\n    status: active\n    type: backend\n    ownership_state: owned\n` +
      `  - target_id: legacy\n    name: legacy\n    remote_url: ${JSON.stringify(RELEASED_REMOTE)}\n    status: retired\n    type: backend\n    ownership_state: released\n`,
  );
}

function knowledgeItem(id: string, targetIds: string[]): void {
  writeKnowledgeItem(
    makeItem(
      "requirement",
      id,
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      {
        module: "sales",
        owner: AgentStage.BUSINESS_ANALYST,
        status: "approved",
        target_ids: targetIds,
        schema_version: 2,
        sources: [{ type: "agent", locator: AgentStage.BUSINESS_ANALYST, captured_at: "2026-08-20T09:00:00Z", digest: null, origin: { root: "knowledge", target_id: null } }],
      },
    ),
    root,
    { force: true },
  );
}

function boundTask(targetId: string, taskId = "T-historical"): PersistedTask {
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  return newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    targetBindings: { targets: [{ target_id: targetId, role: AgentStage.BACKEND_ENGINEER }] },
  });
}

describe("checkKnowledge — historical archived knowledge (DT §5.1)", () => {
  it("an item scoped only to a released tombstone passes and is reported as historical, not orphaned", () => {
    registryWithTombstone();
    knowledgeItem("REQ-HIST1", ["legacy"]);
    knowledgeItem("REQ-CUR1", ["api"]);
    const report = checkKnowledge(root);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.problems.join("\n")).not.toContain("REQ-HIST1");
    const notes = report.notes.join("\n");
    expect(notes).toMatch(/1 historical archived knowledge item/);
    expect(notes).toContain("sales/REQ-HIST1");
    expect(notes).not.toContain("sales/REQ-CUR1");
  });

  it("an item scoped to a live target and a tombstone stays current for the live target", () => {
    registryWithTombstone();
    knowledgeItem("REQ-MIX1", ["api", "legacy"]);
    const report = checkKnowledge(root);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.notes.join("\n")).not.toContain("REQ-MIX1");
  });

  it("deleting the tombstone by hand turns its items into unknown target_id failures (orphan = FAIL)", () => {
    registryWithTombstone();
    knowledgeItem("REQ-HIST1", ["legacy"]);
    writeRegistry(
      `schema_version: 2\ntargets:\n` +
        `  - target_id: api\n    name: api\n    remote_url: ${JSON.stringify(ACTIVE)}\n    status: active\n    type: backend\n    ownership_state: owned\n`,
    );
    const report = checkKnowledge(root);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/sales\/REQ-HIST1: unknown target_id "legacy"/);
  });

  it("keeps active+released invalid at load time (DT §5.1 state machine)", () => {
    writeRegistry(
      `schema_version: 2\ntargets:\n` +
        `  - target_id: ghost\n    name: ghost\n    remote_url: ${JSON.stringify(RELEASED_REMOTE)}\n    status: active\n    type: backend\n    ownership_state: released\n`,
    );
    expect(() => loadTargetRegistry(root)).toThrow(TargetRegistryError);
    expect(() => loadTargetRegistry(root)).toThrow(/active\+released/);
  });
});

describe("runtime brief — historical items never render (DT §5.1)", () => {
  function mapTarget(id: string, checkout: string): void {
    fs.mkdirSync(path.join(root, ".workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".workflow", "targets.local.yaml"),
      `schema_version: 1\ntargets:\n  ${id}:\n    path: ${JSON.stringify(checkout)}\n`,
      "utf8",
    );
  }

  it("excludes an item scoped only to the tombstone from the Target-scoped brief and the unscoped fallback", () => {
    registryWithTombstone();
    knowledgeItem("REQ-HIST1", ["legacy"]);
    knowledgeItem("REQ-CUR1", ["api"]);
    const checkout = path.join(root, "api-checkout");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"api"}\n', "utf8");
    mapTarget("api", checkout);

    const scoped = knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: checkout, knowledgeRoot: root, moduleName: "sales", targetRoot: checkout });
    expect(scoped.join("\n")).toContain("REQ-CUR1");
    expect(scoped.join("\n")).not.toContain("REQ-HIST1");

    // The B34 fail-open path: a Target root whose id cannot be resolved must
    // not smuggle historical items back in through the unscoped fallback.
    const unmapped = path.join(root, "unmapped-checkout");
    fs.mkdirSync(unmapped, { recursive: true });
    fs.writeFileSync(path.join(unmapped, "package.json"), '{"name":"unmapped"}\n', "utf8");
    const fallback = knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: unmapped, knowledgeRoot: root, moduleName: "sales", targetRoot: unmapped });
    expect(fallback.join("\n")).not.toContain("REQ-HIST1");
  });
});

describe("reconcile — a tombstone is not current Target evidence (DT §5.1)", () => {
  it("refuses to reconcile a released Target instead of failing on its missing mapping", () => {
    registryWithTombstone();
    expect(() => reconcileKnowledge({ knowledgeRoot: root, frameworkRoot: root, targetId: "legacy", now: "2026-09-20T00:00:00Z" })).toThrow(
      /released tombstone/,
    );
  });
});

describe("module docs and task bindings refuse released Targets", () => {
  it("resolveModuleTargets reports a declared tombstone as an error, with the transfer advice", () => {
    registryWithTombstone();
    const design = path.join(root, "_docs", "module", "sales");
    fs.mkdirSync(design, { recursive: true });
    fs.writeFileSync(path.join(design, "design.md"), "# Design\n\n## Targets\n\n- legacy (backend-engineer)\n", "utf8");
    const result = resolveModuleTargets("sales", root, { frameworkRoot: root });
    expect(result.problems.some((p) => p.severity === "error" && /released tombstone/.test(p.message))).toBe(true);
  });

  it("a new task cannot bind a released Target", () => {
    registryWithTombstone();
    expect(() => assertTargetCanStartNewTask(loadTargetRegistry(root), "legacy")).toThrow(/released tombstone/);
  });

  it("a resumed run whose task binds a released Target is refused at preflight (fail-closed)", () => {
    registryWithTombstone();
    // A separate framework checkout: it must not sit inside the Knowledge root
    // or the overlap rule would refuse before the ownership check runs.
    const framework = fs.mkdtempSync(path.join(os.tmpdir(), "sta-historical-fw-"));
    roots.push(framework);
    fs.mkdirSync(path.join(framework, ".git"), { recursive: true });
    // The tombstone still has this machine's old checkout mapped: the refusal
    // must come from the ownership state, not from a missing mapping. The
    // checkout sits outside the Knowledge root — mapping rules forbid overlap.
    const legacyCheckout = fs.mkdtempSync(path.join(os.tmpdir(), "sta-historical-co-"));
    roots.push(legacyCheckout);
    fs.mkdirSync(path.join(legacyCheckout, ".git"), { recursive: true });
    fs.writeFileSync(path.join(legacyCheckout, "package.json"), '{"name":"legacy"}\n', "utf8");
    fs.mkdirSync(path.join(root, ".workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".workflow", "targets.local.yaml"),
      `schema_version: 1\ntargets:\n  legacy:\n    path: ${JSON.stringify(legacyCheckout)}\n`,
      "utf8",
    );
    const installation = path.join(root, "installation.yaml");
    fs.writeFileSync(
      installation,
      `schema_version: 2\nknowledge_root: ${JSON.stringify(root)}\ndefault_root: default\nknowledge_roots:\n  default: ${JSON.stringify(root)}\n`,
      "utf8",
    );
    process.env.STA_INSTALLATION_CONFIG = installation;
    try {
      expect(() =>
        preflightThreeRepoTask(boundTask("legacy"), AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: installation }),
      ).toThrow(/released tombstone/);
    } finally {
      delete process.env.STA_INSTALLATION_CONFIG;
    }
  });
});
