import { AgentStage, TaskLevel } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { loadRoleWorkspace } from "./roleWorkspace.js";
import { roleWorkflowState, workflowFor } from "./roleWorkflow.js";
import { signoffVerdict } from "./roleApproval.js";
import type { RoleLane } from "./roleLane.js";

/**
 * The point where the V1.5 human lanes meet a real orchestrator run (T114).
 *
 * `roleWorkflowState()` deliberately only describes the handoff: it cannot
 * start an agent, and it must never create a human acknowledgement itself.
 * This small, read-only guard is the other half. When enabled by a caller, it
 * prevents SA or DEV implementation work from starting until the preceding
 * lane has both signed off and been acknowledged by the receiving person.
 */
export interface RoleExecutionGateResult {
  allowed: boolean;
  reason?: string;
}

export interface RoleExecutionGateOptions {
  /**
   * The task's classification level, when the caller knows it (T-UX12). The
   * UX-artifact precondition is a *design-phase* requirement: TRIVIAL and SMALL
   * work has no design phase (the classifier does not schedule uxui-designer
   * for it either), so demanding one there would block small fixes on ceremony
   * the pipeline itself skipped. MEDIUM+ — and an unknown level, fail-closed —
   * still require the signed artifact. Absent level keeps the old behaviour.
   */
  level?: TaskLevel;
}

/** Whether this task's level carries the UX-artifact precondition. */
function uxGateApplies(level: TaskLevel | undefined): boolean {
  if (level === undefined) return true;
  return level === TaskLevel.MEDIUM || level === TaskLevel.LARGE_CRITICAL || level === TaskLevel.UNKNOWN;
}

function requiredHandoff(stage: AgentStage): { from: RoleLane; to: RoleLane } | null {
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

/**
 * Checks only the cross-lane prerequisite for a stage. BA has no upstream
 * lane, and non-lead stages stay governed by their existing pipeline rules.
 * The function writes nothing: `sta roles ack` remains a person-only action.
 */
export function checkRoleExecutionGate(
  projectRoot: string,
  moduleName: string,
  stage: AgentStage,
  now: string = new Date().toISOString(),
  options: RoleExecutionGateOptions = {},
): RoleExecutionGateResult {
  const handoff = requiredHandoff(stage);
  if (!handoff) return { allowed: true };

  const loaded = loadKnowledge(projectRoot);
  if (loaded.missing) {
    return {
      allowed: false,
      reason: `cannot start ${stage}: no knowledge/ directory exists, so the ${handoff.from.toUpperCase()} → ${handoff.to.toUpperCase()} handoff cannot be verified`,
    };
  }
  if (loaded.problems.length > 0) {
    return {
      allowed: false,
      reason: `cannot start ${stage}: knowledge is invalid (${loaded.problems.join("; ")})`,
    };
  }
  if (loaded.items.length === 0) {
    // A knowledge/ directory with zero items is what `sta init` seeds into every
    // fresh project. There is no handoff to verify yet, and enforcing the lane
    // discipline on an empty model would leave the SA lane at `intake` forever —
    // which blocked every engineer stage on every newly-initialized project until
    // T117's real run caught it. Presence of the directory is not adoption.
    return { allowed: true };
  }

  const workflow = workflowFor(handoff.from);
  if (!workflow) {
    return { allowed: false, reason: `cannot start ${stage}: no workflow is defined for the ${handoff.from.toUpperCase()} lane` };
  }

  const knowledge = new KnowledgeBase(loaded.items);
  if (stage === AgentStage.FRONTEND_ENGINEER && uxGateApplies(options.level)) {
    const artifacts = knowledge.query({ module: moduleName, kinds: ["ux-design"], status: "approved" }).filter((item): item is Extract<typeof item, { kind: "ux-design" }> => item.kind === "ux-design");
    const uxui = loadRoleWorkspace("uxui", moduleName, projectRoot, now);
    const expectedPrefix = `_docs/module/${moduleName}/uxui/`;
    const canonicalRoot = fs.realpathSync.native(path.resolve(projectRoot));
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
      return { allowed: false, reason: `cannot start ${stage}: frontend work requires an approved current UX artifact and human uxui-signoff` };
    }
  }
  const state = roleWorkflowState(workflow, moduleName, knowledge, (lane) =>
    loadRoleWorkspace(lane, moduleName, projectRoot, now),
  );

  if (state.stage !== "ready" || state.handoff.blockers.length > 0) {
    const detail = state.handoff.blockers.length > 0 ? `: ${state.handoff.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason: `cannot start ${stage}: ${handoff.from.toUpperCase()} lane is ${state.stage}${detail}`,
    };
  }
  if (!state.handoff.acknowledgedByTarget) {
    return {
      allowed: false,
      reason:
        `cannot start ${stage}: ${handoff.to.toUpperCase()} lane has not acknowledged the approved ` +
        `${handoff.from.toUpperCase()} handoff (${state.handoff.items.join(", ") || "no items"})`,
    };
  }

  return { allowed: true };
}
