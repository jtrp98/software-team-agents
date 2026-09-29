import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { EvidenceRecord } from "../evidence/evidenceStore.js";
import { verifiedArtifactProvenance } from "./artifactProvenance.js";
import { loadKnowledge, pathFor } from "./knowledgeStore.js";
import type { KnowledgeItem, KnowledgeKind, KnowledgeStatus } from "./knowledgeModel.js";
import { loadKnowledgePolicy, type KnowledgePolicy } from "./knowledgePolicy.js";
import { freshnessOf, type Freshness } from "./freshness.js";
import { loadLocalTargetMapping } from "../threeRepo/localTargets.js";
import { loadTargetRegistry } from "../threeRepo/targets.js";
import { resolveFrameworkRoot } from "../targetcli/roots.js";
import { describeStatus, type TaskStatusView } from "../orchestrator/taskStatus.js";
import { STAGE_EVIDENCE_REQUIREMENTS } from "../orchestrator/transitionGuard.js";

/**
 * The canonical discovery surface a fresh Controller reads first (V13
 * TASK-010): one manifest that indexes the Knowledge workspace and the STA
 * state that persists across sessions — operating instructions,
 * organizational knowledge, role-authored artifacts, durable decisions and
 * the task list with a next-action projection — every entry carrying the
 * digest or freshness verdict that says whether it can still be trusted.
 *
 * WHY ONE ENTRY POINT
 *
 * A Controller that has never seen this workspace must answer "what is here,
 * what is the next action, and what can I rely on" without a prior
 * conversation. Everything it needs already persists — knowledge items, the
 * evidence store, the task store, the bootstrap documents — but it was spread
 * across `sta status`, `sta knowledge get`, the STATE file and the evidence
 * tables, with no single place that says where the operating instructions are
 * and whether what they point at still hashes to what was recorded. The
 * manifest is that index; it derives everything from the same persisted
 * records the runtime reads, so it cannot become a second source of truth.
 *
 * NOTHING FAILS SILENTLY
 *
 * A missing bootstrap document, a stale artifact, a knowledge item whose
 * source moved, a broken reference — each is a line in `problems`, and the
 * `sta knowledge manifest` command exits non-zero when the list is
 * non-empty. Discovery that pretends missing material is merely absent would
 * let a fresh Controller act on a stale fact; visible failure is the point.
 *
 * READ ONLY
 *
 * Building a manifest touches nothing: it is the projection a Controller is
 * allowed to read. Governing writes stay with STA; role packet composition
 * keeps using the deterministic role-scoped selection (`knowledgeBriefFor`),
 * which is a different, narrower question than "what does this workspace
 * hold".
 */

export interface ManifestFileEntry {
  /** Forward-slashed path relative to the Knowledge root. */
  id: string;
  /** Absolute path the id resolves to. */
  path: string;
  present: boolean;
  /** sha256 of the current bytes; null when the file is absent. */
  digest: string | null;
}

export interface ManifestKnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  module: string | null;
  title: string;
  status: KnowledgeStatus;
  version: number;
  owner: AgentStage;
  /** The item's file on disk, with its current digest. */
  file: ManifestFileEntry;
  freshness: Freshness;
}

export interface ManifestArtifactEntry {
  evidenceId: string;
  taskId: string;
  stage: AgentStage;
  attempt: number;
  role: string;
  artifactType: string;
  knowledgePath: string | null;
  /** True when `verifiedArtifactProvenance` held against the bytes on disk *now*. */
  verified: boolean;
  /** The refusal reason when `verified` is false — never a silent gap. */
  problem: string | null;
}

export interface ManifestDecisionEntry {
  evidenceId: string;
  taskId: string;
  stage: AgentStage;
  role: string;
  subject: string;
  digest: string;
  recordedAt: number;
}

export interface ManifestTaskEntry {
  taskId: string;
  module: string | null;
  /** The same settled projection `sta status` renders — never a second opinion. */
  status: TaskStatusView;
  /** Deterministic discovery hint: what the next session should do about this task. */
  nextAction: string;
  completionEvidenceId: string | null;
}

export interface KnowledgeManifest {
  knowledgeRoot: string;
  now: string;
  operatingInstructions: ManifestFileEntry[];
  knowledgeItems: ManifestKnowledgeEntry[];
  artifacts: ManifestArtifactEntry[];
  decisions: ManifestDecisionEntry[];
  tasks: ManifestTaskEntry[];
  /** Every missing/stale/unverifiable reference, one line each. Empty means the manifest is fully trustworthy. */
  problems: string[];
}

/** Freshness verdicts that mean the underlying material can no longer be trusted as read. */
const BROKEN_FRESHNESS: ReadonlySet<string> = new Set(["changed", "source-changed", "source-missing", "unavailable"]);

/** Bootstrap documents a fresh Controller is told to read first (req.md §11):
 * absent ones are problems, present ones are digested. The directories are
 * indexed only when they exist — a workspace may simply not have standards yet. */
const REQUIRED_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const OPTIONAL_INSTRUCTIONS = ["knowledge/README.md", "knowledge-policy.yaml"];
const INSTRUCTION_DIRS = ["rules", "policies", "standards"];

function fileEntry(root: string, relativeId: string): ManifestFileEntry {
  const absolute = path.join(root, ...relativeId.split("/"));
  try {
    const bytes = fs.readFileSync(absolute);
    return {
      id: relativeId,
      path: absolute,
      present: true,
      digest: cryptoDigest(bytes),
    };
  } catch {
    return { id: relativeId, path: absolute, present: false, digest: null };
  }
}

function cryptoDigest(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function instructionIds(root: string): string[] {
  const ids = [...REQUIRED_INSTRUCTIONS, ...OPTIONAL_INSTRUCTIONS];
  for (const dir of INSTRUCTION_DIRS) {
    const walk = (relative: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, ...relative.split("/")), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) ids.push(child);
      }
    };
    walk(dir);
  }
  return ids;
}

/** Best-effort target-id → path mapping, so freshness of target-rooted sources
 * can be verified rather than reported unverifiable. A failure degrades to an
 * empty map, and the freshness verdict says what could not be checked. */
function targetPathsFor(root: string): ReadonlyMap<string, string> {
  try {
    const registry = loadTargetRegistry(root);
    return new Map(loadLocalTargetMapping(root, registry, resolveFrameworkRoot()).map((entry) => [entry.target_id, entry.path]));
  } catch {
    return new Map();
  }
}

function knowledgeEntry(item: KnowledgeItem, root: string, policy: KnowledgePolicy, now: string, targetPaths: ReadonlyMap<string, string>): ManifestKnowledgeEntry {
  const file = fileEntry(root, `knowledge/${item.module ?? "_project"}/${item.kind}/${item.id}.yaml`);
  const freshness = freshnessOf(item, { now, policy, projectRoot: root, knowledgeRoot: root, targetPaths });
  return {
    id: item.id,
    kind: item.kind,
    module: item.module,
    title: item.title,
    status: item.status,
    version: item.version,
    owner: item.owner,
    file,
    freshness,
  };
}

/** The discovery hint for one task, derived only from persisted state and the
 * same settled status view `sta status` renders. This is a projection for a
 * reader, never a transition decision — moving a task stays STA's alone. */
export function nextActionFor(task: PersistedTask, status: TaskStatusView): string {
  switch (status.kind) {
    case "CANCELLED":
      return "cancelled — no action";
    case "PAUSED":
      return `resume with \`sta resume --task-id ${task.taskId}\``;
    case "DEPLOYED":
      return task.completionEvidenceId
        ? `done — completion evidence ${task.completionEvidenceId}`
        : "DEPLOYED without completion evidence — verify before treating as Done";
    case "WAITING_FOR_HUMAN": {
      const pending = task.approvals.find((record) => record.status === "pending");
      return pending
        ? `human approval required: request ${pending.requestId} (${pending.scope})`
        : `human decision required: ${status.reason ?? "gate not satisfied"}`;
    }
    case "WAITING_FOR_DEPENDENCY":
      return `waiting on tasks: ${(status.waitingOn ?? []).join(", ")}`;
    case "BLOCKED":
      return `blocked: ${status.reason ?? task.blockedReason ?? "no reason recorded"}`;
    case "RUNNING": {
      const stage = task.machine.pipeline[task.pipelineCursor];
      const required = stage ? STAGE_EVIDENCE_REQUIREMENTS[stage].join(", ") : "unknown";
      const who = status.currentAgent ?? stage ?? "unknown stage";
      return `stage ${who} — required evidence: ${required}`;
    }
  }
}

function decisionKinds(record: EvidenceRecord): boolean {
  return (
    record.kind === "approval-decision" ||
    record.kind === "recovery-decision" ||
    record.kind === "stage-completion" ||
    record.kind === "task-completion"
  );
}

/** The module a v2 task was compiled for, read off its persisted plan source —
 * the same `_docs/module/<name>/plan.md` rule the preflight uses, so the
 * manifest and the binding check can never disagree about which module a row
 * belongs to. */
function moduleOf(task: PersistedTask, knowledgeRoot: string): string | null {
  const runtimeTask = task.runtimeTask;
  if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) return null;
  const modulesRoot = path.join(path.resolve(knowledgeRoot), "_docs", "module");
  const relative = path.relative(modulesRoot, path.resolve(runtimeTask.plan_source));
  const parts = relative.split(path.sep);
  return parts.length === 2 && parts[1] === "plan.md" && parts[0] !== ".." && !path.isAbsolute(relative) ? parts[0] : null;
}

export function buildKnowledgeManifest(options: {
  knowledgeRoot: string;
  store: TaskStore;
  now: string;
  policy?: KnowledgePolicy;
}): KnowledgeManifest {
  const root = path.resolve(options.knowledgeRoot);
  const policy = options.policy ?? loadKnowledgePolicy(root);
  const problems: string[] = [];

  const operatingInstructions = instructionIds(root).map((id) => fileEntry(root, id));
  for (const required of REQUIRED_INSTRUCTIONS) {
    const entry = operatingInstructions.find((instruction) => instruction.id === required);
    if (entry && !entry.present) {
      problems.push(`operating instruction \`${required}\` is missing from the Knowledge root ${root} — a fresh Controller has no bootstrap entry point`);
    }
  }

  const { items, problems: loadProblems, missing } = loadKnowledge(root);
  if (missing) {
    problems.push(`no \`knowledge/\` directory under ${root} — there is no organizational knowledge to discover`);
  }
  for (const problem of loadProblems) problems.push(`knowledge store: ${problem}`);
  const targetPaths = targetPathsFor(root);
  const knowledgeItems = items.map((item) => knowledgeEntry(item, root, policy, options.now, targetPaths));
  for (const entry of knowledgeItems) {
    if (BROKEN_FRESHNESS.has(entry.freshness.verdict)) {
      problems.push(`knowledge item ${entry.id}: ${entry.freshness.verdict} — ${entry.freshness.reason}`);
    } else if (!entry.file.present) {
      problems.push(`knowledge item ${entry.id}: its file ${entry.file.path} is missing from disk`);
    }
  }

  const artifacts: ManifestArtifactEntry[] = [];
  const decisions: ManifestDecisionEntry[] = [];
  const tasks: ManifestTaskEntry[] = [];
  for (const task of options.store.listTasks().slice().sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    const evidence = options.store.evidenceForTask(task.taskId);
    for (const record of evidence) {
      if (record.kind === "artifact" && record.payload.kind === "artifact") {
        let verified = true;
        let problem: string | null = null;
        try {
          verifiedArtifactProvenance(options.store, record.evidenceId);
        } catch (error) {
          verified = false;
          problem = error instanceof Error ? error.message : String(error);
          problems.push(`artifact ${record.evidenceId} (${record.payload.artifactType} of ${task.taskId}): ${problem}`);
        }
        artifacts.push({
          evidenceId: record.evidenceId,
          taskId: record.taskId,
          stage: record.stage,
          attempt: record.attempt,
          role: record.role,
          artifactType: record.payload.artifactType,
          knowledgePath: record.payload.knowledgePath,
          verified,
          problem,
        });
      } else if (decisionKinds(record)) {
        decisions.push({
          evidenceId: record.evidenceId,
          taskId: record.taskId,
          stage: record.stage,
          role: record.role,
          subject: record.subject,
          digest: record.digest,
          recordedAt: record.recordedAt,
        });
      }
    }
    const status = describeStatus(task);
    tasks.push({
      taskId: task.taskId,
      module: moduleOf(task, root),
      status,
      nextAction: nextActionFor(task, status),
      completionEvidenceId: task.completionEvidenceId,
    });
  }

  return {
    knowledgeRoot: root,
    now: options.now,
    operatingInstructions,
    knowledgeItems,
    artifacts,
    decisions,
    tasks,
    problems,
  };
}

const PLURAL = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`;

/** Compact human rendering; `--json` consumers read the manifest object directly. */
export function renderKnowledgeManifest(manifest: KnowledgeManifest): string[] {
  const lines: string[] = [];
  lines.push(`Knowledge manifest for ${manifest.knowledgeRoot}`);
  lines.push("");
  lines.push(`Operating instructions — ${PLURAL(manifest.operatingInstructions.length, "file")}:`);
  for (const instruction of manifest.operatingInstructions) {
    lines.push(`  ${instruction.present ? "ok " : "MISSING"} ${instruction.id}${instruction.digest ? ` sha256:${instruction.digest.slice(0, 12)}` : ""}`);
  }
  lines.push("");
  lines.push(`Organizational knowledge — ${PLURAL(manifest.knowledgeItems.length, "item")}:`);
  for (const item of manifest.knowledgeItems) {
    lines.push(`  ${item.id} v${item.version} [${item.status}, ${item.kind}] ${item.freshness.verdict} — ${item.freshness.reason}`);
  }
  lines.push("");
  lines.push(`Role-authored artifacts — ${PLURAL(manifest.artifacts.length, "record")}:`);
  for (const artifact of manifest.artifacts) {
    const state = artifact.verified ? "verified" : `UNVERIFIED: ${artifact.problem}`;
    lines.push(`  ${artifact.evidenceId} ${artifact.taskId}/${artifact.stage}/${artifact.artifactType} — ${state}`);
    if (artifact.knowledgePath) lines.push(`    knowledge: ${artifact.knowledgePath}`);
  }
  lines.push("");
  lines.push(`Durable decisions — ${PLURAL(manifest.decisions.length, "record")}:`);
  for (const decision of manifest.decisions) {
    lines.push(`  ${decision.evidenceId} ${decision.taskId}/${decision.stage} ${decision.subject} (by ${decision.role}, sha256:${decision.digest.slice(0, 12)})`);
  }
  lines.push("");
  lines.push(`Tasks — ${PLURAL(manifest.tasks.length, "task")}:`);
  for (const task of manifest.tasks) {
    lines.push(`  ${task.taskId}: ${task.status.kind} — ${task.nextAction}`);
  }
  if (manifest.problems.length > 0) {
    lines.push("");
    lines.push(`Problems — ${PLURAL(manifest.problems.length, "reference")} cannot be trusted as read:`);
    for (const problem of manifest.problems) lines.push(`  ! ${problem}`);
  }
  return lines;
}
