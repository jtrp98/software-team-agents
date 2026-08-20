import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem, type KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { sourceIdFor, type SourceRecord } from "../knowledge/sourceRegistry.js";
import { firstH1, firstParagraph, sectionBody, sections, slug } from "./markdown.js";

/**
 * Legacy Docs Import (T83).
 *
 * TASKS_V1.md names `CLAUDE.md` and `docs/`, and V1.3's goal statement is
 * broader and blunter: **ของเดิม (9 agents, plan.md, design.md, CLAUDE.md,
 * docs) ต้องไม่หาย**. So this stage takes everything documentary that the other
 * three stages do not: the project's rules (`CLAUDE.md`, `policies/*.md`), its
 * free prose (`README.md`, `docs/`, `wiki/`), and the module documents with no
 * stage of their own (`requirement.md`, `test-plan.md`, `review.md`,
 * `security.md`, `deploy.md`). `plan.md` is T84's and `design.md` is T85's.
 *
 * TWO KINDS OF DOCUMENT, TWO TREATMENTS
 *
 * `requirement.md` and `test-plan.md` carry ids the rest of the pipeline traces
 * through (`REQ-NNN`, and a test-plan's `### REQ-NNN` sections), so they are
 * parsed into the real kinds — `requirement` and `test` items. Without that,
 * every `refines`/`verifies` relation T85 and T84 write would dangle, and the
 * traceability chain T19 built would arrive in the knowledge model broken.
 *
 * Everything else becomes one `architecture` item per file: an index into the
 * prose, holding the file's title, its heading outline and its opening
 * paragraph, citing the file by locator and digest. This follows the call T75
 * already made for discovered documentation and made explicitly — do not guess a
 * kind from a heading, because "Installation" is not a business rule. Guessing
 * would be the one way this stage could actually lose something: a misfiled item
 * is harder to find than an unfiled one.
 *
 * WHAT "PRESERVING THE ORIGINAL" MEANS HERE
 *
 * Not copying it. The file is never deleted, moved or rewritten by anything in
 * V1.3 — it stays exactly where it was, and each item points at it with a line
 * locator and a content digest, so T71 can say when the prose has moved on from
 * what the item claims. Duplicating a 300-line CLAUDE.md into a YAML `body`
 * would create a second copy that starts drifting from the first the same day.
 * The one exception is a *rules* document (`CLAUDE.md`, `policies/*.md`), whose
 * whole point is to be readable without opening another file: those keep their
 * full text.
 */

const RULE_DOCS = ["CLAUDE.md"];
const RULE_DIRS = ["policies"];
const PROSE_DIRS = ["docs", "wiki"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".workflow", "knowledge"]);

/** Module documents this stage owns. `plan.md` (T84) and `design.md` (T85) are deliberately absent. */
const MODULE_PROSE_DOCS = ["review.md", "security.md", "deploy.md"];

export interface LegacyDocsResult {
  items: KnowledgeItem[];
  sources: SourceRecord[];
  notes: string[];
}

function fileSource(relativePath: string, projectRoot: string, now: string, capturedBy: AgentStage): SourceRecord {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: sourceIdFor(relativePath),
    type: "file",
    locator: relativePath,
    captured_at: now,
    captured_by: capturedBy,
    digest: digestOfSource(relativePath, projectRoot),
  };
}

interface EnvelopeParts {
  id: string;
  title: string;
  body: string;
  module: string | null;
  owner: AgentStage;
  locator: string;
  sourceId: string;
  projectRoot: string;
  now: string;
  relations?: KnowledgeItem["relations"];
  sensitive?: boolean;
}

function envelope(parts: EnvelopeParts): Omit<KnowledgeItem, "kind" | "payload"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: parts.id,
    title: parts.title,
    body: parts.body,
    repo: null,
    module: parts.module,
    owner: parts.owner,
    // Everything an importer produces is a draft. A legacy document having
    // existed for a year is not the same as somebody having agreed that this is
    // what it says — `approved` is a person's word (T65), and T88 is where they
    // say it.
    status: "draft",
    sensitive: parts.sensitive ?? false,
    version: 1,
    created_at: parts.now,
    updated_at: parts.now,
    sources: [
      {
        type: "file",
        locator: parts.locator,
        captured_at: parts.now,
        digest: digestOfSource(parts.locator, parts.projectRoot),
        source_id: parts.sourceId,
        note: "legacy import (T83)",
      },
    ],
    relations: parts.relations ?? [],
  };
}

/** An outline of a prose document: its own headings, so the item is findable by what the file covers. */
function outlineOf(text: string, fullText: boolean): string {
  if (fullText) return text.trimEnd();

  const opening = firstParagraph(text);
  const headings = sections(text, 2)
    .map((s) => s.title)
    .filter((t) => t !== "");
  const parts = [opening];
  if (headings.length > 0) parts.push(`Sections: ${headings.join(" · ")}`);
  return parts.filter((p) => p !== "").join("\n\n");
}

function proseItem(
  relativePath: string,
  text: string,
  projectRoot: string,
  now: string,
  sourceId: string,
  options: { module: string | null; idPrefix: string; fullText: boolean },
): KnowledgeItemOf<"architecture"> {
  const title = firstH1(text) ?? relativePath;
  return {
    ...envelope({
      id: `${options.idPrefix}-${slug(relativePath)}`,
      title,
      body: outlineOf(text, options.fullText),
      module: options.module,
      // A document is a statement about how the system is built, and
      // `system-analyst` is the role that owns those (T65's ownership rules
      // check this) — regardless of who typed the file originally.
      owner: AgentStage.SYSTEM_ANALYST,
      locator: relativePath,
      sourceId,
      projectRoot,
      now,
    }),
    kind: "architecture",
    payload: {
      // Never guessed. "The document exists" and "the thing it describes is a
      // good idea" are different claims, and only the first one is evidence.
      feasibility: "unknown",
      risks: [],
      component: null,
    },
  };
}

/** `REQ-NNN` rows in a `## Core Features` section — the head of T19's traceability chain. */
function requirementItems(
  relativePath: string,
  text: string,
  module: string,
  projectRoot: string,
  now: string,
  sourceId: string,
): Array<KnowledgeItemOf<"requirement">> {
  const body = sectionBody(text, /^##\s+Core Features/);
  if (body === null) return [];

  const items: Array<KnowledgeItemOf<"requirement">> = [];
  const seen = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    const match = /\b(REQ-\d+)\b\s*[—:.-]?\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, id, rest] = match;
    if (seen.has(id)) continue;
    seen.add(id);

    // `- **REQ-001** — Staff can ...` leaves `** — Staff can ...`: the id is
    // usually bolded, so the separator sits *after* the closing asterisks and a
    // single pass in either order leaves one of the two behind.
    const title =
      rest
        .replace(/^\*+/, "")
        .replace(/^\s*[—–:.-]+\s*/, "")
        .replace(/\*+$/, "")
        .trim() || id;
    items.push({
      ...envelope({
        id,
        title: title.length > 200 ? `${title.slice(0, 200)}…` : title,
        body: line.trim(),
        module,
        owner: AgentStage.BUSINESS_ANALYST,
        locator: relativePath,
        sourceId,
        projectRoot,
        now,
      }),
      kind: "requirement",
      payload: {
        // A legacy line does not state its acceptance criteria in a form worth
        // parsing, and inventing one would be worse than leaving it empty: the
        // engineers read this field.
        acceptance_criteria: [],
        actors: [],
        priority: null,
        // CLAUDE.md's rule, mechanically true of an imported line: nobody has
        // re-confirmed it as part of this adoption.
        assumption_unconfirmed: true,
      },
    });
  }
  return items;
}

/** `### REQ-NNN` sections of a `test-plan.md`, each with its `**Levels:**` line. */
function testItems(
  relativePath: string,
  text: string,
  module: string,
  projectRoot: string,
  now: string,
  sourceId: string,
): Array<KnowledgeItemOf<"test">> {
  const automated = /^\*\*Has automated test framework:\*\*\s*yes/im.test(text);
  const items: Array<KnowledgeItemOf<"test">> = [];
  const used = new Map<string, number>();

  for (const section of sections(text, 3)) {
    const match = /\b(REQ-\d+)\b/.exec(section.title);
    if (!match) continue;
    const requirementId = match[1];

    const levelsLine = /\*\*Levels:\*\*\s*(.+)$/im.exec(section.body);
    const levels = (levelsLine ? levelsLine[1] : "")
      .split(/[,/]/)
      .map((l) => l.trim().toLowerCase())
      .filter((l): l is "unit" | "integration" | "api" | "e2e" => ["unit", "integration", "api", "e2e"].includes(l));

    const base = `TEST-${requirementId.replace(/^REQ-/, "")}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);

    items.push({
      ...envelope({
        id: seen === 0 ? base : `${base}-${seen + 1}`,
        title: section.title,
        body: section.body.trim(),
        module,
        owner: AgentStage.TEST_PLANNER,
        locator: relativePath,
        sourceId,
        projectRoot,
        now,
        relations: [{ type: "verifies", to: requirementId }],
      }),
      kind: "test",
      payload: { levels, automated },
    });
  }
  return items;
}

function walkMarkdown(dir: string, projectRoot: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walkMarkdown(path.join(dir, entry.name), projectRoot, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(projectRoot, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
}

function moduleNames(projectRoot: string): string[] {
  const root = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Reads every legacy document this stage owns and converts it. Never writes. */
export function importLegacyDocs(projectRoot: string, now: string): LegacyDocsResult {
  const items: KnowledgeItem[] = [];
  const sources: SourceRecord[] = [];
  const notes: string[] = [];

  const add = (relativePath: string, build: (text: string, sourceId: string) => KnowledgeItem[]): void => {
    const abs = path.join(projectRoot, ...relativePath.split("/"));
    if (!fs.existsSync(abs)) return;
    const text = fs.readFileSync(abs, "utf8");
    if (text.trim() === "") {
      notes.push(`${relativePath} is empty — skipped rather than imported as an empty item`);
      return;
    }
    const source = fileSource(relativePath, projectRoot, now, AgentStage.SYSTEM_ANALYST);
    const produced = build(text, source.id);
    if (produced.length === 0) {
      notes.push(`${relativePath} produced no item — nothing in it matched what this stage knows how to read`);
      return;
    }
    sources.push(source);
    items.push(...produced);
  };

  // 1. The rules. Full text, because a rule you have to open another file to
  //    read is a rule an agent will not read.
  for (const file of RULE_DOCS) {
    add(file, (text, sourceId) => [
      proseItem(file, text, projectRoot, now, sourceId, { module: null, idPrefix: "DES-RULES", fullText: true }),
    ]);
  }
  for (const dir of RULE_DIRS) {
    const found: string[] = [];
    walkMarkdown(path.join(projectRoot, dir), projectRoot, found);
    for (const file of found.sort()) {
      add(file, (text, sourceId) => [
        proseItem(file, text, projectRoot, now, sourceId, { module: null, idPrefix: "DES-RULES", fullText: true }),
      ]);
    }
  }

  // 2. Free prose: README at the root, plus docs/ and wiki/ recursively.
  add("README.md", (text, sourceId) => [
    proseItem("README.md", text, projectRoot, now, sourceId, { module: null, idPrefix: "DES-DOC", fullText: false }),
  ]);
  for (const dir of PROSE_DIRS) {
    const found: string[] = [];
    walkMarkdown(path.join(projectRoot, dir), projectRoot, found);
    for (const file of found.sort()) {
      add(file, (text, sourceId) => [
        proseItem(file, text, projectRoot, now, sourceId, { module: null, idPrefix: "DES-DOC", fullText: false }),
      ]);
    }
  }

  // 3. Module documents, minus plan.md (T84) and design.md (T85).
  for (const module of moduleNames(projectRoot)) {
    add(`_docs/module/${module}/requirement.md`, (text, sourceId) =>
      requirementItems(`_docs/module/${module}/requirement.md`, text, module, projectRoot, now, sourceId),
    );
    add(`_docs/module/${module}/test-plan.md`, (text, sourceId) =>
      testItems(`_docs/module/${module}/test-plan.md`, text, module, projectRoot, now, sourceId),
    );
    for (const doc of MODULE_PROSE_DOCS) {
      const rel = `_docs/module/${module}/${doc}`;
      add(rel, (text, sourceId) => [
        proseItem(rel, text, projectRoot, now, sourceId, { module, idPrefix: "DES-DOC", fullText: false }),
      ]);
    }
  }

  return { items, sources, notes };
}
