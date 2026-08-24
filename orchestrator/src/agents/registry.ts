import { z } from "zod";
import { AgentStage, TaskState } from "../types.js";
import { Permission } from "./permissions.js";
import { Capability } from "./capabilities.js";

/**
 * What an agent can actually do, beyond which stage it occupies (T12).
 *
 * Role says *where* an agent sits in the pipeline; this says *what it is able to
 * build*. The two were the same thing only while there was exactly one stack. A
 * `backend-engineer` that knows Express and Prisma is not interchangeable with
 * one that knows EF Core, and the registry had no way to express the difference
 * — so selecting an agent for a task meant selecting by position and hoping.
 *
 * Empty arrays are meaningful here: a documentation agent genuinely writes no
 * language and targets no framework, and saying so is different from not having
 * been filled in.
 */
export const AgentCapabilitySchema = z.object({
  /** Programming languages this agent writes. Empty for the analysis and documentation roles. */
  languages: z.array(z.string().min(1)),
  /** Frameworks and libraries it works against. */
  frameworks: z.array(z.string().min(1)),
  /** Databases it can design against or query. */
  database: z.array(z.string().min(1)),
  /** What it can do, from a controlled vocabulary — free text here would be unmatchable. */
  capabilities: z.array(z.enum(Capability)),
});
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentRegistryEntrySchema = z.object({
  name: z.enum(AgentStage),
  role: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  tools: z.array(z.string().min(1)),
  permissions: z.array(z.enum(Permission)).min(1),
  allowed_states: z.array(z.enum(TaskState)),
  capability: AgentCapabilitySchema,
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
    capability: {
      languages: ["typescript"],
      frameworks: ["nextjs", "express", "prisma"],
      database: ["postgresql"],
      capabilities: [Capability.SCAFFOLDING, Capability.SCHEMA_DESIGN],
    },
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
    capability: {
      languages: [],
      frameworks: [],
      database: [],
      capabilities: [Capability.REQUIREMENTS_INTERVIEW],
    },
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
    capability: {
      languages: [],
      frameworks: [],
      database: ["postgresql"],
      capabilities: [Capability.SCHEMA_DESIGN, Capability.FEASIBILITY_ANALYSIS],
    },
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
    capability: {
      languages: [],
      frameworks: [],
      database: [],
      capabilities: [Capability.TASK_PHASING],
    },
  },
  [AgentStage.TEST_PLANNER]: {
    name: AgentStage.TEST_PLANNER,
    role: "test-planner",
    responsibilities: [
      "decide what needs testing and at what level (unit/integration/API/E2E), before implementation starts",
      "write test-plan.md so engineers and qa-engineer share one test strategy instead of each guessing their own",
    ],
    inputs: ["requirements", "design", "plan"],
    outputs: ["test-plan"],
    tools: ["Read", "Glob", "Grep", "Write", "Edit"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.PLAN],
    capability: {
      languages: [],
      frameworks: [],
      database: [],
      capabilities: [Capability.TEST_STRATEGY],
    },
  },
  [AgentStage.UXUI_DESIGNER]: {
    name: AgentStage.UXUI_DESIGNER,
    role: "uxui-designer",
    responsibilities: [
      "analyze the design source (Figma file via read-only MCP, or an exported design handoff) and produce draft UX-* recommendations",
      "advise frontend-engineer on UI structure before implementation starts — a consultant, never an implementer",
    ],
    inputs: ["requirements", "design"],
    outputs: ["ux-design"],
    // No AskUserQuestion: like the engineers, unclear rules route back to
    // system-analyst/business-analyst rather than being settled in this chat.
    tools: ["Read", "Glob", "Grep", "Write", "Edit"],
    permissions: [Permission.READ, Permission.WRITE_DOCS],
    allowed_states: [TaskState.IMPLEMENTATION],
    capability: {
      languages: [],
      frameworks: [],
      database: [],
      capabilities: [Capability.UX_ANALYSIS],
    },
  },
  [AgentStage.BACKEND_ENGINEER]: {
    name: AgentStage.BACKEND_ENGINEER,
    role: "backend-engineer",
    responsibilities: ["implement API/DB code from design.md's contract"],
    inputs: ["plan", "design", "requirements", "test-plan", "qa-report", "backend-code"],
    outputs: ["backend-code"],
    tools: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"],
    permissions: [Permission.READ, Permission.WRITE_CODE, Permission.TEST],
    allowed_states: [TaskState.IMPLEMENTATION],
    // Declares the stack the agent prompt actually implements today, not the one
    // project.yaml names as the target. A capability list that describes an
    // intended future is worse than none: it would match tasks nothing can build.
    capability: {
      languages: ["typescript"],
      frameworks: ["express", "prisma", "zod"],
      database: ["postgresql"],
      capabilities: [Capability.REST_API, Capability.DATABASE_ACCESS, Capability.AUTH, Capability.TESTING],
    },
  },
  [AgentStage.FRONTEND_ENGINEER]: {
    name: AgentStage.FRONTEND_ENGINEER,
    role: "frontend-engineer",
    responsibilities: ["implement UI code from design.md and the backend's actual API"],
    inputs: ["plan", "design", "requirements", "test-plan", "qa-report", "frontend-code"],
    outputs: ["frontend-code"],
    tools: ["Write", "Edit", "Read", "Glob", "Grep", "Bash"],
    permissions: [Permission.READ, Permission.WRITE_CODE, Permission.TEST],
    allowed_states: [TaskState.IMPLEMENTATION],
    capability: {
      languages: ["typescript"],
      frameworks: ["nextjs", "react", "tailwind", "zustand"],
      database: [],
      capabilities: [Capability.UI, Capability.TESTING],
    },
  },
  [AgentStage.QA_ENGINEER]: {
    name: AgentStage.QA_ENGINEER,
    role: "qa-engineer",
    responsibilities: [
      "verify implemented code against requirements/design with evidence",
      "mark plan.md tasks done — the only role allowed to",
    ],
    inputs: ["requirements", "design", "plan", "test-plan", "backend-code", "frontend-code", "qa-evidence"],
    outputs: ["qa-report"],
    tools: ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "Write", "Edit"],
    permissions: [Permission.READ, Permission.TEST, Permission.WRITE_DOCS],
    allowed_states: [TaskState.QA],
    capability: {
      languages: ["typescript"],
      frameworks: [],
      database: ["postgresql"],
      capabilities: [Capability.VERIFICATION, Capability.TESTING],
    },
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
    capability: {
      languages: ["typescript"],
      frameworks: [],
      database: ["postgresql"],
      capabilities: [Capability.SECURITY_AUDIT],
    },
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
    capability: {
      languages: ["typescript"],
      frameworks: ["docker"],
      database: ["postgresql"],
      capabilities: [Capability.DEPLOYMENT, Capability.MIGRATION, Capability.CI],
    },
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
    capability: {
      languages: [],
      frameworks: [],
      database: [],
      capabilities: [Capability.TRIAGE, Capability.APPROVAL],
    },
  },
};

export const AGENT_REGISTRY: Record<AgentStage, AgentRegistryEntry> = Object.fromEntries(
  Object.entries(RAW_REGISTRY).map(([stage, entry]) => [stage, AgentRegistryEntrySchema.parse(entry)]),
) as Record<AgentStage, AgentRegistryEntry>;

export function getAgent(stage: AgentStage): AgentRegistryEntry {
  return AGENT_REGISTRY[stage];
}

/**
 * Every agent that can do a thing (T12) — selection by what a task needs rather
 * than by position in the pipeline.
 *
 * Returns all matches rather than one: which of several capable agents should
 * run is an ordering question the pipeline already answers, and picking here
 * would quietly override it.
 */
export function agentsWithCapability(capability: Capability): AgentRegistryEntry[] {
  return Object.values(AGENT_REGISTRY).filter((a) => a.capability.capabilities.includes(capability));
}

/** Agents that can write a given language. Case-insensitive: "TypeScript" and "typescript" are one language. */
export function agentsForLanguage(language: string): AgentRegistryEntry[] {
  const wanted = language.toLowerCase();
  return Object.values(AGENT_REGISTRY).filter((a) => a.capability.languages.some((l) => l.toLowerCase() === wanted));
}

/** Agents that work against a given framework. */
export function agentsForFramework(framework: string): AgentRegistryEntry[] {
  const wanted = framework.toLowerCase();
  return Object.values(AGENT_REGISTRY).filter((a) => a.capability.frameworks.some((f) => f.toLowerCase() === wanted));
}

/**
 * Whether the roster can cover a requirement, and what is missing if not.
 * Reported rather than thrown: an uncovered capability is a fact about the
 * project's setup, and the caller decides whether it is fatal.
 */
export function coverageFor(required: Capability[]): { covered: Capability[]; missing: Capability[] } {
  const covered: Capability[] = [];
  const missing: Capability[] = [];
  for (const capability of required) {
    (agentsWithCapability(capability).length > 0 ? covered : missing).push(capability);
  }
  return { covered, missing };
}
