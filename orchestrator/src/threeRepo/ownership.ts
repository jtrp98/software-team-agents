export type RepositoryOwner = "framework" | "knowledge" | "target";
export type InstallMode = "legacy-project" | "three-repo";

export const KNOWLEDGE_OWNED_PATHS = [
  "knowledge",
  "_docs",
  "decisions",
  "knowledge-policy.yaml",
  "targets.yaml",
  "knowledge/_roles",
  ".workflow",
] as const;

/** Instructions that belong to a target project even when their basename is shared
 * with a framework instruction.  The install/upgrade manifest is relative to a
 * target, so these can never be framework-managed payload. */
export const TARGET_OWNED_PATHS = ["AGENTS.md", "CLAUDE.md", ".claude", ".codex", ".agents"] as const;

function normalise(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function ownerOfPath(relativePath: string): RepositoryOwner {
  const candidate = normalise(relativePath);
  if (KNOWLEDGE_OWNED_PATHS.some((owned) => candidate === owned || candidate.startsWith(`${owned}/`))) {
    return "knowledge";
  }
  if (TARGET_OWNED_PATHS.some((owned) => candidate === owned || candidate.startsWith(`${owned}/`))) {
    return "target";
  }
  return "framework";
}

/** Framework install/upgrade manifests may contain only framework-owned paths.
 * Legacy project mode is deliberately opt-in because its bindings share names
 * with Target instructions. */
export function assertFrameworkManagedPaths(paths: readonly string[], mode: InstallMode = "three-repo"): void {
  const isLegacyFrameworkInstruction = (candidate: string): boolean => {
    const normalised = normalise(candidate);
    return normalised === "CLAUDE.md" || normalised.startsWith(".claude/");
  };
  const forbidden = paths.filter((candidate) =>
    ownerOfPath(candidate) !== "framework" && !(mode === "legacy-project" && isLegacyFrameworkInstruction(candidate)),
  );
  if (forbidden.length > 0) {
    throw new Error(`framework manifest includes project-owned path(s): ${forbidden.join(", ")}`);
  }
}
