import * as fs from "node:fs";
import * as path from "node:path";
import { checkInstallManifest, installManifestPath, type InstallManifest } from "./installManifest.js";
import { checkStaConfig } from "./staConfig.js";
import { sha256Of } from "./templateManifest.js";

/**
 * T98 — checked after `init`/`upgrade`/`migrate`/`rollback`, and available on
 * its own as `--check-installation`: does `.sta/` actually describe the
 * project that's really on disk?
 *
 * `notes` (a file the project modified) are expected, ongoing state, exactly
 * like `--check-workspace`'s "no workspace.yaml yet" — a modified framework
 * file is not a problem, it's the whole point of never overwriting one.
 * `problems` are things that should not be possible from a clean
 * `init`/`upgrade` — a missing manifest, an invalid config, a tracked file
 * that vanished from the project without going through anything this module
 * knows about.
 */
export interface InstallValidationResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export function validateInstallation(projectRoot: string): InstallValidationResult {
  const problems: string[] = [];
  const notes: string[] = [];

  const manifestPath = installManifestPath(projectRoot);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`${manifestPath} is missing — run \`sta init\` first`], notes };
  }

  let manifest: InstallManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as InstallManifest;
  } catch (e) {
    return { ok: false, problems: [`${manifestPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`], notes };
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

  problems.push(...checkStaConfig(projectRoot));

  return { ok: problems.length === 0, problems, notes };
}
