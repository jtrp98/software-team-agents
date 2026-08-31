export interface Section {
  heading: string;
  /** `##` -> 2, `###` -> 3. Only `##` starts a new top-level section; deeper ones stay inside their parent. */
  level: number;
  /** Line index of the heading itself, and of the first line after this section. */
  start: number;
  end: number;
}

/**
 * The `Grep -n "^## "` step §10 tells an agent to run, done once and returned
 * as data. Only `##` boundaries are used: `###` subsections belong to the `##`
 * they sit under, and splitting on them would hand out half a contract.
 */
export function sectionMap(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let fenced = false;

  for (let i = 0; i < lines.length; i++) {
    // A `## ` inside a fenced block is sample content, not a heading — policies/documentation.md
    // itself contains exactly that, and treating it as a boundary would split a code block.
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;

    const m = /^(#{2,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (!m || m[1].length !== 2) continue;

    if (sections.length > 0) sections[sections.length - 1].end = i;
    sections.push({ heading: m[2].trim(), level: 2, start: i, end: lines.length });
  }
  return sections;
}

/** Text of everything before the first `## ` — the title and any preamble, always kept. */
export function preamble(markdown: string, sections: Section[]): string {
  const lines = markdown.split(/\r?\n/);
  const end = sections.length > 0 ? sections[0].start : lines.length;
  return lines.slice(0, end).join("\n");
}

export function sectionText(markdown: string, s: Section): string {
  return markdown.split(/\r?\n/).slice(s.start, s.end).join("\n");
}

export interface NestedSection {
  heading: string;
  start: number;
  end: number;
}

export function nestedSections(markdown: string, level: number): NestedSection[] {
  const lines = markdown.split(/\r?\n/);
  const out: NestedSection[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{2,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (!match || match[1].length !== level) continue;
    if (out.length > 0) out[out.length - 1].end = i;
    out.push({ heading: match[2].trim(), start: i, end: lines.length });
  }
  return out;
}
