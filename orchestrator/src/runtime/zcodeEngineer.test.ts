import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderZcodeConfigJson } from "./bindingGenerator.js";
import { ZcodeAdapter, managedZcodeHooks } from "./zcodeAdapter.js";
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
// without creating Git state or invoking an AI provider in a unit test. The
// ZCode CLI itself is a fake spawn answering --version, `hooks trust status`
// (all managed hooks trusted) and `-p --json` with a parsable summary — the
// same live shapes zcodeAdapter.test.ts pins.
vi.mock("../qa/changeSource.js", async (original) => ({
  ...await original<typeof import("../qa/changeSource.js")>(),
  captureChangeSetFingerprint: vi.fn(),
}));

let fixture: string;
let project: string;
let entry: string;
let home: string;
let runs: number;

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

const SUMMARY = JSON.stringify({
  sessionId: "sess_11111111-2222-3333-4444-555555555555",
  response: "DONE",
  usage: { inputTokens: 120, outputTokens: 7 },
  projection: { status: "completed" },
});

function trustStatus(): string {
  return JSON.stringify({
    workspacePath: "W",
    workspaceIdentity: "W",
    bundleDigest: "b".repeat(64),
    reasonCode: "workspace_hooks_trusted",
    items: managedZcodeHooks().map(({ event, script }, index) => ({
      reviewItemId: `workspace-hook-${index}`,
      event,
      matcher: null,
      displayCommand: `node \${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}`,
      sourcePath: ".zcode/config.json",
      configuredEnabled: true,
      hookDeclarationDigest: String(index).repeat(64).slice(0, 64),
      trustState: "trusted_persistent",
    })),
  });
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-engineer-"));
  project = path.join(fixture, "project");
  fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "agents", "backend-engineer.md"), "---\nname: backend-engineer\n---\nROLE INSTRUCTIONS\n");
  fs.mkdirSync(path.join(project, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(project, ".zcode", "config.json"), renderZcodeConfigJson());
  const install = path.join(fixture, "install", "resources");
  fs.mkdirSync(path.join(install, "glm"), { recursive: true });
  fs.mkdirSync(path.join(install, "config", "provider"), { recursive: true });
  fs.writeFileSync(path.join(install, "glm", "zcode.cjs"), "// fake zcode entry\n");
  fs.writeFileSync(path.join(install, "config", "provider", "zcode-builtin.json"), "{}\n");
  entry = path.join(install, "glm", "zcode.cjs");
  home = path.join(fixture, "home");
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "v2", "provider_config.json"), "{}\n");
  runs = 0;
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

function adapter(write: () => void, trust: string = trustStatus()): ZcodeAdapter {
  const spawnSync: SpawnSync = (_command, args) => {
    const rest = args.slice(1);
    if (rest[0] === "--version") return { status: 0, stdout: "0.16.9\n", stderr: "" } as ReturnType<SpawnSync>;
    if (rest[0] === "hooks") return { status: 0, stdout: trust, stderr: "" } as ReturnType<SpawnSync>;
    runs += 1;
    write();
    return { status: 0, stdout: SUMMARY, stderr: "" } as ReturnType<SpawnSync>;
  };
  return new ZcodeAdapter({
    projectRoot: project,
    cliEntry: entry,
    nodePath: "node",
    spawnSync,
    env: { USERPROFILE: home, HOME: home },
    platform: "linux",
    journalRoot: path.join(fixture, "journal"),
  });
}

function request(overrides: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    taskId: "BE-ZCODE",
    role: "backend-engineer",
    definitionPath: ".claude/agents/backend-engineer.md",
    cwd: project,
    prompt: "implement the task",
    autonomy: "edit",
    guards: { writeAllow: ["src/**"], writeDeny: [], forbidCommands: ["git"], exitChecks: [] },
    ...overrides,
  };
}

function write(file: string, content = "export {};"): void {
  const target = path.join(project, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A synced checkout carries the guard payload the adapter's preflight requires of its cwd. */
function syncZcodePayload(root: string): void {
  fs.mkdirSync(path.join(root, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zcode", "config.json"), renderZcodeConfigJson());
}

describe("ZCode engineer post-run write path", () => {
  it("routes both engineer roles with verified post-run capability, without pre-tool certification", async () => {
    const runtime = adapter(() => {});
    const report = await detectRuntimeCapabilities(runtime, { probe: { available: true } });
    const verified = new Set(report.checks.filter((check) => check.verified).map((check) => check.capability));
    expect(verified.has(RuntimeCapability.POST_RUN_WRITE_GUARD)).toBe(true);
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const route = resolveRuntimeRoute({ stage, role: stage, projectRoot: project, registry: new RuntimeRegistry([runtime]), config: null, flags: { runtime: "zcode" }, modelPolicy: null, hasTargetWrite: true, verifiedCapabilities: { zcode: verified } });
      expect(route.error).toBeUndefined();
      expect(route.selected?.runtime.id).toBe("zcode");
    }
  });

  it("accepts an allowed file, certifies the post-run guard, and preserves honest evidence", async () => {
    const runtime = adapter(() => write("src/order.ts"));
    const attempt = await runtime.prepare(request());
    const result = await runtime.execute(attempt);
    expect(result.status).toBe("OK");
    expect(result.guards.enforced).toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
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
    expect(runs).toBe(0);
    expect(result.guards.enforced).not.toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
  });

  it("rejects a missing post-run snapshot and does not certify the guard", async () => {
    const runtime = adapter(() => { write("src/order.ts"); vi.mocked(captureChangeSetFingerprint).mockRejectedValue(new Error("snapshot lost")); });
    const result = await runtime.execute(await runtime.prepare(request()));
    expect(result.status).toBe("ERROR");
    expect(result.guards.enforced).not.toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
  });

  it("refuses before spawn when a STA guard hook is not persistently trusted", async () => {
    const pending = JSON.parse(trustStatus());
    pending.reasonCode = "workspace_hooks_pending_trust";
    pending.items[0].trustState = "pending_trust";
    const runtime = adapter(() => write("src/order.ts"), JSON.stringify(pending));
    const result = await runtime.executeAgent(request());
    expect(result.status).toBe("ERROR");
    expect(runs).toBe(0);
    expect(result.diagnostics.join(" ")).toMatch(/not trusted_persistent/);
  });

  it("rejects mutations to the read-only Knowledge workspace during a Target run", async () => {
    seedRealContracts(project);
    const target = path.join(fixture, "target");
    fs.mkdirSync(target);
    syncZcodePayload(target);
    const runtime = adapter(() => write("_docs/requirement.md", "forged"));
    const result = await runtime.execute(await runtime.prepare(request({ cwd: target, bindingRoot: project, knowledgeRoot: project, workRoots: [{ targetId: "backend", path: target, access: "write" }] })));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/read-only root/);
  });

  it.each([true, false])("checks Target edits against the engineer contract and stack: allowed=%s", async (allowed) => {
    seedRealContracts(project);
    fs.mkdirSync(path.join(project, "stacks", "node"), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../../../stacks/node/stack.yaml"), path.join(project, "stacks", "node", "stack.yaml"));
    const target = path.join(fixture, "target");
    fs.mkdirSync(target);
    syncZcodePayload(target);
    writeTargetConfig(target, {
      schema_version: 1, target_id: "backend", registered_at: "fixture", overrides: [],
      stack: { profile: "node", package_manager: "npm", commands: { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" }, schema_paths: [], source_roots: ["."], detected_at: "fixture", fingerprint: `sha256:${"0".repeat(64)}` },
    });
    const runtime = adapter(() => {
      const file = path.join(target, allowed ? "src/lib/order.ts" : "src/components/order.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {};");
    });
    const result = await runtime.execute(await runtime.prepare(request({ cwd: target, bindingRoot: project, guards: { writeAllow: [], writeDeny: [], forbidCommands: ["git"], exitChecks: [] }, workRoots: [{ targetId: "backend", path: target, access: "write" }] })));
    expect(result.status, result.diagnostics.join("\n")).toBe(allowed ? "OK" : "ERROR");
    if (!allowed) expect(result.diagnostics.join(" ")).toMatch(/not covered by this role/);
  });

  it("direct execution refuses a run whose write falls outside the granted paths", async () => {
    // Generate disposable synthetic data so this test never embeds a credential literal.
    const syntheticValue = randomBytes(16).toString("hex");
    const runtime = adapter(() => write("outside.txt", `const password = ${JSON.stringify(syntheticValue)};`));
    const sta = createSta({ registry: new RuntimeRegistry([runtime]), cwd: project, runStore: path.join(fixture, "store"), env: {} });
    const result = await sta.execute({ runtime: "zcode", role: "backend-engineer", task: "implement", permissions: { write: true, writePaths: ["src/**"] } });
    expect(result.status).toBe("failed");
    expect(result.evidence.diagnostics.join(" ")).toMatch(/postflight/);
  });
});
