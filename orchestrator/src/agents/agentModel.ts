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
  return parseFrontmatterField(text, "model");
}

/**
 * Resolves which prompt version actually ran a stage (T57's "log which prompt version a task
 * used"), the same way `resolveAgentModel` resolves the model — from `.claude/agents/<role>.md`'s
 * own `version:` frontmatter field, never a second copy kept anywhere else.
 *
 * T57 is log-only by design: nothing here lets the orchestrator run an *older* prompt version.
 * Claude Code resolves a subagent from exactly `.claude/agents/<role>.md`, so only the prompt
 * currently at that path can ever run (`.claude/agents/` §4.1's reasoning). Bump the number in
 * that same file's frontmatter when the prompt changes meaningfully; this just reads it back so
 * a run's log says which one it was.
 *
 * Returns `null`, never throws, when the file is missing or has no parseable `version:` line —
 * an agent file that predates T57 (or a test stub) should log as "unknown", not stop the run.
 */
export function resolveAgentVersion(projectRoot: string, role: string): number | null {
  const file = path.join(projectRoot, ".claude", "agents", `${role}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseVersionFromFrontmatter(text);
}

export function parseVersionFromFrontmatter(text: string): number | null {
  const raw = parseFrontmatterField(text, "version");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reads the configured model-reasoning effort for telemetry only. */
export function resolveAgentEffort(projectRoot: string, role: string): string | null {
  const file = path.join(projectRoot, ".claude", "agents", `${role}.md`);
  try {
    return parseEffortFromFrontmatter(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function parseEffortFromFrontmatter(text: string): string | null {
  return parseFrontmatterField(text, "effort");
}

/** Shared parser for the deliberately flat agent-frontmatter fields. */
export function parseFrontmatterField(text: string, key: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fieldRe = new RegExp(`^${key}\\s*:`);
  const line = match[1]
    .split(/\r?\n/)
    .find((l) => fieldRe.test(l));
  if (!line) return null;
  const value = line.split(":").slice(1).join(":").trim();
  return value.length > 0 ? value : null;
}
