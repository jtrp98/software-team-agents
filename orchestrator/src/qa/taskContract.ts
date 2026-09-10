import type { PlanTask } from "../docs/planTask.js";
import type { TaskGraph, ResolvedEdge } from "../graph/taskGraph.js";
import type { PacketFields } from "../artifacts/executionPacket.js";
import type { Finding } from "../artifacts/finding.js";
import type { QaRiskSignals } from "./mode.js";

/**
 * T-V8-014 — the exact task contract a QA round verifies against.
 *
 * `productionQaInputs` previously handed QA a plan-row description plus
 * `design.md#DES-nnn` / `plan.md#BE-004` *pointers*. A pointer is not a
 * contract: it tells QA where to look for the acceptance criteria, which
 * means the round's actual standard of proof is whatever QA finds when it
 * reads there. This module carries the authored acceptance text itself,
 * alongside the identities that make a verdict checkable — the attempt and
 * packet hash the work was produced under, the real changed-file manifest,
 * the dependency outputs that were complete when it started, the graph blast
 * radius, and the durable findings (T-V8-013) still open against it.
 *
 * Nothing here decides a verdict. It fixes *what must be answered*; QA still
 * answers it from source, diffs and deterministic results. The graph is
 * candidate evidence for scope selection only — `V8-PROBLEM-ANALYSIS.md` §8.
 */

export interface QaPacketIdentity {
  stage: string;
  attempt: number;
  packet_hash: string;
  task_hash: string;
  plan_hash: string;
  config_hash: string;
  base_revision: string;
}

export interface QaDependencyOutput {
  taskId: string;
  /** Contracts the dependency produces — what this task is entitled to rely on. */
  produces: string[];
  /** Why the edge exists: authored, shared contract, or phase order. */
  edgeKinds: ResolvedEdge["kind"][];
  /** Ledger evidence the packet recorded for this dependency, when a packet was compiled. */
  evidence?: { source: string; hash: string; outputs: { source: string; hash: string }[] };
}

export interface QaBlastRadius {
  /** Direct dependencies — upstream work this task's verdict rests on. */
  dependencies: string[];
  /** Transitive graph descendants — everything a wrong verdict here would let through. */
  descendants: string[];
  /** The contract edges inside that radius, named so scope selection is auditable rather than opaque. */
  contractEdges: { from: string; to: string; reason: string }[];
  /** Phases the radius spans, this task's own included. */
  phases: number[];
}

export interface QaTaskContract {
  taskId: string;
  title: string;
  phase: number;
  owner: string;
  objective: string;
  why: string;
  /** The authored acceptance criteria text, verbatim — not a pointer to it. */
  acceptanceText: string;
  /** `AC-*` ids from the task's own traceability. */
  acceptanceIds: string[];
  /** `DES-*`/`DEC-*` ids from the task's own traceability. */
  designIds: string[];
  /** `REQ-*` ids from the task's own traceability. */
  requirementIds: string[];
  produces: string[];
  consumes: string[];
  validationAndEvidence: string;
  scopeAndConstraints: string;
  doNotModify: string;
  compatibility: string;
  risk: string[];
  humanGate: string[];
  packet?: QaPacketIdentity;
  dependencyOutputs: QaDependencyOutput[];
  blastRadius: QaBlastRadius;
  /** The real changed-file manifest for this round. Empty means the caller could not say — itself a finding. */
  fileManifest: string[];
  /** Durable findings still open against this task (OPEN/FIX_CLAIMED). */
  openFindings: Finding[];
  /** Findings already closed (VERIFIED/ACCEPTED) — history, not work. */
  closedFindings: Finding[];
}

export interface BuildQaTaskContractInput {
  task: PlanTask;
  /** The canonical full-field graph (T-V8-003). Absent leaves the blast radius empty rather than guessed. */
  graph?: TaskGraph;
  /**
   * The immutable packet the work was produced under, when one was compiled.
   * `packet_hash` lives on the persisted `ExecutionPacket` wrapper rather than
   * on `PacketFields.identity`, so it is taken separately — a Finding's
   * `packet_hash` is that same value, which is what makes the two joinable.
   */
  packet?: Pick<PacketFields, "stage" | "attempt" | "identity" | "dependencies"> & { packet_hash: string };
  findings?: readonly Finding[];
  changedFiles?: readonly string[];
}

const OPEN_STATES: ReadonlySet<Finding["status"]> = new Set<Finding["status"]>(["OPEN", "FIX_CLAIMED"]);

function idsWithPrefix(traceability: readonly string[], prefixes: readonly string[]): string[] {
  return traceability.filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
}

function blastRadiusOf(task: PlanTask, graph: TaskGraph | undefined): QaBlastRadius {
  if (!graph || !graph.nodes.has(task.id)) {
    return { dependencies: [], descendants: [], contractEdges: [], phases: [task.phase] };
  }
  const dependencies = [...graph.dependenciesOf(task.id)].sort();
  const descendants = [...graph.descendantsOf(task.id)].sort();
  // Contract edges are reported separately from the descendant list because
  // they are the ones this task's `produces` actually caused: a reviewer
  // widening or questioning the radius needs to see which edge carried it.
  const inRadius = new Set([task.id, ...descendants]);
  const contractEdges = graph.edges
    .filter((edge) => edge.kind === "contract" && inRadius.has(edge.from) && inRadius.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const phases = [
    ...new Set(
      [task.phase, ...[...dependencies, ...descendants].map((id) => graph.nodes.get(id)?.phase)].filter(
        (phase): phase is number => phase !== undefined,
      ),
    ),
  ].sort((a, b) => a - b);
  return { dependencies, descendants, contractEdges, phases };
}

function dependencyOutputsOf(
  task: PlanTask,
  graph: TaskGraph | undefined,
  packet: BuildQaTaskContractInput["packet"],
): QaDependencyOutput[] {
  const byId = new Map<string, QaDependencyOutput>();
  if (graph && graph.nodes.has(task.id)) {
    for (const entry of graph.dependencyOutputsOf(task.id)) {
      byId.set(entry.taskId, {
        taskId: entry.taskId,
        produces: [...entry.produces].sort(),
        edgeKinds: [...new Set(entry.edges.map((edge) => edge.kind))].sort(),
      });
    }
  }
  for (const dependency of packet?.dependencies ?? []) {
    const existing = byId.get(dependency.task_id);
    byId.set(dependency.task_id, {
      taskId: dependency.task_id,
      produces: existing?.produces ?? [...dependency.produces].sort(),
      edgeKinds: existing?.edgeKinds ?? [...new Set(dependency.edges)].sort(),
      evidence: {
        source: dependency.evidence.source,
        hash: dependency.evidence.hash,
        outputs: dependency.evidence.outputs.map((output) => ({ source: output.source, hash: output.hash })),
      },
    });
  }
  return [...byId.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function buildQaTaskContract(input: BuildQaTaskContractInput): QaTaskContract {
  const { task } = input;
  const findings = (input.findings ?? []).filter((finding) => finding.task_id === task.id);
  return {
    taskId: task.id,
    title: task.title,
    phase: task.phase,
    owner: task.owner,
    objective: task.objective,
    why: task.why,
    acceptanceText: task.acceptanceCriteria,
    acceptanceIds: idsWithPrefix(task.traceability, ["AC-"]),
    designIds: idsWithPrefix(task.traceability, ["DES-", "DEC-"]),
    requirementIds: idsWithPrefix(task.traceability, ["REQ-"]),
    produces: [...task.produces],
    consumes: [...task.consumes],
    validationAndEvidence: task.validationAndEvidence,
    scopeAndConstraints: task.scopeAndConstraints,
    doNotModify: task.doNotModify,
    compatibility: task.compatibility,
    risk: [...task.risk],
    humanGate: [...task.humanGate],
    ...(input.packet
      ? {
          packet: {
            stage: input.packet.stage,
            attempt: input.packet.attempt,
            packet_hash: input.packet.packet_hash,
            task_hash: input.packet.identity.task_hash,
            plan_hash: input.packet.identity.plan_hash,
            config_hash: input.packet.identity.config_hash,
            base_revision: input.packet.identity.base_revision,
          },
        }
      : {}),
    dependencyOutputs: dependencyOutputsOf(task, input.graph, input.packet),
    blastRadius: blastRadiusOf(task, input.graph),
    fileManifest: [...new Set((input.changedFiles ?? []).map((file) => file.replaceAll("\\", "/")))].sort(),
    openFindings: findings.filter((finding) => OPEN_STATES.has(finding.status)),
    closedFindings: findings.filter((finding) => !OPEN_STATES.has(finding.status)),
  };
}

/**
 * Every identity a verdict must be mapped to before a round may close.
 *
 * Mode-independent on purpose. TARGETED narrows the *file surface* a round
 * reads, never which of this task's acceptance criteria have to hold — a
 * lighter round that quietly verified fewer requirements would be exactly the
 * underscoped pass T-V8-014 exists to prevent. What TARGETED buys is not
 * asking fewer questions; it is not re-reading the whole project to answer
 * them.
 */
export function requiredVerdictIds(contract: QaTaskContract): string[] {
  return [
    ...new Set([
      contract.taskId,
      ...contract.acceptanceIds,
      ...contract.designIds,
      ...contract.openFindings.flatMap((finding) => [finding.finding_id, ...finding.acceptance_ids, ...finding.design_ids]),
    ]),
  ];
}

/**
 * Risk signals the canonical task already states, mapped to the FULL triggers
 * `qa/mode.ts` enforces.
 *
 * PM writes `Risk:` and `Human gate:` as declared facts about the task, so
 * reading them here is not inference from prose — it is the same
 * caller-supplied-boolean contract `selectQaMode` already has, sourced from
 * the plan instead of from the intake classification. Merge with
 * `riskSignalsFromClassification`; neither is a superset of the other.
 */
export function qaRiskSignalsFromTask(task: { risk: readonly string[]; humanGate: readonly string[] }): QaRiskSignals {
  const risk = new Set<string>(task.risk);
  const gate = new Set<string>(task.humanGate);
  return {
    touchesSchema: risk.has("schema") || gate.has("schema"),
    changesSharedContract: risk.has("shared-contract") || risk.has("breaking-contract") || gate.has("breaking-contract"),
    securitySensitive: risk.has("security") || risk.has("authorization") || risk.has("data-loss") || gate.has("security"),
    migrationOrCutover: gate.has("migration") || gate.has("deployment"),
  };
}

const MANIFEST_PREVIEW = 40;

/** Prompt-ready rendering. Every line is a fact QA can check, not prose about the task. */
export function renderQaTaskContract(contract: QaTaskContract): string[] {
  const list = (values: readonly string[]) => (values.length > 0 ? values.join(", ") : "none");
  const lines: string[] = [
    `## Task contract ${contract.taskId} — ${contract.title}`,
    `- phase ${contract.phase}; owner ${contract.owner}`,
    `- traceability: REQ ${list(contract.requirementIds)}; AC ${list(contract.acceptanceIds)}; DES ${list(contract.designIds)}`,
    `- contracts: produces ${list(contract.produces)}; consumes ${list(contract.consumes)}`,
    `- risk: ${list(contract.risk)}; human gates: ${list(contract.humanGate)}`,
  ];
  if (contract.packet) {
    lines.push(
      `- attempt ${contract.packet.attempt} of stage ${contract.packet.stage}; packet ${contract.packet.packet_hash}; ` +
        `task hash ${contract.packet.task_hash}; plan hash ${contract.packet.plan_hash}; base revision ${contract.packet.base_revision}`,
    );
  } else {
    lines.push("- no execution packet was persisted for this round — attempt/packet identity is unavailable, not assumed");
  }
  lines.push("", "### Objective", contract.objective, "", "### Why", contract.why);
  lines.push("", "### Acceptance criteria (authored text — this is the standard of proof)", contract.acceptanceText);
  lines.push("", "### Required validation and expected evidence", contract.validationAndEvidence);
  lines.push("", "### Scope and constraints", contract.scopeAndConstraints);
  lines.push("", "### Do not modify", contract.doNotModify);
  lines.push("", "### Compatibility", contract.compatibility);

  lines.push("", "### Dependency outputs");
  if (contract.dependencyOutputs.length === 0) lines.push("- none");
  for (const dependency of contract.dependencyOutputs) {
    lines.push(
      `- ${dependency.taskId} [${dependency.edgeKinds.join(", ")}]: produces ${list(dependency.produces)}` +
        (dependency.evidence ? `; evidence ${dependency.evidence.source} (${dependency.evidence.hash})` : "; no ledger evidence recorded"),
    );
  }

  lines.push("", "### Blast radius (graph — candidate scope, never a verdict)");
  lines.push(`- direct dependencies: ${list(contract.blastRadius.dependencies)}`);
  lines.push(`- transitive descendants: ${list(contract.blastRadius.descendants)}`);
  lines.push(`- phases spanned: ${contract.blastRadius.phases.join(", ") || "none"}`);
  for (const edge of contract.blastRadius.contractEdges) lines.push(`- contract edge ${edge.from} -> ${edge.to}: ${edge.reason}`);

  lines.push("", `### Verified file manifest (${contract.fileManifest.length} file(s) actually changed)`);
  if (contract.fileManifest.length === 0) {
    lines.push("- none reported — an empty manifest is itself a finding, not a clean round");
  } else {
    for (const file of contract.fileManifest.slice(0, MANIFEST_PREVIEW)) lines.push(`- ${file}`);
    if (contract.fileManifest.length > MANIFEST_PREVIEW) {
      lines.push(`- …and ${contract.fileManifest.length - MANIFEST_PREVIEW} more (request the full manifest if you need it)`);
    }
  }

  lines.push("", `### Open findings (${contract.openFindings.length}) — recheck every one`);
  if (contract.openFindings.length === 0) lines.push("- none");
  for (const finding of contract.openFindings) {
    lines.push(
      `- ${finding.finding_id} [${finding.status}] ${finding.category}/${finding.severity}; owner ${finding.owner}; ` +
        `raised by ${finding.raised_by}; AC ${list(finding.acceptance_ids)}; DES ${list(finding.design_ids)}`,
    );
    lines.push(`  expected: ${finding.expected}`);
    lines.push(`  observed: ${finding.observed}`);
    lines.push(`  files: ${list(finding.files.map((file) => (file.symbol ? `${file.path}#${file.symbol}` : file.path)))}`);
  }
  if (contract.closedFindings.length > 0) {
    lines.push(`- (${contract.closedFindings.length} closed finding(s) not listed — history, not this round's work)`);
  }

  const required = requiredVerdictIds(contract);
  lines.push(
    "",
    "### Verdict mapping this round must produce",
    `Give an explicit ✅/⚠️/❌ verdict, with evidence, for every one of these ${required.length} id(s) under \`## Per-Task Results\`:`,
    required.map((id) => `\`${id}\``).join(", "),
    "A PASS that maps no id, or leaves one of these unmapped, is rejected — it is not a verdict, it is an assertion.",
  );
  return lines;
}
