import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest, sha256Of } from "./templateManifest.js";
import { CURRENT_STA_SCHEMA_VERSION, isInstalled, writeInstallManifest, type InstallManifest } from "./installManifest.js";
import { defaultStaConfig, staConfigPath, writeStaConfig } from "./staConfig.js";
import { assertFrameworkManagedPaths } from "../threeRepo/ownership.js";

/**
 * T92 — `sta init`: materializes `<templatesDir>/**` into `projectRoot`,
 * seeds the project-owned directories the pipeline expects to find, and
 * writes `.sta/config.yaml` + `.sta/manifest.json`.
 *
 * Two things it never does, on purpose (see the T90 boundary):
 *   - it never overwrites a file the project already has with *different*
 *     content — that project already owns that path for some other reason,
 *     so the conflicting framework file is skipped and reported rather than
 *     silently clobbered (matches CLAUDE.md's "never overwrite project code");
 *   - it never touches `knowledge/`, `_docs/`, `decisions/`, `.workflow/`
 *     again once they exist — created empty here only if wholly absent.
 */
export interface InitResult {
  /** Framework files copied into the project (or already present with matching content). */
  installed: string[];
  /** Framework files the project already had with *different* content — left untouched. */
  skippedConflicts: string[];
  /** Project-owned directories created because they didn't exist yet. */
  seededDirs: string[];
  configWritten: boolean;
}

export class AlreadyInstalledError extends Error {}

const PROJECT_OWNED_DIRS = ["knowledge", "_docs", "decisions"];

export function runInit(
  projectRoot: string,
  templatesDir: string,
  now: string,
  opts: { force?: boolean } = {},
): InitResult {
  if (isInstalled(projectRoot) && !opts.force) {
    throw new AlreadyInstalledError(
      `${projectRoot} already has .sta/manifest.json — this project is already initialized. ` +
        "Use `sta upgrade` to move it to a newer framework version, or pass --force to reinitialize.",
    );
  }

  const templateManifest = readTemplateManifest(templatesDir);
  assertFrameworkManagedPaths(templateManifest.files.map((file) => file.path), "legacy-project");
  const installed: string[] = [];
  const skippedConflicts: string[] = [];
  const trackedFiles: InstallManifest["files"] = [];

  for (const file of templateManifest.files) {
    const src = path.join(templatesDir, file.path);
    const dest = path.join(projectRoot, file.path);
    if (fs.existsSync(dest)) {
      const existingHash = sha256Of(fs.readFileSync(dest));
      if (existingHash !== file.sha256) {
        skippedConflicts.push(file.path);
        continue; // the project already owns this path with content of its own — never clobber it
      }
      // identical content already there: nothing to copy, still framework-tracked.
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    installed.push(file.path);
    trackedFiles.push(file);
  }

  const seededDirs: string[] = [];
  for (const dir of PROJECT_OWNED_DIRS) {
    const abs = path.join(projectRoot, dir);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      seededDirs.push(dir);
    }
  }
  fs.mkdirSync(path.join(projectRoot, ".sta", "backups"), { recursive: true });

  const configWritten = !fs.existsSync(staConfigPath(projectRoot));
  if (configWritten) writeStaConfig(projectRoot, defaultStaConfig());

  writeInstallManifest(projectRoot, {
    schema_version: CURRENT_STA_SCHEMA_VERSION,
    framework_version: templateManifest.framework_version,
    installed_at: now,
    updated_at: now,
    files: trackedFiles,
  });

  return { installed, skippedConflicts, seededDirs, configWritten };
}
