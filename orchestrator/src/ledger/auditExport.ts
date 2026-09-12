import { z } from "zod";
import {
  LEDGER_SCHEMA_VERSION,
  LedgerAttemptSchema,
  LedgerCheckpointSchema,
  LedgerEventSchema,
  LedgerNotFoundError,
  LedgerRunSchema,
  LedgerTaskSchema,
  type RunLedger,
} from "./runLedger.js";
import { transitionVocabulary } from "./vocabulary.js";
import { LEDGER_ADAPTER_VERSION } from "./adapters.js";

/**
 * T-V8-016 — the JSON audit/recovery export.
 *
 * This is deliberately *not* a second authority. It is a complete, versioned,
 * self-describing dump of what the ledger held at one moment: readable by a
 * person, diffable in evidence, and re-importable for verification. Nothing in
 * the running system reads it to decide what to do next — that is what makes it
 * safe for it to exist alongside SQLite, and it is the same role the wave
 * `manifest.json` keeps for runs that predate the ledger.
 */
export const RunAuditExportSchema = z.strictObject({
  export_version: z.literal(1),
  ledger_version: z.literal(LEDGER_SCHEMA_VERSION),
  adapter_version: z.literal(LEDGER_ADAPTER_VERSION),
  /** The published transition table this export was produced under, so a later reader can see the rules, not guess them. */
  vocabulary: z.object({
    run: z.record(z.string(), z.array(z.string())),
    task: z.record(z.string(), z.array(z.string())),
    attempt: z.record(z.string(), z.array(z.string())),
  }),
  run: LedgerRunSchema,
  tasks: z.array(LedgerTaskSchema),
  attempts: z.array(LedgerAttemptSchema),
  checkpoints: z.array(LedgerCheckpointSchema),
  events: z.array(LedgerEventSchema),
});
export type RunAuditExport = z.infer<typeof RunAuditExportSchema>;

export function exportRunAudit(ledger: RunLedger, runId: string): RunAuditExport {
  const run = ledger.readRun(runId);
  if (!run) throw new LedgerNotFoundError("run", runId);
  const tasks = ledger.readTasks(runId);
  return RunAuditExportSchema.parse({
    export_version: 1,
    ledger_version: LEDGER_SCHEMA_VERSION,
    adapter_version: LEDGER_ADAPTER_VERSION,
    vocabulary: transitionVocabulary(),
    run,
    tasks,
    attempts: tasks.flatMap((task) => ledger.attemptsForTask(runId, task.task_id)),
    checkpoints: ledger.checkpointsForRun(runId),
    events: ledger.eventsForRun(runId),
  });
}

export class AuditImportError extends Error {
  constructor(public readonly issues: string[]) {
    super(`run audit export does not match the current contract:\n- ${issues.join("\n- ")}`);
    this.name = "AuditImportError";
  }
}

/**
 * Parses an export back into records, refusing anything this build cannot read
 * exactly. A malformed or newer export is an actionable refusal, never a
 * partially-understood recovery: reading half a run's history is how a resume
 * reruns work that already landed.
 */
export function importRunAudit(document: unknown): RunAuditExport {
  const parsed = RunAuditExportSchema.safeParse(document);
  if (!parsed.success) {
    throw new AuditImportError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  const value = parsed.data;
  const issues: string[] = [];
  const taskIds = new Set(value.tasks.map((task) => task.task_id));
  if (JSON.stringify([...value.tasks].sort((a, b) => a.position - b.position).map((task) => task.task_id)) !== JSON.stringify(value.run.task_order)) {
    issues.push("tasks do not reproduce the run's frozen task_order");
  }
  for (const attempt of value.attempts) if (!taskIds.has(attempt.task_id)) issues.push(`attempt ${attempt.attempt_id} references unknown task ${attempt.task_id}`);
  for (const checkpoint of value.checkpoints) if (!taskIds.has(checkpoint.task_id)) issues.push(`checkpoint ${checkpoint.sha} references unknown task ${checkpoint.task_id}`);
  for (const record of [...value.tasks, ...value.attempts, ...value.checkpoints, ...value.events]) {
    if (record.run_id !== value.run.run_id) issues.push(`a record claims run ${record.run_id}, not ${value.run.run_id}`);
  }
  if (issues.length > 0) throw new AuditImportError(issues);
  return value;
}

/**
 * Proves an export round-trips: re-importing it yields the same bytes.
 *
 * Cheap, and it catches the class of bug that matters most here — an export
 * that silently drops or reorders a record still looks like a valid document.
 */
export function assertAuditRoundTrip(exported: RunAuditExport): void {
  const reimported = importRunAudit(JSON.parse(JSON.stringify(exported)));
  if (JSON.stringify(reimported) !== JSON.stringify(exported)) {
    throw new AuditImportError(["re-importing this export did not reproduce it byte-for-byte"]);
  }
}
