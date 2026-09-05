import { LocalWorkspace } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import type {
  RuntimeAdapter,
  RuntimeAgentRequest,
  RuntimeAgentResult,
  RuntimeBinding,
  RuntimeGuardReport,
  RuntimeProbe,
  RuntimeWorkspace,
} from "./runtimeAdapter.js";

/** Stable registry/log id for the explicitly paid fallback. */
export const PAID_API_RUNTIME_ID = "paid-api" as const;

/**
 * The official provider transport supplied by an embedding host.
 *
 * The Framework deliberately receives no credential fields. Authentication is
 * owned by the official transport, exactly as it is by each local CLI adapter.
 */
export type PaidApiInvoke = (request: RuntimeAgentRequest) => Promise<RuntimeAgentResult>;

export interface ApiAdapterOptions {
  projectRoot: string;
  /** Models the configured official transport is known to reach. Empty means unreported. */
  models?: readonly string[];
  /** Mocked in conformance tests; an embedding host supplies its official transport. */
  invoke?: PaidApiInvoke;
  /** Availability probe for that transport. */
  probe?: () => Promise<RuntimeProbe>;
}

const NOT_CONFIGURED =
  "paid API transport is not configured; provide an official authenticated transport after enabling execution.allow_paid_fallback";

/**
 * Intentionally not a guard runtime: Target-write stages are refused by
 * runtimeExecutor before invoke.
 */
export class ApiAdapter implements RuntimeAdapter {
  readonly id = PAID_API_RUNTIME_ID;
  readonly displayName = "Paid API";
  readonly binding: RuntimeBinding = {
    // The API has no native named-agent store. The adapter folds the canonical
    // role definition into the already-assembled prompt before transport.
    dir: ".claude",
    definitionPath: (role) => `.claude/agents/${role}.md`,
    guardConfigPath: null,
  };
  /** No PRE/POST/EXIT guard claim is made. */
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    RuntimeCapability.MODEL_SELECTION,
    RuntimeCapability.STRUCTURED_RESULT,
    RuntimeCapability.COST_REPORTING,
  ]);
  readonly models: ReadonlySet<string>;
  readonly workspace: RuntimeWorkspace;

  private readonly invoke?: PaidApiInvoke;
  private readonly probeTransport?: () => Promise<RuntimeProbe>;

  constructor(opts: ApiAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.models = new Set(opts.models ?? []);
    this.invoke = opts.invoke;
    this.probeTransport = opts.probe;
  }

  async probe(): Promise<RuntimeProbe> {
    if (!this.invoke || !this.probeTransport) return { available: false, reason: NOT_CONFIGURED };
    try {
      return await this.probeTransport();
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    const guardReport = apiGuardReport(req);
    if (!this.invoke) return unavailable(NOT_CONFIGURED, guardReport);

    let roleDefinition: string | null;
    try {
      roleDefinition = await this.workspace.readFile(req.definitionPath);
    } catch (error) {
      return unavailable(`cannot read role binding ${req.definitionPath}: ${String(error)}`, guardReport);
    }
    if (!roleDefinition?.trim()) {
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards: guardReport,
        diagnostics: [`no role binding found at ${req.definitionPath}; refusing an unscoped paid API call`],
      };
    }

    // Reuse RuntimeAgentRequest rather than creating a parallel provider port.
    // The injected transport receives the caller env unchanged and owns auth.
    const transportRequest: RuntimeAgentRequest = {
      ...req,
      prompt: `${roleDefinition.trim()}\n\n${req.prompt}`,
      env: req.env ? { ...req.env } : undefined,
    };
    try {
      const result = await this.invoke(transportRequest);
      return {
        ...result,
        guards: guardReport,
        diagnostics: [...result.diagnostics, ...(guardReport.reason ? [guardReport.reason] : [])],
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        status: timedOut ? "TIMEOUT" : "UNAVAILABLE",
        exitCode: null,
        text: "",
        usage: {},
        guards: guardReport,
        diagnostics: [`paid API transport ${timedOut ? "timed out" : "was unavailable"}: ${String(error)}`],
      };
    }
  }
}

function apiGuardReport(req: RuntimeAgentRequest): RuntimeGuardReport {
  const unenforced: RuntimeCapability[] = [];
  if (req.guards.writeAllow.length > 0 || req.guards.writeDeny.length > 0 || req.guards.forbidCommands.length > 0) {
    unenforced.push(RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.POST_TOOL_GUARD);
  }
  if (req.guards.exitChecks.length > 0) {
    unenforced.push(RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD);
  }
  return {
    enforced: [],
    unenforced,
    reason:
      "Paid API transport has no in-band tool or exit guard; Target writes are refused by the executor before API invocation",
  };
}

function unavailable(reason: string, guards: RuntimeGuardReport): RuntimeAgentResult {
  return {
    status: "UNAVAILABLE",
    exitCode: null,
    text: "",
    usage: {},
    guards,
    diagnostics: [reason],
  };
}
