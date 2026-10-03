import * as path from "node:path";
import { defaultInstallationConfigPath } from "../threeRepo/installation.js";

/**
 * STA Core's machine-local home: the directory that already holds
 * `installation.yaml` (`%LOCALAPPDATA%\software-team-agents` on Windows,
 * `~/.config/software-team-agents` elsewhere). Everything the Core persists —
 * its database, service record, per-run overlays, logs and the encrypted
 * Intent secret — lives here, outside every Knowledge, Target and Framework
 * repository by construction.
 *
 * Derived from `defaultInstallationConfigPath()` rather than recomputed, so the
 * one test/E2E override channel (`STA_INSTALLATION_CONFIG`) isolates the Core
 * home too, and a production machine has exactly one answer.
 */
export function coreHome(): string {
  return path.dirname(defaultInstallationConfigPath());
}

export interface CorePaths {
  readonly home: string;
  readonly machineConfig: string;
  readonly installationConfig: string;
  readonly database: string;
  readonly serviceRecord: string;
  readonly runsDir: string;
  readonly logsDir: string;
  readonly secretsDir: string;
}

export function corePaths(home = coreHome()): CorePaths {
  const coreDir = path.join(home, "core");
  return {
    home,
    machineConfig: path.join(home, "machine.yaml"),
    installationConfig: path.join(home, "installation.yaml"),
    database: path.join(coreDir, "core.db"),
    serviceRecord: path.join(coreDir, "service.json"),
    runsDir: path.join(coreDir, "runs"),
    logsDir: path.join(coreDir, "logs"),
    secretsDir: path.join(home, "secrets"),
  };
}

/** The per-run overlay a bounded-run child reads via `--core-run <id>`. */
export function runOverlayPath(runId: string, home = coreHome()): string {
  return path.join(corePaths(home).runsDir, runId, "overlay.json");
}

export function runLogPath(runId: string, segment: number, home = coreHome()): string {
  return path.join(corePaths(home).runsDir, runId, `segment-${segment}.log`);
}
