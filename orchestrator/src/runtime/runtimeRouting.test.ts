import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { StaConfig } from "../packaging/staConfig.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { parseModelRoute, requiredCapabilitiesFor, resolveRuntimeRoute, type ResolveRuntimeRouteOptions } from "./runtimeRouting.js";
import type { ModelTiers } from "./modelTiers.js";

const tierTable = {
  T1: { reserved: true, camps: { anthropic: { model: "opus", effort: "max", notes: "x" }, openai: { model: "sol", effort: "xhigh", notes: "x" }, google: { model: "pro", effort: "high", notes: "x" }, zai: { model: "glm", effort: "thinking", notes: "x" } } },
  T2: { reserved: false, camps: { anthropic: { model: "opus", effort: "high", notes: "x" }, openai: { model: "sol", effort: "high", notes: "x" }, google: { model: "pro", effort: "high", notes: "x" }, zai: { model: "glm", effort: "thinking", notes: "x" } } },
  T3: { reserved: false, camps: { anthropic: { model: "opus", effort: "medium", notes: "x" }, openai: { model: "sol", effort: "medium", notes: "x" }, google: { model: "pro", effort: "medium", notes: "x" }, zai: { model: "glm", effort: "thinking", notes: "x" } } },
  T4: { reserved: false, camps: { anthropic: { model: "sonnet", effort: "high", notes: "x" }, openai: { model: "terra", effort: "high", notes: "x" }, google: { model: "flash", effort: "high", notes: "x" }, zai: { model: "glm-4.7", effort: "thinking", notes: "x" } } },
  T5: { reserved: false, camps: { anthropic: { model: "sonnet", effort: "medium", notes: "x" }, openai: { model: "terra", effort: "medium", notes: "x" }, google: { model: "flash", effort: "medium", notes: "x" }, zai: { model: "glm-4.7", effort: "off", notes: "x" } } },
  T6: { reserved: false, camps: { anthropic: { model: "haiku", effort: "low", notes: "x" }, openai: { model: "luna", effort: "low", notes: "x" }, google: { model: "lite", effort: "low", notes: "x" }, zai: { model: "turbo", effort: "off", notes: "x" } } },
} as ModelTiers;

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-routing-"));
}

function writeRoleFrontmatter(root: string, role: string, model: string): void {
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), `---\nmodel: ${model}\nversion: 1\n---\nbody`, "utf8");
}

function routingFixture(): {
  projectRoot: string;
  registry: RuntimeRegistry;
  availability: Record<string, { available: true }>;
} {
  const projectRoot = tmpProject();
  writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
  const registry = new RuntimeRegistry([
    new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet", "opus"] }),
    new MockRuntimeAdapter({ id: "codex", models: ["gpt-5", "sonnet"] }),
    new MockRuntimeAdapter({ id: "opencode", models: ["sonnet"] }),
  ]);
  return {
    projectRoot,
    registry,
    availability: {
      "claude-code": { available: true },
      codex: { available: true },
      opencode: { available: true },
    },
  };
}

function route(over: Partial<ResolveRuntimeRouteOptions> = {}) {
  const fixture = routingFixture();
  return resolveRuntimeRoute({
    role: "backend-engineer",
    stage: AgentStage.BACKEND_ENGINEER,
    projectRoot: fixture.projectRoot,
    registry: fixture.registry,
    availability: fixture.availability,
    config: null,
    ...over,
  });
}

describe("T-V4-CAST-005", () => {
  it("feeds a phase tier into the existing level-four route without making a sixth level", () => {
    const resolved = route({ tier: { id: "T4", table: tierTable } });
    expect(resolved.precedenceLevel).toBe(4);
    expect(resolved.selected).toMatchObject({ model: "sonnet", effort: "high", modelExplicit: true });
  });

  it("keeps the frontmatter route unchanged when no tier table is supplied", () => {
    const resolved = route();
    expect(resolved.precedenceLevel).toBe(4);
    expect(resolved.selected).toMatchObject({ model: "sonnet", effort: undefined, modelExplicit: false });
  });
});

describe("parseModelRoute", () => {
  it("preserves plain model names and splits runtime:model only on the first colon", () => {
    expect(parseModelRoute("opus")).toEqual({ model: "opus" });
    expect(parseModelRoute("codex:o4-mini")).toEqual({ runtimeId: "codex", model: "o4-mini" });
    expect(parseModelRoute(":weird")).toEqual({ model: ":weird" });
  });
});

describe("requiredCapabilitiesFor", () => {
  it("derives interactive prompts from the role and PRE_TOOL_GUARD from Target-write access", () => {
    expect(requiredCapabilitiesFor(AgentStage.BUSINESS_ANALYST)).toContain(RuntimeCapability.INTERACTIVE_PROMPTS);
    expect(requiredCapabilitiesFor(AgentStage.BACKEND_ENGINEER)).not.toContain(RuntimeCapability.INTERACTIVE_PROMPTS);
    expect(requiredCapabilitiesFor(AgentStage.BACKEND_ENGINEER, true)).toContain(RuntimeCapability.PRE_TOOL_GUARD);
  });
});

describe("resolveRuntimeRoute — V3 shape and compatibility", () => {
  it("no config returns exactly claude-code plus the role frontmatter model at automatic precedence", () => {
    const result = route();
    expect(result.precedenceLevel).toBe(4);
    expect(result.candidates.map((candidate) => ({ runtime: candidate.runtime.id, model: candidate.model }))).toEqual([
      { runtime: "claude-code", model: "sonnet" },
    ]);
    expect(result.selected).toBe(result.candidates[0]);
    expect(result.requested).toMatchObject({ runtimeId: "claude-code", model: "sonnet" });
    expect(result.candidates[0]!.reason).toMatch(/automatic selection/);
    expect(result.error).toBeUndefined();
  });

  it("keeps the routing.by_role runtime:model spelling at precedence 2", () => {
    const compact = route({
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": "codex:gpt-5" } } },
    });
    expect(compact.precedenceLevel).toBe(2);
    expect(compact.selected).toMatchObject({ model: "gpt-5", runtime: expect.objectContaining({ id: "codex" }) });
  });

  // The legacy `model_routing` spelling is removed. A config that still
  // carries the key must load (staConfig keeps it declared) and must be
  // ignored by routing, not silently honoured as a second spelling.
  it("ignores a legacy model_routing key and routes at automatic precedence instead", () => {
    const result = route({
      config: { schema_version: 1, model_routing: { "backend-engineer": "codex:gpt-5" } },
    });
    expect(result.precedenceLevel).toBe(4);
    expect(result.selected?.runtime.id).toBe("claude-code");
    expect(result.selected?.model).toBe("sonnet");
  });

  // No compatibility fallback survives: an unregistered runtime is a closed
  // route, never a quiet substitution of the default.
  it("fails closed when routing.by_role names an unregistered runtime", () => {
    const result = route({
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": "ghost:o4-mini" } } },
    });
    expect(result.selected).toBeUndefined();
    expect(result.candidates).toEqual([]);
    expect(result.requested.runtimeId).toBe("ghost");
    expect(result.error).toBeTruthy();
    expect(result.diagnostics.join("\n")).toContain("not registered");
  });

  it("routing.by_role beats a config-named default runner", () => {
    const result = route({
      config: {
        schema_version: 1,
        execution: { runner: "opencode" },
        routing: { by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } } },
      },
    });
    expect(result.precedenceLevel).toBe(2);
    expect(result.selected?.runtime.id).toBe("codex");
    expect(result.selected?.model).toBe("gpt-5");
  });

  it("T-V4-CAST-001 — marks the model explicit for a --model flag and a by_role override, not for a frontmatter default", () => {
    // frontmatter default → not explicit
    expect(route().selected?.modelExplicit ?? false).toBe(false);

    // --model flag → explicit, precedence 1
    const flagged = route({ flags: { model: "opus" } });
    expect(flagged.precedenceLevel).toBe(1);
    expect(flagged.selected?.model).toBe("opus");
    expect(flagged.selected?.modelExplicit).toBe(true);

    // by_role with an explicit model + effort → explicit, effort carried
    const byRole = route({
      config: {
        schema_version: 1,
        routing: { by_role: { "backend-engineer": { runtime: "claude-code", model: "opus", effort: "high" } } },
      },
    });
    expect(byRole.selected?.modelExplicit).toBe(true);
    expect(byRole.effort).toBe("high");

    // by_role naming only a runtime (model falls back to frontmatter) → not explicit
    const runtimeOnly = route({
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": { runtime: "codex" } } } },
    });
    expect(runtimeOnly.selected?.modelExplicit ?? false).toBe(false);
    expect(runtimeOnly.effort).toBeUndefined();
  });

  // `routing.strategy` / `routing.order` (the old precedence level 3) are
  // removed. A config carrying them still loads and the route falls through
  // to the automatic default: no candidate list is built from them.
  it("ignores routing.strategy/order and resolves one automatic candidate", () => {
    const result = route({
      config: {
        schema_version: 1,
        routing: {
          strategy: "subscription-first",
          order: ["opencode", "codex", "claude-code"],
          allow_below_supported: ["codex", "opencode"],
        },
      },
    });
    expect(result.precedenceLevel).toBe(4);
    expect(result.candidates.map((candidate) => candidate.runtime.id)).toEqual(["claude-code"]);
    expect(result.candidates.every((candidate) => candidate.reason.length > 20)).toBe(true);
  });
});

describe("resolveRuntimeRoute — the surviving precedence table", () => {
  // Three sources, one route. Levels 3 (policy order) and 5 (previous-failure
  // walking) no longer exist, so the table is 1 > 2 > 4.
  type Level = 1 | 2 | 4;
  const pairs: Array<[Level, Level]> = [[1, 2], [1, 4], [2, 4]];

  function inputsFor(higher: Level, lower: Level): Partial<ResolveRuntimeRouteOptions> {
    const config: StaConfig = { schema_version: 1, routing: { allow_below_supported: ["codex", "opencode"] } };
    if (higher === 2 || lower === 2) {
      config.routing = {
        ...config.routing,
        by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } },
      };
    }
    return {
      config,
      flags: higher === 1 ? { runtime: "claude-code", model: "opus" } : undefined,
    };
  }

  it.each(pairs)("level %i beats level %i", (higher, lower) => {
    const result = route(inputsFor(higher, lower));
    expect(result.precedenceLevel).toBe(higher);
    expect(result.selected, result.error).toBeDefined();
  });

  it("never resolves more than one candidate, whatever the config declares", () => {
    const result = route({
      config: {
        schema_version: 1,
        model_routing: { "backend-engineer": "opencode:sonnet" },
        execution: { mode: "auto", allow_handoff: true, runner: "opencode" },
        routing: {
          strategy: "subscription-first",
          order: ["opencode", "codex", "claude-code"],
          allow_below_supported: ["codex", "opencode"],
          by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } },
        },
      },
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.selected?.runtime.id).toBe("codex");
  });
});

describe("resolveRuntimeRoute — availability, support and guard refusal", () => {
  it("preserves an unavailable probe reason verbatim in diagnostics", () => {
    const exactReason = "codex executable missing: PATH entry Ω";
    const result = route({
      flags: { runtime: "codex", model: "gpt-5" },
      availability: {
        "claude-code": { available: true },
        codex: { available: false, reason: exactReason },
        opencode: { available: true },
      },
    });
    // The requested candidate stays in the plan so the executor classifies the
    // probe result as UNAVAILABLE and escalates it with the exact reason.
    expect(result.selected?.runtime.id).toBe("codex");
    expect(result.error).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes(exactReason))).toBe(true);
  });

  it("zero available runtimes returns an empty list and an explicit error", () => {
    const result = route({
      availability: {
        "claude-code": { available: false, reason: "claude missing" },
        codex: { available: false, reason: "codex missing" },
        opencode: { available: false, reason: "opencode missing" },
      },
    });
    expect(result.precedenceLevel).toBe(4);
    expect(result.candidates.map((candidate) => candidate.runtime.id)).toEqual(["claude-code"]);
    expect(result.selected?.runtime.id).toBe("claude-code");
    expect(result.error).toBeUndefined();
    expect(result.diagnostics.join("\n")).toContain("claude missing");
  });

  it("refuses automatic routing below supported unless that exact runtime is opted in", () => {
    const denied = route({ defaultRuntimeId: "codex", config: { schema_version: 1 } });
    expect(denied.selected).toBeUndefined();
    expect(denied.error).toContain('support level "preview"');

    const allowed = route({
      defaultRuntimeId: "codex",
      config: { schema_version: 1, routing: { allow_below_supported: ["codex"] } },
    });
    expect(allowed.selected?.runtime.id).toBe("codex");

    const explicit = route({ flags: { runtime: "codex", model: "gpt-5" } });
    expect(explicit.precedenceLevel).toBe(1);
    expect(explicit.selected?.runtime.id).toBe("codex");
  });

  it("excludes and refuses a Target-write runtime missing PRE_TOOL_GUARD", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "backend-engineer", "sonnet");
    const weak = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet"],
      capabilities: [RuntimeCapability.NAMED_AGENTS],
    });
    const result = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot,
      registry: new RuntimeRegistry([weak]),
      config: null,
      availability: { "claude-code": { available: true } },
      hasTargetWrite: true,
    });
    expect(result.candidates).toEqual([]);
    expect(result.selected).toBeUndefined();
    expect(result.error).toContain('runtime "claude-code"');
    expect(result.error).toContain(RuntimeCapability.PRE_TOOL_GUARD);
  });

  it("keeps a non-write capability shortfall diagnostic without weakening the stage", () => {
    const projectRoot = tmpProject();
    writeRoleFrontmatter(projectRoot, "business-analyst", "opus");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["opus"], capabilities: [] });
    const result = resolveRuntimeRoute({
      role: "business-analyst",
      stage: AgentStage.BUSINESS_ANALYST,
      projectRoot,
      registry: new RuntimeRegistry([runtime]),
      config: null,
      availability: { "claude-code": { available: true } },
    });
    expect(result.selected?.runtime).toBe(runtime);
    expect(result.diagnostics.join("\n")).toContain(RuntimeCapability.INTERACTIVE_PROMPTS);
  });
});
