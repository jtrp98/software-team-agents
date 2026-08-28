import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ApiAdapter } from "./apiAdapter.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { NO_GUARDS, type RuntimeAgentRequest } from "./runtimeAdapter.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-adapter-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "backend-engineer.md"), "canonical role instructions", "utf8");
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function request(root: string): RuntimeAgentRequest {
  return {
    role: "backend-engineer",
    cwd: root,
    definitionPath: ".claude/agents/backend-engineer.md",
    prompt: "task prompt",
    model: "paid-model",
    autonomy: "read-only",
    guards: { writeAllow: ["src/**"], writeDeny: [".git/**"], forbidCommands: ["git"], exitChecks: ["code-green"] },
    env: { AGENTCLAUDE_ROLE: "backend-engineer", AGENTCLAUDE_WRITABLE_WORK_ROOTS: "[]" },
  };
}

describe("ApiAdapter — paid path safety", () => {
  it("implements RuntimeAdapter without claiming any guard capability", () => {
    const adapter = new ApiAdapter({ projectRoot: fixture() });
    for (const capability of [
      RuntimeCapability.PRE_TOOL_GUARD,
      RuntimeCapability.POST_TOOL_GUARD,
      RuntimeCapability.EXIT_GUARD,
      RuntimeCapability.PER_AGENT_EXIT_GUARD,
    ]) {
      expect(adapter.capabilities.has(capability), capability).toBe(false);
    }
    expect(adapter.binding.guardConfigPath).toBeNull();
  });

  it("passes role context and caller env to a mocked official transport without modification", async () => {
    const root = fixture();
    let observed: RuntimeAgentRequest | undefined;
    const adapter = new ApiAdapter({
      projectRoot: root,
      probe: async () => ({ available: true }),
      invoke: async (input) => {
        observed = input;
        return { status: "OK", exitCode: 0, text: "done", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [] };
      },
    });
    const result = await adapter.executeAgent(request(root));
    expect(result.status).toBe("OK");
    expect(observed?.prompt).toContain("canonical role instructions");
    expect(observed?.prompt).toContain("task prompt");
    expect(observed?.env).toEqual(request(root).env);
    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(result.guards.unenforced).toContain(RuntimeCapability.EXIT_GUARD);
  });

  it("normalizes an unavailable mocked transport and never throws", async () => {
    const root = fixture();
    const adapter = new ApiAdapter({
      projectRoot: root,
      probe: async () => ({ available: true }),
      invoke: async () => { throw new Error("mock network unavailable"); },
    });
    await expect(adapter.executeAgent(request(root))).resolves.toMatchObject({ status: "UNAVAILABLE" });
  });

  it("refuses a Target-write stage before the mocked transport is invoked", async () => {
    const root = fixture();
    let calls = 0;
    const adapter = new ApiAdapter({
      projectRoot: root,
      probe: async () => ({ available: true }),
      invoke: async () => {
        calls += 1;
        return { status: "OK", exitCode: 0, text: "done", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [] };
      },
    });
    const executor = createRuntimeExecutor({
      runtime: adapter,
      registry: new RuntimeRegistry([adapter]),
      routingFlags: { runtime: "paid-api", model: "paid-model" },
      routingMode: "single",
      allowPaidFallback: true,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
      threeRepoTask: () => ({
        task: { taskId: "T-API-WRITE" } as never,
        roots: {
          bindingRoot: root,
          knowledgeRoot: path.join(root, "knowledge"),
          workRoots: [{ targetId: "target", path: path.join(root, "target"), access: "write" }],
        },
      }),
    });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-API-WRITE", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(calls).toBe(0);
  });
});
