import { resolveKnowledgeBinding } from "./roleWorkspace.js";

/**
 * T-WG7 — the DEV lane reads module documents through the Knowledge repo.
 *
 * Two generated artifacts carry the resolved binding into every session so no
 * prompt has to hard-code a machine-specific path:
 *
 *   `CLAUDE.md`                        — the shared rules doc, prefixed with an
 *                                        authoritative three-repo banner that
 *                                        re-points every `_docs/**` reference
 *                                        at the Knowledge root (READ-ONLY)
 *   `.claude/shared/knowledge-root.md` — a tiny generated include naming the
 *                                        root, regenerated on every dev sync
 *
 * Both derive from the binding exactly like BINDING_RENDERINGS derive from
 * agent sources: owned by declaring their derivation, never hand-edited. The
 * manifest tracks the *rendered* hashes, so a plain (non-dev) sync after a
 * role change sees a tracked-but-changed file and reports a loud conflict
 * instead of silently flipping the doc between shapes.
 */

export const KNOWLEDGE_ROOT_INCLUDE_PATH = ".claude/shared/knowledge-root.md";
export const CLAUDE_MD_PATH = "CLAUDE.md";

const BANNER_OPEN = "<!-- sta:three-repo-dev -->";
const BANNER_CLOSE = "<!-- /sta:three-repo-dev -->";

/** The generated include's body — one obvious place a prompt can cite. */
export function renderKnowledgeInclude(knowledgeRoot: string): string {
  return (
    "# Knowledge root (generated — do not edit)\n" +
    "\n" +
    "Resolved from this workspace's Knowledge binding at sync time and\n" +
    "regenerated on every `software-team-agents sync`.\n" +
    "\n" +
    `KNOWLEDGE_ROOT=${knowledgeRoot}\n` +
    "\n" +
    "Module documents live under `<root>/_docs/module/<name>/` inside that\n" +
    "repository. This dev workspace treats that tree as READ-ONLY context;\n" +
    "documents are written by analysis roles in the Knowledge workspace\n" +
    "(`software-team-agents ba`), never here.\n"
  );
}

function banner(knowledgeRoot: string): string {
  return (
    `${BANNER_OPEN}\n` +
    "> **THREE-REPO WORKSPACE — role: dev.** Every module document\n" +
    "> (`requirement.md`, `design.md`, `plan.md`, `review.md`, `security.md`,\n" +
    "> `deploy.md`) and `_docs/status.md` lives in the **Knowledge repository** —\n" +
    "> not in this repository:\n" +
    ">\n" +
    `> **Knowledge root:** \`${knowledgeRoot}\`\n` +
    ">\n" +
    "> Wherever the rules below say to read or open `_docs/…`, read that path\n" +
    "> **inside the Knowledge root above**, as READ-ONLY context. This repository\n" +
    "> carries no `_docs/` of its own: anything found under a local `_docs/` is\n" +
    "> stale legacy — never write it, never update it; report it instead\n" +
    "> (`software-team-agents status`). Documents are written by analysis roles\n" +
    "> in the Knowledge workspace (`software-team-agents ba`), never here.\n" +
    `${BANNER_CLOSE}\n`
  );
}

/** Removes a previously rendered banner so re-rendering is idempotent. */
export function stripDevClaudeBanner(content: string): string {
  const open = content.indexOf(BANNER_OPEN);
  if (open === -1) return content;
  const close = content.indexOf(BANNER_CLOSE, open);
  if (close === -1) return content; // unterminated banner — leave untouched rather than guess
  let rest = content.slice(close + BANNER_CLOSE.length);
  if (rest.startsWith("\n")) rest = rest.slice(1); // banner always ends with exactly one newline
  return content.slice(0, open) + rest;
}

/** Prefixes the authoritative banner; safe to apply over already-rendered content. */
export function renderDevClaude(baseContent: string, knowledgeRoot: string): string {
  return banner(knowledgeRoot) + stripDevClaudeBanner(baseContent);
}

/**
 * Resolves the Knowledge root a dev workspace renders against, or undefined
 * when this is not a dev workspace or nothing valid resolves. Binding problems
 * deliberately do not throw here — they surface fail-closed in the dev/ba
 * preflight with recovery advice; sync must still be able to refresh assets on
 * a machine whose installation binding is mid-repair.
 */
export function resolveDevKnowledgeRoot(options: {
  targetRoot: string;
  config?: { role?: "ba" | "dev"; knowledge?: { path: string } };
  installationConfigPath?: string;
}): string | undefined {
  if (options.config?.role !== "dev") return undefined;
  try {
    const binding = resolveKnowledgeBinding({
      targetRoot: options.targetRoot,
      configKnowledgePath: options.config.knowledge?.path,
      installationConfigPath: options.installationConfigPath,
    });
    return binding?.knowledgeRoot;
  } catch {
    return undefined;
  }
}
