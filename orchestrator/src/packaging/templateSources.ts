import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The packaging boundary for T90 (V1.4) — which files at the repo root are
 * "framework template": content a target project needs *materialized* at its
 * own root so Claude Code and the orchestrator's `--check-*` scripts can find
 * it, as opposed to the framework's own source (`orchestrator/src/**`), this
 * repo's own working docs (`TASKS_V1.md`, `HANDOFF*.md`, ...), or a project's
 * runtime/knowledge state (`.workflow/`, `knowledge/`, `_docs/`).
 *
 * This list is the one thing T91-T98 (CLI install, `init`, upgrade, migrate,
 * rollback) all build on — get it wrong here and every later task copies the
 * wrong boundary. See the T90 proposal in HANDOFF_V1.md for the reasoning:
 * `.claude/agents/*.md` must ship as real files in the target project because
 * Claude Code resolves subagents from the project's own `.claude/agents/`,
 * not from a package installed under `node_modules/`.
 *
 * Each entry is a directory (recursive) or a single file, relative to the
 * repo root. Whole directories are walked at build time rather than globbed,
 * so a new file dropped into e.g. `policies/` is picked up automatically —
 * the boundary is "this directory", not "the files that existed when this
 * list was written".
 */
export interface TemplateSourceEntry {
  /** Repo-root-relative path. */
  relPath: string;
  kind: "dir" | "file";
}

export const TEMPLATE_SOURCES: readonly TemplateSourceEntry[] = [
  { relPath: "CLAUDE.md", kind: "file" },
  { relPath: "AGENTS.md", kind: "file" },
  { relPath: ".claude/agents", kind: "dir" },
  { relPath: ".claude/commands", kind: "dir" },
  { relPath: ".claude/hooks", kind: "dir" },
  { relPath: ".claude/scripts", kind: "dir" },
  { relPath: ".claude/shared", kind: "dir" },
  { relPath: ".claude/settings.json", kind: "file" },
  { relPath: ".opencode/plugin", kind: "dir" },
  { relPath: "contracts", kind: "dir" },
  { relPath: "workflows", kind: "dir" },
  { relPath: "policies", kind: "dir" },
  { relPath: "stacks", kind: "dir" },
  { relPath: "layout.yaml", kind: "file" },
  { relPath: "escalation-policy.yaml", kind: "file" },
  { relPath: "test-pyramid.yaml", kind: "file" },
];

/**
 * Deliberately never templated, stated here so the boundary is a decision
 * anyone can read rather than an absence nobody explained:
 *
 *   orchestrator/**      framework source — ships as compiled dist/, never as source
 *   .claude/tests/**     the framework's own self-test, not something a target project runs
 *   _docs/**, decisions/**, knowledge/**, .workflow/**   project-owned state; `sta init`
 *                        creates these empty if absent and never overwrites them again
 *   project.yaml         Framework self-profile only; `sta init` never writes it to a Target
 *   README.md, MERGE_GUIDE.md, TASKS*.md, CHECKLIST*.md, HANDOFF*.md
 *                        this repo's own working docs about building the framework itself
 */
export const NEVER_TEMPLATED: readonly string[] = [
  "orchestrator",
  ".claude/tests",
  "_docs",
  "decisions",
  "knowledge",
  "knowledge-policy.yaml",
  "targets.yaml",
  ".workflow",
  "project.yaml",
  "README.md",
  "MERGE_GUIDE.md",
];

/** Every file under every `TEMPLATE_SOURCES` entry, repo-root-relative, forward-slashed, sorted. */
export function listTemplateFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const entry of TEMPLATE_SOURCES) {
    const abs = path.join(repoRoot, entry.relPath);
    if (!fs.existsSync(abs)) continue; // a project skeleton may not have every optional home yet
    if (entry.kind === "file") {
      out.push(entry.relPath);
      continue;
    }
    walkDir(abs, entry.relPath, out);
  }
  out.sort();
  return out;
}

function walkDir(absDir: string, relDir: string, out: string[]): void {
  for (const name of fs.readdirSync(absDir)) {
    const absChild = path.join(absDir, name);
    const relChild = `${relDir}/${name}`;
    const stat = fs.statSync(absChild);
    if (stat.isDirectory()) {
      walkDir(absChild, relChild, out);
    } else if (stat.isFile()) {
      out.push(relChild);
    }
  }
}
