import * as fs from "node:fs";
import * as path from "node:path";
import { readKnowledgeFile } from "../knowledge/knowledgeStore.js";

/**
 * Read-only access to the documents a person needs while answering a gate:
 * the module's `_docs/module/<module>/**.md` files and its `knowledge/<module>/<kind>/<ID>.yaml`
 * items. Paths are relative to the Knowledge root and only these two shapes are ever served.
 */

export interface RunDocEntry {
  path: string;
  label: string;
  group: "item" | "doc";
  status?: string;
}

export interface RunDocContent {
  path: string;
  title: string;
  markdown: string;
}

const MAX_DOC_BYTES = 400_000;
const MAX_DOC_FILES = 60;

const toRel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join("/");

function walkMarkdown(dir: string, depth: number, out: string[]): void {
  if (depth > 2 || out.length >= MAX_DOC_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith(".md") && !/archive/i.test(entry.name)) out.push(full);
  }
}

function itemFiles(root: string, moduleName: string): string[] {
  const base = path.join(root, "knowledge", moduleName);
  const out: string[] = [];
  let kinds: fs.Dirent[];
  try {
    kinds = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const kind of kinds.filter((e) => e.isDirectory())) {
    try {
      for (const file of fs.readdirSync(path.join(base, kind.name))) if (file.endsWith(".yaml")) out.push(path.join(base, kind.name, file));
    } catch { /* unreadable kind folder: skip */ }
  }
  return out;
}

/** `ids` narrows the items to those named in the gate; with none, every item still short of approved is listed. */
export function listRunDocs(root: string, moduleName: string, ids: string[]): RunDocEntry[] {
  const docs: RunDocEntry[] = [];
  for (const file of itemFiles(root, moduleName)) {
    const id = path.basename(file, ".yaml");
    try {
      const item = readKnowledgeFile(file);
      if (ids.length > 0 ? !ids.includes(id) : item.status === "approved") continue;
      docs.push({ path: toRel(root, file), label: `${item.id} — ${item.title}`, group: "item", status: item.status });
    } catch { /* an unreadable item is reported by --check-knowledge, not here */ }
  }
  docs.sort((a, b) => a.label.localeCompare(b.label));
  const md: string[] = [];
  walkMarkdown(path.join(root, "_docs", "module", moduleName), 0, md);
  for (const file of md) docs.push({ path: toRel(root, file), label: toRel(path.join(root, "_docs", "module", moduleName), file), group: "doc" });
  return docs;
}

export function readRunDoc(root: string, moduleName: string, rel: string): RunDocContent | null {
  const normalized = rel.replace(/\\/g, "/");
  const isDoc = normalized.startsWith(`_docs/module/${moduleName}/`) && normalized.endsWith(".md");
  const isItem = new RegExp(`^knowledge/${moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+/[^/]+\\.yaml$`).test(normalized);
  if ((!isDoc && !isItem) || normalized.split("/").includes("..")) return null;
  const file = path.resolve(root, ...normalized.split("/"));
  try {
    // Resolve symlinks too: a link inside the repo must not lead outside it.
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    if (fs.statSync(real).size > MAX_DOC_BYTES) return { path: normalized, title: path.basename(normalized), markdown: "_(file too large to preview)_" };
    if (isDoc) return { path: normalized, title: path.basename(normalized), markdown: fs.readFileSync(real, "utf8") };
    const item = readKnowledgeFile(real, normalized);
    const meta = `> ${item.kind} · status: **${item.status}** · owner: ${item.owner}`;
    return { path: normalized, title: `${item.id} — ${item.title}`, markdown: `# ${item.id} — ${item.title}\n\n${meta}\n\n${item.body}` };
  } catch {
    return null;
  }
}
