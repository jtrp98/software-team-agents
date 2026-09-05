import * as fs from "node:fs";
import * as path from "node:path";
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
 *
 * T-V5-038 — the `.sta/`-only installer (`sta init`/`sta upgrade`) is gone, so
 * there is no longer a legacy layout to validate here: a workspace with
 * neither `.agent-team/manifest.json` nor a `.sta/manifest.json` (a project
 * that never ran the current installer, or one still on the retired `.sta/`
 * layout) reports one actionable problem naming `software-team-agents init`
 * as the way forward. `.sta/` itself keeps validating separately, and only
 * for rollback, through `rollback.ts`'s own legacy-backup fallback — that is
 * a different mechanism (undo, not install-state checking) and out of scope
 * here.
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
}

export function validateInstallation(projectRoot: string): InstallValidationResult {
  if (fs.existsSync(targetManifestPath(projectRoot))) {
    return validateAgentTeamInstallation(projectRoot);
  }
  return {
    ok: false,
    problems: [
      fs.existsSync(path.join(projectRoot, ".sta", "manifest.json"))
        ? `${projectRoot} carries only a legacy .sta/manifest.json — the current installer writes .agent-team/; run \`software-team-agents init\` to convert this workspace (a .sta/-only workspace converts with no content loss)`
        : `no installation manifest found (.agent-team/manifest.json does not exist under ${projectRoot}) — run \`software-team-agents init\` inside the workspace first`,
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

  return { ok: problems.length === 0, problems, notes };
}
