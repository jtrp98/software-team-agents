import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import { sourceIdFor } from "../../knowledge/sourceRegistry.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * Documentation Discovery (T75) — the second Discovery stage in T73's flow.
 *
 * TASKS_V1.md scopes this narrowly: "README, wiki, docs/". That is a
 * deliberately different target from `_docs/module/**` — those are the
 * pipeline's own structured requirement/design/plan docs, and they already
 * have a dedicated, semantics-aware path in (T61's `fromArtifacts.ts` for
 * the live orchestrator, T84/T85 for a legacy import). This stage is for the
 * free-form prose a project accumulates outside that structure, which has
 * no schema to parse against.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not attempt to classify a doc's content into `requirement` or
 * `business-rule` or any other semantically loaded kind — a heading called
 * "Installation" is not a business rule, and guessing would plant items
 * whose kind is a fabrication the moment a person reads it. Every doc this
 * stage finds becomes one `architecture` item (matching T74's own use of
 * that kind for "this exists" facts about the project) carrying its H1
 * title, first paragraph, and heading outline as evidence — not an
 * interpretation of what the doc means.
 */

const DOC_SUBDIRS = ["docs", "wiki"];
const README_PATTERN = /^readme\.md$/i;
const WALK_IGNORE = new Set(["node_modules", ".git"]);

interface DiscoveredDoc {
  relPath: string;
  absPath: string;
  content: string;
}

function readDoc(root: string, absPath: string): DiscoveredDoc {
  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  return { relPath, absPath, content: fs.readFileSync(absPath, "utf8") };
}

function findReadmes(root: string): DiscoveredDoc[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && README_PATTERN.test(e.name))
    .map((e) => readDoc(root, path.join(root, e.name)));
}

function findMarkdownUnder(root: string, subdir: string): DiscoveredDoc[] {
  const base = path.join(root, subdir);
  if (!fs.existsSync(base)) return [];

  const found: DiscoveredDoc[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_IGNORE.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(readDoc(root, abs));
    }
  };
  walk(base);
  return found;
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

/** H1-H3 only, and the first H1 is dropped — it's already captured as `title`, whether or not the doc has any other headings. */
function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  let skippedFirstH1 = false;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;
    if (!skippedFirstH1 && match[1].length === 1) {
      skippedFirstH1 = true;
      continue;
    }
    headings.push(match[2].trim());
  }
  return headings;
}

function firstParagraph(content: string): string {
  const withoutH1 = content.replace(/^#\s+.+$/m, "");
  const paragraph = withoutH1
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#"));
  if (!paragraph) return "";
  return paragraph.length > 400 ? `${paragraph.slice(0, 400)}…` : paragraph;
}

function slugOf(relPath: string): string {
  return relPath
    .replace(/\.md$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function docItem(
  doc: DiscoveredDoc,
  now: string,
): { item: KnowledgeItemOf<"architecture">; source: SourceRecord } | null {
  const content = doc.content.trim();
  if (content.length === 0) return null;

  const title = extractTitle(content, doc.relPath);
  const headings = extractHeadings(content);
  const snippet = firstParagraph(content);
  const digest = `sha256:${createHash("sha256").update(doc.content).digest("hex").slice(0, 16)}`;

  const source: SourceRecord = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: sourceIdFor(doc.relPath),
    type: "file",
    locator: doc.relPath,
    captured_at: now,
    captured_by: AgentStage.SYSTEM_ANALYST,
    digest,
  };

  const bodyParts = [`Documentation discovery (T75) read \`${doc.relPath}\`.`];
  if (snippet) bodyParts.push(snippet);
  if (headings.length > 0) bodyParts.push(`Sections: ${headings.join(", ")}.`);

  const item: KnowledgeItemOf<"architecture"> = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `DES-DOC-${slugOf(doc.relPath)}`,
    kind: "architecture",
    title: `Documented: ${title}`,
    body: bodyParts.join("\n\n"),
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    sources: [{ type: "file", locator: doc.relPath, captured_at: now, digest, source_id: source.id }],
    relations: [],
    payload: { feasibility: "unknown", risks: [], component: null },
  };

  return { item, source };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function documentationDiscoveryStage(now: () => string = () => new Date().toISOString()): DiscoveryStage {
  return {
    id: "documentation",
    discover: (projectRoot: string): DiscoveryResult => {
      const timestamp = now();
      const docs = [
        ...findReadmes(projectRoot),
        ...DOC_SUBDIRS.flatMap((subdir) => findMarkdownUnder(projectRoot, subdir)),
      ];

      const items: KnowledgeItemOf<"architecture">[] = [];
      const sources: SourceRecord[] = [];
      const emptied: string[] = [];

      for (const doc of docs) {
        const built = docItem(doc, timestamp);
        if (!built) {
          emptied.push(doc.relPath);
          continue;
        }
        items.push(built.item);
        sources.push(built.source);
      }

      const result: DiscoveryResult = { items, sources, skipped: docs.length === 0 };
      if (docs.length === 0) result.note = "no README.md, docs/, or wiki/ markdown found";
      else if (emptied.length > 0) result.note = `skipped ${emptied.length} empty file(s): ${emptied.join(", ")}`;
      return result;
    },
  };
}
