import { contentHash } from "../artifacts/executionPacket.js";

/** Select explicit ID declarations, never a fuzzy mention or an entire document. */
export function selectTaskReference(markdown: string, id: string, source: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const declaration = (line: string): string | undefined => {
    // Strip a heading/bullet/numbered-list/table-cell prefix, then any wrapping
    // backtick/asterisk/paren (e.g. "1. (AC-012.1) ..." — a numbered acceptance-criteria list).
    const text = line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|\|\s*)?/, "").replace(/^[`*(]+/, "");
    return /^(REQ-\d+|AC-\d+(?:\.\d+)?|DES-\d+|DEC-\d+|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*)(?=[\s:|`*)—-]|$)/.exec(text)?.[1];
  };
  const starts = lines.flatMap((line, i) => declaration(line) === id ? [i] : []);
  // When a heading declares the ID, a table row elsewhere that merely cites it (e.g. a
  // summary table) is a reference, not a second declaration, so it doesn't count here.
  // List-item matches still count: an ID declared both as a heading and as a list item
  // is a genuine ambiguity, not a summary reference.
  const headingStarts = starts.filter((i) => /^\s*#{1,6}\s/.test(lines[i]));
  const candidates = headingStarts.length > 0 ? starts.filter((i) => headingStarts.includes(i) || !/^\s*\|/.test(lines[i])) : starts;
  if (candidates.length !== 1) throw new Error(`${source}: ${id} requires exactly one addressable declaration; found ${candidates.length}. Author an ID heading/list/table row, then recompile`);
  const start = candidates[0];
  let end = start + 1;
  const headingDepth = /^\s*(#{1,6})\s/.exec(lines[start])?.[1].length;
  const listIndent = /^(\s*)(?:[-*]|\d+[.)])\s/.exec(lines[start])?.[1].length;
  if (!/^\s*\|/.test(lines[start])) while (end < lines.length) {
    const line = lines[end];
    const nextHeading = /^\s*(#{1,6})\s/.exec(line)?.[1].length;
    const nextListIndent = /^(\s*)(?:[-*]|\d+[.)])\s/.exec(line)?.[1].length;
    if (declaration(line) || (nextHeading !== undefined && (headingDepth === undefined || nextHeading <= headingDepth)) || (headingDepth === undefined && nextListIndent !== undefined && nextListIndent <= (listIndent ?? 0))) break;
    end++;
  }
  const text = lines.slice(start, end).join("\n").trim();
  if (!text.replace(id, "").replace(/[\s#*`|:—-]/g, "")) throw new Error(`${source}: ${id} has no semantic text`);
  return { id, source: `${source}#${id}`, text, hash: contentHash(text) };
}
