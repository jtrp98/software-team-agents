import * as fs from "node:fs";
import * as path from "node:path";
import { sectionMap } from "../context/sections.js";

/**
 * T-V3TOK-013 — on-demand policy retrieval.
 *
 * `policies/` is 52,733 B across seven files, and every agent prompt used to
 * open all of it before looking at the work. Removing that pre-read (T-V3TOK-012)
 * is only safe if a narrower way in exists first: without one an agent falls
 * back to `Read policies/documentation.md`, which is 28,438 B on its own, and
 * the tokens come straight back.
 *
 * This is a *surface*, not a new parser. Sections come from `sectionMap()` in
 * `context/contextManager.ts`, which already handles the one case that matters
 * here — a `## ` inside a fenced block is sample content, and `documentation.md`
 * genuinely contains those. Writing a second parser would mean two answers to
 * "where does §10 start", and the retrieval one would be the untested one.
 */

/** `policies/<area>.md` — the area is the filename without its extension. */
export interface PolicySectionRef {
  heading: string;
  /** Leading `§`-style number when the heading starts with one (`## 5c. …` -> `5c`). */
  number: string | null;
  bytes: number;
}

export interface PolicyAreaIndex {
  area: string;
  relPath: string;
  bytes: number;
  sections: PolicySectionRef[];
}

export class PolicyIndexError extends Error {}

function policiesDir(projectRoot: string): string {
  return path.join(projectRoot, "policies");
}

/** `## 5c. An engineer doesn't…` -> `5c`; `## Scaffold` -> null. */
function headingNumber(heading: string): string | null {
  return /^(\d+[a-z]?(?:-\d+)?)\s*[.)]?\s+/i.exec(heading)?.[1]?.toLowerCase() ?? null;
}

function readArea(dir: string, file: string): PolicyAreaIndex {
  const markdown = fs.readFileSync(path.join(dir, file), "utf8");
  const lines = markdown.split(/\r?\n/);
  return {
    area: file.slice(0, -".md".length),
    relPath: `policies/${file}`,
    bytes: markdown.length,
    sections: sectionMap(markdown).map((section) => ({
      heading: section.heading,
      number: headingNumber(section.heading),
      bytes: lines.slice(section.start, section.end).join("\n").length,
    })),
  };
}

/** Every policy file and the `## ` sections inside it. Throws only when `policies/` itself is missing. */
export function listPolicySections(projectRoot: string): PolicyAreaIndex[] {
  const dir = policiesDir(projectRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new PolicyIndexError(`no policies/ directory under ${projectRoot}`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .map((file) => readArea(dir, file));
}

/**
 * Normalizes the three forms an agent will actually type: `§10`, `10`, and a
 * substring of the heading. A prompt pointer is written `policies/coding.md §5c`,
 * so `§` has to survive being pasted verbatim.
 */
function normalizeQuery(query: string): string {
  return query.replace(/^§/, "").trim().toLowerCase();
}

function matches(section: PolicySectionRef, query: string): boolean {
  const q = normalizeQuery(query);
  if (q.length === 0) return false;
  if (section.number !== null && section.number === q) return true;
  return section.heading.toLowerCase().includes(q);
}

export interface PolicySectionHit {
  found: true;
  area: string;
  relPath: string;
  heading: string;
  text: string;
  bytes: number;
  /** Size of the whole file the section came from — the number the caller avoided reading. */
  areaBytes: number;
}

export interface PolicySectionMiss {
  found: false;
  area: string;
  relPath: string;
  /**
   * What *is* there. A miss that answers with the available list lets an agent
   * pick in the same turn instead of falling back to reading the whole file,
   * which is the failure mode this verb exists to prevent — so a miss is exit 0,
   * not an error.
   */
  sections: PolicySectionRef[];
}

export type PolicySectionResult = PolicySectionHit | PolicySectionMiss;

/** Resolves an area name, accepting `documentation`, `documentation.md`, or `policies/documentation.md`. */
function resolveArea(projectRoot: string, area: string): PolicyAreaIndex {
  const wanted = area.replace(/^policies\//, "").replace(/\.md$/, "").toLowerCase();
  const index = listPolicySections(projectRoot);
  const hit = index.find((entry) => entry.area.toLowerCase() === wanted);
  if (!hit) {
    throw new PolicyIndexError(
      `no policy area "${area}" — available: ${index.map((entry) => entry.area).join(", ")}`,
    );
  }
  return hit;
}

/** One section's text, or the list of sections that area does have. */
export function getPolicySection(projectRoot: string, area: string, section: string): PolicySectionResult {
  const entry = resolveArea(projectRoot, area);
  const markdown = fs.readFileSync(path.join(projectRoot, ...entry.relPath.split("/")), "utf8");
  const lines = markdown.split(/\r?\n/);
  const map = sectionMap(markdown);

  const idx = map.findIndex((_, i) => matches(entry.sections[i], section));
  if (idx === -1) return { found: false, area: entry.area, relPath: entry.relPath, sections: entry.sections };

  const text = lines.slice(map[idx].start, map[idx].end).join("\n").replace(/\s+$/, "");
  return {
    found: true,
    area: entry.area,
    relPath: entry.relPath,
    heading: map[idx].heading,
    text,
    bytes: text.length,
    areaBytes: entry.bytes,
  };
}

/**
 * Every `policies/<file>.md §<n>` pointer an agent prompt may carry, resolved
 * against the real headings. T-V3TOK-014 guard 4 uses this so a pointer that
 * rots is a failing check rather than an agent's dead end at runtime.
 */
export function policyPointerResolves(projectRoot: string, area: string, section: string): boolean {
  try {
    return getPolicySection(projectRoot, area, section).found;
  } catch {
    return false;
  }
}
