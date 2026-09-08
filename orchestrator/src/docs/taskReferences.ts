import { contentHash } from "../artifacts/executionPacket.js";

/** Select explicit ID declarations, never a fuzzy mention or an entire document. */
export function selectTaskReference(markdown: string, id: string, source: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const declaration = (line: string): string | undefined => {
    const text = line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+(?:\[[ xX]\]\s+)?|\|\s*)?/, "").replace(/^[`*]+/, "");
    return /^(REQ-\d+|AC-\d+(?:\.\d+)?|DES-\d+|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*)(?=[\s:|`*—-]|$)/.exec(text)?.[1];
  };
  const starts = lines.flatMap((line, i) => declaration(line) === id ? [i] : []);
  if (starts.length !== 1) throw new Error(`${source}: ${id} requires exactly one addressable declaration; found ${starts.length}. Author an ID heading/list/table row, then recompile`);
  const start = starts[0];
  let end = start + 1;
  const headingDepth = /^\s*(#{1,6})\s/.exec(lines[start])?.[1].length;
  const listIndent = /^(\s*)[-*]\s/.exec(lines[start])?.[1].length;
  if (!/^\s*\|/.test(lines[start])) while (end < lines.length) {
    const line = lines[end];
    const nextHeading = /^\s*(#{1,6})\s/.exec(line)?.[1].length;
    const nextListIndent = /^(\s*)[-*]\s/.exec(line)?.[1].length;
    if (declaration(line) || (nextHeading !== undefined && (headingDepth === undefined || nextHeading <= headingDepth)) || (headingDepth === undefined && nextListIndent !== undefined && nextListIndent <= (listIndent ?? 0))) break;
    end++;
  }
  const text = lines.slice(start, end).join("\n").trim();
  if (!text.replace(id, "").replace(/[\s#*`|:—-]/g, "")) throw new Error(`${source}: ${id} has no semantic text`);
  return { id, source: `${source}#${id}`, text, hash: contentHash(text) };
}
