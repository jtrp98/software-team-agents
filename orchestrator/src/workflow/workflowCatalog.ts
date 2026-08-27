import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage, TaskLevel } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask, type ClassificationInput } from "../classification/taskClassifier.js";
import type { WorkflowDefinition, WorkflowStep, WorkflowTrigger } from "./workflowDefinition.js";

/**
 * Where the generated files live. Declared here rather than in
 * `workflowDefinition.ts` so the dependency runs one way only — the loader
 * reads the catalog, the catalog never reads the loader — and re-exported there
 * for callers that only ever needed a path.
 */
export function workflowsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "workflows");
}

export function workflowPath(id: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(workflowsDir(projectRoot), `${id}.yml`);
}

/**
 * The single authored source for "which agents run, in what order, for one kind
 * of change" (T-V3TOK-110, ADR-007).
 *
 * WHY THIS FILE EXISTS
 *
 * `workflows/*.yml` used to be hand-written next to a hand-written classifier,
 * with `--check-workflows` comparing the two. That is a dual source of truth
 * kept aligned by lint: every classifier edit demanded a matching YAML edit, and
 * the lint could only object *after* someone forgot. The files were never
 * runtime inputs — nothing but two checkers ever read them — so the duplication
 * bought documentation at the price of a sync obligation.
 *
 * Now there is one authored source and one generated artifact:
 *
 *   `taskClassifier.ts`   the behaviour — what actually runs (unchanged)
 *   this file             the prose the classifier does not model
 *   `workflows/*.yml`     GENERATED from both; byte-checked by --check-workflows
 *
 * Behaviour is *derived*, never re-declared: {@link deriveSignalWorkflow} probes
 * `classifyTask()` and reads the step list, the conditions, the level and the
 * approval flag straight out of its answers. Editing the classifier and running
 * `node scripts/regenerate-renderings.mjs` is the whole procedure — there is no
 * second place to keep aligned, which is why the drift check could be tightened
 * from a semantic comparison to a byte comparison (the pattern
 * `--check-bindings` already uses for `.codex/`, `.opencode/` and
 * `.agents/skills`).
 *
 * THE THREE WORKFLOWS THAT CANNOT BE DERIVED
 *
 * `hotfix`, `refactor` and `security-fix` are distinguished by *intent*, not by
 * anything observable in the change — a refactor and a bug fix look identical
 * from outside, and "this is urgent" is a property of the situation. The
 * classifier has no signal for them and must not grow one, so they are named
 * explicitly by the caller. They are authored here in full (see
 * {@link EXPLICIT_BEHAVIOUR}) rather than derived — but they are still authored
 * exactly *once*, so no sync obligation exists for them either.
 */

/** Every classification signal that selects a workflow, plus the id it selects. */
const SIGNAL_WORKFLOWS: readonly { id: string; signal: keyof ClassificationInput }[] = [
  { id: "deploy", signal: "isProductionDeployOrMigration" },
  { id: "feature", signal: "isNewFeatureModuleOrProject" },
  { id: "schema-change", signal: "touchesSchema" },
  { id: "business-rule", signal: "touchesBusinessRuleOnly" },
  { id: "incremental", signal: "isIncrementalFeature" },
  { id: "bugfix", signal: "isClearBugFix" },
  { id: "typo", signal: "isTypoOrCopyOnly" },
];

/** The id the classifier falls back to when no signal matched. */
const TRIAGE_ID = "triage";

/**
 * Triage's priority is the one number not derived from the classifier, because
 * "nothing matched" is not a signal that can lose a race against another one.
 * It is last by construction; 99 leaves room for signals added later.
 */
const TRIAGE_PRIORITY = 99;

/** Prose a workflow file carries that the classifier has no reason to model. */
interface WorkflowDoc {
  /** The `#` block above `workflow:` — why this pipeline is shaped the way it is. */
  rationale: string[];
  /** The `description:` line. */
  description: string;
  /** Comment lines emitted directly above `priority:`, explaining the precedence. */
  priorityRationale?: string[];
  /** Per-step `note:` text, keyed by the agent it hangs off. */
  notes?: Partial<Record<AgentStage, string>>;
}

/**
 * Every note and description the hand-written workflow files carried, kept
 * verbatim. This is the half of those files that was worth keeping: the
 * classifier can say *what* runs but not *why this shape and not another*.
 */
const WORKFLOW_DOCS: Readonly<Record<string, WorkflowDoc>> = {
  bugfix: {
    rationale: [
      "Requirement and schema already cover the case; the code simply does not match them.",
      "Nothing upstream has a question to answer, so nothing upstream runs.",
    ],
    description: "Bug fix where requirement and schema are already clear - BA, SA and PM all skipped.",
  },
  "business-rule": {
    rationale: [
      "A rule changed, the shape of the data did not. BA and SA amend their documents;",
      "project-manager earns no run because there is not enough work to phase.",
    ],
    description: "Business rule change with no schema impact - BA and SA amend, project-manager skipped.",
  },
  deploy: {
    rationale: [
      "An actual production deploy or DB migration. The work it ships was verified by its own",
      "upstream task, so this workflow starts at the gate rather than re-running the pipeline.",
    ],
    description: "Production deploy or database migration - always stops for a person first.",
    notes: {
      [AgentStage.DEVOPS]: "refuses to ship a phase qa-engineer has not accepted, whatever this file says",
    },
  },
  feature: {
    rationale: ["Brand-new feature, module or project: nothing is assumed, so no stage is skipped."],
    description: "New feature, module or project - the full chain, starting from a requirements interview.",
    priorityRationale: [
      "Above `schema-change` (priority 2): a brand-new feature/module/project that",
      "also touches the schema still starts from the requirements interview — it",
      "must not silently degrade into the schema-only pipeline that skips",
      "business-analyst and project-manager.",
    ],
  },
  hotfix: {
    rationale: [
      "An urgent production fix. It skips the analysis stages, but deliberately does NOT skip",
      "qa-engineer: shipping unverified is what turns one incident into two, and devops refuses a",
      "phase QA has not accepted regardless of how the task was classified.",
      "",
      "Chosen explicitly: urgency is a property of the situation, not of the change.",
    ],
    description: "Urgent production fix - straight to the engineers, then verified and shipped.",
    notes: {
      [AgentStage.DEVOPS]: "still gated - an unverified or unaudited phase is refused even here",
    },
  },
  incremental: {
    rationale: [
      "Building out a module whose requirements are already understood. The business interview",
      "would ask nothing new, so it is skipped; the design still gets a look.",
    ],
    description: "Incremental feature on an existing module - business-analyst and project-manager skipped.",
  },
  refactor: {
    rationale: [
      "Behaviour is meant to stay identical, so there is no requirement or design question to ask -",
      "but QA matters more than usual, because \"unchanged behaviour\" is exactly the claim under test.",
      "",
      "Chosen explicitly: a refactor and a bug fix look the same from the outside, and the difference",
      "is what the author intended. Inferring it from the diff would be guessing.",
    ],
    description: "Restructuring with no intended behaviour change - verification is the point.",
  },
  "schema-change": {
    rationale: [
      "Adds or alters a field/table/relation. The costliest mistake available in this pipeline,",
      "so it never skips system-analyst and never skips a security pass.",
    ],
    description: "Data model change - routes through system-analyst, schema confirmation always needs a person.",
    priorityRationale: [
      "Below `feature` (priority 1): a brand-new feature/module that also needs new",
      "tables must run the full requirements interview first — this pipeline is for",
      "schema work on something that already exists.",
    ],
    notes: {
      [AgentStage.SECURITY]: "a schema change gets a security pass whether or not the caller flagged one",
    },
  },
  "security-fix": {
    rationale: [
      "Remediating a finding the security agent raised. security runs unconditionally, because the",
      "whole point is re-auditing, and only security may close its own finding - an engineer's fix",
      "moves it to \"fix claimed\" and no further.",
      "",
      "Chosen explicitly: the trigger is a finding in security.md, which is not a classification signal.",
    ],
    description: "Fixing a raised security finding - re-audited by security, never closed by the fixer.",
  },
  triage: {
    rationale: [
      "No signal matched. The one thing this must never do is pick a level anyway: an",
      "unclassified task gets a person, because guessing here is wrong in a way nothing downstream catches.",
    ],
    description: "Nothing matched - escalate to a person rather than defaulting to a level.",
    notes: {
      [AgentStage.HUMAN]: "no forward path exists until a person re-classifies the task",
    },
  },
  typo: {
    rationale: [
      "Copy or styling only. Running nine stages for a wording fix is waste, not diligence",
      "(CLAUDE.md, \"Right-size the pipeline\").",
    ],
    description: "Copy or styling change only - engineer alone, no QA stage.",
  },
};

/**
 * The three intent-named workflows, authored in full because no classification
 * signal selects them. Kept deliberately small: anything derivable belongs in
 * the classifier, and adding a signal here to "complete the table" would be
 * inventing runtime behaviour nobody asked for.
 */
const EXPLICIT_BEHAVIOUR: Readonly<
  Record<string, { level: TaskLevel; requiresHumanApproval: boolean; steps: readonly Omit<WorkflowStep, "note">[] }>
> = {
  hotfix: {
    level: TaskLevel.MEDIUM,
    requiresHumanApproval: true,
    steps: [
      { agent: AgentStage.BACKEND_ENGINEER, when: "touchesBackend" },
      { agent: AgentStage.FRONTEND_ENGINEER, when: "touchesFrontend" },
      { agent: AgentStage.QA_ENGINEER },
      { agent: AgentStage.DEVOPS },
    ],
  },
  refactor: {
    level: TaskLevel.SMALL,
    requiresHumanApproval: false,
    steps: [
      { agent: AgentStage.BACKEND_ENGINEER, when: "touchesBackend" },
      { agent: AgentStage.FRONTEND_ENGINEER, when: "touchesFrontend" },
      { agent: AgentStage.QA_ENGINEER },
      { agent: AgentStage.SECURITY, when: "touchesSensitiveArea" },
    ],
  },
  "security-fix": {
    level: TaskLevel.LARGE_CRITICAL,
    requiresHumanApproval: true,
    steps: [
      { agent: AgentStage.BACKEND_ENGINEER, when: "touchesBackend" },
      { agent: AgentStage.FRONTEND_ENGINEER, when: "touchesFrontend" },
      { agent: AgentStage.QA_ENGINEER },
      { agent: AgentStage.SECURITY, when: "always_sensitive" },
      { agent: AgentStage.DEVOPS },
    ],
  },
};

export class WorkflowDerivationError extends Error {
  constructor(message: string) {
    super(`workflow catalog cannot be derived from the classifier: ${message}`);
    this.name = "WorkflowDerivationError";
  }
}

// --- precedence -------------------------------------------------------------

/**
 * A classification's identity for precedence purposes, with `security` removed.
 *
 * The security stage is the one thing a *losing* signal can still add: a
 * new-feature task that also touches the schema runs the feature pipeline and
 * gains a security pass from the schema obligation. Comparing the full pipeline
 * would then match neither pure workflow and make the precedence undecidable,
 * so the shared obligation is excluded and the pipeline shape decides.
 */
function precedenceShape(input: ClassificationInput): string {
  const result = classifyTask(input);
  return `${result.level}|${result.pipeline.filter((stage) => stage !== AgentStage.SECURITY).join(">")}`;
}

const PRECEDENCE_PROBE: ClassificationInput = { touchesBackend: true, touchesFrontend: true };

/** True when `a`'s pipeline is what the classifier produces with both signals set. */
function winsOver(a: keyof ClassificationInput, b: keyof ClassificationInput): boolean {
  const both = precedenceShape({ ...PRECEDENCE_PROBE, [a]: true, [b]: true });
  return both === precedenceShape({ ...PRECEDENCE_PROBE, [a]: true });
}

/**
 * The order the classifier tests its signals in, read out of the classifier
 * itself rather than restated as a number somebody maintains. Ranking by "how
 * many other signals this one beats" gives a total order without depending on a
 * comparator being a strict weak ordering.
 */
export function derivePriorities(): Map<string, number> {
  const wins = new Map<string, number>();
  for (const { id, signal } of SIGNAL_WORKFLOWS) {
    let count = 0;
    for (const other of SIGNAL_WORKFLOWS) {
      if (other.signal === signal) continue;
      if (winsOver(signal, other.signal)) count += 1;
    }
    wins.set(id, count);
  }

  const ordered = [...SIGNAL_WORKFLOWS].sort((x, y) => (wins.get(y.id) ?? 0) - (wins.get(x.id) ?? 0));
  const priorities = new Map<string, number>();
  ordered.forEach(({ id }, index) => {
    const clash = [...priorities.entries()].find(([, p]) => p === index);
    if (clash) throw new WorkflowDerivationError(`${id} and ${clash[0]} both rank ${index}`);
    priorities.set(id, index);
  });
  priorities.set(TRIAGE_ID, TRIAGE_PRIORITY);
  return priorities;
}

// --- derivation -------------------------------------------------------------

const NO_FLAGS: ClassificationInput = {};
const BACKEND_ONLY: ClassificationInput = { touchesBackend: true };
const FRONTEND_ONLY: ClassificationInput = { touchesFrontend: true };
const BOTH_ENGINEERS: ClassificationInput = { touchesBackend: true, touchesFrontend: true };
const SENSITIVE: ClassificationInput = { touchesBackend: true, touchesFrontend: true, touchesSensitiveArea: true };

/**
 * Reads one workflow out of the classifier by asking it the five questions the
 * `when:` vocabulary can express. A stage present with no engineer flag at all
 * is unconditional; one that appears only alongside a flag carries that flag as
 * its condition.
 *
 * `security` is the exception the schema already has a word for: when it runs
 * without anybody flagging a sensitive area, that is not an unconditional step
 * but a forced one, and `always_sensitive` says so.
 */
function deriveSteps(signal: keyof ClassificationInput, id: string): WorkflowStep[] {
  const pipelineFor = (flags: ClassificationInput) => classifyTask({ ...flags, [signal]: true }).pipeline;
  const none = pipelineFor(NO_FLAGS);
  const backend = pipelineFor(BACKEND_ONLY);
  const frontend = pipelineFor(FRONTEND_ONLY);
  const sensitive = pipelineFor(SENSITIVE);

  const steps: WorkflowStep[] = [];
  for (const stage of sensitive) {
    if (steps.some((step) => step.agent === stage)) continue;
    const inNone = none.includes(stage);
    const inBackend = backend.includes(stage);
    const inFrontend = frontend.includes(stage);

    if (inNone) {
      steps.push(stage === AgentStage.SECURITY ? { agent: stage, when: "always_sensitive" } : { agent: stage });
      continue;
    }
    if (inBackend && !inFrontend) {
      steps.push({ agent: stage, when: "touchesBackend" });
      continue;
    }
    if (inFrontend && !inBackend) {
      steps.push({ agent: stage, when: "touchesFrontend" });
      continue;
    }
    if (!inBackend && !inFrontend) {
      steps.push({ agent: stage, when: "touchesSensitiveArea" });
      continue;
    }
    throw new WorkflowDerivationError(
      `${id}: ${stage} appears for a backend-only and a frontend-only task but not for a task with neither — ` +
        "the `when:` vocabulary cannot express that, so the generated file would be wrong",
    );
  }
  return steps;
}

/** One derived workflow: everything behavioural comes from the classifier, everything prose from {@link WORKFLOW_DOCS}. */
function deriveSignalWorkflow(id: string, signal: keyof ClassificationInput, priority: number): WorkflowDefinition {
  const shapes = [NO_FLAGS, BACKEND_ONLY, FRONTEND_ONLY, BOTH_ENGINEERS, SENSITIVE].map((flags) =>
    classifyTask({ ...flags, [signal]: true }),
  );
  const [first] = shapes;
  for (const shape of shapes) {
    if (shape.level !== first.level) {
      throw new WorkflowDerivationError(`${id}: level depends on the engineer flags (${first.level} vs ${shape.level})`);
    }
    if (shape.requiresHumanApproval !== first.requiresHumanApproval) {
      throw new WorkflowDerivationError(`${id}: requires_human_approval depends on the engineer flags`);
    }
  }

  return {
    workflow: id,
    description: doc(id).description,
    trigger: { kind: "signal", signal: signal as Extract<WorkflowTrigger, { kind: "signal" }>["signal"], priority },
    level: first.level,
    requires_human_approval: first.requiresHumanApproval,
    steps: withNotes(id, deriveSteps(signal, id)),
  };
}

function doc(id: string): WorkflowDoc {
  const entry = WORKFLOW_DOCS[id];
  if (!entry) throw new WorkflowDerivationError(`no prose recorded for workflow "${id}"`);
  return entry;
}

function withNotes(id: string, steps: readonly Omit<WorkflowStep, "note">[]): WorkflowStep[] {
  const notes = doc(id).notes ?? {};
  return steps.map((step) => {
    const note = notes[step.agent];
    return note === undefined ? { ...step } : { ...step, note };
  });
}

/** The triage workflow: the classifier's "no signal matched" answer, read the same way. */
function deriveTriage(priority: number): WorkflowDefinition {
  const result = classifyTask({});
  return {
    workflow: TRIAGE_ID,
    description: doc(TRIAGE_ID).description,
    trigger: { kind: "signal", signal: "none", priority },
    level: result.level,
    requires_human_approval: result.requiresHumanApproval,
    steps: withNotes(
      TRIAGE_ID,
      result.pipeline.map((agent) => ({ agent })),
    ),
  };
}

function explicitWorkflow(id: string): WorkflowDefinition {
  const behaviour = EXPLICIT_BEHAVIOUR[id];
  if (!behaviour) throw new WorkflowDerivationError(`no authored behaviour for explicit workflow "${id}"`);
  return {
    workflow: id,
    description: doc(id).description,
    trigger: { kind: "explicit" },
    level: behaviour.level,
    requires_human_approval: behaviour.requiresHumanApproval,
    steps: withNotes(id, behaviour.steps),
  };
}

/**
 * Every workflow, derived. This is what `reviewSeparation.ts` and the file
 * generator both read — neither parses YAML any more, so neither can be looking
 * at a stale copy of a pipeline that moved on.
 */
export function catalogWorkflows(): Record<string, WorkflowDefinition> {
  const priorities = derivePriorities();
  const out: Record<string, WorkflowDefinition> = {};
  for (const { id, signal } of SIGNAL_WORKFLOWS) {
    out[id] = deriveSignalWorkflow(id, signal, priorities.get(id)!);
  }
  out[TRIAGE_ID] = deriveTriage(priorities.get(TRIAGE_ID)!);
  for (const id of Object.keys(EXPLICIT_BEHAVIOUR)) out[id] = explicitWorkflow(id);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every workflow id the catalog defines, sorted — the filenames `workflows/` must contain, exactly. */
export function catalogWorkflowIds(): string[] {
  return Object.keys(catalogWorkflows()).sort();
}

// --- rendering --------------------------------------------------------------

/**
 * YAML plain scalars where they are safe and double-quoted ones where they are
 * not. Every description and note in this catalog is plain-safe today; the
 * quoting branch exists so a future note containing a colon produces a valid
 * file rather than a silently mis-parsed one.
 */
function scalar(value: string): string {
  const needsQuoting =
    value.length === 0 ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#/.test(value) ||
    value.trim() !== value ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[-+]?[0-9]/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function commentBlock(lines: readonly string[], indent = ""): string[] {
  return lines.map((line) => (line === "" ? `${indent}#` : `${indent}# ${line}`));
}

/**
 * One workflow file's exact bytes. Deterministic and total — the same catalog
 * always renders the same text, which is what lets `--check-workflows` compare
 * bytes instead of meanings.
 */
export function renderWorkflowYaml(workflow: WorkflowDefinition): string {
  const entry = doc(workflow.workflow);
  const lines: string[] = [...commentBlock(entry.rationale)];

  lines.push(`workflow: ${scalar(workflow.workflow)}`);
  lines.push(`description: ${scalar(workflow.description)}`);
  lines.push("trigger:");
  lines.push(`  kind: ${workflow.trigger.kind}`);
  if (workflow.trigger.kind === "signal") {
    lines.push(`  signal: ${workflow.trigger.signal}`);
    if (entry.priorityRationale) lines.push(...commentBlock(entry.priorityRationale, "  "));
    lines.push(`  priority: ${workflow.trigger.priority}`);
  }
  lines.push(`level: ${workflow.level}`);
  lines.push(`requires_human_approval: ${workflow.requires_human_approval}`);
  lines.push("steps:");
  for (const step of workflow.steps) {
    lines.push(`  - agent: ${step.agent}`);
    if (step.when) lines.push(`    when: ${step.when}`);
    if (step.note) lines.push(`    note: ${scalar(step.note)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Every generated workflow file as `<relative posix path> → bytes`, sorted by path. */
export function renderWorkflowFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, workflow] of Object.entries(catalogWorkflows())) {
    out.set(`workflows/${id}.yml`, renderWorkflowYaml(workflow));
  }
  return out;
}

// --- generate / check -------------------------------------------------------

export interface WorkflowGenerationResult {
  /** Repo-relative paths actually written (unchanged files are left alone). */
  written: string[];
  /** Repo-relative paths deleted because the catalog no longer defines them. */
  removed: string[];
}

/** Writes `workflows/*.yml` from the catalog, removing any file the catalog no longer defines. */
export function generateWorkflowFiles(projectRoot: string = defaultProjectRoot()): WorkflowGenerationResult {
  const dir = workflowsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const rendered = renderWorkflowFiles();
  const written: string[] = [];
  const removed: string[] = [];

  for (const [rel, content] of rendered) {
    const dest = path.join(projectRoot, ...rel.split("/"));
    // Compare the way `checkWorkflowFiles` does — on normalized newlines. A
    // checkout with CRLF endings is already correct, and rewriting it to LF
    // every run would leave the tree permanently dirty for no content change.
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (current !== null && current.replace(/\r\n/g, "\n") === content) continue;
    fs.writeFileSync(dest, Buffer.from(current !== null && current.includes("\r\n") ? content.replace(/\n/g, "\r\n") : content, "utf8"));
    written.push(rel);
  }

  const expected = new Set([...rendered.keys()].map((rel) => path.basename(rel)));
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".yml") || expected.has(file)) continue;
    fs.rmSync(path.join(dir, file));
    removed.push(`workflows/${file}`);
  }
  return { written, removed };
}

export interface WorkflowFileCheck {
  ok: boolean;
  problems: string[];
}

/**
 * The deterministic half of `--check-workflows`: every committed workflow file
 * is byte-identical to what this catalog renders today, and no orphan file
 * survives. Byte equality is a stronger statement than the semantic comparison
 * it replaced — that one only probed four flag combinations, so a note, a
 * description or a priority could drift without anything objecting.
 */
export function checkWorkflowFiles(projectRoot: string = defaultProjectRoot()): WorkflowFileCheck {
  const problems: string[] = [];
  let rendered: Map<string, string>;
  try {
    rendered = renderWorkflowFiles();
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : String(e)] };
  }

  for (const [rel, content] of rendered) {
    const dest = path.join(projectRoot, ...rel.split("/"));
    if (!fs.existsSync(dest)) {
      problems.push(`missing ${rel} — run \`node scripts/regenerate-renderings.mjs\``);
      continue;
    }
    const actual = fs.readFileSync(dest, "utf8").replace(/\r\n/g, "\n");
    if (actual !== content) {
      problems.push(
        `${rel} does not match what the classifier and workflow catalog render — ` +
          "edit `orchestrator/src/classification/taskClassifier.ts` or `orchestrator/src/workflow/workflowCatalog.ts`, " +
          "then run `node scripts/regenerate-renderings.mjs` (this file is generated, never hand-edited)",
      );
    }
  }

  const expected = new Set([...rendered.keys()].map((rel) => path.basename(rel)));
  const dir = workflowsDir(projectRoot);
  let present: string[];
  try {
    present = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch {
    return { ok: false, problems: [...problems, `no workflows directory at ${dir}`] };
  }
  for (const file of present) {
    if (!expected.has(file)) {
      problems.push(`orphan workflows/${file} with no entry in the workflow catalog — regenerate the workflow files`);
    }
  }
  return { ok: problems.length === 0, problems };
}
