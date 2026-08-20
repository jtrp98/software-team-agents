import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves which model a stage actually runs on (T26's "Model" field of the execution log),
 * by reading `.claude/agents/<role>.md`'s own frontmatter — the single source of truth CLAUDE.md
 * names for this ("To change one, edit that agent's frontmatter"). The orchestrator's own
 * `AGENT_REGISTRY` (agents/registry.ts) deliberately carries no copy of it: two definitions of
 * the same fact is exactly the drift this pipeline spends effort avoiding elsewhere.
 *
 * Returns `null`, never throws, when the file is missing or has no parseable `model:` line — a
 * stage whose model can't be resolved should log as "unknown", not stop the run.
 */
export function resolveAgentModel(projectRoot: string, role: string): string | null {
  const file = path.join(projectRoot, ".claude", "agents", `${role}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseModelFromFrontmatter(text);
}

/** Frontmatter is `---\nkey: value\n...\n---` at the very top of the file — a plain YAML scalar per line, no nesting. */
export function parseModelFromFrontmatter(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const line = match[1]
    .split(/\r?\n/)
    .find((l) => /^model\s*:/.test(l));
  if (!line) return null;
  const value = line.split(":").slice(1).join(":").trim();
  return value.length > 0 ? value : null;
}
