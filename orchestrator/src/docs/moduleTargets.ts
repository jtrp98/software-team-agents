import { sectionMap, sectionText } from "../context/sections.js";

/**
 * `design.md`'s `## Targets` section (V9 AD-2): the Target ids a module spans,
 * one per line, optionally annotated with the engineer role(s) that Target
 * serves in this module. Ids only — rationale belongs in
 * `## Feature-by-Feature Feasibility`, so any prose here is a grammar problem,
 * never a tolerated extra.
 *
 * The section is optional in the current contract: a module that declares none
 * is unscoped, not invalid.
 * Resolving these ids against `targets.yaml` is a later task's job — this
 * module only reads the declaration.
 */

export interface ParsedModuleTargets {
  /** Whether a `## Targets` section exists at all. */
  present: boolean;
  /** Declared ids, in document order, de-duplicated. */
  ids: string[];
  /** Repeated ids, in first-duplicate order. Consumers may report them without changing the de-duplicated declaration contract. */
  duplicates: string[];
  problems: string[];
}

/** The engineer roles a Target can serve in a module — the roles a stack profile scopes. */
const ENGINEER_ROLES: ReadonlySet<string> = new Set(["frontend-engineer", "backend-engineer"]);

/** `- <target-id>` or `- <target-id> (role, role)` — the whole grammar, on one line. The id carries the same shape `targets.schema.json` declares for `target_id` (`^[a-z][a-z0-9-]*$`). */
const TARGET_LINE = /^[-*]\s+([a-z][a-z0-9-]*)\s*(?:\(([^()]*)\))?\s*$/;

export function parseModuleTargets(markdown: string): ParsedModuleTargets {
  const section = sectionMap(markdown).find((candidate) => candidate.heading === "Targets");
  if (!section) return { present: false, ids: [], duplicates: [], problems: [] };

  const ids: string[] = [];
  const duplicates: string[] = [];
  const problems: string[] = [];
  const body = sectionText(markdown, section).split(/\r?\n/).slice(1); // drop the heading line
  for (const raw of body) {
    const line = raw.trim();
    if (line === "") continue;
    const match = TARGET_LINE.exec(line);
    if (!match) {
      problems.push(
        `## Targets § "${line}": expected "- <target-id>" optionally annotated with "(frontend-engineer, backend-engineer)" — ids only, no rationale`,
      );
      continue;
    }
    const id = match[1];
    if (ids.includes(id)) {
      if (!duplicates.includes(id)) duplicates.push(id);
    } else {
      ids.push(id);
    }
    if (match[2] !== undefined) {
      for (const role of match[2].split(",").map((part) => part.trim()).filter((part) => part !== "")) {
        if (!ENGINEER_ROLES.has(role)) {
          problems.push(`## Targets § "${line}": "${role}" is not an engineer role (${[...ENGINEER_ROLES].join(", ")})`);
        }
      }
    }
  }
  return { present: true, ids, duplicates, problems };
}

/** The declared Target ids of one `design.md`, in document order, de-duplicated; empty when the module declares none. */
export function readModuleTargets(designMd: string): string[] {
  return parseModuleTargets(designMd).ids;
}
