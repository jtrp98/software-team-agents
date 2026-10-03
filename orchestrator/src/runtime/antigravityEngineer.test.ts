import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAdapter } from "./antigravityAdapter.js";
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

vi.mock("../qa/changeSource.js", async (original) => ({
  ...await original<typeof import("../qa/changeSource.js")>(),
  captureChangeSetFingerprint: vi.fn(),
}));

let fixture: string;
let project: string;
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

const SUCCESS_ENVELOPE = JSON.stringify({
  conversation_id: "11dbde93-bd0b-4643-8e03-6509ae35635b",
  status: "SUCCESS",
  response: "DONE\n",
  duration_seconds: 1.0,
  num_turns: 1,
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
});

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agy-engineer-"));
  project = path.join(fixture, "project");
  fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "agents", "backend-engineer.md"), "---\nname: backend-engineer\n---\nROLE INSTRUCTIONS\n");
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

function adapter(write: () => void): AntigravityAdapter {
  const spawnSync: SpawnSync = (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "1.1.27\n", stderr: "" } as ReturnType<SpawnSync>;
    runs += 1;
    write();
    return { status: 0, stdout: SUCCESS_ENVELOPE, stderr: "" } as ReturnType<SpawnSync>;
  };
  return new AntigravityAdapter({
    projectRoot: project,
    spawnSync,
    journalRoot: path.join(fixture, "journal"),
  });
}

function request(overrides: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    taskId: "BE-AGY",
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

describe("Antigravity engineer post-run write path", () => {
  it("routes both engineer roles with verified post-run capability, without pre-tool certification", async () => {
    const runtime = adapter(() => {});
    const report = await detectRuntimeCapabilities(runtime, { probe: { available: true } });
    const verified = new Set(report.checks.filter((check) => check.verified).map((check) => check.capability));
    expect(verified.has(RuntimeCapability.POST_RUN_WRITE_GUARD)).toBe(true);
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const route = resolveRuntimeRoute({
        stage,
        role: stage,
        projectRoot: project,
        registry: new RuntimeRegistry([runtime]),
        config: null,
        flags: { runtime: "antigravity" },
        modelPolicy: null,
        hasTargetWrite: true,
        verifiedCapabilities: { antigravity: verified },
      });
      expect(route.error).toBeUndefined();
      expect(route.selected?.runtime.id).toBe("antigravity");
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
    const runtime = adapter(() => {
      write("src/order.ts");
      vi.mocked(captureChangeSetFingerprint).mockRejectedValue(new Error("snapshot lost"));
    });
    const result = await runtime.execute(await runtime.prepare(request()));
    expect(result.status).toBe("ERROR");
    expect(result.guards.enforced).not.toContain(RuntimeCapability.POST_RUN_WRITE_GUARD);
  });

  it("rejects mutations to the read-only Knowledge workspace during a Target run", async () => {
    seedRealContracts(project);
    const target = path.join(fixture, "target");
    fs.mkdirSync(target);
    const runtime = adapter(() => write("_docs/requirement.md", "forged"));
    const result = await runtime.execute(await runtime.prepare(request({
      cwd: target,
      bindingRoot: project,
      knowledgeRoot: project,
      workRoots: [{ targetId: "backend", path: target, access: "write" }],
    })));
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
      schema_version: 1,
      target_id: "backend",
      registered_at: "fixture",
      overrides: [],
      stack: {
        profile: "node",
        package_manager: "npm",
        commands: { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" },
        schema_paths: [],
        source_roots: ["."],
        detected_at: "fixture",
        fingerprint: `sha256:${"0".repeat(64)}`,
      },
    });
    const runtime = adapter(() => {
      const file = path.join(target, allowed ? "src/lib/order.ts" : "src/components/order.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {};");
    });
    const result = await runtime.execute(await runtime.prepare(request({
      cwd: target,
      bindingRoot: project,
      guards: { writeAllow: [], writeDeny: [], forbidCommands: ["git"], exitChecks: [] },
      workRoots: [{ targetId: "backend", path: target, access: "write" }],
    })));
    expect(result.status, result.diagnostics.join("\n")).toBe(allowed ? "OK" : "ERROR");
    if (!allowed) expect(result.diagnostics.join(" ")).toMatch(/not covered by this role/);
  });

  it("direct execution refuses a run whose write falls outside the granted paths", async () => {
    const syntheticValue = randomBytes(16).toString("hex");
    const runtime = adapter(() => write("outside.txt", `const password = ${JSON.stringify(syntheticValue)};`));
    const sta = createSta({ registry: new RuntimeRegistry([runtime]), cwd: project, runStore: path.join(fixture, "store"), env: {} });
    const result = await sta.execute({
      runtime: "antigravity",
      role: "backend-engineer",
      task: "implement",
      permissions: { write: true, writePaths: ["src/**"] },
    });
    expect(result.status).toBe("failed");
    expect(result.evidence.diagnostics.join(" ")).toMatch(/postflight/);
  });
});
