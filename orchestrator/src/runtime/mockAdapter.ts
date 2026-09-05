import {
  NO_GUARDS_REPORT,
  type RuntimeAdapter,
  type RuntimeAgentRequest,
  type RuntimeAgentResult,
  type RuntimeBinding,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeProbe,
  type RuntimeWorkspace,
} from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * A `RuntimeAdapter` backed by nothing at all.
 *
 * This exists to answer the question the interface is only worth having if it
 * can answer: can the orchestrator drive its pipeline end to end without any AI
 * runtime installed, and without knowing which one it is talking to? Everything
 * here is in memory — no process is spawned, no file on disk is touched, and the
 * workspace is a `Map`. If a test using this passes, nothing in the path it
 * exercised reached for `claude`, `codex`, or the local filesystem.
 *
 * The in-memory workspace is deliberate rather than convenient: reusing
 * `LocalWorkspace` here would have let a `fs` dependency hide in the QA/security
 * readback path and still look like it went through the interface.
 */

/** A workspace whose files live in a Map. Proves the workspace seam is real — nothing in the framework may assume the agent's files are on the orchestrator's own disk. */
export class MemoryWorkspace implements RuntimeWorkspace {
  readonly files: Map<string, string>;
  /** Every command asked for, in order. Nothing is executed. */
  readonly commands: RuntimeCommand[] = [];
  /** Canned results, keyed by the command name. Anything unlisted returns exit 0 with empty output. */
  commandResults: Map<string, RuntimeCommandResult> = new Map();

  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }

  async readFile(relPath: string): Promise<string | null> {
    return this.files.get(normalize(relPath)) ?? null;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.files.set(normalize(relPath), content);
  }

  async exists(relPath: string): Promise<boolean> {
    const key = normalize(relPath);
    if (this.files.has(key)) return true;
    // A directory-shaped path (e.g. a binding-presence check) has no entry of
    // its own in a flat file map the way `LocalWorkspace`'s real filesystem
    // check does — so a directory "exists" here when some file lives under it.
    const prefix = `${key}/`;
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  async runCommand(spec: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.commands.push(spec);
    return (
      this.commandResults.get(spec.command) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false }
    );
  }
}

/** Forward slashes, no leading `./` — so a test can write a path the way the framework's conventions do and read it back. */
function normalize(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A binding that resolves anywhere the test wants, defaulting to a plausible shape. */
export function mockBinding(dir = ".mock"): RuntimeBinding {
  return {
    dir,
    definitionPath: (role) => `${dir}/agents/${role}.md`,
    guardConfigPath: `${dir}/guards.json`,
  };
}

/** An `OK` result with everything filled in, so a test only states the part it cares about. */
export function okResult(over: Partial<RuntimeAgentResult> = {}): RuntimeAgentResult {
  return {
    status: "OK",
    exitCode: 0,
    text: "done",
    usage: {},
    guards: NO_GUARDS_REPORT,
    diagnostics: [],
    ...over,
  };
}

export interface MockRuntimeOptions {
  id?: string;
  displayName?: string;
  binding?: RuntimeBinding;
  capabilities?: Iterable<RuntimeCapability>;
  models?: Iterable<string>;
  probe?: RuntimeProbe;
  /** Files the workspace starts with, keyed by repo-relative path. */
  files?: Record<string, string>;
  /** What to return for a given request. Defaults to a plain `OK`. */
  respond?: (req: RuntimeAgentRequest, callIndex: number) => RuntimeAgentResult;
}

/** Every capability a runtime could declare — the "nothing is missing" baseline, so a test that cares about an absence has to state it. */
export const ALL_MOCK_CAPABILITIES: readonly RuntimeCapability[] = Object.values(RuntimeCapability);

export class MockRuntimeAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly binding: RuntimeBinding;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly models: ReadonlySet<string>;
  readonly workspace: MemoryWorkspace;
  /** Every request this adapter was given, in order — the record a test asserts the executor's behaviour against. */
  readonly requests: RuntimeAgentRequest[] = [];

  private readonly probeResult: RuntimeProbe;
  private readonly respond: (req: RuntimeAgentRequest, callIndex: number) => RuntimeAgentResult;

  constructor(opts: MockRuntimeOptions = {}) {
    this.id = opts.id ?? "mock";
    this.displayName = opts.displayName ?? "Mock Runtime";
    this.binding = opts.binding ?? mockBinding();
    this.capabilities = new Set(opts.capabilities ?? ALL_MOCK_CAPABILITIES);
    this.models = new Set(opts.models ?? ["mock-model"]);
    this.workspace = new MemoryWorkspace(opts.files);
    this.probeResult = opts.probe ?? { available: true, version: "0.0.0-mock" };
    this.respond = opts.respond ?? (() => okResult());
  }

  async probe(): Promise<RuntimeProbe> {
    return this.probeResult;
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    const index = this.requests.length;
    this.requests.push(req);
    return this.respond(req, index);
  }

  /** The roles this adapter was asked to run, in order. The assertion most tests actually want. */
  rolesRun(): string[] {
    return this.requests.map((r) => r.role);
  }
}
