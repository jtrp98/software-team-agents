import { AgentStage } from "../types.js";
import { parsePlanTasks } from "../docs/planGraph.js";
import { buildTraceChain } from "../traceability/traceability.js";
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
  const parsed = parsePlanTasks(planMd);
  if (parsed.problems.length > 0) return unavailableTrace(`plan.md task structure is not reliable: ${parsed.problems[0]}`);
  const exactTask = taskId ? parsed.tasks.find((task) => task.id === taskId) : undefined;
  const selectedTasks = exactTask ? [exactTask] : parsed.tasks.filter((task) => phases.includes(task.phase));
  if (selectedTasks.length === 0) return unavailableTrace(`plan.md has no parseable task in phase ${phases.join(", ")}`);
  if (selectedTasks.some((task) => task.designRefs.length === 0)) {
    return unavailableTrace("at least one selected plan task has no DES-NNN relationship");
  }

  const selectedDesignRefs = new Set(selectedTasks.flatMap((task) => task.designRefs));
  const plannedDesignRefs = new Set(parsed.tasks.flatMap((task) => task.designRefs));
  const chain = buildTraceChain({ requirementMd, designMd, planMd });
  const relevantRequirementIds = new Set(
    chain
      .filter((entry) => entry.design.some((id) => selectedDesignRefs.has(id)))
      .map((entry) => entry.requirement),
  );
  const plannedRequirementIds = new Set(chain.filter((entry) => entry.tasks.length > 0).map((entry) => entry.requirement));
  const everySelectedDesignMapsToRequirement = [...selectedDesignRefs].every((id) =>
    chain.some((entry) => entry.design.includes(id)),
  );
  return {
    usableForDesign: true,
    usableForRequirement: everySelectedDesignMapsToRequirement && relevantRequirementIds.size > 0,
    reason: everySelectedDesignMapsToRequirement
      ? "traceability relationships resolved"
      : "a selected DES-NNN has no same-line REQ-NNN relationship in design.md",
    selectedTaskIds: new Set(selectedTasks.map((task) => task.id)),
    selectedDesignRefs,
    plannedDesignRefs,
    relevantRequirementIds,
    plannedRequirementIds,
  };
}

export function traceVerdict(ids: string[], relevant: Set<string>, planned: Set<string>): DesignSectionVerdict {
  if (ids.some((id) => relevant.has(id))) return "keep";
  if (ids.length > 0 && ids.every((id) => planned.has(id))) return "drop";
  return "unknown";
}
