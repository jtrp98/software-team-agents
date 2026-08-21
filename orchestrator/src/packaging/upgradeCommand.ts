import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest, sha256Of, type TemplateFileEntry } from "./templateManifest.js";
import { InstallManifestMissingError, installManifestPath, readInstallManifest, writeInstallManifest, type InstallManifest } from "./installManifest.js";
import { assertFrameworkManagedPaths } from "../threeRepo/ownership.js";

/**
 * T95 — `sta upgrade`: brings a project's framework files up to whatever
 * `templatesDir` currently holds, without ever silently discarding a user's
 * edit.
 *
 * Per file already tracked in `.sta/manifest.json`:
 *   - on-disk hash still matches the manifest's recorded (pristine) hash
 *     -> untouched by the user since install/last upgrade -> back it up,
 *        then overwrite with the new template content
 *   - on-disk hash differs -> the user edited it -> skipped and reported,
 *     manifest entry left exactly as it was (so a later revert-to-pristine
 *     still upgrades cleanly next time)
 *   - missing entirely (user deleted it) -> treated as a fresh install of
 *     that one file, no backup needed (there is nothing to back up)
 *
 * A file the new templates add that the manifest never tracked is installed
 * as new. A file the new templates drop is left exactly where it is in the
 * project — upgrade only ever adds or (conditionally) overwrites, it never
 * deletes.
 *
 * Every overwritten file's *previous* content is copied into
 * `.sta/backups/<timestamp>/`, alongside a copy of the manifest as it stood
 * before this upgrade — that pairing is what makes T97's rollback exact.
 */
export interface UpgradeResult {
  overwritten: string[];
  addedNew: string[];
  skippedUserModified: string[];
  restoredDeleted: string[];
  droppedFromFramework: string[];
  backupDir: string;
}

export function runUpgrade(projectRoot: string, templatesDir: string, now: string): UpgradeResult {
  if (!fs.existsSync(installManifestPath(projectRoot))) {
    throw new InstallManifestMissingError(`${projectRoot} has not run \`sta init\` yet — nothing to upgrade`);
  }
  const oldManifest = readInstallManifest(projectRoot);
  const newTemplateManifest = readTemplateManifest(templatesDir);
  assertFrameworkManagedPaths(oldManifest.files.map((file) => file.path), "legacy-project");
  assertFrameworkManagedPaths(newTemplateManifest.files.map((file) => file.path), "legacy-project");

  const backupDir = path.join(projectRoot, ".sta", "backups", now.replace(/[:.]/g, "-"));
  fs.mkdirSync(backupDir, { recursive: true });

  const oldByPath = new Map(oldManifest.files.map((f) => [f.path, f]));
  const newByPath = new Map(newTemplateManifest.files.map((f) => [f.path, f]));

  const overwritten: string[] = [];
  const addedNew: string[] = [];
  const skippedUserModified: string[] = [];
  const restoredDeleted: string[] = [];
  const resultFiles: TemplateFileEntry[] = [];

  for (const [relPath, newFile] of newByPath) {
    const dest = path.join(projectRoot, relPath);
    const src = path.join(templatesDir, relPath);
    const old = oldByPath.get(relPath);

    if (!old) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      addedNew.push(relPath);
      resultFiles.push(newFile);
      continue;
    }

    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      restoredDeleted.push(relPath);
      resultFiles.push(newFile);
      continue;
    }

    const currentHash = sha256Of(fs.readFileSync(dest));
    if (currentHash === old.sha256) {
      const backupDest = path.join(backupDir, relPath);
      fs.mkdirSync(path.dirname(backupDest), { recursive: true });
      fs.copyFileSync(dest, backupDest);
      fs.copyFileSync(src, dest);
      overwritten.push(relPath);
      resultFiles.push(newFile);
    } else {
      skippedUserModified.push(relPath);
      resultFiles.push(old); // keep the original pristine baseline, not the user's hash
    }
  }

  const droppedFromFramework = [...oldByPath.keys()].filter((p) => !newByPath.has(p));

  fs.writeFileSync(path.join(backupDir, "manifest.json"), `${JSON.stringify(oldManifest, null, 2)}\n`, "utf8");

  const newManifest: InstallManifest = {
    schema_version: oldManifest.schema_version,
    framework_version: newTemplateManifest.framework_version,
    installed_at: oldManifest.installed_at,
    updated_at: now,
    files: resultFiles,
  };
  writeInstallManifest(projectRoot, newManifest);

  return { overwritten, addedNew, skippedUserModified, restoredDeleted, droppedFromFramework, backupDir };
}
