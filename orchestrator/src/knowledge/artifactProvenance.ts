import * as fs from "node:fs";
import * as path from "node:path";
import { contentHash } from "../artifacts/executionPacket.js";
import { stableHash } from "../artifacts/executionPacket.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { readExecutionPacket } from "../state/runtimeArtifacts.js";
import type { EvidenceRecord } from "../evidence/evidenceStore.js";
import type { TaskStore } from "../store/taskStore.js";

export function verifiedRoleAttemptProvenance(store: TaskStore, evidenceId: string): {
  taskId: string; stage: EvidenceRecord["stage"]; attempt: number; role: string;
  contractDigest: string; packetPath: string; evidenceId: string;
  dispatchEvidenceId: string;
} {
  const run = store.loadEvidence(evidenceId);
  if (!run || run.kind !== "role-run" || run.payload.kind !== "role-run") {
    throw new Error(`role dispatch evidence ${evidenceId} is absent or has the wrong kind`);
  }
  const role = AGENT_REGISTRY[run.stage].role;
  if (run.role !== role || !run.payload.contractDigest || !run.payload.packetPath) {
    throw new Error(`role dispatch ${evidenceId} lacks verified role, contract or packet identity`);
  }
  const task = store.loadTask(run.taskId);
  const dispatch = run.refs.map((id) => store.loadEvidence(id)).find((ref) =>
    ref?.kind === "role-dispatch" && ref.taskId === run.taskId && ref.stage === run.stage && ref.attempt === run.attempt,
  );
  const canonical = task?.runtimeTask && "version" in task.runtimeTask && task.runtimeTask.version === 2 ? task.runtimeTask : null;
  if (!dispatch || dispatch.payload.kind !== "role-dispatch") {
    throw new Error(`role run ${evidenceId} has no pre-dispatch evidence`);
  }
  const payload = dispatch.payload;
    if (dispatch.role !== role || payload.idempotencyKey !== `${run.taskId}:${run.stage}:${run.attempt}` ||
        payload.contractDigest !== run.payload.contractDigest || payload.packetPath !== run.payload.packetPath ||
        payload.runtimeId !== run.payload.runtime) {
      throw new Error(`role run ${evidenceId} does not match its pre-dispatch identity`);
    }
    if (task?.knowledgeRoot && canonical) {
      const root = fs.realpathSync(task.knowledgeRoot!.path);
      const absolute = path.resolve(root, payload.packetPath);
      const real = fs.realpathSync(absolute);
      const within = path.relative(root, real);
      if (within.startsWith("..") || path.isAbsolute(within) || absolute !== real) throw new Error(`role dispatch ${dispatch.evidenceId} escapes its Knowledge root`);
      const packet = readExecutionPacket(real, { packetHash: payload.packetHash, planHash: canonical.plan_hash });
      if (packet.task_id !== run.taskId || packet.stage !== run.stage || packet.role !== role ||
          payload.scopeDigest !== stableHash({ scope: canonical.scope, knowledgeRoot: task.knowledgeRoot, targetBindings: task.targetBindings })) {
        throw new Error(`role dispatch ${dispatch.evidenceId} does not match frozen task/role/scope`);
      }
    }
  return { taskId: run.taskId, stage: run.stage, attempt: run.attempt, role, contractDigest: run.payload.contractDigest,
    packetPath: run.payload.packetPath, evidenceId, dispatchEvidenceId: dispatch.evidenceId };
}

/** Read-time verification of an authored artifact, including its actual bytes.
 * Metadata inside a document is never used to establish the writer. */
export function verifiedArtifactProvenance(store: TaskStore, evidenceId: string): {
  taskId: string;
  stage: EvidenceRecord["stage"];
  role: string;
  attempt: number;
  roleAttemptId: string;
  contractDigest: string;
  contentDigest: string;
  knowledgePath: string | null;
  sourceDigest: string | null;
  evidenceId: string;
  dispatchEvidenceId: string;
  roleRunEvidenceId: string;
} {
  const artifact = store.loadEvidence(evidenceId);
  if (!artifact || artifact.kind !== "artifact" || artifact.payload.kind !== "artifact") {
    throw new Error(`artifact evidence ${evidenceId} is absent or has the wrong kind`);
  }
  const payload = artifact.payload;
  const expectedRole = AGENT_REGISTRY[artifact.stage].role;
  const attemptId = `${artifact.taskId}:${artifact.stage}:${artifact.attempt}`;
  if (artifact.role !== expectedRole || payload.ownerRole !== artifact.stage || payload.roleAttemptId !== attemptId) {
    throw new Error(`artifact ${evidenceId} has forged role/attempt metadata`);
  }
  if (!AGENT_REGISTRY[artifact.stage].outputs.includes(payload.artifactType)) {
    throw new Error(`artifact ${evidenceId} is not registered output of ${artifact.stage}`);
  }
  if (payload.location !== `task-store:${artifact.taskId}/artifacts/${payload.artifactType}`) {
    throw new Error(`artifact ${evidenceId} has a forged storage location`);
  }
  const dispatch = artifact.refs.map((id) => store.loadEvidence(id)).find(
    (ref) => ref?.kind === "role-run" && ref.taskId === artifact.taskId && ref.stage === artifact.stage && ref.attempt === artifact.attempt,
  );
  if (!dispatch || dispatch.payload.kind !== "role-run" || dispatch.role !== expectedRole ||
      dispatch.payload.contractDigest !== payload.contractDigest || !dispatch.payload.packetPath) {
    throw new Error(`artifact ${evidenceId} has no matching contract-bound role dispatch`);
  }
  const verifiedRun = verifiedRoleAttemptProvenance(store, dispatch.evidenceId);
  const task = store.loadTask(artifact.taskId);
  const bytes = task?.artifacts[payload.artifactType];
  if (!bytes || contentHash(bytes) !== payload.contentDigest) {
    throw new Error(`artifact ${evidenceId} does not match persisted artifact bytes`);
  }
  if ((payload.knowledgePath === null) !== (payload.sourceDigest === null)) {
    throw new Error(`artifact ${evidenceId} has incomplete Knowledge provenance`);
  }
  if (task?.knowledgeRoot && task.runtimeTask && "version" in task.runtimeTask && task.runtimeTask.version === 2 &&
      ["business-analyst", "system-analyst", "reviewer", "qa-engineer"].includes(artifact.stage) &&
      payload.knowledgePath === null) {
    throw new Error(`artifact ${evidenceId} has no Knowledge document provenance`);
  }
  if (payload.knowledgePath !== null && payload.sourceDigest !== null) {
    if (!task?.knowledgeRoot) throw new Error(`artifact ${evidenceId} has no bound Knowledge root`);
    const root = fs.realpathSync(task.knowledgeRoot.path);
    const absolute = path.resolve(root, payload.knowledgePath);
    const real = fs.realpathSync(absolute);
    const within = path.relative(root, real);
    if (within.startsWith("..") || path.isAbsolute(within) || absolute !== real) {
      throw new Error(`artifact ${evidenceId} escapes its Knowledge root`);
    }
    if (contentHash(fs.readFileSync(real, "utf8")) !== payload.sourceDigest) {
      throw new Error(`artifact ${evidenceId} Knowledge document bytes changed`);
    }
    const preDispatch = store.loadEvidence(verifiedRun.dispatchEvidenceId);
    if (!preDispatch || preDispatch.payload.kind !== "role-dispatch" ||
        preDispatch.payload.sourceBeforeDigest === payload.sourceDigest) {
      throw new Error(`artifact ${evidenceId} has no changed Knowledge bytes after pre-dispatch evidence`);
    }
  }
  return {
    taskId: artifact.taskId,
    stage: artifact.stage,
    role: artifact.role,
    attempt: artifact.attempt,
    roleAttemptId: attemptId,
    contractDigest: payload.contractDigest,
    contentDigest: payload.contentDigest,
    knowledgePath: payload.knowledgePath,
    sourceDigest: payload.sourceDigest,
    evidenceId: artifact.evidenceId,
    dispatchEvidenceId: verifiedRun.dispatchEvidenceId,
    roleRunEvidenceId: dispatch.evidenceId,
  };
}
