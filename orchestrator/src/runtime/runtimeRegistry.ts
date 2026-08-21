import type { RuntimeAdapter } from "./runtimeAdapter.js";

/**
 * Which runtimes this process knows about (T108).
 *
 * Deliberately not a module-level singleton with side-effecting imports. A
 * registry that fills itself when a file is imported makes "which runtimes
 * exist" depend on import order, and this framework already went out of its way
 * elsewhere to keep facts declarative — the caller constructs one and registers
 * what it means to offer.
 *
 * `select()` is deliberately absent. Choosing a runtime for a task is T112's
 * job, and it does not select on capability: with Claude Code and Codex having
 * the same guard and agent mechanisms, capability-based selection would pick
 * between two identical candidates. The axis that actually differs is which
 * models each can reach (`RuntimeAdapter.models`), which is why T112 continues
 * T58's per-role model choice rather than inventing a parallel routing scheme.
 * Adding a `select()` here now would fix the wrong axis into the interface.
 */

export const DEFAULT_RUNTIME_ID = "claude-code";

export class RuntimeNotRegisteredError extends Error {
  constructor(id: string, known: readonly string[]) {
    super(
      known.length === 0
        ? `no runtime is registered, so "${id}" cannot be resolved`
        : `runtime "${id}" is not registered — known: ${known.join(", ")}`,
    );
    this.name = "RuntimeNotRegisteredError";
  }
}

export class DuplicateRuntimeError extends Error {
  constructor(id: string) {
    super(`runtime "${id}" is already registered — an id is a log key, so two adapters must not share one`);
    this.name = "DuplicateRuntimeError";
  }
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  constructor(initial: readonly RuntimeAdapter[] = []) {
    for (const a of initial) this.register(a);
  }

  /** Throws on a duplicate id rather than replacing: a run log records which runtime ran a stage, so silently swapping what an id means would rewrite the meaning of records already written. */
  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.id)) throw new DuplicateRuntimeError(adapter.id);
    this.adapters.set(adapter.id, adapter);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /** The strict lookup — use this everywhere a missing runtime means the caller is misconfigured, which is almost everywhere. */
  get(id: string): RuntimeAdapter {
    const found = this.adapters.get(id);
    if (!found) throw new RuntimeNotRegisteredError(id, this.ids());
    return found;
  }

  /** For the one case that is genuinely a question rather than an assumption: "is this runtime on offer at all?" */
  tryGet(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Every registered runtime that can reach a given model.
   *
   * Not routing — routing decides *which* of these to use, and that is T112 with
   * a policy to consult (`.sta/config.yaml`'s `model_routing`, declared since T93
   * and still read by nothing). This only answers the factual half, which is
   * knowable without any policy at all.
   */
  reaching(model: string): RuntimeAdapter[] {
    return this.list().filter((a) => a.models.has(model));
  }
}
