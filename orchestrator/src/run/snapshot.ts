import {
  isKnownJournalRecord,
  readJournal,
  readRunManifest,
  type KnownJournalRecord,
  type RunManifest,
} from "./journal.js";
import { reconstructRunState, type RunState } from "./stateMachine.js";

export interface RunDiskSnapshot {
  manifest: RunManifest;
  records: KnownJournalRecord[];
  state: RunState;
  truncatedFinalLine: boolean;
}

/** Rebuilds current run identity and state using only its durable files. */
export function loadRunDiskSnapshot(projectRoot: string, runId: string): RunDiskSnapshot {
  const manifest = readRunManifest(projectRoot, runId);
  const journal = readJournal(projectRoot, runId);
  const unknown = journal.records.filter((record) => !isKnownJournalRecord(record));
  if (unknown.length > 0) {
    throw new Error(`run ${runId} contains unknown journal kind(s): ${unknown.map((record) => record.kind).join(", ")}`);
  }
  const records = journal.records.filter(isKnownJournalRecord);
  return {
    manifest,
    records,
    state: reconstructRunState(records),
    truncatedFinalLine: journal.truncatedFinalLine,
  };
}
