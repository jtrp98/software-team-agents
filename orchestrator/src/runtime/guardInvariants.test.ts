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

function productionTypescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypescriptFiles(absolute));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(absolute);
  }
  return files;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("T-V3R-001 guardrail invariants", () => {
  it("criterion 2 — execution scope is always a subset of the role contract, with a tripwire for the future packet scope", async () => {
    const packetImplementations = productionTypescriptFiles(path.join(REPO_ROOT, "orchestrator", "src"))
      .filter((file) => /\b(?:interface|type|class)\s+ExecutionPacket\b/.test(fs.readFileSync(file, "utf8")));
    expect(
      packetImplementations,
      "ExecutionPacket now exists: replace the Phase-0 tripwire with an assertion over its declared scope before landing it",
    ).toEqual([]);

    const roles = Object.values(AgentStage).filter((stage) => stage !== AgentStage.HUMAN);
    expect(roles.length).toBeGreaterThan(0);
    for (const stage of roles) {
      const role = stage;
      const contract = contractGuards(role, REPO_ROOT);
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
      "claudeCodeAdapter.ts",
      "codexAdapter.ts",
      "mockAdapter.ts",
      "openCodeAdapter.ts",
    ]);
    const forbidden = /(?:ANTHROPIC|CLAUDE|OPENAI|CODEX|OPENCODE)_(?:API_KEY|AUTH_TOKEN)|AWS_SHARED_CREDENTIALS_FILE|GOOGLE_APPLICATION_CREDENTIALS|["'`](?:\.ssh|\.aws)[\\/]|credentials\.json/gi;
    const violations = adapters.flatMap(({ file, source }) => [...source.matchAll(forbidden)].map((match) => `${file}: ${match[0]}`));
    expect(violations).toEqual([]);
  });

  it("criterion 5 — paid fallback defaults false and no API-backed adapter is reachable before its opt-in mechanism exists", () => {
    const config = defaultStaConfig() as ReturnType<typeof defaultStaConfig> & { allow_paid_fallback?: boolean };
    expect(config.allow_paid_fallback ?? false).toBe(false);

    const apiAdapterImplementations = productionTypescriptFiles(path.join(REPO_ROOT, "orchestrator", "src"))
      .filter((file) => /\bclass\s+\w*ApiAdapter\b/.test(fs.readFileSync(file, "utf8")));
    expect(
      apiAdapterImplementations,
      "an API adapter now exists: this invariant must be replaced with a production allow_paid_fallback gate assertion",
    ).toEqual([]);
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
