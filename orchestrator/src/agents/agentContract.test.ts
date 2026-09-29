import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "./registry.js";
import {
  AgentContractError,
  CONTRACTED_AGENTS,
  ContractDispatchRefusedError,
  ContractRegistryMismatchError,
  assertContractsMatchRegistry,
  checkAllContracts,
  contractPath,
  defaultProjectRoot,
  diffContractAgainstRegistry,
  loadAgentContract,
  loadAllAgentContracts,
  resolveAuthoritativeContract,
  type AgentContract,
} from "./agentContract.js";

function fixtureRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-contracts-"));
  fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "contracts", name), body, "utf8");
  }
  return root;
}

function realContract(agent: AgentStage): AgentContract {
  return loadAgentContract(agent);
}

function asYaml(contract: unknown): string {
  // JSON is valid YAML, which is enough to build a fixture without a serializer.
  return JSON.stringify(contract, null, 2);
}

describe("the shipped contracts", () => {
  it("exist for all twelve agents, and not for `human` — a gate is not an agent", () => {
    expect(CONTRACTED_AGENTS).toHaveLength(12);
    expect(CONTRACTED_AGENTS).not.toContain(AgentStage.HUMAN);
    for (const agent of CONTRACTED_AGENTS) {
      expect(fs.existsSync(contractPath(agent))).toBe(true);
    }
    expect(fs.existsSync(contractPath("human"))).toBe(false);
  });

  it("all load and validate against the schema", () => {
    const all = loadAllAgentContracts();
    expect(Object.keys(all).sort()).toEqual([...CONTRACTED_AGENTS].sort());
  });

  it("agree with the registry the orchestrator actually runs on", () => {
    const result = checkAllContracts();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertContractsMatchRegistry()).not.toThrow();
  });

  it("resolve from the repo root, so a merged copy finds them the same way", () => {
    expect(fs.existsSync(path.join(defaultProjectRoot(), "contracts"))).toBe(true);
  });

  it("state a description and at least one constraint each — an empty contract is not a contract", () => {
    for (const agent of CONTRACTED_AGENTS) {
      const contract = loadAgentContract(agent);
      expect(contract.agent.description.length).toBeGreaterThan(10);
      expect(contract.constraints.length).toBeGreaterThan(0);
    }
  });

  it("carry the constraints that matter most, on the agents they bind", () => {
    expect(realContract(AgentStage.BUSINESS_ANALYST).constraints).toContain(
      "confirmed_input_or_human_gate",
    );
    expect(realContract(AgentStage.BUSINESS_ANALYST).constraints).not.toContain(
      "human_confirmation_required",
    );
    expect(realContract(AgentStage.BACKEND_ENGINEER).constraints).toContain("no_schema_guessing");
    expect(realContract(AgentStage.FRONTEND_ENGINEER).constraints).toContain("green_before_handoff");
    expect(realContract(AgentStage.QA_ENGINEER).constraints).toContain("cannot_close_security_finding");
    expect(realContract(AgentStage.SECURITY).constraints).toContain("sole_security_finding_closer");
    expect(realContract(AgentStage.DEVOPS).constraints).toContain("no_deploy_without_verification");
    for (const agent of CONTRACTED_AGENTS) {
      expect(realContract(agent).constraints).toContain("no_git");
      expect(realContract(agent).constraints).toContain("no_next_agent_invocation");
    }
  });
});

describe("loadAgentContract", () => {
  it("refuses a file that is not there", () => {
    expect(() => loadAgentContract(AgentStage.DEVOPS, fixtureRoot({}))).toThrow(AgentContractError);
  });

  it("refuses a file that is not YAML", () => {
    const root = fixtureRoot({ "devops.yaml": "agent: [unclosed\n" });
    expect(() => loadAgentContract(AgentStage.DEVOPS, root)).toThrow(/not valid YAML/);
  });

  it("refuses a contract whose declared name does not match its filename", () => {
    const contract = realContract(AgentStage.DEVOPS);
    const root = fixtureRoot({ "devops.yaml": asYaml({ ...contract, agent: { ...contract.agent, name: "security", role: "security" } }) });
    expect(() => loadAgentContract(AgentStage.DEVOPS, root)).toThrow(/the filename is the identity/);
  });

  it("refuses a constraint outside the published vocabulary, instead of accepting free text", () => {
    const contract = realContract(AgentStage.DEVOPS);
    const root = fixtureRoot({ "devops.yaml": asYaml({ ...contract, constraints: ["be_careful_ok"] }) });
    expect(() => loadAgentContract(AgentStage.DEVOPS, root)).toThrow(AgentContractError);
  });

  it("refuses a contract missing a required section", () => {
    const contract = realContract(AgentStage.DEVOPS) as Partial<AgentContract>;
    delete contract.permissions;
    const root = fixtureRoot({ "devops.yaml": asYaml(contract) });
    expect(() => loadAgentContract(AgentStage.DEVOPS, root)).toThrow(AgentContractError);
  });
});

describe("diffContractAgainstRegistry", () => {
  it("catches a tool the contract forgot", () => {
    const contract = realContract(AgentStage.BACKEND_ENGINEER);
    const issues = diffContractAgainstRegistry({ ...contract, tools: contract.tools.filter((t) => t !== "Bash") });
    expect(issues.join(" ")).toContain("tools: missing Bash");
  });

  it("catches a permission the contract granted itself", () => {
    const contract = realContract(AgentStage.QA_ENGINEER);
    const issues = diffContractAgainstRegistry({
      ...contract,
      permissions: { ...contract.permissions, capabilities: [...contract.permissions.capabilities, "deploy" as never] },
    });
    expect(issues.join(" ")).toContain("permissions.capabilities");
    expect(issues.join(" ")).toContain("deploy");
  });

  it("does not care how inputs are split between required and optional, only that the set matches", () => {
    const contract = realContract(AgentStage.BACKEND_ENGINEER);
    const swapped = {
      ...contract,
      input: { required: [...contract.input.optional], optional: [...contract.input.required] },
    };
    expect(diffContractAgainstRegistry(swapped)).toEqual([]);
  });

  it("treats the conditional test-plan as optional for DEV and QA without removing their PlanTask authorities", () => {
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER]) {
      const contract = realContract(stage);
      expect(contract.input.required, stage).not.toContain("test-plan");
      expect(contract.input.optional, stage).toContain("test-plan");
      expect(contract.input.required, stage).toContain("plan");
    }
  });

  it("catches an input the registry never grants", () => {
    const contract = realContract(AgentStage.BACKEND_ENGINEER);
    const issues = diffContractAgainstRegistry({
      ...contract,
      input: { ...contract.input, optional: [...contract.input.optional, "security-report"] },
    });
    expect(issues.join(" ")).toContain("security-report");
  });

  it("reports every disagreement at once, not just the first", () => {
    const contract = realContract(AgentStage.SECURITY);
    const issues = diffContractAgainstRegistry({ ...contract, tools: ["Read"], states: [] });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("reports an unknown role — a contract naming an agent the registry has no entry for at all", () => {
    const contract = realContract(AgentStage.DEVOPS);
    // A schema-valid, but registry-unknown, `agent.name` (bypassing the
    // schema's own closed enum, which — by V13 TASK-005 design — already
    // keeps every *shipped* contract from ever naming an unregistered role;
    // this exercises `resolveAuthoritativeContract`'s registry-mismatch path
    // exactly as a future registry/schema drift would surface it).
    const issues = diffContractAgainstRegistry({ ...contract, agent: { ...contract.agent, name: "ghost-role", role: "ghost-role" } });
    expect(issues).toEqual([`agent.name "ghost-role" is not a role this orchestrator knows`]);
  });
});

describe("assertContractsMatchRegistry", () => {
  it("throws with every problem listed when a contracts folder is wrong", () => {
    const contract = realContract(AgentStage.SETUP);
    const root = fixtureRoot({ "setup.yaml": asYaml({ ...contract, tools: ["Read"] }) });
    try {
      assertContractsMatchRegistry(root);
      throw new Error("expected it to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ContractRegistryMismatchError);
      // eleven missing contract files (only setup's was written) plus the tool mismatch on setup
      expect((e as ContractRegistryMismatchError).problems.length).toBe(12);
    }
  });

  it("has a registry entry for every contracted agent", () => {
    for (const agent of CONTRACTED_AGENTS) {
      expect(AGENT_REGISTRY[agent]).toBeDefined();
    }
  });
});

/**
 * V13 TASK-005 — the single function dispatch and `--check-contracts` both
 * go through. BA/SA/Engineer(backend+frontend)/QA positive cases below cover
 * every currently-real role this task's dispatch preflight protects;
 * Reviewer does not exist yet (TASK-006 adds it) and is deliberately absent
 * here rather than invented.
 */
describe("resolveAuthoritativeContract", () => {
  it.each([
    AgentStage.BUSINESS_ANALYST,
    AgentStage.SYSTEM_ANALYST,
    AgentStage.BACKEND_ENGINEER,
    AgentStage.FRONTEND_ENGINEER,
    AgentStage.QA_ENGINEER,
  ])("resolves %s cleanly against the real, shipped contract and a stable sha256 digest", (stage) => {
    const resolved = resolveAuthoritativeContract(stage);
    expect(resolved.contract.agent.name).toBe(stage);
    expect(resolved.digest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic over the exact on-disk bytes: resolving twice with no
    // change in between must answer the identical digest.
    expect(resolveAuthoritativeContract(stage).digest).toBe(resolved.digest);
  });

  /** V13 TASK-005 carry-over, closed by TASK-006: the reviewer now has a real contract. */
  it("resolves the reviewer: schema-valid, registry-consistent, and a stable digest of its exact bytes", () => {
    const resolved = resolveAuthoritativeContract(AgentStage.REVIEWER);
    expect(resolved.contract.agent).toMatchObject({ name: "reviewer", role: "reviewer" });
    expect(diffContractAgainstRegistry(resolved.contract)).toEqual([]);
    expect(resolved.contract.output.required).toEqual(["review-report"]);
    expect(resolved.contract.states).toEqual(["REVIEW"]);
    expect(resolved.contract.permissions.capabilities).not.toContain("write_code");
    expect(resolved.contract.tools).not.toContain("Bash");
    const raw = fs.readFileSync(path.join(defaultProjectRoot(), "contracts", "reviewer.yaml"));
    expect(resolved.digest).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(resolveAuthoritativeContract(AgentStage.REVIEWER).digest).toBe(resolved.digest);
  });

  it("changes digest when the contract's bytes change on disk, and matches sha256 of those exact bytes", () => {
    const contract = realContract(AgentStage.DEVOPS);
    const root = fixtureRoot({ "devops.yaml": asYaml(contract) });
    const before = resolveAuthoritativeContract(AgentStage.DEVOPS, root);
    expect(before.digest).toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "contracts", "devops.yaml"))).digest("hex"));
    fs.writeFileSync(
      path.join(root, "contracts", "devops.yaml"),
      asYaml({ ...contract, agent: { ...contract.agent, description: contract.agent.description + " (edited)" } }),
      "utf8",
    );
    const after = resolveAuthoritativeContract(AgentStage.DEVOPS, root);
    expect(after.digest).not.toBe(before.digest);
  });

  it("refuses an unknown/misspelled stage name before any guard/work-root resolution — no contract file exists to resolve", () => {
    // A stage nobody declared a contract for at all: this is the literal
    // "unknown/misspelled stage name" dispatch would be asked to refuse.
    // `AgentContractError` (not `ContractDispatchRefusedError`, which is
    // reserved for a contract that loaded but disagrees with the registry —
    // see `diffContractAgainstRegistry`'s own "unknown role" coverage below
    // for the case where a contract loads but names an agent the registry
    // itself has no entry for).
    expect(() => resolveAuthoritativeContract("marketing-analyst", fixtureRoot({}))).toThrow(AgentContractError);
    expect(() => resolveAuthoritativeContract("marketing-analyst", fixtureRoot({}))).not.toThrow(ContractDispatchRefusedError);
  });

  it("refuses a contract that disagrees with the registry — distinct from a missing/invalid file", () => {
    const contract = realContract(AgentStage.QA_ENGINEER);
    const root = fixtureRoot({
      "qa-engineer.yaml": asYaml({
        ...contract,
        permissions: { ...contract.permissions, capabilities: [...contract.permissions.capabilities, "deploy" as never] },
      }),
    });
    expect(() => resolveAuthoritativeContract(AgentStage.QA_ENGINEER, root)).toThrow(ContractDispatchRefusedError);
    expect(() => resolveAuthoritativeContract(AgentStage.QA_ENGINEER, root)).not.toThrow(AgentContractError);
  });

  it("still refuses a missing contract file as AgentContractError, not ContractDispatchRefusedError", () => {
    expect(() => resolveAuthoritativeContract(AgentStage.DEVOPS, fixtureRoot({}))).toThrow(AgentContractError);
  });
});
