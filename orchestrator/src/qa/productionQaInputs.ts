import { AgentStage } from "../types.js";
import { readModuleDoc } from "../agents/moduleDocs.js";
import { parseOpenIssues } from "../orchestrator/failureClassifier.js";
import { gitDiffSummary } from "./changeSource.js";
import { buildQaTaskContract, type QaTaskContract } from "./taskContract.js";
import type { QaFindingRecord } from "./evidence.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { readWorkPlan, taskObjective, taskDesignRefs } from "../docs/planGraph.js";
import {
  latestExecutionPacketPath,
  readExecutionPacketForAudit,
  readFindingsForTask,
} from "../state/runtimeArtifacts.js";

/**
 * The previous failed QA round's findings, read from the module's `review.md`
 * (`## Open Issues`) — the input a recheck plan needs so round N+1 verifies
 * the named findings first instead of starting over.
 *
 * Findings carry no file lists today because review.md does not name files;
 * freshness keys stay unknown, which planRecheck treats as "no cross-boundary
 * signal" rather than inventing one. Evidence reuse across processes arrives
 * when deterministic results gain their own persistence.
 */
export function previousRoundFromDocs(docsRoot: string, moduleName: string, taskId: string): { findings: QaFindingRecord[]; evidence: [] } | undefined {
  if (!moduleName) return undefined;
  const reviewMd = readModuleDoc(docsRoot, moduleName, "review.md");
  if (!reviewMd) return undefined;
  const rows = parseOpenIssues(reviewMd);
  if (rows.length === 0) return undefined;
  const findings: QaFindingRecord[] = rows.map((row, i) => ({
    id: `F${i + 1}`,
    description: row.raw.replace(/\s+/g, " ").slice(0, 200),
    owner: row.owner ?? "unassigned",
    files: [],
    createdAt: Date.now(),
    status: "OPEN",
  }));
  void taskId;
  return { findings, evidence: [] };
}

/**
 * Builds concise QA inputs from the module's existing plan/design and the
 * already-derived task graph.  These are references and summaries, not copied
 * requirements or source payloads; QA may still request the named source.
 */
export async function productionQaInputs(opts: {
  docsRoot: string;
  moduleName: string;
  taskId: string;
  roots: readonly string[];
  /**
   * T-V8-014 - the Framework root holding this task's runtime artifacts.
   * Optional: without it the contract still carries the authored acceptance
   * text and the graph radius, and simply reports that no packet/finding
   * evidence was resolvable rather than pretending there was none.
   */
  projectRoot?: string;
  /** This round's real changed-file manifest, resolved by the caller that owns the Target roots. */
  changedFiles?: readonly string[];
}) {
  const planMd = readModuleDoc(opts.docsRoot, opts.moduleName, "plan.md") ?? "";
  const designMd = readModuleDoc(opts.docsRoot, opts.moduleName, "design.md") ?? "";
  const parsed = readWorkPlan(planMd);
  if (parsed.problems.length) throw new Error(`invalid QA plan: ${parsed.problems.join("; ")}`);
  const task = parsed.tasks.find((row) => row.id === opts.taskId);
  let graph: ReturnType<typeof taskGraphFromPlan> | undefined;
  let affectedTaskIds: string[] = [];
  let affectedPhases: number[] = [];
  if (task) {
      graph = taskGraphFromPlan(parsed.tasks);
      affectedTaskIds = [...new Set([...graph.dependenciesOf(task.id), ...graph.descendantsOf(task.id)])].sort();
      affectedPhases = [...new Set([task.phase, ...affectedTaskIds.map((id) => graph!.nodes.get(id)?.phase).filter((phase): phase is number => phase !== undefined)])].sort((a, b) => a - b);
  }
  const riskRef = /^##\s+Risks\s*&\s*Dependencies\s*$/im.test(designMd) ? ["design.md#Risks-&-Dependencies"] : [];
  const diffParts = await Promise.all(opts.roots.map(async (root) => {
    try {
      return `[${root}]\n${await gitDiffSummary(root)}`;
    } catch {
      return `[${root}] No git diff stat available; inspect the scoped files directly.`;
    }
  }));

  // The exact contract is only constructible from a canonical PlanTask: a
  // legacy row has no authored acceptance text, no `produces`/`consumes` and
  // no traceability split, so there is nothing to bind QA to that would not
  // be invented here. Those rounds keep the pre-T-V8-014 pointer package.
  const contract: QaTaskContract | undefined =
    task && "version" in task
      ? buildQaTaskContract({
          task,
          graph,
          ...(opts.projectRoot ? { packet: latestQaPacketEvidence(opts.projectRoot, task.id, task.owner as AgentStage) } : {}),
          ...(opts.projectRoot ? { findings: readTaskFindingsSafely(opts.projectRoot, task.id) } : {}),
          changedFiles: opts.changedFiles ?? [],
        })
      : undefined;

  return {
    packageInputs: () => ({
      ...(contract ? { taskContract: contract } : {}),
      taskIntent: task ? taskObjective(task) : `Task ${opts.taskId} in module ${opts.moduleName}; no matching plan row was found.`,
      acceptanceCriteria: task
        ? [...taskDesignRefs(task).map((ref) => `design.md#${ref}`), `plan.md#${task.id}`]
        : [`plan.md#${opts.taskId}`],
      diffSummary: diffParts.length > 0 ? diffParts.join("\n") : "No writable Target root was resolved; inspect the scoped files directly.",
      knownRisks: riskRef,
    }),
    scopeInputs: () => ({ affectedTaskIds, affectedPhases }),
    taskContract: () => contract,
  };
}

/**
 * The immutable packet the owner stage last executed under, when one is on
 * disk. Read tolerantly and discarded on any problem: a QA round must not be
 * blocked because an older attempt's audit record no longer parses, and a
 * contract that says "no packet identity was resolvable" is honest where a
 * fabricated hash would not be.
 */
function latestQaPacketEvidence(projectRoot: string, taskId: string, stage: AgentStage) {
  try {
    const packetPath = latestExecutionPacketPath(projectRoot, taskId, stage);
    if (!packetPath) return undefined;
    const packet = readExecutionPacketForAudit(packetPath);
    if (!("version" in packet) || packet.version !== 2) return undefined;
    return { stage: packet.stage, attempt: packet.attempt, identity: packet.identity, dependencies: packet.dependencies, packet_hash: packet.packet_hash };
  } catch {
    return undefined;
  }
}

/** Durable findings for this task. Same tolerance: an unreadable store yields none, never a thrown QA round. */
function readTaskFindingsSafely(projectRoot: string, taskId: string) {
  try {
    return readFindingsForTask(projectRoot, taskId);
  } catch {
    return [];
  }
}
