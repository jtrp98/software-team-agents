import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ArrayLiteralExpression, Expression, Node } from "typescript";
import { GIT_COMMAND_ALLOW_LIST } from "./commandLayer.js";

/**
 * The parser loads lazily on purpose: this module sits in the eager import
 * chain of the whole CLI, and the packed payload ships no `typescript` (a
 * devDependency) — an eager import made every command of an installed
 * package crash before argv was even read. A Framework checkout always has
 * it; the injectable loader lets tests prove the fail-closed path without
 * uninstalling anything.
 */
function loadTypeScript(): typeof import("typescript") | null {
  try {
    return createRequire(import.meta.url)("typescript") as typeof import("typescript");
  } catch {
    return null;
  }
}

export interface GitOwnershipCheckResult {
  readonly ok: boolean;
  readonly problems: string[];
  readonly scannedFiles: number;
}

const PROCESS_CALLS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
const DYNAMIC_READ_ONLY_CALLERS = new Set([
  "codeintel/targetRevision.ts",
  "knowledge/knowledgeHistory.ts",
]);
const FORBIDDEN = new Set(["push", "reset", "clean", "rebase", "merge", "tag", "revert", "cherry-pick", "filter-branch"]);
const FORBIDDEN_REMOTE = new Set(["add", "set-url"]);
const READ_ONLY = new Set(["rev-parse", "symbolic-ref", "status", "ls-files", "diff", "log", "show", "cat-file", "merge-base"]);

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(file);
    }
  };
  walk(path.join(root, "orchestrator", "src"));
  return out.sort();
}

function forbiddenCommand(tokens: readonly string[]): string | null {
  const command = tokens[0]?.toLowerCase();
  if (!command) return null;
  if (FORBIDDEN.has(command)) return command;
  if (command === "remote" && FORBIDDEN_REMOTE.has(tokens[1]?.toLowerCase())) return `remote ${tokens[1].toLowerCase()}`;
  return null;
}

function isReadOnlyCommand(tokens: readonly string[]): boolean {
  const command = tokens[0]?.toLowerCase();
  if (!command) return true;
  if (READ_ONLY.has(command)) return true;
  if (command === "branch") return tokens.includes("--list");
  if (command === "config") return tokens.slice(1).some((token) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(token));
  if (command === "remote") {
    const operation = tokens[1]?.toLowerCase();
    return operation === undefined || ["show", "get-url", "-v", "--verbose"].includes(operation);
  }
  return false;
}

function productionPath(srcRoot: string, file: string): string {
  return path.relative(srcRoot, file).replace(/\\/g, "/");
}

export function checkGitOwnership(
  projectRoot: string,
  loadParser: () => typeof import("typescript") | null = loadTypeScript,
): GitOwnershipCheckResult {
  const srcRoot = path.join(projectRoot, "orchestrator", "src");
  const files = sourceFiles(projectRoot);
  const production = files.filter((file) => !/\.test\.ts$/i.test(file));
  const problems: string[] = [];
  if (files.length === 0) problems.push("scanned zero TypeScript files under orchestrator/src; Git ownership cannot be verified");
  if (production.length === 0 && files.length > 0) problems.push("scanned zero non-test TypeScript files under orchestrator/src; Git ownership cannot be verified");

  for (const entry of GIT_COMMAND_ALLOW_LIST) {
    const tokens = entry.replace(/<[^>]+>/g, "paths").split(/\s+/);
    const forbidden = forbiddenCommand(tokens);
    if (forbidden) problems.push(`orchestrator/src/git allow-list contains forbidden git subcommand: ${forbidden}`);
  }

  const ts = production.length > 0 ? loadParser() : null;
  if (production.length > 0 && !ts) {
    problems.push("typescript is not installed — run `npm install` at the framework root; the git-ownership scan needs its parser to read sources");
  }

  if (ts) {
    const literal = (node: Node | undefined): string | null =>
      node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    const callName = (expression: Expression): string | null => {
      if (ts.isIdentifier(expression)) return expression.text;
      if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
      return null;
    };
    const commandTokens = (array: ArrayLiteralExpression): string[] | null => {
      const tokens: string[] = [];
      for (const element of array.elements) {
        const value = literal(element);
        if (value === null) return null;
        tokens.push(value);
      }
      let index = 0;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(tokens[index])) index += 2;
        else index += 1;
      }
      return tokens.slice(index);
    };

    for (const file of production) {
      const relative = productionPath(srcRoot, file);
      const insideGit = relative === "git" || relative.startsWith("git/");
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      const visit = (node: Node): void => {
        if (ts.isCallExpression(node) && PROCESS_CALLS.has(callName(node.expression) ?? "") && literal(node.arguments[0])?.toLowerCase() === "git") {
          const second = node.arguments[1];
          const tokens = second && ts.isArrayLiteralExpression(second) ? commandTokens(second) : null;
          if (tokens) {
            const forbidden = forbiddenCommand(tokens);
            if (forbidden) problems.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} invokes forbidden git subcommand ${forbidden}`);
            if (!insideGit && !isReadOnlyCommand(tokens)) {
              problems.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} invokes mutating git subcommand ${tokens[0]} outside orchestrator/src/git/`);
            }
          } else if (!insideGit && !DYNAMIC_READ_ONLY_CALLERS.has(relative)) {
            problems.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} passes a dynamic git command outside orchestrator/src/git/`);
          } else if (insideGit && relative !== "git/commandLayer.ts") {
            problems.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} bypasses the closed git command layer with a dynamic command`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);

      if (DYNAMIC_READ_ONLY_CALLERS.has(relative)) {
        const inspectArrays = (node: Node): void => {
          if (ts.isCallExpression(node)) {
            const name = callName(node.expression);
            const commandArg = relative === "codeintel/targetRevision.ts" && name === "run"
              ? node.arguments[0]
              : relative === "knowledge/knowledgeHistory.ts" && name === "git"
                ? node.arguments[1]
                : undefined;
            const tokens = commandArg && ts.isArrayLiteralExpression(commandArg) ? commandTokens(commandArg) : null;
            if (tokens && !isReadOnlyCommand(tokens)) {
              problems.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} feeds a mutating git command to its read-only wrapper: ${tokens.join(" ")}`);
            }
          }
          ts.forEachChild(node, inspectArrays);
        };
        inspectArrays(source);
      }
    }
  }

  return { ok: problems.length === 0, problems, scannedFiles: files.length };
}
