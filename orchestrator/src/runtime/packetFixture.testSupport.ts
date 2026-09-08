/** Disposable fixture support shared by packet/guard/persistence regression tests. */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCanonicalPlan, renderCanonicalTasks, type PlanTask } from "../docs/planTask.js";
import { buildRuntimeTask, type RuntimeTaskBuildInput } from "../orchestrator/runtimeTask.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { compileExecutionPacket } from "./agentRunAssembly.js";

export const FIXTURE_REVISION = "a".repeat(40);
export const fixtureTask = (overrides: Partial<PlanTask> = {}): PlanTask => ({
  ...parseCanonicalPlan(fs.readFileSync(new URL("../docs/fixtures/canonical-plan.md", import.meta.url), "utf8")).tasks[0],
  produces: [], ...overrides,
});

export function writePacketPlan(root: string, tasks: PlanTask[], moduleName = "packet-fixture"): void {
  const dir = path.join(root, "_docs/module", moduleName);
  fs.mkdirSync(dir, { recursive: true });
  const ids = [...new Set(tasks.flatMap(t => [...t.traceability, ...t.produces, ...t.consumes]))];
  fs.writeFileSync(path.join(dir, "plan.md"), renderCanonicalTasks(tasks));
  fs.writeFileSync(path.join(dir, "requirement.md"), "# Requirements\n\n" + ids.filter(id => /^(REQ|AC)-/.test(id)).map(id => `- ${id}: Selected fixture requirement for empty orders.`).join("\n") + "\n- REQ-999: UNRELATED REQUIREMENT SECRET SENTINEL\n- AC-999.1: UNRELATED ACCEPTANCE SENTINEL\n");
  fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\n" + ids.filter(id => /^(DES-|Contract:)/.test(id)).map(id => `- ${id}: Preserve the documented order response contract.`).join("\n") + "\n- DES-999: UNRELATED DESIGN SENTINEL\n");
}

export function runtimeTaskFixture(root: string, opts: { taskId?: string; stage?: AgentStage; allow?: string[]; targetRoot?: string; overrides?: Partial<PlanTask>; input?: Partial<RuntimeTaskBuildInput> } = {}) {
  fs.mkdirSync(opts.targetRoot ?? root, { recursive: true });
  const task = fixtureTask({ id: opts.taskId ?? "T-PACKET", ...opts.overrides });
  const stage = opts.stage ?? AgentStage.BACKEND_ENGINEER;
  const plan = [...task.dependsOn.map(id => fixtureTask({ id })), task];
  writePacketPlan(root, plan);
  const runtimeTask = buildRuntimeTask({
    taskId: task.id, projectRoot: defaultProjectRoot(), docsRoot: root, moduleName: "packet-fixture", workflow: "bugfix",
    classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
    targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "fixture", path: opts.targetRoot ?? root }],
    ...opts.input,
  })!;
  if (!runtimeTask) throw new Error("fixture did not compile");
  const targetRoot = opts.targetRoot ?? root;
  runtimeTask.scope.work_roots = [{ stage, target_id: "fixture", root: targetRoot, allow: (opts.allow ?? ["server/**"]).map(glob => ({ contract_glob: glob, effective_glob: path.resolve(targetRoot, ...glob.split("/")) })) }];
  return runtimeTask;
}

export function packetFixture(root: string, opts: { attempt?: number; taskId?: string; stage?: AgentStage } = {}) {
  const task = runtimeTaskFixture(root, opts);
  const stage = opts.stage ?? AgentStage.BACKEND_ENGINEER;
  return compileExecutionPacket({
    req: { stage, taskId: task.task_id, context: [] }, role: stage, runtimeTask: task,
    contractScope: { allow: ["server/**"], deny: [".git/**"] }, attempt: opts.attempt ?? 1, baseRevision: FIXTURE_REVISION,
  });
}
