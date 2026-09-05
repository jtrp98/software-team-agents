import * as fs from "node:fs";
import * as path from "node:path";

export type RepositoryOwner = "framework" | "knowledge" | "target";
export type InstallMode = "legacy-project" | "three-repo";

export const INSTRUCTION_PRECEDENCE = [
  "framework-managed",
  "project-owned-with-framework-block",
  "project-owned-merged",
  "project-owned-untouched",
] as const;
export type InstructionPrecedence = (typeof INSTRUCTION_PRECEDENCE)[number];

export interface InstructionSurfaceEntry {
  path: string;
  owner: RepositoryOwner;
  precedence: InstructionPrecedence;
  frameworkContributionPresent: boolean;
  consequence?: string;
}

/** Files whose directory-specific precedence can override the root bootstrap. */
export function isNestedInstruction(entry: InstructionSurfaceEntry): boolean {
  const candidate = normalise(entry.path);
  return candidate !== "AGENTS.md" &&
    (path.posix.basename(candidate) === "AGENTS.md" || path.posix.basename(candidate) === "CLAUDE.local.md");
}

interface InstructionPathClass {
  name: string;
  owner: RepositoryOwner;
  precedence: InstructionPrecedence;
  matches: (relativePath: string) => boolean;
}

export const KNOWLEDGE_OWNED_PATHS = [
  "knowledge",
  "_docs",
  "decisions",
  "knowledge-policy.yaml",
  "targets.yaml",
  "knowledge/_roles",
  ".workflow",
] as const;

/**
 * Regenerable execution artifacts are Local Runtime State, never Knowledge.
 * Keep this deny ahead of the broad `.workflow` Knowledge classification:
 * `.workflow` also contains installation-local bindings that predate V3, but
 * packets, verification evidence and runner output must never inherit durable
 * Knowledge ownership from that compatibility root.
 */
export const KNOWLEDGE_DENIED_RUNTIME_DIRS = ["packets", "evidence", "runs"] as const;

export class RuntimeStateOwnershipError extends Error {
  constructor(relativePath: string, kind: string) {
    super(
      `refusing to classify "${relativePath}" as Knowledge-owned — regenerable ${kind} artifacts belong under .workflow/${kind}/ in Local Runtime State`,
    );
    this.name = "RuntimeStateOwnershipError";
  }
}

/** Instructions that belong to a target project even when their basename is shared
 * with a framework instruction.  The install/upgrade manifest is relative to a
 * target, so these can never be framework-managed payload. */
export const TARGET_OWNED_PATHS = ["AGENTS.md", "CLAUDE.md", ".claude", ".codex", ".agents"] as const;

function normalise(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * The instruction precedence model is deliberately data, not scattered branch
 * logic. Repository ownership (`ownerOfPath`) remains unchanged: this narrower
 * table declares who controls instruction bytes when both the Framework and a
 * Target have a legitimate interest in the same file.
 */
export const INSTRUCTION_PATH_CLASSES: readonly InstructionPathClass[] = [
  {
    name: "root-claude",
    owner: "target",
    precedence: "project-owned-with-framework-block",
    matches: (candidate) => candidate === "CLAUDE.md",
  },
  {
    name: "root-agents",
    owner: "target",
    precedence: "project-owned-with-framework-block",
    matches: (candidate) => candidate === "AGENTS.md",
  },
  {
    name: "local-claude",
    owner: "target",
    precedence: "project-owned-untouched",
    matches: (candidate) => path.posix.basename(candidate) === "CLAUDE.local.md",
  },
  {
    name: "nested-agents",
    owner: "target",
    precedence: "project-owned-untouched",
    matches: (candidate) => candidate !== "AGENTS.md" && path.posix.basename(candidate) === "AGENTS.md",
  },
  {
    name: "claude-settings",
    owner: "target",
    precedence: "project-owned-merged",
    matches: (candidate) => candidate === ".claude/settings.json",
  },
  {
    name: "claude-agents",
    owner: "framework",
    precedence: "framework-managed",
    matches: (candidate) => candidate.startsWith(".claude/agents/"),
  },
  {
    name: "codex-instructions",
    owner: "framework",
    precedence: "framework-managed",
    matches: (candidate) => candidate.startsWith(".codex/"),
  },
  {
    name: "opencode-instructions",
    owner: "framework",
    precedence: "framework-managed",
    matches: (candidate) => candidate.startsWith(".opencode/"),
  },
] as const;

export function instructionPathClass(relativePath: string): InstructionPathClass | undefined {
  const candidate = normalise(relativePath);
  return INSTRUCTION_PATH_CLASSES.find((entry) => entry.matches(candidate));
}

/** Matches the static gate's bounded tree-walk exclusions. .agent-team backups are not instruction surface. */
export const INSTRUCTION_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".workflow", ".next", "build", ".agent-team"]);

function installedFrameworkHookCount(targetRoot: string): number {
  const hooksDir = path.join(targetRoot, ".claude", "hooks");
  try {
    return fs
      .readdirSync(hooksDir, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(".js"))
      .length;
  } catch {
    return 0;
  }
}

export function missingInstructionConsequence(targetRoot: string, relativePath: string): string | undefined {
  const candidate = normalise(relativePath);
  if (candidate === "CLAUDE.md") return "Framework routing is not delivered to this workspace";
  if (candidate === ".claude/settings.json") {
    return `${installedFrameworkHookCount(targetRoot)} framework hooks are installed but not registered`;
  }
  if (candidate === "AGENTS.md") return "Framework routing is not delivered to Codex in this workspace";
  const pathClass = instructionPathClass(candidate);
  if (pathClass?.precedence === "framework-managed") return "Framework does not manage this instruction file";
  return undefined;
}

export const BOOTSTRAP_BLOCK_OPEN = "<!-- sta:bootstrap -->";
export const BOOTSTRAP_BLOCK_CLOSE = "<!-- /sta:bootstrap -->";

function containsOneBootstrapBlock(file: string): boolean {
  try {
    const body = fs.readFileSync(file, "utf8");
    return body.split(BOOTSTRAP_BLOCK_OPEN).length - 1 === 1 &&
      body.split(BOOTSTRAP_BLOCK_CLOSE).length - 1 === 1 &&
      body.indexOf(BOOTSTRAP_BLOCK_CLOSE) > body.indexOf(BOOTSTRAP_BLOCK_OPEN);
  } catch {
    return false;
  }
}

/**
 * Removes the Framework-managed bootstrap block from an otherwise
 * project-owned file (e.g. a Target's `CLAUDE.md`). What is left is the
 * project's own content, if any. The block itself is Framework-authored
 * bytes and must never be treated as project content by an importer.
 */
export function stripFrameworkManagedBlock(text: string): string {
  const openIndex = text.indexOf(BOOTSTRAP_BLOCK_OPEN);
  const closeIndex = text.indexOf(BOOTSTRAP_BLOCK_CLOSE);
  if (openIndex === -1 || closeIndex === -1 || closeIndex < openIndex) return text;
  return (text.slice(0, openIndex) + text.slice(closeIndex + BOOTSTRAP_BLOCK_CLOSE.length)).trim();
}

/** Read-only, symlink-avoiding inventory of the complete Target instruction surface. */
export function detectInstructionSurface(options: {
  targetRoot: string;
  frameworkPaths?: ReadonlySet<string>;
}): InstructionSurfaceEntry[] {
  const targetRoot = path.resolve(options.targetRoot);
  const frameworkPaths = new Set([...(options.frameworkPaths ?? [])].map(normalise));
  const hasManifest = options.frameworkPaths !== undefined;
  const found: InstructionSurfaceEntry[] = [];

  const walk = (directory: string, relativeDirectory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = normalise(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!INSTRUCTION_SCAN_SKIP_DIRS.has(entry.name)) walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const pathClass = instructionPathClass(relative);
      if (!pathClass) continue;
      const frameworkContributionPresent =
        frameworkPaths.has(relative) ||
        (pathClass.precedence === "project-owned-with-framework-block" && containsOneBootstrapBlock(absolute));

      // Resolve owner from manifest membership with directory prefix as a fallback only.
      // If the manifest was provided and does not claim this file, it is project-owned (target),
      // not framework-managed.
      let owner: RepositoryOwner = pathClass.owner;
      let precedence: InstructionPrecedence = pathClass.precedence;
      if (hasManifest && pathClass.owner === "framework") {
        if (frameworkPaths.has(relative)) {
          owner = "framework";
          precedence = "framework-managed";
        } else {
          owner = "target";
          precedence = "project-owned-untouched";
        }
      }

      found.push({
        path: relative,
        owner,
        precedence,
        frameworkContributionPresent,
        consequence: frameworkContributionPresent || precedence !== "framework-managed"
          ? undefined
          : missingInstructionConsequence(targetRoot, relative),
      });
    }
  };
  walk(targetRoot, "");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function ownerOfPath(relativePath: string): RepositoryOwner {
  const candidate = normalise(relativePath);
  const segments = candidate.split("/");
  const hasKnowledgePrefix = KNOWLEDGE_OWNED_PATHS.some((owned) => candidate === owned || candidate.startsWith(`${owned}/`));
  const runtimeKind = KNOWLEDGE_DENIED_RUNTIME_DIRS.find(
    (kind) => candidate === kind || candidate.startsWith(`${kind}/`) || (hasKnowledgePrefix && segments.includes(kind)),
  );
  if (runtimeKind) throw new RuntimeStateOwnershipError(relativePath, runtimeKind);
  if (hasKnowledgePrefix) {
    return "knowledge";
  }
  if (TARGET_OWNED_PATHS.some((owned) => candidate === owned || candidate.startsWith(`${owned}/`))) {
    return "target";
  }
  return "framework";
}

/**
 * Whether the content at `relativePath` is authored by the Framework rather
 * than by a project. The adoption importer must refuse these paths
 * (`policies/**`, `.claude/agents/**`, `contracts/**`, `workflows/**`,
 * `stacks/**`, `layout.yaml` and siblings) instead of duplicating them into a
 * project's knowledge graph. Reuses the two classifications this module
 * already maintains rather than introducing a third list: `ownerOfPath`'s
 * default bucket (everything not explicitly Knowledge- or Target-owned is
 * Framework's own repository content) and `instructionPathClass`'s
 * `framework-managed` instruction surface (e.g. `.claude/agents/**`, which
 * `ownerOfPath` alone would call "target" because of the shared `.claude`
 * prefix).
 */
export function isFrameworkAuthoredPath(relativePath: string): boolean {
  let owner: RepositoryOwner;
  try {
    owner = ownerOfPath(relativePath);
  } catch {
    // Regenerable runtime state (packets/evidence/runs) is never Framework
    // rulebook content — let the caller's own handling decide what to do.
    return false;
  }
  if (owner === "framework") return true;
  return instructionPathClass(relativePath)?.owner === "framework";
}

/** Framework install/upgrade manifests may contain only framework-owned paths.
 * Legacy project mode is deliberately opt-in because its bindings share names
 * with Target instructions. */
export function assertFrameworkManagedPaths(paths: readonly string[], mode: InstallMode = "three-repo"): void {
  const isLegacyFrameworkInstruction = (candidate: string): boolean => {
    const normalised = normalise(candidate);
    return normalised === "CLAUDE.md" || normalised === "AGENTS.md" || normalised.startsWith(".claude/");
  };
  const forbidden = paths.filter((candidate) =>
    ownerOfPath(candidate) !== "framework" && !(mode === "legacy-project" && isLegacyFrameworkInstruction(candidate)),
  );
  if (forbidden.length > 0) {
    throw new Error(`framework manifest includes project-owned path(s): ${forbidden.join(", ")}`);
  }
}
