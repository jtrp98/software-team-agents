import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { SESSION_ROLE_PATH } from "../agents/pathPermissions.js";
import { resolveStackPathRules } from "../profile/projectProfile.js";
import { loadTargetConfig } from "./targetMeta.js";

/**
 * The `session-role` command — the one writer of `.workflow/session-role.json`
 * (SESSION_ROLE_PATH), the declared-session-role channel the guard hooks fall
 * back to when `STA_ROLE` is absent (a desktop role-play session: ZCode, the
 * V12 decision — no CLI launch path, so no orchestrator ever sets the env var).
 *
 * The file is what turns per-role Target/Knowledge write enforcement on for
 * such a session, exactly the layer an orchestrated run gets from its stage
 * identity. Writing it is a person's act — or the AI's, on that person's
 * explicit instruction — always through this command, never a hand-edited
 * file: the command validates the role against the agent registry and
 * pre-resolves the stack half with the same `resolveStackPathRules` call the
 * orchestrated path uses, so a hook never parses YAML and a session can never
 * grant itself a shape the registry does not carry.
 */

export type SessionRoleAction = "set" | "clear" | "show";

export interface SessionRoleDeclaration {
  role: string;
  /** Pre-resolved layout globs, present only when the role's stack declares any. */
  stack?: { write: string[]; deny: string[] };
  /** Real clock time of the `set` — audit only; the hook never reads it. */
  declared_at: string;
}

export interface SessionRoleCommandResult {
  action: SessionRoleAction;
  targetRoot: string;
  /** The declaration after a `set`, or the one found by `show` (null when none). */
  declaration: SessionRoleDeclaration | null;
  /** One human line the CLI prints. */
  message: string;
}

/** The valid roles, in registry order — the same set `sta context` accepts. */
export function knownRoleNames(): string[] {
  return Object.values(AGENT_REGISTRY).map((entry) => entry.role);
}

function requireKnownRole(role: string | undefined): string {
  if (!role) {
    throw new Error(`session-role set: a role is required — use one of: ${knownRoleNames().join(", ")}`);
  }
  const known = knownRoleNames().some((candidate) => candidate === role);
  if (!known) {
    throw new Error(`session-role set: unknown agent role "${role}" — use one of: ${knownRoleNames().join(", ")}`);
  }
  return role;
}

/** The declaration a hook accepts, or null when the file is absent/unreadable/off-shape (the hook treats all three as "no declared role"). */
export function readSessionRoleDeclaration(targetRoot: string): SessionRoleDeclaration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(targetRoot, ...SESSION_ROLE_PATH.split("/")), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.role !== "string" || !/^[a-z][a-z0-9-]*$/.test(candidate.role)) return null;
  const declaration: SessionRoleDeclaration = { role: candidate.role, declared_at: typeof candidate.declared_at === "string" ? candidate.declared_at : "" };
  if (candidate.stack && typeof candidate.stack === "object" && !Array.isArray(candidate.stack)) {
    const stack = candidate.stack as Record<string, unknown>;
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []);
    declaration.stack = { write: list(stack.write), deny: list(stack.deny) };
  }
  return declaration;
}

export function runSessionRoleCommand(options: {
  targetRoot: string;
  action: SessionRoleAction;
  role?: string;
  now?: string;
}): SessionRoleCommandResult {
  const file = path.join(options.targetRoot, ...SESSION_ROLE_PATH.split("/"));

  if (options.action === "clear") {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      return { action: "clear", targetRoot: options.targetRoot, declaration: null, message: `session role cleared — removed ${SESSION_ROLE_PATH}; the session is anonymous again (universal floor only)` };
    }
    return { action: "clear", targetRoot: options.targetRoot, declaration: null, message: `no ${SESSION_ROLE_PATH} in this workspace — nothing to clear` };
  }

  if (options.action === "show") {
    const declaration = readSessionRoleDeclaration(options.targetRoot);
    if (!declaration) {
      return { action: "show", targetRoot: options.targetRoot, declaration: null, message: `no session role declared (${SESSION_ROLE_PATH} absent or unreadable) — the session is anonymous: guards enforce the universal floor only` };
    }
    const stack = declaration.stack ? ` (stack: ${declaration.stack.write.length} write, ${declaration.stack.deny.length} deny globs)` : "";
    return { action: "show", targetRoot: options.targetRoot, declaration, message: `declared session role: \`${declaration.role}\`${stack} — per-role contract enforcement applies to this session` };
  }

  const role = requireKnownRole(options.role);
  // The same resolution the orchestrated path hands over on
  // STA_STACK_PATH_RULES — a hook parses no YAML, so the CLI joins the recorded
  // profile to stacks/<profile>/stack.yaml here. Empty for a role no stack
  // scopes (analysis roles): the key is omitted, and over-restriction never
  // happens because there is nothing to over-restrict.
  const config = loadTargetConfig(options.targetRoot);
  const layout = resolveStackPathRules({
    role,
    projectRoot: options.targetRoot,
    profile: config?.stack?.profile,
    sourceRoots: config?.stack?.source_roots,
  });
  const declaration: SessionRoleDeclaration = { role, declared_at: options.now ?? new Date().toISOString() };
  if (layout.write.length > 0 || layout.deny.length > 0) {
    declaration.stack = { write: [...layout.write], deny: [...layout.deny] };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(declaration, null, 2)}\n`, "utf8");
  const stack = declaration.stack ? ` (stack: ${declaration.stack.write.length} write, ${declaration.stack.deny.length} deny globs)` : "";
  return {
    action: "set",
    targetRoot: options.targetRoot,
    declaration,
    message: `session role declared: \`${role}\`${stack} — this session's writes are bounded by \`${role}\`'s contract (clear with \`session-role clear\`)`,
  };
}
