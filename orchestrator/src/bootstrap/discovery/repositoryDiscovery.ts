import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import { sourceIdFor } from "../../knowledge/sourceRegistry.js";
import { digestOfSource } from "../../knowledge/sourceDigest.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * Repository Discovery (T74) — the first Discovery stage in T73's flow.
 *
 * Reads the repo's own structure and package manifests and seeds one
 * `architecture` item per detected component (T61's `architecture` kind is
 * design.md's Feature-by-Feature Feasibility payload — `component` is
 * exactly "which part of the system", which is what a package.json answers)
 * plus one overview item for the folder layout as a whole.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not judge feasibility — everything it writes carries
 * `feasibility: "unknown"`, because "this exists" and "this is a good idea"
 * are different claims and discovery only has evidence for the first. It
 * does not read file contents for anything beyond `package.json` — deeper
 * source analysis (import graphs, route inventories) is T78's job, once a
 * project's declared architecture needs checking against what the code
 * actually does. And it only recognises the dependencies this framework's
 * own fixed stack uses (see CLAUDE.md) — a project on a different stack
 * still gets components and manifests recorded, just without a framework
 * label, which is honest: we don't know what it is, not "it has none".
 */

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".workflow",
  ".turbo",
  ".cache",
  "knowledge",
]);

const FRAMEWORK_SIGNALS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  express: "Express",
  "@prisma/client": "Prisma",
  prisma: "Prisma (CLI)",
  tailwindcss: "Tailwind CSS",
  zustand: "Zustand",
  zod: "Zod",
  vitest: "Vitest",
  typescript: "TypeScript",
};

interface PackageManifest {
  /** "." for the repo root, otherwise a forward-slash relative path. */
  relDir: string;
  absPath: string;
  name: string | null;
  dependencies: string[];
  devDependencies: string[];
  hasTestScript: boolean;
  hasTsconfig: boolean;
}

function findPackageManifests(root: string): PackageManifest[] {
  const found: PackageManifest[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const pkgEntry = entries.find((e) => e.isFile() && e.name === "package.json");
    if (pkgEntry) {
      const absPath = path.join(dir, "package.json");
      const relDir = path.relative(root, dir).split(path.sep).join("/") || ".";
      try {
        const pkg = JSON.parse(fs.readFileSync(absPath, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        found.push({
          relDir,
          absPath,
          name: pkg.name ?? null,
          dependencies: Object.keys(pkg.dependencies ?? {}),
          devDependencies: Object.keys(pkg.devDependencies ?? {}),
          hasTestScript: typeof pkg.scripts?.test === "string",
          hasTsconfig: fs.existsSync(path.join(dir, "tsconfig.json")),
        });
      } catch {
        // Unreadable/malformed package.json — not this stage's job to fix; skip it.
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };

  walk(root);
  return found;
}

function frameworksOf(deps: string[]): string[] {
  const found = new Set<string>();
  for (const dep of deps) {
    const label = FRAMEWORK_SIGNALS[dep];
    if (label) found.add(label);
  }
  return [...found].sort();
}

function slugOf(relDir: string): string {
  return relDir === "." ? "ROOT" : relDir.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function componentItem(
  manifest: PackageManifest,
  projectRoot: string,
  now: string,
): { item: KnowledgeItemOf<"architecture">; source: SourceRecord } {
  const locator = manifest.relDir === "." ? "package.json" : `${manifest.relDir}/package.json`;
  const frameworks = frameworksOf([...manifest.dependencies, ...manifest.devDependencies]);
  // Computed by the same function T71 will recompute it with, so a re-read of an
  // untouched manifest matches instead of reporting a change that never happened.
  const digest = digestOfSource(locator, projectRoot);

  const risks: string[] = [];
  if (!manifest.hasTestScript) risks.push("no `test` script defined in package.json");
  if (manifest.devDependencies.includes("typescript") && !manifest.hasTsconfig) {
    risks.push("declares a typescript devDependency but no tsconfig.json sits alongside it");
  }

  const source: SourceRecord = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: sourceIdFor(locator),
    type: "file",
    locator,
    captured_at: now,
    captured_by: AgentStage.SETUP,
    digest,
  };

  const componentLabel = manifest.name ?? manifest.relDir;
  const item: KnowledgeItemOf<"architecture"> = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `DES-REPO-${slugOf(manifest.relDir)}`,
    kind: "architecture",
    title: `Detected component: ${componentLabel}`,
    body:
      frameworks.length > 0
        ? `Repository discovery (T74) found ${frameworks.join(", ")} via \`${locator}\`.`
        : `Repository discovery (T74) found \`${locator}\` with no recognised framework dependency — this may be a project on a different stack, or a package with none of the fixed stack's usual dependencies.`,
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    sources: [{ type: "file", locator, captured_at: now, digest, source_id: source.id }],
    relations: [],
    payload: { feasibility: "unknown", risks, component: componentLabel },
  };

  return { item, source };
}

function overviewItem(root: string, manifests: PackageManifest[], now: string): KnowledgeItemOf<"architecture"> {
  const topLevel = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: "DES-REPO-OVERVIEW",
    kind: "architecture",
    title: "Repository structure (discovered)",
    body:
      `Repository discovery (T74) found ${manifests.length} package.json manifest(s). ` +
      `Top-level folders: ${topLevel.length > 0 ? topLevel.join(", ") : "(none)"}.`,
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    // No registry record for the repo root itself — this is a summary of
    // many files, not a citation of one, and forcing it into `_sources`
    // would misrepresent what T62's registry is for.
    sources: [{ type: "code", locator: ".", captured_at: now, digest: null, note: "top-level directory listing" }],
    relations: [],
    payload: { feasibility: "unknown", risks: [], component: null },
  };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function repositoryDiscoveryStage(now: () => string = () => new Date().toISOString()): DiscoveryStage {
  return {
    id: "repository",
    discover: (projectRoot: string): DiscoveryResult => {
      const timestamp = now();
      const manifests = findPackageManifests(projectRoot);
      const items: KnowledgeItemOf<"architecture">[] = [overviewItem(projectRoot, manifests, timestamp)];
      const sources: SourceRecord[] = [];
      for (const manifest of manifests) {
        const { item, source } = componentItem(manifest, projectRoot, timestamp);
        items.push(item);
        sources.push(source);
      }
      return { items, sources };
    },
  };
}
