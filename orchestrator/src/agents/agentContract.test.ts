import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "./registry.js";
import {
  AgentContractError,
  CONTRACTED_AGENTS,
  ContractRegistryMismatchError,
  assertContractsMatchRegistry,
  checkAllContracts,
  contractPath,
  defaultProjectRoot,
  diffContractAgainstRegistry,
  loadAgentContract,
  loadAllAgentContracts,
  type AgentContract,
} from "./agentContract.js";

/** Writes a throwaway contracts/ folder and returns the project root holding it. */
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
  it("exist for all ten agents, and not for `human` — a gate is not an agent", () => {
    expect(CONTRACTED_AGENTS).toHaveLength(10);
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

  /** The reason this task exists: the files and the code the orchestrator runs on must say the same thing. */
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
      // nine missing files plus the tool mismatch
      expect((e as ContractRegistryMismatchError).problems.length).toBe(10);
    }
  });

  it("has a registry entry for every contracted agent", () => {
    for (const agent of CONTRACTED_AGENTS) {
      expect(AGENT_REGISTRY[agent]).toBeDefined();
    }
  });
});
