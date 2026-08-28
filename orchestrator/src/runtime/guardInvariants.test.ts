import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { defaultStaConfig } from "../packaging/staConfig.js";
import { contractGuards } from "./runtimeGuards.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import type { RuntimeGuards } from "./runtimeAdapter.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { compileExecutionPacket } from "./agentRunAssembly.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { createProductionRuntimeRegistry } from "../cli.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNTIME_ROOT = path.join(REPO_ROOT, "orchestrator", "src", "runtime");
const roots: string[] = [];

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guard-invariants-"));
  roots.push(root);
  return root;
}

function concreteAdapterSources(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(RUNTIME_ROOT)
    .filter((name) => name.endsWith("Adapter.ts") && name !== "runtimeAdapter.ts")
    .map((name) => ({ file: name, source: fs.readFileSync(path.join(RUNTIME_ROOT, name), "utf8") }))
    .filter(({ source }) => /implements\s+RuntimeAdapter\b/.test(source));
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("T-V3R-001 guardrail invariants", () => {
  it("criterion 2 — execution packet and adapter scopes are subsets of the role contract", async () => {
    const roles = Object.values(AgentStage).filter((stage) => stage !== AgentStage.HUMAN);
    expect(roles.length).toBeGreaterThan(0);
    for (const stage of roles) {
      const role = stage;
      const contract = contractGuards(role, REPO_ROOT);
      const runtimeTask: RuntimeTask = {
        task_id: `T-SCOPE-${role}`,
        workflow: "scope-invariant",
        pm_mode: "lightweight",
        why: "prove packet scope",
        goal: "prove packet scope",
        source_of_truth: { status: "unavailable", paths: [], reason: "fixture" },
        dependencies: { task_ids: [], plan_readiness: "untracked", waiting_on: [], reason: "fixture" },
        scope: {
          status: "resolved",
          work_roots: [{
            stage,
            target_id: "fixture",
            root: tempProject(),
            allow: [
              ...contract.writeAllow.map((glob) => ({ contract_glob: glob, effective_glob: `fixture/${glob}` })),
              { contract_glob: "widened/**", effective_glob: "fixture/widened/**" },
            ],
          }],
          reason: null,
        },
        do_not_touch: contract.writeDeny.length > 0 ? [...contract.writeDeny] : [".git/**"],
        acceptance_criteria: { status: "resolved", items: ["scope stays narrow"], reason: null },
        required_verification: { status: "deferred", levels: [], reason: "fixture" },
        evidence_required: ["packet scope"],
        stop_conditions: ["STOP on scope widening"],
      };
      const packet = compileExecutionPacket({
        req: { stage, taskId: runtimeTask.task_id, context: [] },
        role,
        runtimeTask,
        contractScope: { allow: contract.writeAllow, deny: contract.writeDeny },
      });
      expect(packet.scope.allow, role).not.toContain("widened/**");
      for (const glob of packet.scope.allow) expect(contract.writeAllow, `${role}: packet ${glob}`).toContain(glob);

      const runtime = new MockRuntimeAdapter();
      const executor = createRuntimeExecutor({
        runtime,
        projectRoot: tempProject(),
        moduleName: () => "phase-0",
        guards: () => contract,
        sliceModuleDocs: false,
      });
      await executor({ stage, taskId: `T-SCOPE-${role}`, context: [] });
      const effectiveScope = runtime.requests[0]?.guards.writeAllow;
      expect(effectiveScope, role).toBeDefined();
      for (const glob of effectiveScope ?? []) expect(contract.writeAllow, `${role}: ${glob}`).toContain(glob);
    }
  });

  it("criterion 4 — no concrete adapter source reads a known credential path or auth-token environment variable", () => {
    const adapters = concreteAdapterSources();
    expect(adapters.map(({ file }) => file).sort()).toEqual([
      "apiAdapter.ts",
      "claudeCodeAdapter.ts",
      "codexAdapter.ts",
      "mockAdapter.ts",
      "openCodeAdapter.ts",
    ]);
    const forbidden = /(?:ANTHROPIC|CLAUDE|OPENAI|CODEX|OPENCODE)_(?:API_KEY|AUTH_TOKEN)|AWS_SHARED_CREDENTIALS_FILE|GOOGLE_APPLICATION_CREDENTIALS|["'`](?:\.ssh|\.aws)[\\/]|credentials\.json/gi;
    const violations = adapters.flatMap(({ file, source }) => [...source.matchAll(forbidden)].map((match) => `${file}: ${match[0]}`));
    expect(violations).toEqual([]);
  });

  it("criterion 5 — paid fallback defaults false and production cannot reach ApiAdapter without opt-in", () => {
    const config = defaultStaConfig();
    expect(config.execution?.allow_paid_fallback ?? false).toBe(false);
    expect(createProductionRuntimeRegistry(REPO_ROOT).ids()).not.toContain("paid-api");
    expect(createProductionRuntimeRegistry(REPO_ROOT, { allowPaidFallback: true }).ids()).toContain("paid-api");
  });

  it("criterion 6 — an unregistered-runtime fallback preserves the exact RuntimeGuards object", async () => {
    const projectRoot = tempProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "config.yaml"),
      "schema_version: 1\nmodel_routing:\n  backend-engineer: missing-runtime:some-model\n",
      "utf8",
    );
    const guards: RuntimeGuards = Object.freeze({
      writeAllow: Object.freeze(["server/**"]),
      writeDeny: Object.freeze([".git/**"]),
      forbidCommands: Object.freeze(["git"]),
      exitChecks: Object.freeze(["code-green"] as const),
    });
    const before = JSON.parse(JSON.stringify(guards)) as RuntimeGuards;
    const fallback = new MockRuntimeAdapter({ id: "claude-code", models: ["some-model"] });
    const executor = createRuntimeExecutor({
      runtime: fallback,
      registry: new RuntimeRegistry([fallback]),
      projectRoot,
      moduleName: () => "phase-0",
      guards: () => guards,
      sliceModuleDocs: false,
    });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-FALLBACK-GUARDS", context: [] });
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.requests[0].guards).toBe(guards);
    expect(guards).toEqual(before);
  });
});
