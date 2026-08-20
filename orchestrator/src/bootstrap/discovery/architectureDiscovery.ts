import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * Existing Architecture Discovery (T78) — the fifth Discovery stage in
 * T73's flow.
 *
 * TASKS_V1.md frames this as the fallback for "no clear doc" — infer the
 * layering/service-boundary pattern from the folder names actually present,
 * rather than from anything written down. T74 already answers "what
 * components exist" (package.json), and T75 answers "what do the docs say";
 * this stage answers a third, narrower question neither of them can: "what
 * shape is the code actually in", from folder names alone. It runs
 * unconditionally rather than gating on whether T75 found a doc — a folder
 * layout is evidence either way, and a redundant confirmation of what a doc
 * already says is harmless (T66 flags an actual contradiction, not an
 * agreement).
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not read import statements or trace call graphs — that would be
 * real static analysis, a different and much larger undertaking than "list
 * the folder names and match them against a known vocabulary". A project
 * whose layering doesn't show up in folder names gets no item, honestly,
 * rather than a guess dressed as a finding.
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

/** Folder names that, together, signal a layered (MVC-ish) REST backend. Two or more is enough to call it a pattern. */
const LAYER_NAMES = ["routes", "controllers", "services", "models", "middleware", "repositories", "validators", "schemas"];

interface ComponentRoot {
  relDir: string;
  absDir: string;
  name: string | null;
}

function findComponentRoots(root: string): ComponentRoot[] {
  const found: ComponentRoot[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pkgEntry = entries.find((e) => e.isFile() && e.name === "package.json");
    if (pkgEntry) {
      const relDir = path.relative(root, dir).split(path.sep).join("/") || ".";
      let name: string | null = null;
      try {
        name = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string }).name ?? null;
      } catch {
        // malformed manifest — still a component root, just unnamed
      }
      found.push({ relDir, absDir: dir, name });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return found.length > 0 ? found : [{ relDir: ".", absDir: root, name: null }];
}

function childDirNames(absDir: string): Set<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
}

interface Inference {
  pattern: string;
  layers: string[];
}

function infer(dirs: Set<string>): Inference | null {
  const layers = LAYER_NAMES.filter((name) => dirs.has(name));
  if (layers.length >= 2) return { pattern: "Layered (MVC-ish) REST architecture", layers };
  if (dirs.has("app")) return { pattern: "Next.js App Router", layers: ["app"] };
  if (dirs.has("pages")) return { pattern: "Next.js Pages Router", layers: ["pages"] };
  if (layers.length === 1) return { pattern: `Partial layering (only "${layers[0]}" present)`, layers };
  return null;
}

function slugOf(relDir: string): string {
  return relDir === "." ? "ROOT" : relDir.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function patternItem(component: ComponentRoot, inference: Inference, now: string): { item: KnowledgeItemOf<"architecture">; source: SourceRecord } {
  const componentLabel = component.name ?? component.relDir;
  const locator = component.relDir === "." ? "." : component.relDir;
  const risks = inference.pattern.startsWith("Partial layering")
    ? ["only one of the usual layer folders is present — this pattern is inferred loosely"]
    : [];

  const source: SourceRecord = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `SRC-ARCH-${slugOf(component.relDir)}`,
    type: "code",
    locator,
    captured_at: now,
    captured_by: AgentStage.SYSTEM_ANALYST,
    digest: digestOf([...inference.layers].sort().join(",")),
    note: "folder-name layering signal, not a single file",
  };

  const item: KnowledgeItemOf<"architecture"> = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `DES-PATTERN-${slugOf(component.relDir)}`,
    kind: "architecture",
    title: `Inferred architecture pattern: ${componentLabel}`,
    body: `Existing Architecture Discovery (T78) inferred "${inference.pattern}" from folder names under \`${locator}\` (${inference.layers.join(", ")}).`,
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    sources: [{ type: "code", locator, captured_at: now, digest: source.digest, source_id: source.id, note: source.note }],
    relations: [],
    payload: { feasibility: "unknown", risks, component: componentLabel },
  };

  return { item, source };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function architectureDiscoveryStage(now: () => string = () => new Date().toISOString()): DiscoveryStage {
  return {
    id: "architecture",
    discover: (projectRoot: string): DiscoveryResult => {
      const timestamp = now();
      const items: KnowledgeItemOf<"architecture">[] = [];
      const sources: SourceRecord[] = [];

      for (const component of findComponentRoots(projectRoot)) {
        const inference = infer(childDirNames(component.absDir));
        if (!inference) continue;
        const { item, source } = patternItem(component, inference, timestamp);
        items.push(item);
        sources.push(source);
      }

      if (items.length === 0) {
        return { items: [], sources: [], skipped: true, note: "no recognisable layering/service-boundary folder names found" };
      }
      return { items, sources };
    },
  };
}
