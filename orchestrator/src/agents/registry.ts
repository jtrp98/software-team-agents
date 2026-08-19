import { z } from "zod";
import { AgentStage, TaskState } from "../types.js";
import { Permission } from "./permissions.js";

export const AgentRegistryEntrySchema = z.object({
  name: z.enum(AgentStage),
  role: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  tools: z.array(z.string().min(1)),
  permissions: z.array(z.enum(Permission)).min(1),
  allowed_states: z.array(z.enum(TaskState)),
});
export type AgentRegistryEntry = z.infer<typeof AgentRegistryEntrySchema>;

/**
 * One row per agent this platform replaces (CLAUDE.md's pipeline table).
 * allowed_states is deliberately hand-listed rather than solely derived from
 * state/taskState.ts's STAGE_TO_STATE — devops spans three states
 * (READY_TO_DEPLOY, APPROVED, DEPLOYED) that a single-value map can't express,
 * and setup runs once before any task's state machine exists at all.
 */
const RAW_REGISTRY: Record<AgentStage, AgentRegistryEntry> = {
  [AgentStage.SETUP]: {
    name: AgentStage.SETUP,
    role: "setup",
    responsibilities: ["scaffold the project once, before any feature work"],
    inputs: ["design"],
    outputs: ["scaffolding", "schema.prisma", "backend-code"],
    tools: ["Bash", "Write", "Edit", "Read", "Glob", "Grep", "AskUserQuestion"],
    permissions: [Permission.READ, Permission.WRITE_CODE, Permission.WRITE_DOCS],
    allowed_states: [TaskState.CREATED],
  },
  [AgentStage.BUSINESS_ANALYST]: {
    name: AgentStage.BUSINESS_ANALYST,
    role: "business-analyst",
    responsibilities: ["interview the user and produce/amend requirements.md"],
    inputs: ["qa-report", "design"],
    outputs: ["requirements"],
    tools: ["AskUserQuestion", "Write", "Edit", "Read", "Glob", "Grep"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.REQUIREMENT],
  },
  [AgentStage.SYSTEM_ANALYST]: {
    name: AgentStage.SYSTEM_ANALYST,
    role: "system-analyst",
    responsibilities: ["analyze feasibility and design the data model in design.md"],
    inputs: ["requirements", "qa-report"],
    outputs: ["design"],
    tools: ["Read", "Glob", "Grep", "AskUserQuestion", "Write", "Edit"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.DESIGN],
  },
  [AgentStage.PROJECT_MANAGER]: {
    name: AgentStage.PROJECT_MANAGER,
    role: "project-manager",
    responsibilities: ["turn a confirmed design into a phased plan.md"],
    inputs: ["design", "requirements"],
    outputs: ["plan"],
    tools: ["Read", "Glob", "Grep", "AskUserQuestion", "Write", "Edit"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.PLAN],
  },
  [AgentStage.BACKEND_ENGINEER]: {
    name: AgentStage.BACKEND_ENGINEER,
    role: "backend-engineer",
    responsibilities: ["implement API/DB code from design.md's contract"],
    inputs: ["plan", "design", "requirements", "qa-report", "backend-code"],
    outputs: ["backend-code"],
    tools: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"],
    permissions: [Permission.READ, Permission.WRITE_CODE, Permission.TEST],
    allowed_states: [TaskState.IMPLEMENTATION],
  },
  [AgentStage.FRONTEND_ENGINEER]: {
    name: AgentStage.FRONTEND_ENGINEER,
    role: "frontend-engineer",
    responsibilities: ["implement UI code from design.md and the backend's actual API"],
    inputs: ["plan", "design", "requirements", "qa-report", "frontend-code"],
    outputs: ["frontend-code"],
    tools: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"],
    permissions: [Permission.READ, Permission.WRITE_CODE, Permission.TEST],
    allowed_states: [TaskState.IMPLEMENTATION],
  },
  [AgentStage.QA_ENGINEER]: {
    name: AgentStage.QA_ENGINEER,
    role: "qa-engineer",
    responsibilities: [
      "verify implemented code against requirements/design with evidence",
      "mark plan.md tasks done — the only role allowed to",
    ],
    inputs: ["requirements", "design", "plan", "backend-code", "frontend-code"],
    outputs: ["qa-report"],
    tools: ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "Write", "Edit"],
    permissions: [Permission.READ, Permission.TEST, Permission.WRITE_DOCS],
    allowed_states: [TaskState.QA],
  },
  [AgentStage.SECURITY]: {
    name: AgentStage.SECURITY,
    role: "security",
    responsibilities: ["audit implemented code for real security defects"],
    inputs: ["requirements", "design", "qa-report", "backend-code", "frontend-code"],
    outputs: ["security-report"],
    tools: ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "Write", "Edit"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.SECURITY],
  },
  [AgentStage.DEVOPS]: {
    name: AgentStage.DEVOPS,
    role: "devops",
    responsibilities: ["build, deploy, run migrations only once qa/security have accepted the work"],
    inputs: ["qa-report", "security-report", "plan", "design", "devops-docs"],
    outputs: ["devops-docs"],
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion"],
    permissions: [Permission.READ, Permission.BUILD, Permission.DEPLOY, Permission.ROLLBACK],
    allowed_states: [TaskState.READY_TO_DEPLOY, TaskState.APPROVED, TaskState.DEPLOYED],
  },
  [AgentStage.HUMAN]: {
    name: AgentStage.HUMAN,
    role: "human",
    responsibilities: ["triage unclassifiable tasks; approve gates only a person can approve"],
    inputs: [],
    outputs: [],
    tools: [],
    permissions: [Permission.READ],
    allowed_states: [TaskState.BLOCKED, TaskState.APPROVED],
  },
};

export const AGENT_REGISTRY: Record<AgentStage, AgentRegistryEntry> = Object.fromEntries(
  Object.entries(RAW_REGISTRY).map(([stage, entry]) => [stage, AgentRegistryEntrySchema.parse(entry)]),
) as Record<AgentStage, AgentRegistryEntry>;

export function getAgent(stage: AgentStage): AgentRegistryEntry {
  return AGENT_REGISTRY[stage];
}
