import { AgentStage } from "../types.js";
import { readWorkPlan, taskDesignRefs } from "../docs/planGraph.js";
import type { DocKind } from "./contextManager.js";
import type { DesignSectionVerdict } from "./docSelection.js";

export function needsTraceability(stage: AgentStage, doc: DocKind): boolean {
  if (doc === "design") return stage !== AgentStage.SYSTEM_ANALYST;
  if (doc === "requirement") return stage !== AgentStage.BUSINESS_ANALYST && stage !== AgentStage.SYSTEM_ANALYST;
  return false;
}

export interface TraceabilityScope {
  usableForDesign: boolean;
  usableForRequirement: boolean;
  reason: string;
  selectedTaskIds: Set<string>;
  selectedDesignRefs: Set<string>;
  plannedDesignRefs: Set<string>;
  relevantRequirementIds: Set<string>;
  plannedRequirementIds: Set<string>;
}

export function unavailableTrace(reason: string): TraceabilityScope {
  return {
    usableForDesign: false,
    usableForRequirement: false,
    reason,
    selectedTaskIds: new Set(),
    selectedDesignRefs: new Set(),
    plannedDesignRefs: new Set(),
    relevantRequirementIds: new Set(),
    plannedRequirementIds: new Set(),
  };
}

/** Builds only the REQ → DES → plan relationships the repository already supports. */
export function traceabilityScopeFor(
  requirementMd: string | null,
  designMd: string | null,
  planMd: string | null,
  phases: readonly number[] | undefined,
  taskId?: string,
): TraceabilityScope {
  if (!requirementMd || !designMd || !planMd) return unavailableTrace("requirement.md, design.md, or plan.md is missing");
  if (!phases || phases.length === 0) return unavailableTrace("no phase was supplied");
  const parsed = readWorkPlan(planMd);
  if (parsed.problems.length > 0) return unavailableTrace(`plan.md task structure is not reliable: ${parsed.problems[0]}`);
  const exactTask = taskId ? parsed.tasks.find((task) => task.id === taskId) : undefined;
  const selectedTasks = exactTask ? [exactTask] : parsed.tasks.filter((task) => phases.includes(task.phase));
  if (selectedTasks.length === 0) return unavailableTrace(`plan.md has no parseable task in phase ${phases.join(", ")}`);
  if (selectedTasks.some((task) => taskDesignRefs(task).length === 0)) {
    return unavailableTrace("at least one selected plan task has no DES-NNN relationship");
  }

  const selectedDesignRefs = new Set(selectedTasks.flatMap(taskDesignRefs));
  const plannedDesignRefs = new Set(parsed.tasks.flatMap(taskDesignRefs));
  return {
    usableForDesign: true, usableForRequirement: true, reason: "canonical task trace references",
    selectedTaskIds: new Set(selectedTasks.map(t => t.id)), selectedDesignRefs, plannedDesignRefs,
    relevantRequirementIds: new Set(selectedTasks.flatMap(t => t.traceability.filter(id => id.startsWith("REQ-")))),
    plannedRequirementIds: new Set(parsed.tasks.flatMap(t => t.traceability.filter(id => id.startsWith("REQ-")))),
  };
}

export function traceVerdict(ids: string[], relevant: Set<string>, planned: Set<string>): DesignSectionVerdict {
  if (ids.some((id) => relevant.has(id))) return "keep";
  if (ids.length > 0 && ids.every((id) => planned.has(id))) return "drop";
  return "unknown";
}
