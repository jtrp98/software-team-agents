import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { parseArgs } from "../cli.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, PersistedTaskSchema } from "../store/taskStore.js";
import { openStore } from "../cli/support.js";
import { AgentStage } from "../types.js";
import { openTask } from "../cli/composition/taskIntake.js";
import { declareInstallationConfigOverrideChannelForTest } from "./installation.js";
import { assertRootMatchesFrozenIdentity } from "./rootSelector.js";
import { preflightThreeRepoTask } from "./preflight.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DR §5 — the frozen Knowledge-root identity of a regular orchestrated task.
 * Intake records `{name, path}` on the persisted row; a resumed task answers
 * to that record (never to a re-read `default_root`), an explicit `--root` on
 * resume is a drift assertion, and the per-stage preflight refuses any
 * selection that disagrees with the frozen identity before registry/module
 * reads. Fixtures mirror the DR §8.3 run-isolation rows.
 */

const originalInstallation = process.env.STA_INSTALLATION_CONFIG;
const originalKnowledgeRootEnv = process.env.STA_KNOWLEDGE_ROOT;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalInstallation === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = originalInstallation;
  if (originalKnowledgeRootEnv === undefined) delete process.env.STA_KNOWLEDGE_ROOT;
  else process.env.STA_KNOWLEDGE_ROOT = originalKnowledgeRootEnv;
});

function repository(directory: string, remote?: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(directory, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
}

interface TwoRootFixture {
  root: string;
  framework: string;
  personal: string;
  work: string;
  config: string;
}

function twoRootFixture(): TwoRootFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v11-frozen-root-"));
  roots.push(root);
  const framework = path.join(root, "framework");
  const personal = path.join(root, "personal");
  const work = path.join(root, "work");
  repository(framework);
  repository(personal);
  repository(work);
  const config = path.join(root, "installation.yaml");
  fs.writeFileSync(
    config,
    [
      "schema_version: 2",
      `knowledge_root: ${JSON.stringify(personal)}`,
      "default_root: personal",
      "knowledge_roots:",
      `  personal: ${JSON.stringify(personal)}`,
      `  work: ${JSON.stringify(work)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.STA_INSTALLATION_CONFIG = config;
  return { root, framework, personal, work, config };
}

function registryYaml(remote: string): string {
  return `schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: ${JSON.stringify(remote)}\n    status: active\n    type: backend\n`;
}

describe("PersistedTask knowledgeRoot — the frozen identity", () => {
  it("an old row without the field loads as null; a frozen row round-trips", () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true });
    const legacy = newPersistedTask({ taskId: "legacy-row", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
    expect(PersistedTaskSchema.parse(legacy).knowledgeRoot).toBeNull();

    const frozen = newPersistedTask({
      taskId: "frozen-row",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      knowledgeRoot: { name: "work", path: "C:\\kn\\work" },
    });
    expect(PersistedTaskSchema.parse(frozen).knowledgeRoot).toEqual({ name: "work", path: "C:\\kn\\work" });
  });
});

describe("assertRootMatchesFrozenIdentity — resume never re-selects (DR §5 invariant 5)", () => {
  it("a frozen identity that still resolves to the same name and path passes", () => {
    const { work, config } = twoRootFixture();
    expect(() => assertRootMatchesFrozenIdentity({ name: "work", path: work }, "work", config)).not.toThrow();
    // Resume without --root re-resolves the frozen name, never the fresh default.
    expect(() => assertRootMatchesFrozenIdentity({ name: "work", path: work }, undefined, config)).not.toThrow();
  });

  it("an explicit --root that resolves elsewhere, or a re-pointed frozen path, is a refusal", () => {
    const { root, personal, work, config } = twoRootFixture();
    expect(() => assertRootMatchesFrozenIdentity({ name: "work", path: work }, "personal", config))
      .toThrow(/drift.*"work".*"personal"/s);

    const moved = path.join(root, "moved");
    repository(moved);
    fs.writeFileSync(
      config,
      [
        "schema_version: 2",
        `knowledge_root: ${JSON.stringify(personal)}`,
        "default_root: personal",
        "knowledge_roots:",
        `  personal: ${JSON.stringify(personal)}`,
        `  work: ${JSON.stringify(moved)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => assertRootMatchesFrozenIdentity({ name: "work", path: work }, undefined, config))
      .toThrow(/drift.*"work"/s);
  });

  it("a task without a frozen identity is untouched, and a vanished installation refuses fail-closed", () => {
    const { config } = twoRootFixture();
    expect(() => assertRootMatchesFrozenIdentity(null, "personal", config)).not.toThrow();
    expect(() => assertRootMatchesFrozenIdentity(undefined, undefined, config)).not.toThrow();

    const { config: gone } = twoRootFixture();
    fs.rmSync(gone);
    expect(() => assertRootMatchesFrozenIdentity({ name: "work", path: "C:\\kn\\work" }, undefined, gone))
      .toThrow(/frozen to Knowledge root "work"/);
  });
});

describe("preflightThreeRepoTask — the frozen assertion stops before registry reads (DR §5)", () => {
  it("accepts the run whose selection still resolves to the frozen identity", () => {
    const { framework, work, config } = twoRootFixture();
    fs.writeFileSync(path.join(work, "targets.yaml"), registryYaml("https://github.com/acme/api.git"), "utf8");
    const classification = classifyTask({ touchesBusinessRuleOnly: true });
    const task = newPersistedTask({
      taskId: "frozen-ok",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      knowledgeRoot: { name: "work", path: work },
    });
    const resolved = preflightThreeRepoTask(task, AgentStage.BUSINESS_ANALYST, {
      frameworkRoot: framework,
      installationConfigPath: config,
      knowledgeRootName: "work",
    });
    expect(resolved.knowledgeRoot).toBe(path.resolve(work));
  });

  it("refuses when the resolved selection disagrees with the frozen identity, before the registry is read", () => {
    const { framework, work, config } = twoRootFixture();
    // The selected (default) root deliberately has NO targets.yaml: the frozen
    // refusal must fire before any registry read, not after one.
    const classification = classifyTask({ touchesBusinessRuleOnly: true });
    const task = newPersistedTask({
      taskId: "frozen-drift",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      knowledgeRoot: { name: "work", path: work },
    });
    expect(() =>
      preflightThreeRepoTask(task, AgentStage.BUSINESS_ANALYST, { frameworkRoot: framework, installationConfigPath: config }),
    ).toThrow(/frozen to Knowledge root "work".*resolved to "personal"/s);
  });

  it("refuses when the installation re-pointed the frozen name at another path", () => {
    const { root, framework, personal, config } = twoRootFixture();
    const moved = path.join(root, "moved");
    repository(moved);
    fs.writeFileSync(
      config,
      [
        "schema_version: 2",
        `knowledge_root: ${JSON.stringify(personal)}`,
        "default_root: personal",
        "knowledge_roots:",
        `  personal: ${JSON.stringify(personal)}`,
        `  work: ${JSON.stringify(moved)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const classification = classifyTask({ touchesBusinessRuleOnly: true });
    const task = newPersistedTask({
      taskId: "frozen-repoint",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      knowledgeRoot: { name: "work", path: path.join(root, "work") },
    });
    expect(() =>
      preflightThreeRepoTask(task, AgentStage.BUSINESS_ANALYST, {
        frameworkRoot: framework,
        installationConfigPath: config,
        knowledgeRootName: "work",
      }),
    ).toThrow(/frozen to Knowledge root "work"/);
  });

  it("a task without a frozen identity behaves as before", () => {
    const { framework, work, config } = twoRootFixture();
    fs.writeFileSync(path.join(work, "targets.yaml"), registryYaml("https://github.com/acme/api.git"), "utf8");
    const classification = classifyTask({ touchesBusinessRuleOnly: true });
    const task = newPersistedTask({ taskId: "unfrozen", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
    expect(() =>
      preflightThreeRepoTask(task, AgentStage.BUSINESS_ANALYST, {
        frameworkRoot: framework,
        installationConfigPath: config,
        knowledgeRootName: "work",
      }),
    ).not.toThrow();
  });
});

describe("openTask intake — freeze at creation, resume on the frozen root", () => {
  function intakeFixture(): TwoRootFixture & { api: string; stateDb: string } {
    const base = twoRootFixture();
    const api = path.join(base.root, "api");
    repository(api, "https://github.com/acme/api.git");
    fs.writeFileSync(path.join(base.work, "targets.yaml"), registryYaml("https://github.com/acme/api.git"), "utf8");
    // The default root owns a different repository — the same coordinate in
    // two roots is exactly what the machine-wide ownership rule refuses.
    fs.writeFileSync(
      path.join(base.personal, "targets.yaml"),
      "schema_version: 1\ntargets:\n  - target_id: docs\n    name: Docs\n    remote_url: https://github.com/acme/docs.git\n    status: active\n",
      "utf8",
    );
    fs.mkdirSync(path.join(base.work, ".workflow"), { recursive: true });
    fs.writeFileSync(
      path.join(base.work, ".workflow", "targets.local.yaml"),
      `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(api)}\n`,
      "utf8",
    );
    fs.mkdirSync(path.join(base.work, "_docs", "module", "orders"), { recursive: true });
    fs.writeFileSync(path.join(base.work, "_docs", "module", "orders", "design.md"), "# Design\n\n## Targets\n\n- api\n", "utf8");
    return { ...base, api, stateDb: path.join(base.root, "state", "state.db") };
  }

  it("records the selected root at creation; resume keeps it; resume with another --root refuses", () => {
    const f = intakeFixture();
    fs.mkdirSync(path.dirname(f.stateDb), { recursive: true });
    const { store, registry } = openStore(f.framework, f.stateDb);
    try {
      const createArgs = parseArgs(
        ["--task-id", "T-frozen", "--module", "orders", "--root", "work", "--bug-fix", "--backend", "--backend-target", "api", "--project-root", f.framework],
        f.framework,
      );
      openTask(registry, createArgs, "T-frozen", store);
      const row = store.loadTask("T-frozen");
      expect(row?.knowledgeRoot).toEqual({ name: "work", path: path.resolve(f.work) });

      const resumeArgs = parseArgs(
        ["--task-id", "T-frozen", "--module", "orders", "--resume", "--project-root", f.framework],
        f.framework,
      );
      openTask(registry, resumeArgs, "T-frozen", store);
      expect(store.loadTask("T-frozen")?.knowledgeRoot).toEqual({ name: "work", path: path.resolve(f.work) });

      const driftArgs = parseArgs(
        ["--task-id", "T-frozen", "--module", "orders", "--resume", "--root", "personal", "--project-root", f.framework],
        f.framework,
      );
      expect(() => openTask(registry, driftArgs, "T-frozen", store)).toThrow(/frozen.*"work".*"personal"/s);
    } finally {
      registry.close();
    }
  });

  it("changing default_root between stages cannot repoint a resumed task", () => {
    const f = intakeFixture();
    fs.mkdirSync(path.dirname(f.stateDb), { recursive: true });
    const { store, registry } = openStore(f.framework, f.stateDb);
    try {
      const createArgs = parseArgs(
        ["--task-id", "T-default-drift", "--module", "orders", "--business-rule", "--project-root", f.framework],
        f.framework,
      );
      openTask(registry, createArgs, "T-default-drift", store);
      // Created with no --root under default_root: personal.
      expect(store.loadTask("T-default-drift")?.knowledgeRoot?.name).toBe("personal");

      // The machine's default later moves to work.
      fs.writeFileSync(
        f.config,
        [
          "schema_version: 2",
          `knowledge_root: ${JSON.stringify(f.work)}`,
          "default_root: work",
          "knowledge_roots:",
          `  personal: ${JSON.stringify(f.personal)}`,
          `  work: ${JSON.stringify(f.work)}`,
          "",
        ].join("\n"),
        "utf8",
      );

      // Resume without --root must answer to the frozen record, not the new default.
      const resumeArgs = parseArgs(
        ["--task-id", "T-default-drift", "--module", "orders", "--resume", "--project-root", f.framework],
        f.framework,
      );
      openTask(registry, resumeArgs, "T-default-drift", store);
      expect(store.loadTask("T-default-drift")?.knowledgeRoot).toEqual({ name: "personal", path: path.resolve(f.personal) });
    } finally {
      registry.close();
    }
  });
});
