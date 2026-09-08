import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask } from "../store/taskStore.js";
import { AgentStage } from "../types.js";
import { resolveQaWorkRoots } from "../cli.js";
import { resolveWritableWorkRoots } from "./cliRoots.js";

const INSTALLATION_CONFIG_ENV = "AGENTCLAUDE_INSTALLATION_CONFIG";
const originalInstallationConfig = process.env[INSTALLATION_CONFIG_ENV];

function initialiseRepository(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}

function makeThreeRepoFixture(): {
  root: string;
  framework: string;
  knowledge: string;
  target: string;
  task: ReturnType<typeof newPersistedTask>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-cli-roots-"));
  const framework = path.join(root, "framework");
  const knowledge = path.join(root, "knowledge");
  const target = path.join(root, "target");
  initialiseRepository(framework);
  initialiseRepository(knowledge);
  initialiseRepository(target);
  fs.writeFileSync(
    path.join(target, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/acme/target.git\n',
  );
  fs.mkdirSync(path.join(knowledge, ".workflow"));
  fs.writeFileSync(
    path.join(knowledge, "targets.yaml"),
    "schema_version: 1\ntargets:\n  - target_id: target\n    name: Target\n    remote_url: https://github.com/acme/target.git\n    status: active\n",
  );
  fs.writeFileSync(
    path.join(knowledge, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n  target:\n    path: ${JSON.stringify(target)}\n`,
  );
  const installationConfig = path.join(root, "installation.yaml");
  fs.writeFileSync(
    installationConfig,
    `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`,
  );
  process.env[INSTALLATION_CONFIG_ENV] = installationConfig;

  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  const task = newPersistedTask({
    taskId: "T-V7-018-fixture",
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    targetBindings: { backend_target: "target", frontend_target: null },
  });
  return { root, framework, knowledge, target, task };
}

afterEach(() => {
  if (originalInstallationConfig === undefined) delete process.env[INSTALLATION_CONFIG_ENV];
  else process.env[INSTALLATION_CONFIG_ENV] = originalInstallationConfig;
});

describe("resolveWritableWorkRoots — real three-repo installation", () => {
  it("resolves QA change discovery and deterministic checks to the Target", () => {
    const fixture = makeThreeRepoFixture();
    try {
      expect(
        resolveQaWorkRoots(fixture.framework, fixture.task.taskId, {
          loadTask: () => fixture.task,
        }),
      ).toEqual([fixture.target]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a configured task whose Target cannot be mapped locally", () => {
    const fixture = makeThreeRepoFixture();
    try {
      fs.writeFileSync(path.join(fixture.knowledge, ".workflow", "targets.local.yaml"), "schema_version: 1\ntargets: {}\n");
      expect(() =>
        resolveWritableWorkRoots(fixture.framework, fixture.task.taskId, { loadTask: () => fixture.task }, AgentStage.QA_ENGINEER),
      ).toThrow(/T-V7-018-fixture.*Target binding.*no local path mapping/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps legacy single-repo fallback when no installation config exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-cli-roots-legacy-"));
    process.env[INSTALLATION_CONFIG_ENV] = path.join(root, "missing-installation.yaml");
    try {
      expect(resolveWritableWorkRoots(root, "T-legacy", { loadTask: () => null }, AgentStage.QA_ENGINEER)).toEqual([root]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
