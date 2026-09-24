import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage, TaskLevel } from "../types.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { loadRoleWorkspace } from "../roles/roleWorkspace.js";
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
 * acknowledgement (`sta roles signoff` / `sta roles ack`). Nothing here
 * writes: an acknowledgement is a person-only act.
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
    `a person signs off the ${handoff.from.toUpperCase()} lane (\`sta roles signoff ${handoff.from} --module ${moduleName} --by <name>\`) ` +
    `and the ${handoff.to.toUpperCase()} lane acknowledges it (\`sta roles ack ${handoff.to} <ids> --module ${moduleName} --by <name>\`)`
  );
}

export interface RoleLaneEntryInput {
  /** The Knowledge root to read (`knowledgeRootForTask`). */
  knowledgeRoot: string;
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

  const loaded = loadKnowledge(root);
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

  const knowledge = new KnowledgeBase(loaded.items);
  if (stage === AgentStage.FRONTEND_ENGINEER && uxGateApplies(input.level)) {
    const artifacts = knowledge
      .query({ module: moduleName, kinds: ["ux-design"], status: "approved" })
      .filter((item): item is Extract<typeof item, { kind: "ux-design" }> => item.kind === "ux-design");
    const uxui = loadRoleWorkspace("uxui", moduleName, root, now);
    const expectedPrefix = `_docs/module/${moduleName}/uxui/`;
    const canonicalRoot = fs.realpathSync.native(path.resolve(root));
    const currentArtifacts = artifacts.filter((artifact) =>
      artifact.payload.artifact.startsWith(expectedPrefix) && (() => {
        const candidate = path.resolve(canonicalRoot, artifact.payload.artifact);
        return candidate.startsWith(`${canonicalRoot}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() &&
          fs.realpathSync.native(candidate).startsWith(`${canonicalRoot}${path.sep}`);
      })() && artifact.payload.refines.some((id) => {
        const design = knowledge.resolve(id, moduleName);
        return design?.kind === "architecture" && design.status === "approved";
      }),
    );
    if (currentArtifacts.length === 0 || signoffVerdict(uxui, currentArtifacts).state !== "current") {
      return {
        allowed: false,
        reason:
          `${prefix}: frontend work requires an approved current UX artifact and human uxui-signoff — a person approves ` +
          `the module's ux-design item and signs it off (\`sta roles signoff uxui --module ${moduleName} --by <name>\`)`,
      };
    }
  }

  const state = roleWorkflowState(workflow, moduleName, knowledge, (lane) => loadRoleWorkspace(lane, moduleName, root, now));
  if (state.stage !== "ready" || state.handoff.blockers.length > 0) {
    const detail = state.handoff.blockers.length > 0 ? `: ${state.handoff.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason:
        `${prefix}: ${handoff.from.toUpperCase()} lane is ${state.stage}${detail} — next (${state.nextAction.actor}): ` +
        `${state.nextAction.what} (module ${moduleName}; add --module ${moduleName})`,
    };
  }
  if (!state.handoff.acknowledgedByTarget) {
    return {
      allowed: false,
      reason:
        `${prefix}: ${handoff.to.toUpperCase()} lane has not acknowledged the approved ${handoff.from.toUpperCase()} handoff ` +
        `(${state.handoff.items.join(", ") || "no items"}) — a person runs ` +
        `\`sta roles ack ${handoff.to} ${state.handoff.items.join(",") || "<ids>"} --module ${moduleName} --by <name>\``,
    };
  }
  return ALLOWED;
}

export interface RoleLaneStageGuardOptions {
  /** The project root: where Knowledge lives for a task with no frozen Knowledge root. */
  projectRoot: string;
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
      moduleName,
      stage: request.stage,
      level: request.level,
      now: opts.now?.(),
    });
  };
}
