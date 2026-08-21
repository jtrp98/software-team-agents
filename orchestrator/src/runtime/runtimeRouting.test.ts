import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { RuntimeRouteUnresolvedError, parseModelRoute, requiredCapabilitiesFor, resolveRuntimeRoute } from "./runtimeRouting.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-routing-"));
}

function writeRoleFrontmatter(root: string, role: string, model: string) {
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), `---\nmodel: ${model}\nversion: 1\n---\nbody`, "utf8");
}

describe("parseModelRoute", () => {
  it("treats a plain model name as same-runtime, no override", () => {
    expect(parseModelRoute("opus")).toEqual({ model: "opus" });
  });

  it("splits runtime:model on the first colon", () => {
    expect(parseModelRoute("codex:o4-mini")).toEqual({ runtimeId: "codex", model: "o4-mini" });
  });

  it("does not treat a leading colon as a runtime id", () => {
    expect(parseModelRoute(":weird")).toEqual({ model: ":weird" });
  });
});

describe("requiredCapabilitiesFor", () => {
  it("flags INTERACTIVE_PROMPTS for a stage whose registry entry lists AskUserQuestion", () => {
    expect(requiredCapabilitiesFor(AgentStage.BUSINESS_ANALYST)).toContain(RuntimeCapability.INTERACTIVE_PROMPTS);
  });

  it("does not flag it for a stage with no AskUserQuestion tool", () => {
    expect(requiredCapabilitiesFor(AgentStage.BACKEND_ENGINEER)).not.toContain(RuntimeCapability.INTERACTIVE_PROMPTS);
  });
});

describe("resolveRuntimeRoute — no override", () => {
  it("uses the default runtime and the role's own frontmatter model", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet", "opus"] })]);

    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry,
      config: null,
    });

    expect(route.runtime.id).toBe("claude-code");
    expect(route.model).toBe("sonnet");
    expect(route.diagnostics).toEqual([]);
  });
});

describe("resolveRuntimeRoute — same-runtime model override", () => {
  it("overrides just the model when model_routing has no colon", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet", "opus"] })]);

    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry,
      config: { schema_version: 1, model_routing: { "backend-engineer": "opus" } },
    });

    expect(route.runtime.id).toBe("claude-code");
    expect(route.model).toBe("opus");
  });
});

describe("resolveRuntimeRoute — cross-runtime override", () => {
  it("routes to the named runtime and model when model_routing uses runtime:model", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] }),
      new MockRuntimeAdapter({ id: "codex", models: ["o4-mini"] }),
    ]);

    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry,
      config: { schema_version: 1, model_routing: { "backend-engineer": "codex:o4-mini" } },
    });

    expect(route.runtime.id).toBe("codex");
    expect(route.model).toBe("o4-mini");
    expect(route.diagnostics).toEqual([]);
  });

  it("falls back to the default runtime, with a diagnostic, when the named runtime isn't registered", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] })]);

    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry,
      config: { schema_version: 1, model_routing: { "backend-engineer": "codex:o4-mini" } },
    });

    expect(route.runtime.id).toBe("claude-code");
    expect(route.model).toBe("o4-mini");
    expect(route.diagnostics.some((d) => /not registered/.test(d))).toBe(true);
  });

  it("throws when neither the named runtime nor the default is registered", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([]);

    expect(() =>
      resolveRuntimeRoute({
        role: "backend-engineer",
        stage: AgentStage.BACKEND_ENGINEER,
        projectRoot,
        registry,
        config: { schema_version: 1, model_routing: { "backend-engineer": "codex:o4-mini" } },
      }),
    ).toThrow(RuntimeRouteUnresolvedError);
  });
});

describe("resolveRuntimeRoute — model reachability diagnostic", () => {
  it("warns, but still routes, when the chosen runtime doesn't declare the model reachable", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["opus"] })]);

    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry,
      config: null,
    });

    expect(route.model).toBe("sonnet");
    expect(route.diagnostics.some((d) => /does not declare it can reach model "sonnet"/.test(d))).toBe(true);
  });
});

describe("resolveRuntimeRoute — capability policy", () => {
  it("warns when the chosen runtime doesn't claim a capability the stage needs (e.g. business-analyst needs interactive prompts)", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "business-analyst", "opus");
    const registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: ["opus"], capabilities: [] }),
    ]);

    const route = resolveRuntimeRoute({
      role: "business-analyst",
      stage: AgentStage.BUSINESS_ANALYST,
      projectRoot,
      registry,
      config: null,
    });

    expect(route.diagnostics.some((d) => /interactive-prompts/.test(d))).toBe(true);
  });

  it("prefers T111's verified capabilities over the runtime's static claim when given", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "business-analyst", "opus");
    const registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: ["opus"], capabilities: [RuntimeCapability.INTERACTIVE_PROMPTS] }),
    ]);

    const route = resolveRuntimeRoute({
      role: "business-analyst",
      stage: AgentStage.BUSINESS_ANALYST,
      projectRoot,
      registry,
      config: null,
      verifiedCapabilities: { "claude-code": new Set() },
    });

    expect(route.diagnostics.some((d) => /have verified capabilities/.test(d))).toBe(true);
  });

  it("has no capability diagnostic when the chosen runtime does claim what the stage needs", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "business-analyst", "opus");
    const registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: ["opus"], capabilities: [RuntimeCapability.INTERACTIVE_PROMPTS] }),
    ]);

    const route = resolveRuntimeRoute({
      role: "business-analyst",
      stage: AgentStage.BUSINESS_ANALYST,
      projectRoot,
      registry,
      config: null,
    });

    expect(route.diagnostics).toEqual([]);
  });
});
