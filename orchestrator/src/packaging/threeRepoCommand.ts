import * as fs from "node:fs";
import * as path from "node:path";

const KNOWLEDGE_DIRECTORIES = ["knowledge", "_docs", "decisions"] as const;
const KNOWLEDGE_FILES: Readonly<Record<string, string>> = {
  "knowledge-policy.yaml": "schema_version: 1\n",
  "targets.yaml": "schema_version: 1\ntargets: []\n",
};
const WORKFLOW_IGNORE = ".workflow/";

export interface ThreeRepoInitResult {
  createdDirectories: string[];
  createdFiles: string[];
  gitignoreUpdated: boolean;
}

export interface ThreeRepoUpgradeResult {
  frameworkBindingsUpdated: string[];
  knowledgePathsSkipped: string[];
}

/**
 * Initializes only Knowledge-owned state. Framework bindings remain in the
 * installed framework and Target source/instructions are never materialized.
 * Existing data is left byte-for-byte intact, making this safe to re-run.
 */
export function runThreeRepoInit(knowledgeRoot: string): ThreeRepoInitResult {
  const root = path.resolve(knowledgeRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Knowledge root "${knowledgeRoot}" is not an existing directory`);
  }

  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  for (const relative of KNOWLEDGE_DIRECTORIES) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      createdDirectories.push(relative);
    }
  }
  for (const [relative, content] of Object.entries(KNOWLEDGE_FILES)) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, "utf8");
      createdFiles.push(relative);
    }
  }

  const gitignorePath = path.join(root, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const ignored = existing.split(/\r?\n/).some((line) => line.trim() === WORKFLOW_IGNORE);
  if (!ignored) fs.writeFileSync(gitignorePath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${WORKFLOW_IGNORE}\n`, "utf8");

  return { createdDirectories, createdFiles, gitignoreUpdated: !ignored };
}

/** Three-repo upgrades are intentionally unable to traverse a Knowledge or
 * Target root. Updating the installed CLI/framework is the only binding update. */
export function runThreeRepoUpgrade(knowledgeRoot: string): ThreeRepoUpgradeResult {
  const root = path.resolve(knowledgeRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Knowledge root "${knowledgeRoot}" is not an existing directory`);
  }
  return {
    frameworkBindingsUpdated: [],
    knowledgePathsSkipped: [...KNOWLEDGE_DIRECTORIES, ...Object.keys(KNOWLEDGE_FILES), ".workflow", "AGENTS.md", "CLAUDE.md", ".claude", ".codex", ".agents"],
  };
}
