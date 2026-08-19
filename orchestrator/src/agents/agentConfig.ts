import { z } from "zod";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

/**
 * Structural separation of an agent's configuration (item 7). Each field is
 * its own zod-checked slice, not a text blob — editing what an agent is
 * allowed to touch (Constraints) never risks silently editing who it is
 * (Identity) or how it works (Instructions), because they live in different
 * fields entirely.
 */
export const AgentConfigSchema = z.object({
  identity: z.object({
    name: z.enum(AgentStage),
    role: z.string().min(1),
    description: z.string().min(1),
  }),
  // How the agent works — the rules/procedure it follows, not what it's told about this task.
  instructions: z.array(z.string().min(1)).min(1),
  // Task-instance reference data, populated at runtime by context selection (item 8).
  // Structural shape only here — item 8 owns what actually goes in it and why.
  context: z.array(
    z.object({
      source: z.string().min(1),
      content: z.string(),
    }),
  ),
  // What this agent must never do / its hard boundaries.
  constraints: z.array(z.string().min(1)).min(1),
  artifacts: z.object({
    reads: z.array(z.enum(ArtifactType)),
    writes: z.array(z.enum(ArtifactType)),
  }),
  tools: z.array(z.string().min(1)),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export class AgentConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`agent config failed contract validation:\n- ${issues.join("\n- ")}`);
    this.name = "AgentConfigValidationError";
  }
}

export function validateAgentConfig(data: unknown): AgentConfig {
  const result = AgentConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new AgentConfigValidationError(issues);
  }
  return result.data;
}

/** Reference instances proving the contract fits real agents from this repo's pipeline. */
export const BACKEND_ENGINEER_CONFIG: AgentConfig = validateAgentConfig({
  identity: {
    name: AgentStage.BACKEND_ENGINEER,
    role: "backend-engineer",
    description: "Implements API/DB code from design.md's contract and plan.md's tasks",
  },
  instructions: [
    "implement design.md's Data Model verbatim; never improvise around a contract gap",
    "run backend before frontend within a phase — never in parallel when they share an API contract",
    "typecheck/lint must be green before finishing — never hand off red code",
  ],
  context: [],
  constraints: [
    "never decides a business or design rule itself — unclear logic goes back to system-analyst",
    "never marks a plan.md checkbox — only qa-engineer does that",
    "never runs git",
  ],
  artifacts: {
    reads: [ArtifactType.PLAN, ArtifactType.DESIGN, ArtifactType.REQUIREMENTS],
    writes: [],
  },
  tools: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"],
});

export const QA_ENGINEER_CONFIG: AgentConfig = validateAgentConfig({
  identity: {
    name: AgentStage.QA_ENGINEER,
    role: "qa-engineer",
    description: "Verifies implemented code against requirement.md/design.md with evidence, not opinion",
  },
  instructions: [
    "report every result as structured evidence per qa-report schema — never a bare verbal PASS/FAIL",
    "run FULL mode to close a phase; TARGETED only after a FULL round left a file manifest",
    "escalate to a human after the second failed re-check of the same item, not a third retry",
  ],
  context: [],
  constraints: [
    "cannot close a security finding — only security moves a finding to FIXED",
    "cannot skip listing Unverified Behaviour when no automated test suite exists",
  ],
  artifacts: {
    reads: [ArtifactType.REQUIREMENTS, ArtifactType.DESIGN, ArtifactType.PLAN],
    writes: [ArtifactType.QA_REPORT],
  },
  tools: ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "Write", "Edit"],
});
