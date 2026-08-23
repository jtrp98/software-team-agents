import * as fs from "node:fs";
import * as path from "node:path";
import { listTemplateFiles } from "./templateSources.js";
import { buildManifest, readFrameworkVersion, type TemplateManifest } from "./templateManifest.js";

export interface BuildTemplatesResult {
  manifest: TemplateManifest;
  outDir: string;
}

/**
 * T90 — snapshots every file `templateSources.ts` names into `outDir`,
 * preserving repo-root-relative paths, and writes `manifest.json` alongside
 * them. This is what `npm run build:templates` (and `--build-templates` on
 * the CLI) produces, and what a future `software-team-agents` npm package's
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
