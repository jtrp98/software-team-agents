/**
 * V10 TASK-010 — the enforcement these tests exercise is `packet.scope.allow`
 * at checkpoint, not the PreToolUse hook (D1). So every case drives the real
 * `checkpointTask` over a real Git fixture rather than asserting on globs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { runDeterministicVerification } from "../qa/deterministic.js";
import { buildRuntimeTask, stageWritesBoundTarget } from "../orchestrator/runtimeTask.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { FIXTURE_REVISION, fixtureTask, writePacketPlan } from "../runtime/packetFixture.testSupport.js";
import { contractGuards } from "../runtime/runtimeGuards.js";
import { generatePromptPreview } from "../views/generatedTaskViews.js";
import { AgentStage } from "../types.js";
import { GitCommandLayer } from "./commandLayer.js";
import { CheckpointRefusal, assertTaskContractPaths, checkpointTask } from "./checkpoint.js";

const REPO_ROOT = defaultProjectRoot();
const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Knowledge root holding the module docs, plus a Git-initialised Target checkout. */
function fixture() {
  const knowledge = temp("sta-target-scope-knowledge-");
  const target = temp("sta-target-scope-target-");
  const task = fixtureTask({ id: "T-TARGET-SCOPE" });
  writePacketPlan(knowledge, [...task.dependsOn.map((id) => fixtureTask({ id })), task], "packet-fixture", target);

  git(target, ["init", "-b", "main"]);
  git(target, ["config", "user.name", "Fixture"]);
  git(target, ["config", "user.email", "fixture@example.invalid"]);
  git(target, ["add", "--all", "--"]);
  git(target, ["commit", "-m", "initial", "--"]);

  const stage = AgentStage.BACKEND_ENGINEER;
  const runtimeTask = buildRuntimeTask({
    taskId: task.id,
    projectRoot: REPO_ROOT,
    docsRoot: knowledge,
    moduleName: "packet-fixture",
    workflow: "bugfix",
    classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
    targetWorkRoots: [{ stage, targetId: "fixture", path: target, access: "write" }],
  })!;
  const guards = contractGuards(stage, REPO_ROOT, target, { targetSide: stageWritesBoundTarget(runtimeTask, stage) });
  const packet = compileExecutionPacket({
    req: { stage, taskId: task.id, context: [] },
    role: stage,
    runtimeTask,
    contractScope: { allow: guards.writeAllow, deny: guards.writeDeny },
    baseRevision: FIXTURE_REVISION,
  });
  return { knowledge, target, stage, runtimeTask, guards, packet };
}

function checkpointInput(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    git: new GitCommandLayer({ cwd: f.target }),
    adapter: { status: "OK", exitCode: 0 } as const,
    writableRoots: [f.target],
    runVerification: () =>
      runDeterministicVerification((id) => ({ id, status: "PASS", durationMs: 1, outputSummary: "ok" })),
    runId: "run-target-scope",
    taskId: f.packet.task_id,
    module: "packet-fixture",
    planHash: f.runtimeTask.plan_hash,
    taskDescription: "write outside the old role×stack allowlist",
    allowedPathGlobs: f.packet.scope.allow,
    deniedPathGlobs: f.packet.scope.deny,
    secretScanner: () => ({ ok: true, problems: [] }),
    ...overrides,
  };
}

async function refusalKind(promise: Promise<unknown>): Promise<CheckpointRefusal["kind"]> {
  try {
    await promise;
    throw new Error("checkpoint unexpectedly created");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointRefusal);
    return (error as CheckpointRefusal).kind;
  }
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("V13 TASK-011 — packet scope on module/target", () => {
  it("scopes a writable Target work root by the role×stack allowlist — a root binding alone grants no path", () => {
    const f = fixture();
    // The fixture Target records no stack profile, so the scope is the
    // contract's role boundary alone; a Target with a recorded stack would
    // add its layout globs. Either way there is no Target-wide allow.
    expect(f.guards.writeAllow).toEqual(["README.md", "_docs/status.md", "_docs/status-archive.md"]);
    expect(f.packet.scope.allow).not.toContain("**");
  });

  it("keeps the Knowledge-side role contract for a stage with no writable Target root", () => {
    const knowledgeSide = contractGuards(AgentStage.BACKEND_ENGINEER, REPO_ROOT, REPO_ROOT);
    expect(knowledgeSide.writeAllow).toContain("server/**");
    expect(knowledgeSide.writeAllow).not.toContain("**");
  });

  it("never hands a stage with a writable root an empty allow list", () => {
    const f = fixture();
    expect(f.packet.scope.allow.length).toBeGreaterThan(0);
  });

  it("holds the exact packet/guard scope equality the executor asserts", () => {
    const f = fixture();
    expect(JSON.stringify([...f.packet.scope.allow].sort()))
      .toBe(JSON.stringify([...new Set(f.guards.writeAllow)].sort()));
    expect(f.packet.scope.roots.map((root) => path.resolve(root))).toEqual([path.resolve(f.target)]);
  });

  it("does not drift the generated prompt preview", () => {
    const f = fixture();
    const preview = generatePromptPreview(f.packet, {
      current_revision: f.packet.identity.base_revision,
      current_config_hash: f.packet.identity.config_hash,
      current_compiler_hash: f.packet.identity.compiler_hash,
      current_plan_hash: f.packet.identity.plan_hash,
    });
    expect(preview.state).toBe("executable");
    expect(preview.stale_reasons).toEqual([]);
    expect(preview.prompt.text).toBe(f.packet.text);
    expect(preview.prompt.hash).toBe(preview.persisted_packet.text_hash);
  });

  it("reads an empty allow list as 'nothing may be written', never as 'no restriction'", () => {
    expect(() => assertTaskContractPaths(["src/a.ts"], [])).toThrow(CheckpointRefusal);
    expect(() => assertTaskContractPaths(["src/a.ts"], [])).toThrow(/no writable path/);
  });

  it("applies the packet's deny half before its allow half", () => {
    expect(() => assertTaskContractPaths(["knowledge/x.md"], ["**"], ["knowledge/**"])).toThrow(/packet deny rule/);
    expect(() => assertTaskContractPaths(["src/a.ts"], ["**"], ["knowledge/**"])).not.toThrow();
  });

  it("refuses a write the role×stack allowlist does not grant, even inside the bound Target", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.target, "infra"), { recursive: true });
    fs.writeFileSync(path.join(f.target, "infra", "main.tf"), 'resource "null_resource" "a" {}\n');
    expect(await refusalKind(checkpointTask(checkpointInput(f)))).toBe("TASK_CONTRACT_VIOLATION");
    expect(git(f.target, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it.each([[".workflow/forged.json"], ["node_modules/evil.js"], ["dist/bundle.js"]])(
    "still refuses %s at DENIED_PATH under the scoped Target allow",
    async (relativePath) => {
      const f = fixture();
      const destination = path.join(f.target, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "forged\n");
      expect(await refusalKind(checkpointTask(checkpointInput(f)))).toBe("DENIED_PATH");
      expect(git(f.target, ["diff", "--cached", "--name-only"])).toBe("");
    },
  );

  it.each([["knowledge/policy.md"], ["decisions/ADR-999.md"], ["_docs/module/packet-fixture/design.md"]])(
    "refuses a Knowledge artifact at %s even when it sits inside the Target",
    async (relativePath) => {
      const f = fixture();
      const destination = path.join(f.target, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "engineer-authored analysis\n");
      expect(await refusalKind(checkpointTask(checkpointInput(f)))).toBe("DENIED_PATH");
      expect(git(f.target, ["diff", "--cached", "--name-only"])).toBe("");
    },
  );

  it("refuses a write to the Knowledge repository itself before any contract check", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.knowledge, "_docs", "module", "packet-fixture", "requirement.md"), "rewritten\n");
    // Nothing in the Target changed, so the refusal is NO_CHANGES: a Knowledge
    // path is not even a candidate for this attempt's checkpoint.
    expect(await refusalKind(checkpointTask(checkpointInput(f)))).toBe("NO_CHANGES");
  });
});
