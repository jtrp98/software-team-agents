import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface ArchivedLegacyRecord {
  readonly relativePath: string;
  readonly kind: "packet" | "wave-run";
  readonly taskId?: string;
  readonly sha256: string;
  readonly data: unknown;
}

export interface LegacyArchiveManifest {
  readonly archiveVersion: 1;
  readonly archivedAt: string;
  readonly projectRoot: string;
  readonly records: readonly ArchivedLegacyRecord[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * V13 TASK-023: One-time read-only export and archive of legacy task data
 * (legacy packets and retired wave-run journals) before explicit schema cutover.
 * Retained old records are preserved in .workflow/archive/ for auditability.
 */
export function archiveLegacyTaskData(projectRoot: string): {
  readonly archivedPackets: number;
  readonly archivedWaveRuns: number;
  readonly archivePath: string | null;
} {
  const workflowDir = path.resolve(projectRoot, ".workflow");
  if (!fs.existsSync(workflowDir)) {
    return { archivedPackets: 0, archivedWaveRuns: 0, archivePath: null };
  }

  const records: ArchivedLegacyRecord[] = [];

  // 1. Scan .workflow/packets for pre-v2 legacy execution packets
  const packetsDir = path.join(workflowDir, "packets");
  if (fs.existsSync(packetsDir)) {
    for (const taskEntry of fs.readdirSync(packetsDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const taskDir = path.join(packetsDir, taskEntry.name);
      for (const fileEntry of fs.readdirSync(taskDir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
        const filePath = path.join(taskDir, fileEntry.name);
        try {
          const rawText = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(rawText);
          if (!parsed || typeof parsed !== "object" || parsed.version !== 2) {
            records.push({
              relativePath: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
              kind: "packet",
              taskId: taskEntry.name,
              sha256: sha256(rawText),
              data: parsed,
            });
          }
        } catch {
          // ignore unreadable/corrupt files during archive discovery
        }
      }
    }
  }

  // 2. Scan .workflow/wave-runs for retired wave manifests/journals
  const waveRunsDir = path.join(workflowDir, "wave-runs");
  if (fs.existsSync(waveRunsDir)) {
    for (const runEntry of fs.readdirSync(waveRunsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(waveRunsDir, runEntry.name);
      for (const fileEntry of fs.readdirSync(runDir, { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue;
        const filePath = path.join(runDir, fileEntry.name);
        try {
          const rawText = fs.readFileSync(filePath, "utf8");
          records.push({
            relativePath: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
            kind: "wave-run",
            sha256: sha256(rawText),
            data: fileEntry.name.endsWith(".json") ? JSON.parse(rawText) : rawText,
          });
        } catch {
          // ignore
        }
      }
    }
  }

  if (records.length === 0) {
    return { archivedPackets: 0, archivedWaveRuns: 0, archivePath: null };
  }

  const archiveDir = path.join(workflowDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, "legacy_task_data_archive.json");

  const manifest: LegacyArchiveManifest = {
    archiveVersion: 1,
    archivedAt: new Date().toISOString(),
    projectRoot: path.resolve(projectRoot),
    records,
  };

  fs.writeFileSync(archivePath, JSON.stringify(manifest, null, 2), "utf8");

  const archivedPackets = records.filter((r) => r.kind === "packet").length;
  const archivedWaveRuns = records.filter((r) => r.kind === "wave-run").length;

  return { archivedPackets, archivedWaveRuns, archivePath };
}
