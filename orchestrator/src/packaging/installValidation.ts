import * as fs from "node:fs";
import * as path from "node:path";
import { checkInstallManifest, installManifestPath, type InstallManifest } from "./installManifest.js";
import { inspectStaConfig } from "./staConfig.js";
import { sha256Of } from "./templateManifest.js";
import {
  checkTargetManifest,
  loadTargetConfig,
  readTargetManifest,
  targetManifestPath,
} from "../targetcli/targetMeta.js";
import { inspectManagedBlock } from "../targetcli/knowledgeRender.js";

/**
 * T98 — checked after `init`/`upgrade`/`migrate`/`rollback`, and available on
 * its own as `--check-installation`: does the installation metadata actually
 * describe the project that's really on disk?
 *
 * T-V5-004 — the checker follows the installer. A workspace installed by
 * `software-team-agents init` carries `.agent-team/manifest.json` (F-01: the
 * previous `.sta/`-only check failed every correctly installed workspace), so
 * that manifest is validated when present, using the same structural model the
 * sync engine enforces (`checkTargetManifest`) — no second validation model.
 * A `.sta/`-only workspace still validates during the transition window, but
 * reports itself as *legacy*. Exit-code semantics are unchanged: 0 pass,
 * 1 problems (`scripts/release-gate.mjs` depends on them).
 *
 * `notes` (a file the project modified) are expected, ongoing state — a
 * modified framework file is not a problem, it's the whole point of never
 * overwriting one. `problems` are things that should not be possible from a
 * clean init — a missing manifest, an invalid config, a tracked file that
 * vanished from the project without going through anything this module knows
 * about.
 */
export interface InstallValidationResult {
  ok: boolean;
  problems: string[];
  notes: string[];
  /** Which installer's metadata was validated. */
  layout: "agent-team" | "sta";
}

export function validateInstallation(projectRoot: string): InstallValidationResult {
  if (fs.existsSync(targetManifestPath(projectRoot))) {
    return validateAgentTeamInstallation(projectRoot);
  }
  if (fs.existsSync(installManifestPath(projectRoot))) {
    return validateLegacyStaInstallation(projectRoot);
  }
  return {
    ok: false,
    layout: "agent-team",
    problems: [
      `no installation manifest found (neither .agent-team/manifest.json nor .sta/manifest.json exists under ${projectRoot}) — run \`software-team-agents init\` inside the workspace first`,
    ],
    notes: [],
  };
}

/** Validates the layout `software-team-agents init` writes (the normal case). */
function validateAgentTeamInstallation(projectRoot: string): InstallValidationResult {
  const problems: string[] = [];
  const notes: string[] = [];

  let manifest;
  try {
    manifest = readTargetManifest(projectRoot);
  } catch (e) {
    return {
      ok: false,
      layout: "agent-team",
      problems: [`.agent-team/manifest.json is not readable: ${e instanceof Error ? e.message : String(e)}`],
      notes,
    };
  }

  problems.push(...checkTargetManifest(manifest).map((p) => `.agent-team/manifest.json: ${p}`));

  try {
    const config = loadTargetConfig(projectRoot);
    if (!config) {
      problems.push(".agent-team/config.yaml is missing although manifest.json exists — restore it or delete .agent-team and re-init");
    }
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }

  for (const file of manifest.files) {
    const dest = path.join(projectRoot, file.path);
    if (!fs.existsSync(dest)) {
      // Unlike the legacy .sta/ layout (whose upgrade skips missing files), the
      // .agent-team sync engine restores any tracked-but-missing path on its
      // next run — expected, self-healing ongoing state, so a note not a
      // problem. Measured live in sb-web-student (31 dropped .opencode/commands
      // renderings).
      notes.push(`${file.path} is missing from the project — \`software-team-agents sync\` will restore it`);
      continue;
    }
    const currentHash = sha256Of(fs.readFileSync(dest));
    if (currentHash !== file.sha256) {
      notes.push(`${file.path} differs from the last-synced pristine content — \`software-team-agents sync\` will update it (backup first)`);
    }
  }

  for (const block of manifest.framework_blocks ?? []) {
    const dest = path.join(projectRoot, block.path);
    if (!fs.existsSync(dest)) {
      notes.push(`${block.path} is missing from the project — \`software-team-agents sync\` will restore it`);
      continue;
    }
    const inspected = inspectManagedBlock(block.path, fs.readFileSync(dest, "utf8"));
    if (inspected.state === "malformed") {
      problems.push(`${block.path}: ${inspected.detail} — restore it from .agent-team/backups or repair the marker pair manually`);
      continue;
    }
    if (inspected.state === "absent") {
      notes.push(`${block.path} no longer carries the Framework block recorded in .agent-team/manifest.json`);
      continue;
    }
    if (sha256Of(inspected.block) !== block.sha256) {
      notes.push(`${block.path}'s Framework block differs from the last-synced version — \`software-team-agents sync\` will update it`);
    }
  }

  return { ok: problems.length === 0, problems, notes, layout: "agent-team" };
}

/** Validates the pre-V5 `.sta/` layout. Still functional during the transition; reported as legacy, never as the normal case. */
function validateLegacyStaInstallation(projectRoot: string): InstallValidationResult {
  const problems: string[] = [];
  const notes: string[] = [
    "legacy .sta/ layout — the current installer writes .agent-team/ via `software-team-agents init`; this layout keeps validating during the transition only",
  ];

  const manifestPath = installManifestPath(projectRoot);
  let manifest: InstallManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as InstallManifest;
  } catch (e) {
    return {
      ok: false,
      layout: "sta",
      problems: [`${manifestPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
      notes,
    };
  }

  problems.push(...checkInstallManifest(manifest).map((p) => `.sta/manifest.json: ${p}`));

  for (const file of manifest.files) {
    const dest = path.join(projectRoot, file.path);
    if (!fs.existsSync(dest)) {
      problems.push(`${file.path} is tracked in .sta/manifest.json but is missing from the project`);
      continue;
    }
    const currentHash = sha256Of(fs.readFileSync(dest));
    if (currentHash !== file.sha256) {
      notes.push(`${file.path} differs from the framework's last-installed version — \`sta upgrade\` will skip it`);
    }
  }

  const config = inspectStaConfig(projectRoot);
  problems.push(...config.problems);
  notes.push(...config.warnings);

  return { ok: problems.length === 0, problems, notes, layout: "sta" };
}
