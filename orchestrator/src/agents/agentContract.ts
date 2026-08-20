import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage, TaskState } from "../types.js";
import type { Permission } from "./permissions.js";
import { AGENT_REGISTRY } from "./registry.js";
import type { Capability } from "./capabilities.js";

/**
 * Loads and checks `contracts/<agent-name>.yaml`.
 *
 * Before these files existed, an agent's input/output/permission rules were
 * spread across its own prompt, CLAUDE.md and conventions.md — readable by a
 * person, checkable by nothing. These files state the same rules in a form a
 * program can verify, which is the whole point: a contract nobody can check is
 * a description, not a contract.
 *
 * The in-process registry (agents/registry.ts) is still what the orchestrator
 * reads at runtime, and these files are checked against it rather than
 * replacing it. That is deliberate for now: `AGENT_REGISTRY` is a pure
 * constant that `orchestrator.ts`, `permissionPolicy.ts` and
 * `claudeCliExecutor.ts` use without knowing what a project root is, and
 * making it read files at import time would push that knowledge into all of
 * them. `assertContractsMatchRegistry()` is what keeps the two honest until
 * the folder restructure moves the source of truth here for good.
 */

export interface AgentContract {
  agent: { name: string; role: string; description: string };
  input: { required: string[]; optional: string[] };
  output: { required: string[] };
  constraints: string[];
  permissions: { capabilities: Permission[]; read: string[]; write: string[]; deny: string[] };
  tools: string[];
  states: TaskState[];
  capability: {
    languages: string[];
    frameworks: string[];
    database: string[];
    capabilities: Capability[];
  };
}

/** Every agent that has a contract — the ten real roles. `human` is a gate, not an agent, and has none. */
export const CONTRACTED_AGENTS: AgentStage[] = Object.values(AgentStage).filter((s) => s !== AgentStage.HUMAN);

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "agent-contract.schema.json",
);

/** The repo root this package sits in — where `contracts/` and `.claude/` live. */
export function defaultProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function contractsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "contracts");
}

export function contractPath(agent: AgentStage | string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(contractsDir(projectRoot), `${agent}.yaml`);
}

export class AgentContractError extends Error {
  constructor(
    public readonly agent: string,
    public readonly issues: string[],
  ) {
    super(`contract for ${agent} is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "AgentContractError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/**
 * Reads one contract. Throws — never returns a partially trusted object —
 * because everything that consumes a contract does so to decide what an agent
 * is allowed to do, and a half-read permission list is worse than none.
 */
export function loadAgentContract(agent: AgentStage | string, projectRoot: string = defaultProjectRoot()): AgentContract {
  const file = contractPath(agent, projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new AgentContractError(String(agent), [`no contract file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new AgentContractError(String(agent), [`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new AgentContractError(
      String(agent),
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }

  const contract = parsed as AgentContract;
  if (contract.agent.name !== String(agent)) {
    throw new AgentContractError(String(agent), [
      `declares agent.name "${contract.agent.name}" but lives in ${path.basename(file)} — the filename is the identity`,
    ]);
  }
  return contract;
}

/** Reads all nine. A missing or unreadable one fails the whole load: a partial set would silently exempt an agent from its own rules. */
export function loadAllAgentContracts(projectRoot: string = defaultProjectRoot()): Record<string, AgentContract> {
  const out: Record<string, AgentContract> = {};
  for (const agent of CONTRACTED_AGENTS) {
    out[agent] = loadAgentContract(agent, projectRoot);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function describeDiff(label: string, contract: readonly string[], registry: readonly string[]): string | null {
  if (sameSet(contract, registry)) return null;
  const missing = registry.filter((v) => !contract.includes(v));
  const extra = contract.filter((v) => !registry.includes(v));
  const parts: string[] = [];
  if (missing.length) parts.push(`missing ${missing.join(", ")}`);
  if (extra.length) parts.push(`declares ${extra.join(", ")} which the registry does not`);
  return `${label}: ${parts.join("; ")}`;
}

/**
 * Compares one contract against the registry entry the orchestrator actually
 * runs on. Returns every mismatch rather than the first — a contract that
 * disagrees in three places should say so once, not across three fix rounds.
 *
 * `input.required` and `input.optional` are compared as their union: the
 * registry has no notion of an optional input, so the split is information the
 * contract adds, not information it may contradict.
 */
export function diffContractAgainstRegistry(contract: AgentContract): string[] {
  const stage = contract.agent.name as AgentStage;
  const entry = AGENT_REGISTRY[stage];
  if (!entry) return [`agent.name "${contract.agent.name}" is not a role this orchestrator knows`];

  const issues: (string | null)[] = [
    contract.agent.role === entry.role ? null : `agent.role is "${contract.agent.role}", registry says "${entry.role}"`,
    describeDiff("input", [...contract.input.required, ...contract.input.optional], entry.inputs),
    describeDiff("output.required", contract.output.required, entry.outputs),
    describeDiff("permissions.capabilities", contract.permissions.capabilities, entry.permissions),
    describeDiff("tools", contract.tools, entry.tools),
    describeDiff("states", contract.states, entry.allowed_states),
    describeDiff("capability.languages", contract.capability.languages, entry.capability.languages),
    describeDiff("capability.frameworks", contract.capability.frameworks, entry.capability.frameworks),
    describeDiff("capability.database", contract.capability.database, entry.capability.database),
    describeDiff("capability.capabilities", contract.capability.capabilities, entry.capability.capabilities),
  ];
  return issues.filter((i): i is string => i !== null);
}

export interface ContractCheckResult {
  ok: boolean;
  /** One entry per agent that disagrees with the registry, already formatted for printing. */
  problems: string[];
}

/**
 * The check a CI job (or `--check-contracts`) runs: every contract loads,
 * validates, and agrees with the registry. Collects problems instead of
 * throwing on the first, so one run tells you everything that is wrong.
 */
export function checkAllContracts(projectRoot: string = defaultProjectRoot()): ContractCheckResult {
  const problems: string[] = [];
  for (const agent of CONTRACTED_AGENTS) {
    try {
      const contract = loadAgentContract(agent, projectRoot);
      for (const issue of diffContractAgainstRegistry(contract)) {
        problems.push(`${agent}: ${issue}`);
      }
    } catch (e) {
      problems.push(e instanceof AgentContractError ? e.message : `${agent}: ${String(e)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export class ContractRegistryMismatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`contracts/ and the orchestrator's agent registry disagree:\n- ${problems.join("\n- ")}`);
    this.name = "ContractRegistryMismatchError";
  }
}

export function assertContractsMatchRegistry(projectRoot: string = defaultProjectRoot()): void {
  const result = checkAllContracts(projectRoot);
  if (!result.ok) throw new ContractRegistryMismatchError(result.problems);
}
