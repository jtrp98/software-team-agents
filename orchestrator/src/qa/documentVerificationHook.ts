import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { AgentStage } from "../types.js";
import { checkDocStructure, type DocStructureCheckResult } from "../docs/docStructure.js";
import { checkPlanGraphs, type PlanGraphCheckResult } from "../docs/planGraph.js";

const DOCUMENT_PRODUCING_STAGES = new Set<AgentStage>([
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.UXUI_DESIGNER,
  AgentStage.TEST_PLANNER,
  AgentStage.PROJECT_MANAGER,
]);

export interface DocumentVerificationHookOptions {
  inner: AgentExecutor;
  projectRoot: string;
  moduleName: string | undefined;
  blocking: boolean;
}

export interface DocumentVerificationHook {
  executor: AgentExecutor;
}

export function withDocumentVerificationDisabled(inner: AgentExecutor): AgentExecutor {
  return async (req) => {
    const result = await inner(req);
    if (!DOCUMENT_PRODUCING_STAGES.has(req.stage)) return result;
    return {
      ...result,
      outcome: { ...result.outcome, document_gate: "disabled" },
    };
  };
}

export function createDocumentVerificationHook(opts: DocumentVerificationHookOptions): DocumentVerificationHook {
  const executor: AgentExecutor = async (req): Promise<AgentExecutorResult> => {
    const result = await opts.inner(req);
    if (!DOCUMENT_PRODUCING_STAGES.has(req.stage) || result.outcome.result === "FAIL") return result;

    let structureResult: DocStructureCheckResult;
    try {
       structureResult = checkDocStructure(opts.projectRoot);
    } catch (e: any) {
       return {
         ...result,
         outcome: {
           ...result.outcome,
           result: "FAIL",
           failure_reason: "checkDocStructure threw an error: " + e.message,
           document_gate: "enabled"
         }
       };
    }

    let planResult: PlanGraphCheckResult | undefined;
    if (req.stage === AgentStage.PROJECT_MANAGER) {
      try {
        planResult = checkPlanGraphs(opts.projectRoot, opts.moduleName);
      } catch (e: any) {
        return {
          ...result,
          outcome: {
             ...result.outcome,
             result: "FAIL",
             failure_reason: "checkPlanGraphs threw an error: " + e.message,
             document_gate: "enabled"
          }
        };
      }
    }

    const allProblems = [...structureResult.problems];
    if (planResult) {
      allProblems.push(...planResult.problems);
    }

    if (allProblems.length === 0) {
      return {
        ...result,
        outcome: { ...result.outcome, document_gate: "enabled" },
      };
    }

    if (!opts.blocking) {
      return {
        ...result,
        outcome: { 
          ...result.outcome, 
          document_gate: "enabled"
        }
      };
    }

    const failureReason = "document verification failed \u2014 fix these structure/plan issues:\n" + allProblems.map(p => "- " + p).join("\n");
    return {
      ...result,
      outcome: {
        ...result.outcome,
        result: "FAIL",
        failure_reason: failureReason,
        document_gate: "enabled",
      },
      // Note: we don't set postDevVerificationFailed because this is document validation, 
      // but we want to route it back to the owning stage just like deterministic verification.
      // Wait, "route a failure the way a deterministic failure already is — back to the owning stage, no model invocation between failure and routing"
      // Wait, deterministic verification sets postDevVerificationFailed = true to keep the cursor on the same stage. Let's see.
      postDevVerificationFailed: true,
    };
  };

  return { executor };
}