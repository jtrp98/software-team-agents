import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, type PersistedTask } from "../store/taskStore.js";
import { AgentStage } from "../types.js";
import { declareInstallationConfigOverrideChannelForTest } from "./installation.js";
import { preflightThreeRepoTask } from "./preflight.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * DT §3.2 — cross-root Target ownership at preflight. The writer refuses a
 * duplicate at register time; a hand-edited targets.yaml bypasses only the
 * writer, so every bound lane re-proves the machine-wide invariant: a
 * canonical repository coordinate is owned by at most one Target across
 * every named root of the installation. Ownership compares by canonical
 * coordinate (DT §2.3) — HTTPS, `ssh://` and SCP-like spellings of one
 * repository conflict even when the target_id differs; a released tombstone
 * claims nothing; a task without Target bindings is never blocked by a
 * registry it does not use.
 */

const originalInstallation = process.env.STA_INSTALLATION_CONFIG;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalInstallation === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = originalInstallation;
});

function repository(directory: string, remote?: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(directory, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
}

function targetYaml(id: string, remote: string, extra = ""): string {
  return `schema_version: 1\ntargets:\n  - target_id: ${id}\n    name: ${id}\n    remote_url: ${JSON.stringify(remote)}\n    status: active\n    type: backend${extra}\n`;
}

interface Fixture {
  root: string;
  framework: string;
  personal: string;
  work: string;
  backendRepo: string;
  config: string;
}

/** personal (default, selected) owns `backend`; work owns `api` — different
 * target_ids, remotes chosen per test. */
function fixture(workRemote: string, workRegistryBody?: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v11-ownership-"));
  roots.push(root);
  const framework = path.join(root, "framework");
  const personal = path.join(root, "personal");
  const work = path.join(root, "work");
  const backendRepo = path.join(root, "backend");
  repository(framework);
  repository(personal);
  repository(work);
  repository(backendRepo, "https://github.com/acme/api.git");
  fs.writeFileSync(path.join(personal, "targets.yaml"), targetYaml("backend", "https://github.com/acme/api.git"), "utf8");
  fs.mkdirSync(path.join(personal, ".workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(personal, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(backendRepo)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(work, "targets.yaml"), workRegistryBody ?? targetYaml("api", workRemote), "utf8");
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
  return { root, framework, personal, work, backendRepo, config };
}

function boundBackendTask(taskId = "T-owner"): PersistedTask {
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  return newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    targetBindings: { targets: [{ target_id: "backend", role: AgentStage.BACKEND_ENGINEER }] },
  });
}

function unboundTask(taskId = "T-docs"): PersistedTask {
  const classification = classifyTask({ touchesBusinessRuleOnly: true });
  return newPersistedTask({ taskId, classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
}

const BACKEND = AgentStage.BACKEND_ENGINEER;

describe("preflightThreeRepoTask — cross-root ownership (DT §3.2)", () => {
  it("refuses the DT §3.2 draft conflict: HTTPS in the selected root vs SCP-like SSH in another root, different target_id", () => {
    const f = fixture("git@github.com:acme/api.git");
    expect(() =>
      preflightThreeRepoTask(boundBackendTask(), BACKEND, { frameworkRoot: f.framework, installationConfigPath: f.config }),
    ).toThrow(
      /Task "T-owner" refused: Target "backend" in root "personal" conflicts with Target "api" in root "work" for canonical repository "github\.com\/acme\/api"\. Resolve ownership through the human-gated transfer before run or resume\./,
    );
  });

  it("refuses the ssh:// spelling of the same repository and a case-only path variant", () => {
    const ssh = fixture("ssh://github.com/Acme/API.git");
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-ssh"), BACKEND, { frameworkRoot: ssh.framework, installationConfigPath: ssh.config }),
    ).toThrow(/Target "backend" in root "personal" conflicts with Target "api" in root "work"/);

    const caseOnly = fixture("https://github.com/acme/API.git");
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-case"), BACKEND, { frameworkRoot: caseOnly.framework, installationConfigPath: caseOnly.config }),
    ).toThrow(/for canonical repository "github\.com\/acme\/api"/);
  });

  it("passes a fork at a different endpoint and a non-default port as a different Target", () => {
    const fork = fixture("https://github.com/forkowner/api.git");
    const forkResolved = preflightThreeRepoTask(boundBackendTask("T-fork"), BACKEND, {
      frameworkRoot: fork.framework,
      installationConfigPath: fork.config,
    });
    expect(forkResolved.workRoots.map((entry) => entry.targetId)).toEqual(["backend"]);

    const ported = fixture("ssh://github.com:2222/acme/api.git");
    const portResolved = preflightThreeRepoTask(boundBackendTask("T-port"), BACKEND, {
      frameworkRoot: ported.framework,
      installationConfigPath: ported.config,
    });
    expect(portResolved.workRoots.map((entry) => entry.targetId)).toEqual(["backend"]);
  });

  it("a released tombstone in another root claims nothing and does not block", () => {
    const tombstone = fixture("", `schema_version: 2\ntargets:\n  - target_id: api\n    name: api\n    remote_url: https://github.com/acme/api.git\n    status: retired\n    ownership_state: released\n`);
    const resolved = preflightThreeRepoTask(boundBackendTask("T-released"), BACKEND, {
      frameworkRoot: tombstone.framework,
      installationConfigPath: tombstone.config,
    });
    expect(resolved.workRoots.map((entry) => entry.targetId)).toEqual(["backend"]);
  });

  it("another root's repository_aliases claim ownership too", () => {
    const aliasHistory = fixture(
      "https://github.com/acme/api.git",
      'schema_version: 2\ntargets:\n  - target_id: api\n    name: api\n    remote_url: https://github.com/acme/api.git\n    repository_aliases:\n      - git.example.com/legacy/api\n    status: active\n    ownership_state: owned\n',
    );
    // The selected root's bound Target answers to the coordinate work keeps
    // only as alias history.
    fs.writeFileSync(
      path.join(aliasHistory.personal, "targets.yaml"),
      targetYaml("backend", "https://git.example.com/legacy/api.git"),
      "utf8",
    );
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-alias"), BACKEND, { frameworkRoot: aliasHistory.framework, installationConfigPath: aliasHistory.config }),
    ).toThrow(/conflicts with Target "api" in root "work" for canonical repository "git\.example\.com\/legacy\/api"/);
  });

  it("an unreadable registry in another root refuses a bound task fail-closed, but never blocks an unbound task", () => {
    const broken = fixture("https://github.com/other/repo.git", ":: not yaml [");
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-broken"), BACKEND, { frameworkRoot: broken.framework, installationConfigPath: broken.config }),
    ).toThrow(/Cannot verify machine-local Target ownership: registry for root "work" is unreadable:/);

    expect(() =>
      preflightThreeRepoTask(unboundTask("T-unbound"), AgentStage.BUSINESS_ANALYST, {
        frameworkRoot: broken.framework,
        installationConfigPath: broken.config,
      }),
    ).not.toThrow();
  });

  it("an SSH alias remote without a machine-local mapping refuses fail-closed; with the mapping it detects the conflict", () => {
    const unmapped = fixture("https://github.com/other/repo.git");
    fs.writeFileSync(
      path.join(unmapped.personal, "targets.yaml"),
      targetYaml("backend", "git@github-work:acme/api.git"),
      "utf8",
    );
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-unmapped"), BACKEND, { frameworkRoot: unmapped.framework, installationConfigPath: unmapped.config }),
    ).toThrow(/uses SSH host alias "github-work" with no machine-local canonical-host mapping/);

    const mapped = fixture("https://github.com/acme/api.git");
    fs.writeFileSync(
      path.join(mapped.personal, "targets.yaml"),
      targetYaml("backend", "git@github-work:acme/api.git"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(mapped.personal, ".workflow", "targets.local.yaml"),
      `schema_version: 1\nremote_host_aliases:\n  github-work: github.com\ntargets:\n  backend:\n    path: ${JSON.stringify(mapped.backendRepo)}\n`,
      "utf8",
    );
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-mapped"), BACKEND, { frameworkRoot: mapped.framework, installationConfigPath: mapped.config }),
    ).toThrow(/conflicts with Target "api" in root "work" for canonical repository "github\.com\/acme\/api"/);
  });
});

describe("preflightThreeRepoTask — assertRemoteIdentity through the canonical coordinate (DT §3.2 item 4)", () => {
  it("the checkout's SCP-like origin matches an HTTPS registry remote_url; a different repository still refuses", () => {
    const f = fixture("https://github.com/other/repo.git");
    fs.writeFileSync(path.join(f.work, "targets.yaml"), targetYaml("api", "https://github.com/other/other.git"), "utf8");
    // origin is SCP-like SSH of the very same repository the registry names.
    fs.writeFileSync(path.join(f.backendRepo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n', "utf8");
    const resolved = preflightThreeRepoTask(boundBackendTask("T-origin"), BACKEND, {
      frameworkRoot: f.framework,
      installationConfigPath: f.config,
    });
    expect(resolved.workRoots).toEqual([{ targetId: "backend", path: f.backendRepo, access: "write" }]);

    fs.writeFileSync(path.join(f.backendRepo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/elsewhere.git\n', "utf8");
    expect(() =>
      preflightThreeRepoTask(boundBackendTask("T-origin"), BACKEND, { frameworkRoot: f.framework, installationConfigPath: f.config }),
    ).toThrow(/Target "backend".*expected canonical remote_url/);
  });
});
