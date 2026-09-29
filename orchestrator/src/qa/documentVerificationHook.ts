import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { AgentStage } from "../types.js";
import { checkDocStructure, checkOneDoc, type DocStructureCheckResult, type DocType } from "../docs/docStructure.js";
import { checkPlanGraphs, type PlanGraphCheckResult } from "../docs/planGraph.js";
import { buildTraceChain, checkTraceability } from "../traceability/traceability.js";

const DOCUMENT_PRODUCING_STAGES = new Set<AgentStage>([
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.UXUI_DESIGNER,
  AgentStage.TEST_PLANNER,
  AgentStage.PROJECT_MANAGER,
]);

/** The doc schema each doc-producing stage's own artifact is validated against. UXUI and test-plan have no schema yet — existence and non-empty bytes still gate. */
const STAGE_OWNED_DOC: Partial<Record<AgentStage, { file: string; docType: DocType | null }>> = {
  [AgentStage.BUSINESS_ANALYST]: { file: "requirement.md", docType: "requirement" },
  [AgentStage.SYSTEM_ANALYST]: { file: "design.md", docType: "design" },
  [AgentStage.PROJECT_MANAGER]: { file: "plan.md", docType: "plan" },
  [AgentStage.UXUI_DESIGNER]: { file: "uxui/design.md", docType: null },
  [AgentStage.TEST_PLANNER]: { file: "test-plan.md", docType: null },
};

/** The state owner can repeat the owned-document check from bytes. An executor's
 * `document_gate` marker is observability, never proof of validation. */
export function ownedDocumentProblems(stage: AgentStage, projectRoot: string, moduleName: string): string[] {
  const owned = STAGE_OWNED_DOC[stage];
  if (!owned) return [];
  const file = path.join(projectRoot, "_docs", "module", moduleName, ...owned.file.split("/"));
  let markdown: string;
  try { markdown = fs.readFileSync(file, "utf8"); }
  catch { return [`${moduleName}/${owned.file}: required artifact is missing at the Knowledge root (${projectRoot})`]; }
  if (!markdown.trim()) return [`${moduleName}/${owned.file}: required artifact is empty`];
  const problems = owned.docType ? [...checkOneDoc(owned.docType, markdown, `${moduleName}/${owned.file}`).problems] : [];
  if (stage === AgentStage.PROJECT_MANAGER) {
    problems.push(...checkPlanGraphs(projectRoot, moduleName).problems);
    const dir = path.dirname(file);
    const requirementMd = fs.readFileSync(path.join(dir, "requirement.md"), "utf8");
    const designMd = fs.readFileSync(path.join(dir, "design.md"), "utf8");
    problems.push(...checkTraceability(buildTraceChain({ requirementMd, designMd, planMd: markdown })).problems.filter(problem => problem.includes("plan.md has no task for it yet")));
  }
  return problems;
}

export interface DocumentVerificationHookOptions {
  inner: AgentExecutor;
  /**
   * The Knowledge root the documents live in (V13 TASK-011: the document
   * verifier reads Knowledge, never the Framework or a Target). The stage's
   * own artifact bytes are read here — a document that exists somewhere else
   * does not exist for this check, which is exactly the wrong-root refusal.
   */
  projectRoot: string;
  moduleName: string | undefined;
}

export interface DocumentVerificationHook {
  executor: AgentExecutor;
}

/**
 * Document verification is mandatory (V13 TASK-018): the gate runs on every
 * document-producing stage and is always blocking. There is no disabled
 * executor and no warn posture left — a stage whose artifact bytes do not
 * verify at the Knowledge root does not pass, whatever the run reported.
 */
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

    // V13 TASK-018 — the stage's own artifact is verified where it must live:
    // actual bytes at the Knowledge root, non-empty, and (when a schema exists)
    // structurally valid. Existence elsewhere — the Framework root, a Target,
    // an older checkout — is absence here, and absence blocks.
    const owned = STAGE_OWNED_DOC[req.stage];
    if (owned && opts.moduleName) {
      const artifactPath = path.join(opts.projectRoot, "_docs", "module", opts.moduleName, ...owned.file.split("/"));
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(artifactPath);
      } catch {
        allProblems.push(
          `${opts.moduleName}/${owned.file}: required artifact is missing at the Knowledge root (${opts.projectRoot}) — a document the verifier cannot read does not exist`,
        );
        bytes = Buffer.alloc(0);
      }
      if (bytes.length > 0 && owned.docType) {
        const own = checkOneDoc(owned.docType, bytes.toString("utf8"), `${opts.moduleName}/${owned.file}`);
        allProblems.push(...own.problems);
      }
    }

    // V13 TASK-018 — traceability is checked when the plan is authored: a
    // requirement that design.md covers but plan.md gives no task to is a
    // chain that ends nowhere, and it blocks the PM stage. Requirements with
    // no design yet are recorded to the operator without blocking — early in a
    // module's life that is the expected state, and SA's gate owns design
    // coverage for the requirements of its own round.
    if (req.stage === AgentStage.PROJECT_MANAGER && opts.moduleName) {
      const moduleDir = path.join(opts.projectRoot, "_docs", "module", opts.moduleName);
      const readDoc = (file: string): string | null => {
        try {
          const bytes = fs.readFileSync(path.join(moduleDir, file));
          return bytes.toString("utf8");
        } catch {
          return null;
        }
      };
      const requirementMd = readDoc("requirement.md");
      const designMd = readDoc("design.md");
      const planMd = readDoc("plan.md");
      if (requirementMd && planMd) {
        const chain = buildTraceChain({ requirementMd, designMd: designMd ?? "", planMd });
        const trace = checkTraceability(chain);
        const plannedButUntasked = trace.problems.filter((problem) => problem.includes("plan.md has no task for it yet"));
        allProblems.push(...plannedButUntasked);
      }
    }

    if (allProblems.length === 0) {
      return {
        ...result,
        outcome: { ...result.outcome, document_gate: "enabled" },
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
      // A FAIL outcome never completes the attempt, so the orchestrator keeps
      // the owning stage assigned - no marker is needed to hold the cursor.
    };
  };

  return { executor };
}
