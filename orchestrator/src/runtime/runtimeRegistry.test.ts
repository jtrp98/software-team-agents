import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_ID,
  DuplicateRuntimeError,
  RuntimeNotRegisteredError,
  RuntimeRegistry,
} from "./runtimeRegistry.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";

describe("RuntimeRegistry (T108)", () => {
  it("registers and resolves an adapter by its id", () => {
    const adapter = new MockRuntimeAdapter({ id: "claude-code" });
    const registry = new RuntimeRegistry([adapter]);

    expect(registry.has("claude-code")).toBe(true);
    expect(registry.get("claude-code")).toBe(adapter);
    expect(registry.ids()).toEqual(["claude-code"]);
  });

  it("refuses a second adapter with the same id instead of replacing it", () => {
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "codex" })]);
    // An id is a log key: a run record already says "codex ran this stage", so
    // silently changing what that id resolves to would rewrite history.
    expect(() => registry.register(new MockRuntimeAdapter({ id: "codex" }))).toThrow(DuplicateRuntimeError);
  });

  it("throws a message naming what IS registered when a lookup misses", () => {
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code" })]);
    expect(() => registry.get("codex")).toThrow(RuntimeNotRegisteredError);
    expect(() => registry.get("codex")).toThrow(/known: claude-code/);
  });

  it("says so plainly when nothing at all is registered, rather than listing an empty set", () => {
    const registry = new RuntimeRegistry();
    expect(() => registry.get("claude-code")).toThrow(/no runtime is registered/);
  });

  it("tryGet answers without throwing, for the case that is genuinely a question", () => {
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code" })]);
    expect(registry.tryGet("claude-code")).toBeDefined();
    expect(registry.tryGet("codex")).toBeUndefined();
  });

  /**
   * The factual half of T112. Which runtime to *use* is a policy decision that
   * task owns; which runtimes *can* reach a model is knowable with no policy at
   * all, and this is deliberately only the second thing.
   */
  it("reaching(model) lists every runtime that can serve a model", () => {
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["opus", "sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5.2-codex"] });
    const registry = new RuntimeRegistry([claude, codex]);

    expect(registry.reaching("opus").map((a) => a.id)).toEqual(["claude-code"]);
    expect(registry.reaching("gpt-5.2-codex").map((a) => a.id)).toEqual(["codex"]);
    expect(registry.reaching("something-nobody-has")).toEqual([]);
  });

  it("a model two runtimes both reach returns both — the ambiguity T112 has to resolve with policy", () => {
    const a = new MockRuntimeAdapter({ id: "a", models: ["shared-model"] });
    const b = new MockRuntimeAdapter({ id: "b", models: ["shared-model"] });
    const registry = new RuntimeRegistry([a, b]);

    // Two candidates is a real state, not an error: the registry reports it and
    // does not pick, because picking is the routing decision T112 makes with
    // `.sta/config.yaml` in hand.
    expect(registry.reaching("shared-model").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("the default runtime id is the one this framework was built against", () => {
    expect(DEFAULT_RUNTIME_ID).toBe("claude-code");
  });
});
