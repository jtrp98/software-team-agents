import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codexAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { detectRuntimeCapabilities } from "./runtimeCapabilityDetection.js";
import { resolveRuntimeRoute } from "./runtimeRouting.js";
import { AgentStage } from "../types.js";
import { createSta } from "../execute/execute.js";
import { captureChangeSetFingerprint } from "../qa/changeSource.js";
import { seedRealContracts } from "../testing/contractFixtures.js";
import { writeTargetConfig } from "../targetcli/targetMeta.js";
import type { RuntimeAgentRequest, SpawnSync } from "./runtimeAdapter.js";

// Exercise real file edits and lifecycle checks with filesystem snapshots,
// without creating Git state or invoking an AI provider in a unit test.
vi.mock("../qa/changeSource.js", async (original) => ({
  ...await original<typeof import("../qa/changeSource.js")>(),
  captureChangeSetFingerprint: vi.fn(),
}));

let fixture: string;
let project: string;
let spawns: number;

function fileHashes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files[path.relative(root, absolute).replaceAll("\\", "/")] = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    }
  }
  walk(root);
  return files;
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codex-engineer-"));
  project = path.join(fixture, "project");
  fs.mkdirSync(project);
  spawns = 0;
  vi.mocked(captureChangeSetFingerprint).mockReset().mockImplementation(async (input) => {
    const roots = typeof input === "string" ? [{ path: input }] : input;
    const files: Record<string, string> = {};
    for (const root of roots) {
      for (const [file, hash] of Object.entries(fileHashes(root.path))) files[roots.length > 1 ? `${root.targetId}:${file}` : file] = hash;
    }
    return { files };
  });
});

afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

function adapter(write: () => void): CodexAdapter {
  const spawnSync: SpawnSync = (_command, args) => {
    if (args.includes("--version")) return { status: 0, stdout: "codex-cli test", stderr: "" } as ReturnType<SpawnSync>;
    spawns += 1;
    write();
    return { status: 0, stdout: "done", stderr: "" } as ReturnType<SpawnSync>;
  };
  return new CodexAdapter({ projectRoot: project, spawnSync, journalRoot: path.join(fixture, "journal") });
}

function request(overrides: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return { taskId: "BE-CODEX", cwd: project, prompt: "implement the task", autonomy: "edit", guards: { writeAllow: ["src/**"], writeDeny: [], forbidCommands: ["git"], exitChecks: [] }, ...overrides };
}

function write(file: string, content = "export {};"): void {
  const target = path.join(project, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("Codex engineer post-run write path", () => {
  it("routes both engineer roles with verified post-run capability, without pre-tool certification", async () => {
    const runtime = adapter(() => {});
    const report = await detectRuntimeCapabilities(runtime, { probe: { available: true } });
    const verified = new Set(report.checks.filter((check) => check.verified).map((check) => check.capability));
    expect(verified.has(RuntimeCapability.POST_RUN_WRITE_GUARD)).toBe(true);
    expect(verified.has(RuntimeCapability.PRE_TOOL_GUARD)).toBe(false);
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const route = resolveRuntimeRoute({ stage, role: stage, projectRoot: project, registry: new RuntimeRegistry([runtime]), config: null, flags: { runtime: "codex" }, modelPolicy: null, hasTargetWrite: true, verifiedCapabilities: { codex: verified } });
      expect(route.error).toBeUndefined();
      expect(route.selected?.runtime.id).toBe("codex");
    }
  });

  it("accepts an allowed file and preserves honest guard reporting and evidence", async () => {
    const runtime = adapter(() => write("src/order.ts"));
    const attempt = await runtime.prepare(request());
    const result = await runtime.execute(attempt);
    expect(result.status).toBe("OK");
    expect(result.guards.enforced).toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
    expect(result.guards.enforced).not.toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect((await runtime.collectEvidence(attempt)).changedFiles).toEqual(["src/order.ts"]);
  });

  it.each(["outside.txt", "_docs/module/orders/plan.md", ".env.production"])("rejects an out-of-scope write to %s even when the CLI reports success", async (file) => {
    const runtime = adapter(() => write(file));
    const result = await runtime.execute(await runtime.prepare(request()));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/postflight/);
    expect(fs.existsSync(path.join(project, file))).toBe(true); // Detection does not roll the write back.
  });

  it("refuses before spawn when the baseline snapshot is unavailable", async () => {
    vi.mocked(captureChangeSetFingerprint).mockRejectedValue(new Error("unusable checkout"));
    const runtime = adapter(() => write("src/order.ts"));
    const result = await runtime.execute(await runtime.prepare(request()));
    expect(result.status).toBe("ERROR");
    expect(spawns).toBe(0);
    expect(result.guards.enforced).not.toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
  });

  it("rejects a missing post-run snapshot and does not certify the guard", async () => {
    const runtime = adapter(() => { write("src/order.ts"); vi.mocked(captureChangeSetFingerprint).mockRejectedValue(new Error("snapshot lost")); });
    const result = await runtime.execute(await runtime.prepare(request()));
    expect(result.status).toBe("ERROR");
    expect(result.guards.enforced).not.toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
  });

  it("rejects mutations to the read-only Knowledge workspace during a Target run", async () => {
    seedRealContracts(project);
    const target = path.join(fixture, "target");
    fs.mkdirSync(target);
    const runtime = adapter(() => write("_docs/requirement.md", "forged"));
    const result = await runtime.execute(await runtime.prepare(request({ cwd: target, bindingRoot: project, role: "backend-engineer", knowledgeRoot: project, workRoots: [{ targetId: "backend", path: target, access: "write" }] })));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/read-only root/);
  });

  it.each([true, false])("checks Target edits against the engineer contract and stack: allowed=%s", async (allowed) => {
    seedRealContracts(project);
    fs.mkdirSync(path.join(project, "stacks", "node"), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../../../stacks/node/stack.yaml"), path.join(project, "stacks", "node", "stack.yaml"));
    const target = path.join(fixture, "target");
    fs.mkdirSync(target);
    writeTargetConfig(target, {
      schema_version: 1, target_id: "backend", registered_at: "fixture", overrides: [],
      stack: { profile: "node", package_manager: "npm", commands: { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" }, schema_paths: [], source_roots: ["."], detected_at: "fixture", fingerprint: `sha256:${"0".repeat(64)}` },
    });
    const runtime = adapter(() => {
      const file = path.join(target, allowed ? "src/lib/order.ts" : "src/components/order.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {};");
    });
    const result = await runtime.execute(await runtime.prepare(request({ cwd: target, bindingRoot: project, role: "backend-engineer", knowledgeRoot: project, guards: { writeAllow: [], writeDeny: [], forbidCommands: ["git"], exitChecks: [] }, workRoots: [{ targetId: "backend", path: target, access: "write" }] })));
    expect(result.status, result.diagnostics.join("\n")).toBe(allowed ? "OK" : "ERROR");
    if (!allowed) expect(result.diagnostics.join(" ")).toMatch(/not covered by this role/);
  });

  it("direct execution enforces the post-run guard and no-hardcoded-secret exit check", async () => {
    // Generate disposable synthetic data so this test never embeds a credential literal.
    const syntheticValue = randomBytes(16).toString("hex");
    const runtime = adapter(() => write("src/order.ts", `const password = ${JSON.stringify(syntheticValue)};`));
    const sta = createSta({ registry: new RuntimeRegistry([runtime]), cwd: project, runStore: path.join(fixture, "store"), env: {} });
    const result = await sta.execute({ runtime: "codex", task: "implement", permissions: { write: true, writePaths: ["src/**"] } });
    expect(result.status).toBe("failed");
    expect(result.evidence.diagnostics.join(" ")).toMatch(/no-hardcoded-secret: FAIL/);
  });

  it("direct engineer execution refuses a failing typecheck after a permitted edit", async () => {
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(1)"' } }));
    fs.mkdirSync(path.join(project, ".codex", "agents"), { recursive: true });
    fs.writeFileSync(path.join(project, ".codex", "agents", "backend-engineer.toml"), 'name = "backend-engineer"\ndescription = "test"\ndeveloper_instructions = "implement the task"\n');
    const runtime = adapter(() => write("src/order.ts"));
    const sta = createSta({ registry: new RuntimeRegistry([runtime]), cwd: project, runStore: path.join(fixture, "store"), env: {} });
    const result = await sta.execute({ runtime: "codex", role: "backend-engineer", task: "implement", permissions: { write: true, writePaths: ["src/**"] } });
    expect(result.status).toBe("failed");
    expect(result.evidence.diagnostics.join(" ")).toMatch(/code-green: FAIL/);
  });
});
