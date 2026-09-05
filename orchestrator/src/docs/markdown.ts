/**
 * The small amount of Markdown reading the document readers need.
 *
 * WHY ONE MODULE AND NOT A REGEX PER READER
 *
 * `docs/planGraph.ts` and `agents/moduleDocs.ts` both have to answer "give me
 * the body of `## Data Model`" and "give me the rows of this table". Written per
 * reader, that is two regexes that agree today and disagree after the first fix.
 * One definition, two callers.
 *
 * A note on why this is not a Markdown parser: these documents are written to a
 * fixed template by a fixed set of agents (`.claude/agents/*.md` hold the
 * templates), and every pattern here is matched against the literal heading
 * those templates emit. What that buys is a failure mode worth having — a
 * template that drifts makes a reader find nothing, loudly, rather than find
 * something subtly wrong.
 *
 * T-V5-041 moved this module out of `adoption/` (which was removed with the
 * completed legacy import) and dropped the eight helpers only the importers
 * used: `sectionBody`, `tableRows`, `allTableRows`, `frontmatter`, `commaList`,
 * `firstH1`, `firstParagraph`, `slug`.
 */

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

/** Every `- [ ]` / `- [x]` line, with whether it was ticked — the legacy `plan.md` shape T52 replaced. */
export function checkboxLines(text: string): Array<{ done: boolean; text: string }> {
  const out: Array<{ done: boolean; text: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (match) out.push({ done: match[1].toLowerCase() === "x", text: match[2].trim() });
  }
  return out;
}
