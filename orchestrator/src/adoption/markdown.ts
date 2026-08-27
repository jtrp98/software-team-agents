/**
 * The small amount of Markdown reading every legacy importer needs (T83-T86).
 *
 * WHY ONE MODULE AND NOT A REGEX PER PARSER
 *
 * Four importers all have to answer "give me the body of `## Data Model`" and
 * "give me the rows of this table". Written per parser, that is four regexes
 * that agree today and disagree after the first fix — and the T61-T80 review
 * found that exactly this shape of duplication, not any single module's logic,
 * produced its two worst defects. One definition, four callers.
 *
 * A note on why this is not a Markdown parser: these documents are written to a
 * fixed template by a fixed set of agents (`.claude/agents/*.md` hold the
 * templates), and every pattern here is matched against the literal heading
 * those templates emit. What that buys is a failure mode worth having — a
 * template that drifts makes an importer find nothing, loudly, rather than
 * find something subtly wrong.
 */

/** Lines of a `##`-level section, heading excluded, up to the next `##` (or the end). */
export function sectionBody(text: string, heading: RegExp): string | null {
  const flags = heading.flags.includes("m") ? heading.flags : `${heading.flags}m`;
  const anchored = new RegExp(heading.source, flags);
  const match = anchored.exec(text);
  if (!match) return null;

  const afterHeading = text.slice(match.index + match[0].length).replace(/^[^\n]*\n?/, "");
  const end = afterHeading.search(/^##\s/m);
  return end < 0 ? afterHeading : afterHeading.slice(0, end);
}

export interface MarkdownSection {
  /** Heading level: 2 for `##`, 3 for `###`. */
  level: number;
  title: string;
  body: string;
}

/** Every `##`/`###` section in order. Used where the heading text is data (module names, phases) rather than a fixed label. */
export function sections(text: string, level: 2 | 3): MarkdownSection[] {
  const marker = "#".repeat(level);
  const pattern = new RegExp(`^${marker}\\s+(.+)$`, "gm");
  const found: MarkdownSection[] = [];
  const starts: Array<{ title: string; from: number; bodyFrom: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    starts.push({ title: match[1].trim(), from: match.index, bodyFrom: match.index + match[0].length });
  }

  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const rest = text.slice(current.bodyFrom);
    // Stop at the next heading of this level or shallower, so a `###` inside a
    // `##` belongs to the `##` and not to whatever follows it.
    const shallower = new RegExp(`^#{1,${level}}\\s`, "m");
    const end = rest.search(shallower);
    found.push({ level, title: current.title, body: (end < 0 ? rest : rest.slice(0, end)).replace(/^\n/, "") });
  }
  return found;
}

/**
 * Cells of every data row in the first table found in `text`, header and
 * separator dropped. A section holding prose instead of a table yields nothing,
 * which is the honest answer — "no rows" rather than "one row that is a
 * sentence".
 */
export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/** First table, retaining its header so authoritative optional columns remain addressable by name. */
export function firstTable(text: string): MarkdownTable {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rows: string[][] = [];
  let header: string[] = [];
  let seenSeparator = false;
  let started = false;

  for (const line of lines) {
    const isRow = line.startsWith("|") && line.endsWith("|") && line.length > 1;
    if (!isRow) {
      // A blank line inside a table is the end of it; prose before one is skipped.
      if (started) break;
      continue;
    }
    started = true;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (/^[\s:|-]+$/.test(line.slice(1, -1))) {
      seenSeparator = true;
      continue;
    }
    if (!seenSeparator) {
      if (header.length === 0) header = cells;
      continue;
    }
    rows.push(cells);
  }
  return { header, rows };
}

export function tableRows(text: string): string[][] {
  return firstTable(text).rows;
}

/**
 * Rows of *every* table in `text`, not just the first. `plan.md` holds one
 * table per phase, so a caller asking "is any task in_progress anywhere in this
 * document" needs all of them; a caller reading one phase slices the section
 * first and uses `tableRows`.
 */
export function allTableRows(text: string): string[][] {
  const rows: string[][] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length > 0) {
      rows.push(...tableRows(block.join("\n")));
      block = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("|")) block.push(line);
    else flush();
  }
  flush();
  return rows;
}

/** Every `- [ ]` / `- [x]` line, with whether it was ticked — the legacy `plan.md` shape T52 replaced. */
export function checkboxLines(text: string): Array<{ done: boolean; text: string }> {
  const out: Array<{ done: boolean; text: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (match) out.push({ done: match[1].toLowerCase() === "x", text: match[2].trim() });
  }
  return out;
}

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Splits `---\n<keys>\n---\n<body>`, reading the block as flat `key: value`
 * lines rather than as YAML.
 *
 * That is deliberate. An agent prompt's `description:` is one long sentence
 * written for a model to read, and several in this repo contain a colon, a
 * quote or a `#`. Handing that to a YAML parser turns a perfectly good prompt
 * into "frontmatter is not valid YAML", and the file it is complaining about is
 * one that Claude Code itself loads without trouble. Every key an agent
 * frontmatter uses (`name`, `description`, `tools`, `model`, `effort`,
 * `version`) is a single line with no structure, so the simpler reader is also
 * the more accurate one here.
 */
export function frontmatter(raw: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: match[2] };
}

/** A frontmatter list written inline (`tools: Read, Edit, Bash`), which is how Claude Code writes them. */
export function commaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((v) => v.trim().replace(/^["']|["']$/g, ""))
    .filter((v) => v !== "");
}

/** First `# ` heading, for a document's own title. */
export function firstH1(text: string): string | null {
  const match = /^#\s+(.+)$/m.exec(text);
  return match ? match[1].trim() : null;
}

/** First non-heading, non-blank paragraph, truncated — enough to recognise a document by. */
export function firstParagraph(text: string, limit = 400): string {
  const lines = text.split(/\r?\n/);
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(trimmed);
  }
  const paragraph = collected.join(" ");
  return paragraph.length > limit ? `${paragraph.slice(0, limit).trimEnd()}…` : paragraph;
}

/** A stable, filename-safe, id-safe slug. Uppercased because every id prefix in T61 is. */
export function slug(raw: string): string {
  const cleaned = raw
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
  return cleaned === "" ? "UNTITLED" : cleaned;
}
