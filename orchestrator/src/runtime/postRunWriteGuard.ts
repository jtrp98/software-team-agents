import * as path from "node:path";
import { targetPathRules } from "../agents/pathPermissions.js";
import type { RuntimeAgentRequest } from "./runtimeAdapter.js";
import { verifyChangedFilesScope, type PostflightRoot } from "./postflight.js";

/** Checks only the snapshotted roots. It cannot prevent writes or inspect arbitrary external paths. */
export function verifyPostRunWrites(req: RuntimeAgentRequest, changedFiles: readonly string[] | undefined): string[] {
  if (changedFiles === undefined) return req.autonomy === "read-only" ? [] : ["post-run write guard: changed-files snapshot unavailable; scope cannot be verified"];
  const targets = req.workRoots ?? [];
  const roots: readonly PostflightRoot[] = targets.length > 0
    ? targets.map((root) => ({ ...root, access: req.autonomy === "read-only" ? "read" : root.access }))
    : [{ path: path.resolve(req.cwd), access: req.autonomy === "read-only" ? "read" : "write" }];
  const violations: string[] = [];
  for (const root of roots) {
    const files = roots.length === 1 ? changedFiles : changedFiles.filter((file) => file.startsWith(`${root.targetId}:`)).map((file) => file.slice(file.indexOf(":") + 1));
    let rules = { write: [...req.guards.writeAllow], deny: [...req.guards.writeDeny] };
    if (targets.length > 0 && root.access === "write") {
      if (!req.role) return ["post-run write guard: Target writes require a role"];
      try {
        const contractRoot = req.bindingRoot ?? req.knowledgeRoot ?? req.cwd;
        const owned = targetPathRules(req.role, contractRoot, root.path, req.knowledgeRoot ?? contractRoot);
        rules = { write: owned.write, deny: [...new Set([...owned.deny, ...req.guards.writeDeny])] };
      } catch (error) {
        return [`post-run write guard: cannot resolve Target path rules: ${String(error)}`];
      }
    }
    violations.push(...verifyChangedFilesScope({ role: req.role ?? "executor", roots: [root], changedFiles: files, rules }).violations);
    // A packet may narrow the role's normal Target scope further.
    if (targets.length > 0 && req.guards.writeAllow.length > 0) {
      violations.push(...verifyChangedFilesScope({ role: req.role ?? "executor", roots: [root], changedFiles: files, rules: { write: [...req.guards.writeAllow], deny: [...req.guards.writeDeny] } }).violations);
    }
  }
  if (roots.length > 1) {
    for (const file of changedFiles) {
      if (!roots.some((root) => file.startsWith(`${root.targetId}:`))) violations.push(`post-run write guard: changed file ${file} has no granted root`);
    }
  }
  return [...new Set(violations)];
}
