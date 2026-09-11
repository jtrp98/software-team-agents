import * as fs from "node:fs";
import { runArtifactPaths, type KnownJournalRecord, type RunManifest } from "./journal.js";

/**
 * T-V8-029 — writes a pre-V8 `.workflow/wave-runs/<id>` record for tests.
 *
 * `run/journal.ts` no longer exports a writer, because the wave lifecycle that
 * owned them is retired and an old record must never gain new entries. Tests
 * still need such a directory to exist, to prove the *readers* still read it:
 * `ledger/adapters.ts`'s versioned projection, `run/observability.ts`, and the
 * `sta status`/`sta report`/`sta changed` surfaces that label it as legacy.
 *
 * This is deliberately test-only and deliberately dumb — it does no validation
 * and enforces no state machine, so a test can write exactly the bytes an
 * older version would have left behind, including a broken one.
 */
export function writeLegacyWaveRun(
  projectRoot: string,
  manifest: RunManifest,
  records: readonly KnownJournalRecord[] = [],
): { manifest: string; journal: string } {
  const paths = runArtifactPaths(projectRoot, manifest.run_id);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const record of records) fs.appendFileSync(paths.journal, `${JSON.stringify(record)}\n`, "utf8");
  return { manifest: paths.manifest, journal: paths.journal };
}

/** Appends one more legacy record, for a test that builds a record in stages. */
export function appendLegacyWaveRecord(projectRoot: string, runId: string, record: KnownJournalRecord): void {
  fs.appendFileSync(runArtifactPaths(projectRoot, runId).journal, `${JSON.stringify(record)}\n`, "utf8");
}
