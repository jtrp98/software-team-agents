import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { makeItem } from "../knowledge/sampleKnowledge.js";
import { initTaskMachine } from "../state/taskState.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { newPersistedTask, type PersistedTask } from "../store/taskStore.js";
import { AgentStage, TaskState } from "../types.js";
import { runTransferVerb } from "../cli/verbs/transfer.js";
import { auditTargetOwnershipAcrossRoots } from "./ownershipAudit.js";
import { preflightThreeRepoTask } from "./preflight.js";
import { declareInstallationConfigOverrideChannelForTest } from "./installation.js";
import {
  loadTargetRegistry,
  normalizeTargetRegistry,
  targetById,
} from "./targets.js";
import {
  loadTransferRecord,
  planTargetOwnershipTransfer,
  registerDestinationForTransfer,
  releaseTargetForTransfer,
  rollbackTargetTransfer,
  verifyTargetTransfer,
} from "./targetTransfer.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DT §5.2 — the nine-step human-gated ownership transfer. Step 1 is a
 * read-only plan; steps 2/6/7 are conditioned on an explicit transfer
 * approval record naming target/source/destination (humans approve — the
 * commands only check the record); step 3 is proven by a validator (no
 * non-terminal task remains); step 6 writes the `retired + released`
 * tombstone through the administrative writer only; step 7 registers the
 * destination with alias history and rolls back with the same record; the
 * intermediate state refuses preflight on both sides until the audit sees
 * source released + destination owned as a pair; step 9 runs the doctor
 * checks on both roots before the record is marked completed.
 */

const roots: string[] = [];
const originalConfigEnv = process.env.STA_INSTALLATION_CONFIG;

afterEach(() => {
  if (originalConfigEnv === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = originalConfigEnv;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sta-transfer-${prefix}-`));
  roots.push(dir);
  return dir;
}

function repository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}

interface Fixture {
  base: string;
  framework: string;
  alpha: string;
  beta: string;
  apiRepo: string;
  configPath: string;
  stateDb: string;
}

/** alpha (source, default root) owns `api`; beta (destination) is empty. */
function fixture(): Fixture {
  const base = tmpDir("fx");
  const framework = path.join(base, "framework");
  const alpha = path.join(base, "alpha");
  const beta = path.join(base, "beta");
  const apiRepo = path.join(base, "api-repo");
  repository(framework);
  repository(alpha);
  repository(beta);
  repository(apiRepo);
  fs.writeFileSync(path.join(alpha, "knowledge-policy.yaml"), "version: 1\ndefaults:\n  sensitive: full\n  hide_fields: []\nroles: {}\n", "utf8");
  fs.writeFileSync(path.join(beta, "knowledge-policy.yaml"), "version: 1\ndefaults:\n  sensitive: full\n  hide_fields: []\nroles: {}\n", "utf8");
  fs.writeFileSync(
    path.join(alpha, "targets.yaml"),
    'schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n',
    "utf8",
  );
  fs.writeFileSync(path.join(beta, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
  fs.mkdirSync(path.join(alpha, ".workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(alpha, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(apiRepo)}\n`,
    "utf8",
  );
  const configPath = path.join(base, "installation.yaml");
  fs.writeFileSync(
    configPath,
    `schema_version: 2\nknowledge_root: ${JSON.stringify(alpha)}\ndefault_root: alpha\nknowledge_roots:\n  alpha: ${JSON.stringify(alpha)}\n  beta: ${JSON.stringify(beta)}\n`,
    "utf8",
  );
  process.env.STA_INSTALLATION_CONFIG = configPath;
  return { base, framework, alpha, beta, apiRepo, configPath, stateDb: path.join(alpha, ".workflow", "state.db") };
}

function taskBoundTo(fixture_: Fixture, targetId: string, taskId: string): PersistedTask {
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  return newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    targetBindings: { targets: [{ target_id: targetId, role: AgentStage.BACKEND_ENGINEER }] },
  });
}

function seedNonTerminalTask(fixture_: Fixture, taskId = "T-open"): PersistedTask {
  const task = taskBoundTo(fixture_, "api", taskId);
  const store = new SqliteTaskStore(fixture_.stateDb);
  try {
    store.createTask(task);
  } finally {
    store.close();
  }
  return task;
}

function writeModuleDeclaring(fixture_: Fixture, targetId = "api"): string {
  const dir = path.join(fixture_.alpha, "_docs", "module", "sales");
  fs.mkdirSync(dir, { recursive: true });
  const designPath = path.join(dir, "design.md");
  fs.writeFileSync(designPath, `# sales\n\n## Targets\n\n- ${targetId}\n`, "utf8");
  return designPath;
}

function writeKnowledgeScopedTo(fixture_: Fixture, targetId = "api"): void {
  writeKnowledgeItem(
    makeItem(
      "requirement",
      "REQ-1",
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      {
        module: "sales",
        owner: AgentStage.BUSINESS_ANALYST,
        status: "approved",
        target_ids: [targetId],
        schema_version: 2,
        sources: [{ type: "agent", locator: AgentStage.BUSINESS_ANALYST, captured_at: "2026-08-20T09:00:00Z", digest: null, origin: { root: "knowledge", target_id: null } }],
      },
    ),
    fixture_.alpha,
  );
}

interface RecordOverrides {
  transfer_id?: string;
  source_root?: string;
  source_target_id?: string;
  destination_root?: string;
  destination_target_id?: string;
  destination_name?: string;
  destination_remote_url?: string;
  destination_repository_aliases?: string[];
  source_approved_by?: string;
  destination_approved_by?: string;
  confirmed_transfer_not_fork_or_mirror?: boolean;
  status?: string;
}

function recordYaml(overrides: RecordOverrides = {}): string {
  const record = {
    schema_version: 1,
    transfer_id: "api-alpha-to-beta",
    source_root: "alpha",
    source_target_id: "api",
    destination_root: "beta",
    destination_target_id: "backend",
    destination_name: "Backend",
    destination_remote_url: "https://github.com/acme/api.git",
    destination_repository_aliases: [] as string[],
    source_approved_by: "Krit (owner of alpha)",
    destination_approved_by: "Wipa (owner of beta)",
    confirmed_transfer_not_fork_or_mirror: true,
    status: "pending",
    ...overrides,
  };
  const lines = [
    "schema_version: 1",
    `transfer_id: ${record.transfer_id}`,
    `source_root: ${record.source_root}`,
    `source_target_id: ${record.source_target_id}`,
    `destination_root: ${record.destination_root}`,
    `destination_target_id: ${record.destination_target_id}`,
    `destination_name: ${JSON.stringify(record.destination_name)}`,
    `destination_remote_url: ${JSON.stringify(record.destination_remote_url)}`,
    `destination_repository_aliases: [${record.destination_repository_aliases.map((alias) => JSON.stringify(alias)).join(", ")}]`,
    `source_approved_by: ${JSON.stringify(record.source_approved_by)}`,
    `destination_approved_by: ${JSON.stringify(record.destination_approved_by)}`,
    `confirmed_transfer_not_fork_or_mirror: ${record.confirmed_transfer_not_fork_or_mirror}`,
    `status: ${record.status}`,
    "",
  ];
  return lines.join("\n");
}

function writeRecord(fixture_: Fixture, overrides: RecordOverrides = {}): string {
  const recordPath = path.join(fixture_.base, "transfer.yaml");
  fs.writeFileSync(recordPath, recordYaml(overrides), "utf8");
  return recordPath;
}

const releasedEntry = (root: string): { status: string; ownership_state: string; remote_url: string } =>
  normalizeTargetRegistry(loadTargetRegistry(root)).targets.find((target) => target.target_id === "api")!;

describe("planTargetOwnershipTransfer — step 1, read-only", () => {
  it("collects coordinates, non-terminal tasks, module refs, scoped knowledge and local mappings without writing", () => {
    const f = fixture();
    seedNonTerminalTask(f);
    writeModuleDeclaring(f);
    writeKnowledgeScopedTo(f);
    const registryBefore = fs.readFileSync(path.join(f.alpha, "targets.yaml"));
    const dbBefore = fs.readFileSync(f.stateDb);

    const plan = planTargetOwnershipTransfer({ sourceRoot: "alpha", sourceTargetId: "api", destinationRoot: "beta", installationConfigPath: f.configPath });

    expect(plan.sourceRoot).toBe("alpha");
    expect(plan.destinationRoot).toBe("beta");
    expect(plan.sourceCoordinates).toEqual(["github.com/acme/api"]);
    expect(plan.nonTerminalTasks).toEqual([{ taskId: "T-open", state: "CREATED" }]);
    expect(plan.moduleRefs).toEqual(["sales"]);
    expect(plan.scopedKnowledgeItems).toEqual([{ id: "sales/REQ-1", module: "sales", kind: "requirement" }]);
    expect(plan.localMappings.source).toBe(path.resolve(f.apiRepo));
    expect(plan.localMappings.destination).toBeNull();
    expect(plan.aliasHistoryForDestination).toEqual([]);
    expect(plan.recordTemplate).toContain("transfer_id:");
    expect(plan.recordTemplate).toContain("<fill in");
    // read-only: the registries and the task store are byte-identical after the plan.
    expect(fs.readFileSync(path.join(f.alpha, "targets.yaml")).equals(registryBefore)).toBe(true);
    expect(fs.readFileSync(f.stateDb).equals(dbBefore)).toBe(true);
  });

  it("reports a destination that already owns the coordinate as the repair case with the recommended alias history", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.beta, "targets.yaml"),
      'schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/Acme/API.git\n    status: active\n    type: backend\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(f.alpha, "targets.yaml"),
      'schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://git.example.com/legacy/api.git\n    status: active\n    type: backend\n    ownership_state: owned\n    repository_aliases: [git.example.com/older/api]\n',
      "utf8",
    );
    const plan = planTargetOwnershipTransfer({ sourceRoot: "alpha", sourceTargetId: "api", destinationRoot: "beta", destinationTargetId: "backend", installationConfigPath: f.configPath });
    expect(plan.sourceCoordinates).toEqual(["git.example.com/legacy/api", "git.example.com/older/api"]);
    expect(plan.destinationExistingEntry).toMatchObject({ target_id: "backend", ownership_state: "owned" });
    expect(plan.destinationAlreadyCoversSource).toBe(false);
    // A remote-move transfer keeps the source coordinates as the destination's alias history.
    expect(plan.aliasHistoryForDestination).toEqual(["git.example.com/legacy/api", "git.example.com/older/api"]);
  });

  it("refuses an unknown source root or target before collecting anything", () => {
    const f = fixture();
    expect(() =>
      planTargetOwnershipTransfer({ sourceRoot: "demo", sourceTargetId: "api", destinationRoot: "beta", installationConfigPath: f.configPath }),
    ).toThrow(/unknown Knowledge root "demo"/);
    expect(() =>
      planTargetOwnershipTransfer({ sourceRoot: "alpha", sourceTargetId: "missing", destinationRoot: "beta", installationConfigPath: f.configPath }),
    ).toThrow(/unknown Target "missing"/);
  });
});

describe("the approval record — steps 2/6/7 condition", () => {
  it("release refuses a record whose human approvals are still placeholders and writes nothing", () => {
    const f = fixture();
    const recordPath = writeRecord(f, { source_approved_by: "<fill in: the person approving the release for alpha>" });
    expect(() => releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /transfer "api-alpha-to-beta" refused: the approval record still contains unfilled placeholder approvals — a person approves every gate, never an agent/,
    );
    expect(releasedEntry(f.alpha).ownership_state).toBe("owned");
  });

  it("release refuses a record whose destination identity does not cover the source coordinates", () => {
    const f = fixture();
    const recordPath = writeRecord(f, { destination_remote_url: "https://github.com/other/repo.git" });
    expect(() => releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /does not cover the source Target "api" coordinates \(github\.com\/acme\/api\)/,
    );
    expect(releasedEntry(f.alpha).ownership_state).toBe("owned");
  });

  it("release refuses a record that names a different source than the registry shows, or skips the fork/mirror confirmation", () => {
    const f = fixture();
    expect(() =>
      releaseTargetForTransfer({ transferRecordPath: writeRecord(f, { source_target_id: "other" }), installationConfigPath: f.configPath }),
    ).toThrow(/names Target "other" in source root "alpha", but the registry holds "api"/);
    expect(() =>
      releaseTargetForTransfer({ transferRecordPath: writeRecord(f, { confirmed_transfer_not_fork_or_mirror: false }), installationConfigPath: f.configPath }),
    ).toThrow(/transfer is not confirmed as a transfer — a fork or mirror is a distinct Target \(DT §5\.2 step 2\)/);
  });
});

describe("release — steps 3/4 validators then the step 6 tombstone", () => {
  it("refuses while a non-terminal task binds the source target; after cancel it releases", () => {
    const f = fixture();
    const task = seedNonTerminalTask(f);
    const recordPath = writeRecord(f);
    expect(() => releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /transfer "api-alpha-to-beta" refused: non-terminal task\(s\) still bind Target "api" in source root "alpha": T-open \(CREATED\)/,
    );
    task.cancelled = true;
    const store = new SqliteTaskStore(f.stateDb);
    try {
      store.saveTask(task);
    } finally {
      store.close();
    }
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(releasedEntry(f.alpha)).toMatchObject({ status: "retired", ownership_state: "released", remote_url: "https://github.com/acme/api.git" });
    expect(loadTransferRecord(recordPath).status).toBe("released");
  });

  it("refuses while a module still declares the source target; amending the module unblocks", () => {
    const f = fixture();
    const designPath = writeModuleDeclaring(f);
    const recordPath = writeRecord(f);
    expect(() => releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /module docs in root "alpha" still declare Target "api": sales/,
    );
    fs.writeFileSync(designPath, "# sales\n\n## Targets\n\n- backend\n", "utf8");
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(releasedEntry(f.alpha).ownership_state).toBe("released");
  });

  it("refuses a second release of an already-released tombstone", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    fs.writeFileSync(recordPath, recordYaml({ status: "released" }), "utf8");
    expect(() => releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /status is "released" — the release runs on a "pending" record only/,
    );
  });

  it("refuses a record whose status does not authorize the release (completed or rolled back)", () => {
    const f = fixture();
    expect(() =>
      releaseTargetForTransfer({ transferRecordPath: writeRecord(f, { status: "completed" }), installationConfigPath: f.configPath }),
    ).toThrow(/status is "completed"/);
  });
});

describe("register — step 7 destination owner with alias history", () => {
  it("refuses while the record is pending because the source still owns the coordinate", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    expect(() => registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /status is "pending" — the destination register runs on a "released" record/,
    );
    expect(normalizeTargetRegistry(loadTargetRegistry(f.beta)).targets).toHaveLength(0);
  });

  it("registers the destination owner after the release and is idempotent on re-run", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    const result = registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(result.operation).toBe("addition");
    expect(normalizeTargetRegistry(loadTargetRegistry(f.beta)).targets[0]).toMatchObject({
      target_id: "backend",
      ownership_state: "owned",
      repository_aliases: [],
    });
    const again = registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(again.operation).toBe("already-current");
  });

  it("a remote-move transfer keeps the old coordinate as destination alias history; the release refuses when the alias is missing", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.alpha, "targets.yaml"),
      'schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://git.example.com/legacy/api.git\n    status: active\n    type: backend\n    ownership_state: owned\n',
      "utf8",
    );
    const missingAlias = writeRecord(f, { destination_repository_aliases: [] });
    expect(() => releaseTargetForTransfer({ transferRecordPath: missingAlias, installationConfigPath: f.configPath })).toThrow(
      /does not cover the source Target "api" coordinates \(git\.example\.com\/legacy\/api\)/,
    );
    const recordPath = writeRecord(f, { destination_repository_aliases: ["git.example.com/legacy/api"] });
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(normalizeTargetRegistry(loadTargetRegistry(f.beta)).targets[0]).toMatchObject({
      remote_url: "https://github.com/acme/api.git",
      repository_aliases: ["git.example.com/legacy/api"],
    });
  });

  it("refuses a destination alias that collides with another root's owner", () => {
    const f = fixture();
    const third = path.join(f.base, "gamma");
    repository(third);
    fs.writeFileSync(
      path.join(third, "targets.yaml"),
      'schema_version: 1\ntargets:\n  - target_id: other\n    name: Other\n    remote_url: https://git.example.com/legacy/api.git\n    status: active\n    type: backend\n',
      "utf8",
    );
    const configPath = path.join(f.base, "installation3.yaml");
    fs.writeFileSync(
      configPath,
      `schema_version: 2\nknowledge_root: ${JSON.stringify(f.alpha)}\ndefault_root: alpha\nknowledge_roots:\n  alpha: ${JSON.stringify(f.alpha)}\n  beta: ${JSON.stringify(f.beta)}\n  gamma: ${JSON.stringify(third)}\n`,
      "utf8",
    );
    process.env.STA_INSTALLATION_CONFIG = configPath;
    const recordPath = writeRecord(f, {
      destination_remote_url: "https://github.com/acme/api.git",
      destination_repository_aliases: [],
    });
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath });
    fs.writeFileSync(recordPath, recordYaml({ destination_repository_aliases: ["git.example.com/legacy/api"], status: "released" }), "utf8");
    expect(() => registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath })).toThrow(
      /already owned by root "gamma" as Target "other"/,
    );
  });
});

describe("rollback — step 7 fallback with the same approval", () => {
  it("restores the release before the destination owns the coordinate; refuses afterwards", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    rollbackTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(releasedEntry(f.alpha)).toMatchObject({ status: "retired", ownership_state: "owned" });
    expect(loadTransferRecord(recordPath).status).toBe("rolled_back");

    // A fresh record releases again; once the destination owns, rollback refuses.
    const second = writeRecord(f, { transfer_id: "api-alpha-to-beta-2" });
    releaseTargetForTransfer({ transferRecordPath: second, installationConfigPath: f.configPath });
    registerDestinationForTransfer({ transferRecordPath: second, installationConfigPath: f.configPath });
    expect(() => rollbackTargetTransfer({ transferRecordPath: second, installationConfigPath: f.configPath })).toThrow(
      /root "beta" \(Target "backend"\) already owns the transferred coordinates — the transfer is past rollback/,
    );
  });
});

describe("the intermediate state and verify — steps 8/9", () => {
  it("refuses preflight on both sides while the pair is incomplete", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    // Source side: a task still bound to the released tombstone refuses.
    const sourceTask = taskBoundTo(f, "api", "T-src");
    expect(() =>
      preflightThreeRepoTask(sourceTask, AgentStage.BACKEND_ENGINEER, { frameworkRoot: f.framework, installationConfigPath: f.configPath }),
    ).toThrow(/released tombstone in this root/);
    // Destination side: the destination target does not exist yet, so a run there refuses.
    const destinationTask = taskBoundTo(f, "backend", "T-dst");
    expect(() =>
      preflightThreeRepoTask(destinationTask, AgentStage.BACKEND_ENGINEER, {
        frameworkRoot: f.framework,
        installationConfigPath: f.configPath,
        knowledgeRootName: "beta",
      }),
    ).toThrow(/unknown Target "backend"/);
  });

  it("the audit reports an incomplete pair as FAIL and a completed pair as owned", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    const pending = auditTargetOwnershipAcrossRoots({ installationConfigPath: f.configPath });
    expect(pending.status).toBe("FAIL");
    expect(pending.problems.join(" ")).toMatch(/released tombstone "api" in root "alpha" has no owning destination pair/);

    registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    const complete = auditTargetOwnershipAcrossRoots({ installationConfigPath: f.configPath });
    expect(complete.status).toBe("PASS");
    expect(complete.detail).toMatch(/1 released tombstone\(s\) paired with a living owner/);
  });

  it("verify refuses until the pair is complete, then passes with knowledge and module checks on both roots", () => {
    const f = fixture();
    writeKnowledgeScopedTo(f);
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(() => verifyTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath })).toThrow(
      /transfer "api-alpha-to-beta" is not complete: source released, but no owning destination pair/,
    );

    registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    const verdict = verifyTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(verdict.problems).toEqual([]);
    expect(verdict.audit.status).toBe("PASS");
    expect(verdict.knowledgeChecks.map((check) => check.ok)).toEqual([true, true]);
    expect(verdict.moduleChecks.every((check) => check.errors.length === 0)).toBe(true);
    expect(loadTransferRecord(recordPath).status).toBe("completed");
    // The archived knowledge scoped to the tombstone stays historical, never an orphan.
    expect(checkKnowledge(f.alpha).problems).toEqual([]);
  });

  it("verify reports a failing knowledge check instead of marking the record completed", () => {
    const f = fixture();
    const recordPath = writeRecord(f);
    releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    // A hand-deleted tombstone elsewhere breaks the knowledge proof on the source root.
    fs.writeFileSync(
      path.join(f.alpha, "targets.yaml"),
      'schema_version: 2\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    type: backend\n    ownership_state: released\n',
      "utf8",
    );
    writeKnowledgeItem(
      makeItem(
        "requirement",
        "REQ-ORPHAN",
        { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
        {
          module: "sales",
          owner: AgentStage.BUSINESS_ANALYST,
          status: "approved",
          target_ids: ["ghost"],
          schema_version: 2,
          sources: [{ type: "agent", locator: AgentStage.BUSINESS_ANALYST, captured_at: "2026-08-20T09:00:00Z", digest: null, origin: { root: "knowledge", target_id: null } }],
        },
      ),
      f.alpha,
    );
    const verdict = verifyTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: f.configPath });
    expect(verdict.problems.join(" ")).toMatch(/unknown target_id "ghost"/);
    expect(loadTransferRecord(recordPath).status).toBe("released");
  });
});

describe("sta transfer — the CLI surface", () => {
  it("plan prints the surface and exits 0; release with an unapproved record exits 1", async () => {
    const f = fixture();
    const exitPlan = await runTransferVerb(
      ["plan", "--source-root", "alpha", "--source-target", "api", "--destination-root", "beta", "--config-path", f.configPath],
      f.framework,
    );
    expect(exitPlan).toBe(0);

    const recordPath = writeRecord(f, { source_approved_by: "<fill in: the person approving the release for alpha>" });
    const exitRelease = await runTransferVerb(["release", "--transfer", recordPath, "--config-path", f.configPath], f.framework);
    expect(exitRelease).toBe(1);
    expect(releasedEntry(f.alpha).ownership_state).toBe("owned");
  });

  it("an unknown operation or a missing --transfer is a usage error with exit 1", async () => {
    const f = fixture();
    expect(await runTransferVerb(["teleport"], f.framework)).toBe(1);
    expect(await runTransferVerb(["release", "--config-path", f.configPath], f.framework)).toBe(1);
  });
});
