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
 * Validates only the current `.agent-team/manifest.json` layout, using the same
 * structural model the sync engine enforces (`checkTargetManifest`) — no second
 * validation model. A workspace on the retired `.sta/`-only layout, or never
 * initialized at all, reports one actionable problem naming `software-team-agents
 * init`. (`.sta/` still validates separately for rollback's own legacy-backup
 * fallback in `rollback.ts` — a different mechanism, out of scope here.)
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
      // The sync engine restores any tracked-but-missing path on its next run —
      // expected, self-healing state, so this is a note, not a problem.
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
