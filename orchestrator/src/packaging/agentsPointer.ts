import * as fs from "node:fs";
import * as path from "node:path";
import { inspectBootstrapBlock } from "../targetcli/knowledgeRender.js";

export const LEGACY_AGENTS_POINTER_PATH = "AGENTS.md";

export type AgentsPointerMerge =
  | { state: "managed"; content: string }
  | { state: "project-owned"; content: string }
  | { state: "malformed"; detail: string };

/** Merge only the delimited Framework block when AGENTS.md already belongs to the project. */
export function mergeAgentsPointer(existing: string | undefined, rendered: string): AgentsPointerMerge {
  const expected = inspectBootstrapBlock(rendered);
  if (expected.state !== "valid") throw new Error("rendered AGENTS.md has no valid Framework bootstrap block");
  if (existing === undefined || existing === rendered) return { state: "managed", content: rendered };

  const current = inspectBootstrapBlock(existing);
  if (current.state === "malformed") return current;
  return {
    state: "project-owned",
    content: expected.block + (current.state === "valid" ? current.outside : existing),
  };
}

/** Every managed-block write is reversible even when no whole-file manifest entry is appropriate. */
export function backupAgentsPointer(projectRoot: string, content: string, now: string): string {
  const target = path.join(projectRoot, ".sta", "backups", now.replace(/[:.]/g, "-"), LEGACY_AGENTS_POINTER_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}
