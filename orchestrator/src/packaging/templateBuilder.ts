import * as fs from "node:fs";
import * as path from "node:path";
import { listTemplateFiles } from "./templateSources.js";
import { buildManifest, readFrameworkVersion, readTemplateManifest, type TemplateManifest } from "./templateManifest.js";

export interface BuildTemplatesResult {
  manifest: TemplateManifest;
  outDir: string;
}

export interface TemplateSnapshotDrift {
  path: string;
  kind: "missing" | "changed" | "stale";
}

/** Read-only comparison of authored template sources with the built snapshot. */
export function compareTemplateSnapshot(repoRoot: string, outDir: string): TemplateSnapshotDrift[] {
  const sourcePaths = listTemplateFiles(repoRoot);
  const sourceSet = new Set(sourcePaths);
  const snapshot = readTemplateManifest(outDir);
  const drift: TemplateSnapshotDrift[] = [];
  for (const relPath of sourcePaths) {
    const source = path.join(repoRoot, ...relPath.split("/"));
    const built = path.join(outDir, ...relPath.split("/"));
    if (!fs.existsSync(built)) {
      drift.push({ path: relPath, kind: "missing" });
    } else if (!fs.readFileSync(source).equals(fs.readFileSync(built))) {
      drift.push({ path: relPath, kind: "changed" });
    }
  }
  for (const file of snapshot.files) {
    if (!sourceSet.has(file.path)) drift.push({ path: file.path, kind: "stale" });
  }
  return drift.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Snapshots every file `templateSources.ts` names into `outDir`,
 * preserving repo-root-relative paths, and writes `manifest.json` alongside
 * them. This is what `npm run build:templates` (and `--build-templates` on
 * the CLI) produces, and what the `software-team-agents` npm package's
 * `templates/` directory *is* — a build artifact of this repo, never checked
 * in itself (same as `dist/`).
 *
 * Deterministic: given the same repo state, re-running produces byte-
 * identical file copies and the same hashes (only `generated_at` differs) —
 * that determinism is what makes `sta upgrade`'s later hash-diff meaningful.
 */
export function buildTemplates(repoRoot: string, outDir: string, now: string): BuildTemplatesResult {
  const relFiles = listTemplateFiles(repoRoot);
  // The version comes from the repo-root distributable package.json — the same
  // file that names the packed .tgz — so artifact and stamped manifest agree.
  const frameworkVersion = readFrameworkVersion(repoRoot);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const relPath of relFiles) {
    const src = path.join(repoRoot, relPath);
    const dest = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const manifest = buildManifest(repoRoot, relFiles, frameworkVersion, now);
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { manifest, outDir };
}
