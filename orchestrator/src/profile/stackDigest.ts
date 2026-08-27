import * as path from "node:path";
import { loadTargetConfig, type TargetStackConfig } from "../targetcli/targetMeta.js";

export const STACK_DIGEST_RELATIVE_PATH = ".claude/shared/stack.md";
export const STACK_DIGEST_BUDGET_BYTES = 1_500;

function resolvedDigest(stack: TargetStackConfig): string {
  const commands = Object.entries(stack.commands)
    .map(([name, command]) => `- ${name}: \`${command}\``)
    .join("\n");
  const sourceRoots = stack.source_roots.length > 0 ? stack.source_roots.map((root) => `\`${root}\``).join(", ") : "none declared";
  const schemaPaths = stack.schema_paths.length > 0 ? stack.schema_paths.map((schema) => `\`${schema}\``).join(", ") : "none detected";
  return [
    "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->",
    "# Target-resolved stack",
    "",
    `- Profile: \`${stack.profile}\``,
    `- Package manager/tool: \`${stack.package_manager}\``,
    `- Source roots: ${sourceRoots}`,
    `- Schema paths: ${schemaPaths}`,
    "",
    "## Commands",
    "",
    commands,
    "",
    "Use this repository's existing libraries and conventions. Implement the resolved stack; do not choose a replacement. A stack change is a human decision.",
    "",
  ].join("\n");
}

function unresolvedDigest(): string {
  return [
    "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->",
    "# Target-resolved stack",
    "",
    "Stack not yet detected. Run `software-team-agents sync` to resolve and record this Target's profile; do not assume a default stack.",
    "",
  ].join("\n");
}

/** Deterministically renders the compact stack lookup that non-engineering roles need. */
export function renderStackDigest(source?: string | TargetStackConfig): string {
  const stack = typeof source === "string" ? loadTargetConfig(source)?.stack : source;
  const rendered = stack ? resolvedDigest(stack) : unresolvedDigest();
  if (Buffer.byteLength(rendered, "utf8") > STACK_DIGEST_BUDGET_BYTES) {
    throw new Error(`generated stack.md exceeds its ${STACK_DIGEST_BUDGET_BYTES.toLocaleString("en-US")} B budget`);
  }
  return rendered;
}

export function stackDigestPath(projectRoot: string): string {
  return path.join(projectRoot, ...STACK_DIGEST_RELATIVE_PATH.split("/"));
}
