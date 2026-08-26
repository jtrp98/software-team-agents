import * as fs from "node:fs";
import * as path from "node:path";
import { sectionMap } from "../context/contextManager.js";

const SOURCE_ROLES = ["backend-engineer", "frontend-engineer"] as const;
const HEADING = "fixed project stack";

function fixedStackSection(markdown: string, role: string): string {
  const section = sectionMap(markdown).find((candidate) => candidate.heading.trim().toLowerCase() === HEADING);
  if (!section) throw new Error(`${role}.md has no ## Fixed project stack section`);
  const lines = markdown.split(/\r?\n/);
  return lines.slice(section.start + 1, section.end).join("\n").trim();
}

/** Deterministically renders the compact stack lookup that non-engineering roles need. */
export function renderStackDigest(projectRoot: string): string {
  const sections = SOURCE_ROLES.map((role) => {
    const file = path.join(projectRoot, ".claude", "agents", `${role}.md`);
    return { role, text: fixedStackSection(fs.readFileSync(file, "utf8"), role) };
  });
  const rendered = [
    "<!-- GENERATED from .claude/agents/{backend,frontend}-engineer.md; do not edit by hand. -->",
    "# Fixed project stack",
    ...sections.flatMap(({ role, text }) => [`## ${role}`, text]),
    "",
  ].join("\n\n");
  if (Buffer.byteLength(rendered, "utf8") > 1_500) throw new Error("generated stack.md exceeds its 1,500 B budget");
  return rendered;
}

export function stackDigestPath(projectRoot: string): string {
  return path.join(projectRoot, ".claude", "shared", "stack.md");
}
