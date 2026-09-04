import { resolveKnowledgeBinding } from "./roleWorkspace.js";

export const KNOWLEDGE_ROOT_INCLUDE_PATH = ".claude/shared/knowledge-root.md";
export const CLAUDE_MD_PATH = "CLAUDE.md";
export const BOOTSTRAP_OPEN = "<!-- sta:bootstrap -->";
export const BOOTSTRAP_CLOSE = "<!-- /sta:bootstrap -->";
export const BOOTSTRAP_BUDGET_BYTES = 4_096;

const LEGACY_OPEN = "<!-- sta:three-repo-dev -->";
const LEGACY_CLOSE = "<!-- /sta:three-repo-dev -->";

export type BootstrapInspection =
  | { state: "absent" }
  | { state: "malformed"; detail: string }
  | { state: "valid"; block: string; outside: string };

export class MalformedBootstrapBlockError extends Error {}

function markerCount(content: string, marker: string): number {
  // Marker comments are whole lines. A prefix such as
  // `# sta:gitignore-end-broken` is corruption, not a valid close marker.
  return content.split(/\r?\n/).filter((line) => line === marker).length;
}

/**
 * T-V5-006 — the one marker-pair locator every Framework block shares. The
 * bootstrap block (CLAUDE.md/AGENTS.md) and the managed .gitignore block use
 * different marker strings but identical locate/validate/split semantics, so
 * they share this implementation instead of growing a second one.
 */
export function inspectMarkerBlock(
  content: string,
  open: string,
  close: string,
  label = "marker",
): BootstrapInspection {
  const opens = markerCount(content, open);
  const closes = markerCount(content, close);
  if (opens === 0 && closes === 0) return { state: "absent" };
  if (opens !== 1 || closes !== 1) {
    return { state: "malformed", detail: `expected one ${label} marker pair; found ${opens} opening and ${closes} closing markers` };
  }
  const openAt = content.indexOf(open);
  const closeAt = content.indexOf(close);
  if (closeAt < openAt) return { state: "malformed", detail: `${label} closing marker appears before its opening marker` };
  let end = closeAt + close.length;
  if (content.startsWith("\r\n", end)) end += 2;
  else if (content.startsWith("\n", end)) end += 1;
  return { state: "valid", block: content.slice(openAt, end), outside: content.slice(0, openAt) + content.slice(end) };
}

/** Locates one exact block without parsing or normalizing project-owned bytes around it. */
export function inspectBootstrapBlock(content: string): BootstrapInspection {
  return inspectMarkerBlock(content, BOOTSTRAP_OPEN, BOOTSTRAP_CLOSE, "bootstrap");
}

function stripLegacyBanner(content: string): string {
  const opens = markerCount(content, LEGACY_OPEN);
  const closes = markerCount(content, LEGACY_CLOSE);
  if (opens === 0 && closes === 0) return content;
  if (opens !== 1 || closes !== 1) return content;
  const open = content.indexOf(LEGACY_OPEN);
  const close = content.indexOf(LEGACY_CLOSE, open);
  if (close < open) return content;
  let end = close + LEGACY_CLOSE.length;
  if (content.startsWith("\r\n", end)) end += 2;
  else if (content.startsWith("\n", end)) end += 1;
  return content.slice(0, open) + content.slice(end);
}

function displayPath(value: string | undefined): string {
  return value ? `\`${value.replaceAll("`", "\\`")}\`` : "**UNBOUND**";
}

export interface BootstrapRenderOptions {
  role: "ba" | "dev";
  workspaceRoot: string;
  /** Knowledge root for DEV; optional Target root for BA. */
  boundRoot?: string;
}

/** The complete always-on Framework context. Keep details behind `sta policy`. */
export function renderBootstrapBlock(options: BootstrapRenderOptions): string {
  const lane = options.role.toUpperCase();
  const boundLabel = options.role === "dev" ? "Knowledge root (read-only)" : "Target root (optional, read-only)";
  const writes = options.role === "dev" ? "Target application code and DEV-role artifacts only" : "Knowledge requirements/design/planning artifacts only";
  const block = [
    BOOTSTRAP_OPEN,
    "# software-team-agents bootstrap",
    `- Workspace role: **${lane}** (\`${options.role}\`) — writes ${writes}.`,
    `- Workspace root (writable): ${displayPath(options.workspaceRoot)}`,
    `- ${boundLabel}: ${displayPath(options.boundRoot)}`,
    "- Human gates: requirements interview; schema confirmation; third QA failure or Critical; Critical/Important security finding; real deploy or migration.",
    "- Hard boundary: no state-changing git.",
    "- Hard boundary: write only inside resolved writable workspace roots.",
    "- Hard boundary: write only paths allowed by the active role contract.",
    "- Hard boundary: Confirm workspace ↔ workspace role before writing anything.",
    "- Hard boundary: amend existing module docs section-by-section; never regenerate them.",
    "- Hard boundary: approvals/sign-offs are human acts; agents never forge them.",
    "- Hard boundary: dates and unclear business rules come from a person; never improvise them.",
    `- Context: execute this as an actual shell command — not just read the name — before browsing files for module context yourself: \`$AGENTCLAUDE_CONTEXT_CMD ${options.role} --module <name> --phase <n>\` (fill in \`<name>\`/\`<n>\`). If that variable is empty/unset, this session was not launched via \`software-team-agents ${options.role}\` — say so and stop instead of grepping local files as a substitute.`,
    "- Everything else: read only the needed section with `sta policy <area> <section>`.",
    BOOTSTRAP_CLOSE,
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(block, "utf8");
  if (bytes > BOOTSTRAP_BUDGET_BYTES) throw new Error(`bootstrap block is ${bytes} B, over its ${BOOTSTRAP_BUDGET_BYTES} B budget`);
  return block;
}

/** Removes the Framework block and restores the exact surrounding byte sequence. */
export function stripBootstrapBlock(content: string): string {
  const inspected = inspectBootstrapBlock(content);
  if (inspected.state === "malformed") throw new MalformedBootstrapBlockError(inspected.detail);
  return inspected.state === "valid" ? inspected.outside : content;
}

/** Prefixes exactly one current block; malformed project files are never guessed at. */
export function renderWorkspaceClaude(baseContent: string, options: BootstrapRenderOptions): string {
  return renderBootstrapBlock(options) + stripBootstrapBlock(stripLegacyBanner(baseContent));
}

/** Backward-compatible name retained for callers/tests while the marker is generalized. */
export function stripDevClaudeBanner(content: string): string {
  return stripBootstrapBlock(stripLegacyBanner(content));
}

/** Backward-compatible DEV wrapper; production uses `renderWorkspaceClaude`. */
export function renderDevClaude(baseContent: string, knowledgeRoot: string, workspaceRoot = "<Target workspace>"): string {
  return renderWorkspaceClaude(baseContent, { role: "dev", workspaceRoot, boundRoot: knowledgeRoot });
}

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

// --- managed .gitignore block (T-V5-006) ------------------------------------

export const GITIGNORE_PATH = ".gitignore";
export const GITIGNORE_BLOCK_OPEN = "# sta:gitignore-start";
export const GITIGNORE_BLOCK_CLOSE = "# sta:gitignore-end";

/**
 * The machine-local paths the framework states a version-control decision for.
 * Derived and policy paths join through their own tasks (T-V5-016/T-V5-018) —
 * each addition must first prove sync regenerates what ignoring would hide.
 */
export const MANAGED_GITIGNORE_PATHS: readonly string[] = [".workflow/", ".agent-team/backups/", "policies/"];

export function inspectGitignoreBlock(content: string): BootstrapInspection {
  return inspectMarkerBlock(content, GITIGNORE_BLOCK_OPEN, GITIGNORE_BLOCK_CLOSE, "gitignore");
}/**
 * Whether the project's own rules (outside any managed block) already ignore a
 * managed path. Deliberately conservative: only exact, leading-slash,
 * trailing-slash, trailing-glob and parent-directory forms count, and an
 * explicit negation makes the path NOT ignored — when in doubt the entry is
 * written (a duplicate ignore rule is harmless; a missing one leaks runtime
 * state into `git status`, which is the F-09 failure this block exists to end).
 */
export function gitignoreAlreadyCovers(content: string | undefined, managedPath: string): boolean {
  if (!content) return false;
  const bare = managedPath.replace(/\/+$/, "");
  const matchingRules = (line: string): boolean => {
    const rule = line.trim();
    if (rule === "" || rule.startsWith("#")) return false;
    if (rule === managedPath || rule === bare) return true;
    if (rule === `/${managedPath}` || rule === `/${bare}`) return true;
    if (rule === `${managedPath}**` || rule === `${bare}/**`) return true;
    if (bare.includes("/") && rule === `${bare.split("/")[0]}/`) return true;
    return false;
  };
  let ignored = false;
  for (const line of content.split("\n")) {
    const rule = line.trim();
    if (rule.startsWith("!") && matchingRules(rule.slice(1))) ignored = false;
    else if (!ignored && matchingRules(rule)) ignored = true;
  }
  return ignored;
}

/**
 * The block bytes for a workspace: header, the not-already-ignored entries, and
 * what the project already covers stated in a comment. `entries` defaults to
 * the machine-local paths; sync passes the full set (T-V5-018 adds the derived
 * rendering directories, which every sync regenerates).
 */
export function renderGitignoreBlock(alreadyIgnored: readonly string[], entries: readonly string[] = MANAGED_GITIGNORE_PATHS): string {
  const listed = entries.filter((p) => !alreadyIgnored.includes(p));
  const lines = [
    GITIGNORE_BLOCK_OPEN,
    "# software-team-agents — framework-managed machine-local paths.",
    "# Ignoring a path does NOT untrack it: files already committed stay in git",
    "# until a person removes them (`git rm -r --cached <path>`).",
  ];
  if (alreadyIgnored.length > 0) {
    lines.push(`# Already ignored by the project, so not listed again: ${alreadyIgnored.join(", ")}`);
  }
  if (listed.length === 0) {
    lines.push("# (every managed path is already covered by the project's own rules)");
  }
  lines.push(...listed, GITIGNORE_BLOCK_CLOSE);
  // The marker inspector includes the line ending after its closing marker in
  // the managed range, so the rendered bytes do too. That makes the manifest
  // hash stable across a later sync.
  return `${lines.join("\n")}\n`;
}

/**
 * One inspector for any framework-managed block contribution, keyed by path —
 * installation validation and any future block consumer pick the right marker
 * pair through this instead of knowing each file's marker dialect.
 */
export function inspectManagedBlock(relativePath: string, content: string): BootstrapInspection {
  return relativePath === GITIGNORE_PATH ? inspectGitignoreBlock(content) : inspectBootstrapBlock(content);
}
