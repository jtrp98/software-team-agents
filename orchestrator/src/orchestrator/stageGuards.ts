import * as path from "node:path";
import { AgentStage, TaskLevel } from "../types.js";
import type { LaneDecisionStore } from "../gates/laneApproval.js";
import { laneItemRefs, laneWorkspaces, loadGovernedKnowledge, uxArtifactFile } from "../roles/laneDecisions.js";
import { roleWorkflowState, workflowFor } from "../roles/roleWorkflow.js";
import { signoffVerdict } from "../roles/roleApproval.js";
import type { RoleLane } from "../roles/roleLane.js";
import type { KnowledgeRootIdentity } from "../store/taskStore.js";
import type { RuntimeTask } from "./runtimeTask.js";

/**
 * Stage-entry guards of the one task engine (V13 TASK-007).
 *
 * The human role lanes (BA → SA → DEV) meet a run here and nowhere else:
 * `Orchestrator.advance()` asks the guard it was constructed with right before
 * it would assign a stage, on every entry point — `sta run`, a multi-task run,
 * a resumed task. A refusal is a *stop*, not a failure: no agent is
 * dispatched, no role-run is recorded, and the task's state machine is left
 * exactly as it was, so the same question is asked again on the next poll and
 * the stop clears by itself once a person records the missing sign-off or
 * acknowledgement through a trusted human decision channel. Nothing here
 * writes: an acknowledgement is a person-only act.
 *
 * Authority is read from one place only (V13 TASK-028): the persisted lane
 * ledger (`laneApproval.ts`), whose records a trusted channel decided. Item
 * statuses are governed by it (`laneDecisions.ts`); `knowledge/_roles/**`,
 * an item file's `status: approved` and any typed name are never read as a
 * sign-off, an acknowledgement or an approval.
 *
 * Fail closed, always: a missing, empty or invalid Knowledge model cannot
 * prove a handoff, so it refuses — an empty `knowledge/` directory is not an
 * approved handoff, however it got there.
 */

/** What the engine knows about the stage it is about to assign. */
export interface StageEntryRequest {
  taskId: string;
  stage: AgentStage;
  level: TaskLevel;
  /** The Knowledge-root identity frozen at intake; null for a task created without an installation. */
  knowledgeRoot: KnowledgeRootIdentity | null;
  runtimeTask: RuntimeTask | null;
}

export type StageEntryDecision = { allowed: true } | { allowed: false; reason: string };

/** Asked by `Orchestrator.advance()` before every stage assignment. Must not write. */
export type StageEntryGuard = (request: StageEntryRequest) => StageEntryDecision;

const ALLOWED: StageEntryDecision = { allowed: true };

/**
 * The one decision of *where a task's Knowledge lives*: the root frozen into
 * the task at intake (three-repo, DR §5 — the runtime's three-repo preflight
 * refuses any selection that disagrees with it), otherwise the project root.
 * This is the same answer the runtime executor reaches with
 * `threeRepo?.roots.knowledgeRoot ?? projectRoot` for a frozen task.
 */
export function knowledgeRootForTask(task: { knowledgeRoot: KnowledgeRootIdentity | null }, projectRoot: string): string {
  return task.knowledgeRoot?.path ?? projectRoot;
}

/** The module a canonical RuntimeTask was compiled from (`<docs>/_docs/module/<name>/plan.md`), if any. */
export function moduleOfRuntimeTask(runtimeTask: RuntimeTask | null): string | undefined {
  if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) return undefined;
  const moduleDir = path.dirname(path.resolve(runtimeTask.plan_source));
  return path.basename(path.dirname(moduleDir)) === "module" ? path.basename(moduleDir) : undefined;
}

/** Whether this task's level carries the UX-artifact precondition (T-UX12): MEDIUM+ and UNKNOWN (fail closed). */
function uxGateApplies(level: TaskLevel): boolean {
  return level === TaskLevel.MEDIUM || level === TaskLevel.LARGE_CRITICAL || level === TaskLevel.UNKNOWN;
}

/** The lane handoff a lead stage depends on; null for a stage no lane gates. */
export function requiredHandoff(stage: AgentStage): { from: RoleLane; to: RoleLane } | null {
  switch (stage) {
    case AgentStage.SYSTEM_ANALYST:
      return { from: "ba", to: "sa" };
    case AgentStage.BACKEND_ENGINEER:
    case AgentStage.FRONTEND_ENGINEER:
      return { from: "sa", to: "dev" };
    default:
      return null;
  }
}

function laneActions(handoff: { from: RoleLane; to: RoleLane }, moduleName: string): string {
  return (
    `a person signs off the ${handoff.from.toUpperCase()} lane and the ${handoff.to.toUpperCase()} lane acknowledges it ` +
    `through a trusted human decision channel (module ${moduleName})`
  );
}

/** What the guard reads lane decisions from: the task store's lane ledger. */
export type LaneLedgerReader = Pick<LaneDecisionStore, "laneRequests">;

export interface RoleLaneEntryInput {
  /** The Knowledge root to read (`knowledgeRootForTask`). */
  knowledgeRoot: string;
  /** The persisted lane ledger — the only source of sign-offs and acknowledgements. */
  ledger: LaneLedgerReader;
  moduleName: string;
  stage: AgentStage;
  level: TaskLevel;
  now?: string;
}

/**
 * The cross-lane prerequisite for one stage: BA signed off and acknowledged
 * by SA before system-analyst; SA signed off and acknowledged by DEV before
 * either engineer; and, for frontend work at MEDIUM+, an approved current UX
 * artifact with its human uxui sign-off. Reads Knowledge, writes nothing.
 */
export function checkRoleLaneEntry(input: RoleLaneEntryInput): StageEntryDecision {
  const { stage, moduleName } = input;
  const handoff = requiredHandoff(stage);
  if (!handoff) return ALLOWED;
  const now = input.now ?? new Date().toISOString();
  const root = input.knowledgeRoot;
  const prefix = `cannot start ${stage}`;

  const loaded = loadGovernedKnowledge(root, input.ledger);
  if (loaded.missing) {
    return {
      allowed: false,
      reason:
        `${prefix}: no knowledge/ directory exists under ${root}, so the ${handoff.from.toUpperCase()} → ` +
        `${handoff.to.toUpperCase()} handoff cannot be verified — ${laneActions(handoff, moduleName)}`,
    };
  }
  if (loaded.problems.length > 0) {
    return {
      allowed: false,
      reason:
        `${prefix}: knowledge under ${root} is invalid (${loaded.problems.join("; ")}) — a person repairs it ` +
        `(\`sta --check-knowledge\`), then ${laneActions(handoff, moduleName)}`,
    };
  }
  if (loaded.items.length === 0) {
    return {
      allowed: false,
      reason:
        `${prefix}: knowledge under ${root} holds no items, so there is no approved ` +
        `${handoff.from.toUpperCase()} → ${handoff.to.toUpperCase()} handoff to verify — ${laneActions(handoff, moduleName)}`,
    };
  }

  const workflow = workflowFor(handoff.from);
  if (!workflow) {
    return { allowed: false, reason: `${prefix}: no workflow is defined for the ${handoff.from.toUpperCase()} lane` };
  }

  const knowledge = loaded.kb;
  const workspaces = laneWorkspaces(loaded.recordsFor, loaded.root, moduleName, now);
  const refsOf = (items: Parameters<typeof laneItemRefs>[0]) => laneItemRefs(items, loaded.root);
  if (stage === AgentStage.FRONTEND_ENGINEER && uxGateApplies(input.level)) {
    // Approved here means covered by the current uxui sign-off decision; the
    // artifact bytes are part of each item's digest, so an edited UX file is stale.
    const currentArtifacts = knowledge
      .query({ module: moduleName, kinds: ["ux-design"], status: "approved" })
      .filter((artifact) =>
        artifact.kind === "ux-design" &&
        uxArtifactFile(artifact, loaded.root) !== null &&
        artifact.payload.refines.some((id) => {
          const design = knowledge.resolve(id, moduleName);
          return design?.kind === "architecture" && design.status === "approved";
        }),
      );
    if (currentArtifacts.length === 0 || signoffVerdict(workspaces("uxui"), refsOf(currentArtifacts)).state !== "current") {
      return {
        allowed: false,
        reason:
          `${prefix}: frontend work requires an approved current UX artifact and human uxui-signoff — a person approves ` +
          `the module's ux-design item and signs it off through a trusted human decision channel (module ${moduleName})`,
      };
    }
  }

  const state = roleWorkflowState(workflow, moduleName, knowledge, workspaces, refsOf);
  if (state.stage !== "ready" || state.handoff.blockers.length > 0) {
    const detail = state.handoff.blockers.length > 0 ? `: ${state.handoff.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason:
        `${prefix}: ${handoff.from.toUpperCase()} lane is ${state.stage}${detail} — next (${state.nextAction.actor}): ` +
        `${state.nextAction.what} (module ${moduleName})`,
    };
  }
  if (!state.handoff.acknowledgedByTarget) {
    return {
      allowed: false,
      reason:
        `${prefix}: ${handoff.to.toUpperCase()} lane has not acknowledged the approved ${handoff.from.toUpperCase()} handoff ` +
        `(${state.handoff.items.join(", ") || "no items"}) at its current versions — a person acknowledges it through the ` +
        `trusted human decision channel (\`sta roles ack ${handoff.to} --module ${moduleName}\`)`,
    };
  }
  return ALLOWED;
}

export interface RoleLaneStageGuardOptions {
  /** The project root: where Knowledge lives for a task with no frozen Knowledge root. */
  projectRoot: string;
  /** The task store's lane ledger. Required: there is no other source of lane decisions. */
  ledger: LaneLedgerReader;
  /** The module this invocation is bound to (`--module`); otherwise read from the task's canonical RuntimeTask. */
  moduleName?: string;
  now?: () => string;
}

/**
 * The production stage-entry guard. Every production composition of the
 * engine (`TaskRegistry` in `sta run`, the read-only verbs, plan
 * registration) supplies this one; there is no default and no switch that
 * turns it off.
 */
export function createRoleLaneStageGuard(opts: RoleLaneStageGuardOptions): StageEntryGuard {
  return (request) => {
    const handoff = requiredHandoff(request.stage);
    if (!handoff) return ALLOWED;
    const moduleName = opts.moduleName ?? moduleOfRuntimeTask(request.runtimeTask);
    if (!moduleName) {
      return {
        allowed: false,
        reason:
          `cannot start ${request.stage}: task ${request.taskId} is bound to no module, so the ` +
          `${handoff.from.toUpperCase()} → ${handoff.to.toUpperCase()} handoff cannot be verified — run it with --module <name>`,
      };
    }
    return checkRoleLaneEntry({
      knowledgeRoot: knowledgeRootForTask(request, opts.projectRoot),
      ledger: opts.ledger,
      moduleName,
      stage: request.stage,
      level: request.level,
      now: opts.now?.(),
    });
  };
}
