/**
 * Shared identifiers used across the orchestrator.
 * AgentStage names are fixed to the twelve roles this platform replaces
 * (see repo root CLAUDE.md) — no generic "Developer"/"SA" stand-ins.
 */
export enum AgentStage {
  SETUP = "setup",
  BUSINESS_ANALYST = "business-analyst",
  SYSTEM_ANALYST = "system-analyst",
  PROJECT_MANAGER = "project-manager",
  TEST_PLANNER = "test-planner",
  UXUI_DESIGNER = "uxui-designer",
  BACKEND_ENGINEER = "backend-engineer",
  FRONTEND_ENGINEER = "frontend-engineer",
  /** Independent code review of the implementation, between the engineers and QA (V13 TASK-006). */
  REVIEWER = "reviewer",
  QA_ENGINEER = "qa-engineer",
  SECURITY = "security",
  DEVOPS = "devops",
  HUMAN = "human",
}

export enum TaskLevel {
  TRIVIAL = "TRIVIAL",
  SMALL = "SMALL",
  MEDIUM = "MEDIUM",
  LARGE_CRITICAL = "LARGE_CRITICAL",
  /** Not enough signal to classify — must not silently default to a level. */
  UNKNOWN = "UNKNOWN",
}

/**
 * States a task can occupy. The set of states any one task actually visits
 * is dynamic — derived from its classification pipeline (see state/taskState.ts) —
 * but the states themselves and their failure loops are fixed here.
 */
export enum TaskState {
  CREATED = "CREATED",
  REQUIREMENT = "REQUIREMENT",
  DESIGN = "DESIGN",
  PLAN = "PLAN",
  IMPLEMENTATION = "IMPLEMENTATION",
  /** The reviewer stage: an independent review of the implementation, before QA verifies it. */
  REVIEW = "REVIEW",
  REVIEW_FAILED = "REVIEW_FAILED",
  QA = "QA",
  QA_FAILED = "QA_FAILED",
  SECURITY = "SECURITY",
  SECURITY_FAILED = "SECURITY_FAILED",
  READY_TO_DEPLOY = "READY_TO_DEPLOY",
  APPROVED = "APPROVED",
  DEPLOYED = "DEPLOYED",
  /** Terminal-for-now state: unclassifiable task, or a retry-limit escalation (item 5). */
  BLOCKED = "BLOCKED",
}
