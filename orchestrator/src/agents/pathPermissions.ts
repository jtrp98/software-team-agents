import * as fs from "node:fs";
import * as path from "node:path";
import { STACK_SCOPED_ROLES, resolveStackPathRules } from "../profile/projectProfile.js";
import { loadTargetConfig } from "../targetcli/targetMeta.js";
import { AgentStage } from "../types.js";
import { defaultProjectRoot, loadAgentContract } from "./agentContract.js";

/**
 * Which paths each agent may write.
 *
 * `permissions.capabilities` already said *what kind* of thing a role may do —
 * write code, write docs, deploy. It could not say *where*, so "backend-engineer
 * may write code" and "backend-engineer may rewrite design.md" were the same
 * permission. The pipeline's whole ownership model is about where: each agent
 * owns exactly one artifact, and an engineer that edits a contract has changed
 * the rule it was supposed to implement.
 *
 * THREE LAYERS, BECAUSE ONE IS NOT AVAILABLE
 *
 * The obvious enforcement point is a `PreToolUse` hook, and it is the one place
 * this cannot fully work: hooks carry no subagent identity — `block-doc-rewrite.js`
 * and `require-green-before-stop.js` both say so — so a hook alone cannot tell
 * which agent is about to write. So enforcement is layered:
 *
 *   1. Declared in `contracts/<agent>.yaml`, next to everything else about the role.
 *   2. Enforced here, by the orchestrator, which does know which agent it invoked.
 *   3. Enforced by `.claude/hooks/block-path-permissions.js`, which reads the role
 *      from an environment variable the orchestrator sets on the child process, and
 *      falls back to a universal floor when it is absent (an interactive session).
 *
 * A desktop role-play session (ZCode, the V12 decision) has neither an orchestrator
 * nor a launch path to set that env var, so it has a second, explicit identity
 * channel: `SESSION_ROLE_PATH`, written only by the workspace CLI's `session-role`
 * verb. The env var wins whenever it exists; the declaration is read only when it
 * does not. Either way the per-role layer applies, and with neither the hook keeps
 * the floor-only posture it has always had.
 *
 * The floor matters: without identity the hook still blocks what no agent may
 * ever write. A partial guard that is honest about its limits beats a complete
 * one that only works when someone remembers to set an env var.
 */

/** Paths no agent may write, whatever its contract says. Enforced with or without identity. */
export const UNIVERSAL_DENY: string[] = [
  ".git/**",
  "node_modules/**",
  // Runtime state belongs to the orchestrator. An agent editing it would be
  // rewriting the record of what it is allowed to do next.
  ".workflow/**",
  "dist/**",
  // A role workspace records that a *person* in a lane acknowledged a
  // change. An agent that could write one could mark its own work seen on that
  // person's behalf, which is the one thing V1.5's whole design forbids. So it
  // is denied at the floor rather than per contract: no agent, no mode, no
  // exception. The writer is a person, through the CLI.
  "knowledge/_roles/**",
];

/** Analysis artifacts and registry files whose home is the Knowledge repo, never a Target workspace. Engineer-owned docs (qa/security/deploy) stay writable here. */
export const WORKSPACE_BA_ARTIFACTS: readonly string[] = [
  "_docs/module/*/requirement.md",
  "_docs/module/*/design.md",
  "_docs/module/*/design-archive.md",
  "_docs/module/*/test-plan.md",
  "_docs/module/*/plan.md",
  "_docs/module/*/uxui/**",
  "_docs/status.md",
  "knowledge/**",
  "decisions/**",
  "targets.yaml",
  "knowledge-policy.yaml",
];

/**
 * Framework payload: the files `sta sync` materialises and a person edits, that
 * no agent contract grants. It used to be denied only in a `role: ba`
 * workspace, which stopped meaning anything once one workspace carried both
 * this and `_docs/**` (V10 TASK-021) — so it is denied per stage now, to every
 * stage, rather than per repository.
 */
export const FRAMEWORK_PAYLOAD_ARTIFACTS: readonly string[] = [
  "contracts/**",
  "workflows/**",
  "stacks/**",
  "layout.yaml",
  "test-pyramid.yaml",
  "escalation-policy.yaml",
];

/**
 * Stages whose write scope is a Target checkout and which may therefore never
 * write a Knowledge artifact, whatever workspace the invocation was launched
 * from (V10 confirmations 7 and 15). The analysis roles are absent on purpose:
 * BA/SA/PM/test-planner/uxui/QA own artifacts in `WORKSPACE_BA_ARTIFACTS`, and
 * a ban that reached them would put the pipeline at odds with itself.
 */
export const KNOWLEDGE_DENIED_ROLES: readonly string[] = [
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.DEVOPS,
];

/** Whether this stage carries the Knowledge deny unconditionally, rather than through a workspace role. */
export function deniesKnowledgeArtifacts(agent: AgentStage | string): boolean {
  return KNOWLEDGE_DENIED_ROLES.includes(String(agent));
}

/** The why-text for a framework-payload deny. Names no command: the rule is about who is writing, not which checkout they are in. */
export function frameworkPayloadDenyWhy(pattern: string): string {
  return (
    `\`${pattern}\` is Framework payload — \`sta sync\` materialises it and a person edits it. ` +
    "No agent contract grants it, so no stage may write it; change it in the Framework repository and sync."
  );
}

/**
 * Glob matching for the small subset these rules use: `*` within a path segment,
 * `**` across segments. Written out rather than pulled in as a dependency because
 * the hook has to apply the identical rule with no dependencies at all, and two
 * implementations of "does this path match" is exactly the kind of thing that
 * drifts silently until a guard stops guarding.
 */
export function matchesGlob(pattern: string, target: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const regex = globToRegExp(normalize(pattern));
  return regex.test(normalize(target));
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "/" && pattern.slice(i) === "/**") {
      // A trailing `/**` covers the directory itself as well as everything under
      // it. Without this, `prisma/**` misses `prisma` — a rule about a directory
      // that does not match the directory.
      out += "(?:/.*)?";
      break;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` spans segments; `**/` also matches zero segments, so `a/**` matches `a` itself.
        const slashAfter = pattern[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/* ------------------------------------------------------------------------- *
 * ONE AUTHORED DECLARATION, GENERATED COPIES
 *
 * The lists above, the role reader, the deny explanation and the matcher used
 * to exist in four hand-maintained copies — here, the two hooks, and the
 * `.codex/hooks` byte-mirror — held in agreement by comments containing the
 * word "Mirrors". That is a hope, not a mechanism, and they had already
 * diverged.
 *
 * Each hook now carries a delimited block rendered by `renderGuardRuleBlock()`,
 * written by `scripts/regenerate-renderings.mjs`, byte-verified by
 * `checkBindings()`. The `.codex/hooks` mirror needs no rendering of its own —
 * byte-identity with its `.claude/hooks` source is required. The block takes
 * no dependency and parses under both a CommonJS and an
 * ESM host; what the hosts genuinely differ about (how `fs`/`path` arrive,
 * which tool names carry a path, how a denial reaches the model) stays
 * authored in each hook.
 *
 * `matchesGlob` therefore exists twice: as TypeScript above, as generated
 * JavaScript below. That is the one duplication a generator cannot remove, so
 * it is the one under test — `pathPermissions.test.ts` executes the rendered
 * block and differential-tests it against the TypeScript.
 * ------------------------------------------------------------------------- */

/**
 * The channel that carries an engineer's stack layout globs to a
 * guard hook, as JSON `{write, deny}`.
 *
 * A hook cannot resolve them itself: they come from the Target's recorded
 * `stack.profile` in `.agent-team/config.yaml` joined with
 * `stacks/<profile>/stack.yaml`, and hooks here take no YAML parser by
 * agreement. So the orchestrator — which already resolves them, and is the only
 * layer that knows which agent it invoked — hands them over beside
 * `STA_ROLE`, exactly as `STA_WRITABLE_WORK_ROOTS` hands over
 * the canonical write roots preflight resolved.
 *
 * Absent or malformed, both halves drop out together: the layout paths leave
 * the write list *and* the deny list, so an uncovered path lands on
 * deny-by-default rather than slipping through. The failure mode is stricter
 * than intended, never looser.
 */
export const GUARD_STACK_RULES_ENV = "STA_STACK_PATH_RULES";

/**
 * The one file a desktop role-play session (ZCode — V12's interactive runtime)
 * declares its played role through: `{ role: string, stack?: { write: string[],
 * deny: string[] } }`, written only by the workspace CLI's `session-role` verb.
 *
 * The path sits under `.workflow/`, which `UNIVERSAL_DENY` already refuses to
 * every agent's file tools, so a session cannot rewrite its own declaration
 * mid-session — the CLI (a person, or the AI on that person's explicit
 * instruction) is the only writer. The hook reads it only when `STA_ROLE` is
 * absent, so an orchestrated run behaves byte-for-byte as before, and a session
 * without a declaration keeps the floor-only posture it has always had.
 *
 * The `stack` half carries the same resolved layout globs the orchestrated path
 * hands over on `STA_STACK_PATH_RULES`, pre-resolved by the same
 * `resolveStackPathRules` call — a hook still parses no YAML, so the CLI joins
 * `.agent-team/config.yaml` to `stacks/<profile>/stack.yaml` on the session's
 * behalf. Absent or unresolved means the globs drop out of both lists, which
 * over-restricts an engineer role rather than letting a layout path through.
 */
export const SESSION_ROLE_PATH = ".workflow/session-role.json";

/**
 * Full Target access map for a single invocation. This is identification data
 * for guard refusal messages, not a grant: only
 * `STA_WRITABLE_WORK_ROOTS` can open a write root.
 */
export const GUARD_TARGET_WORK_ROOTS_ENV = "STA_TARGET_WORK_ROOTS";

export interface GuardTargetWorkRoot {
  readonly targetId: string;
  readonly path: string;
  readonly access: "read" | "write";
}

/** Canonical, minimal guard payload; callers must pass the preflight result unchanged. */
export function serializeGuardTargetWorkRoots(roots: readonly GuardTargetWorkRoot[]): string {
  return JSON.stringify(roots.map((root) => ({
    targetId: root.targetId,
    path: path.resolve(root.path),
    access: root.access,
  })));
}

/** Marker pair delimiting the generated block inside each hook. Whole lines, like every other Framework block. */
export const GUARD_RULES_OPEN = "// sta:guard-rules-start";
export const GUARD_RULES_CLOSE = "// sta:guard-rules-end";

export interface GuardRuleHost {
  /** Repo-relative path, posix separators. */
  path: string;
  /** The runtime whose materialisation decides whether this host exists in a workspace at all. */
  runtime: "claude" | "opencode" | "antigravity";
}

/** Every file that carries the generated block. `.codex/hooks/*` is absent on purpose: it is a byte-mirror, already checked as one. */
export const GUARD_RULE_HOSTS: readonly GuardRuleHost[] = [
  { path: ".claude/hooks/block-path-permissions.js", runtime: "claude" },
  { path: ".opencode/plugin/sta-guards.js", runtime: "opencode" },
  { path: ".agents/hooks/sta-guard.js", runtime: "antigravity" },
];

/**
 * The host-agnostic half of the guard, as JavaScript source. Authored once,
 * here, next to the rules it applies — not in three hook files.
 */
const GUARD_RULE_FUNCTION_SOURCE: readonly string[] = [
  `const SESSION_ROLE_REL_PATH = ${jsRuleLiteral(SESSION_ROLE_PATH)};`,
  "function frameworkPayloadDenial(relative, role) {",
  "  // Bound to the stage, not to the checkout: one workspace carries both the",
  "  // Framework payload and the Knowledge documents, so where a write lands",
  "  // says nothing about whether it is allowed. The role arrives resolved:",
  "  // the env identity when the orchestrator spawned this process, otherwise",
  "  // a desktop role-play session's declared file.",
  "  if (!role) return null;",
  "  for (const pattern of FRAMEWORK_PAYLOAD_ARTIFACTS) {",
  "    if (matchesGlob(pattern, relative)) return frameworkPayloadDenyWhy(pattern);",
  "  }",
  "  return null;",
  "}",
  "function frameworkPayloadDenyWhy(pattern) {",
  "  return '`' + pattern + '` is Framework payload — `sta sync` materialises it and a person edits it. No agent contract grants it, so no stage may write it; change it in the Framework repository and sync.';",
  "}",
  "function sessionRoleFromText(text) {",
  "  // The declared-session-role channel: a desktop role-play session has no",
  "  // STA_ROLE env (no launch path sets one), so the role it is playing arrives",
  "  // as this CLI-written file instead. The path sits under .workflow/, which",
  "  // UNIVERSAL_DENY refuses to every agent's file tools, so a session cannot",
  "  // rewrite its own declaration. Anything absent, unreadable or off-shape is",
  "  // 'no declared role' — the floor-only posture, never an error.",
  "  if (typeof text !== 'string' || text === '') return null;",
  "  let parsed;",
  "  try { parsed = JSON.parse(text); } catch { return null; }",
  "  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;",
  "  if (typeof parsed.role !== 'string' || !/^[a-z][a-z0-9-]*$/.test(parsed.role)) return null;",
  "  return parsed.role;",
  "}",
  "function declaredStackRulesFromText(text) {",
  "  // The stack half of the declaration, the same {write, deny} shape the",
  "  // STA_STACK_PATH_RULES channel carries, pre-resolved by the same CLI call",
  "  // the orchestrator uses. Malformed drops out empty, which over-restricts an",
  "  // engineer role rather than letting a layout path through.",
  "  if (typeof text !== 'string' || text === '') return { write: [], deny: [] };",
  "  let parsed;",
  "  try { parsed = JSON.parse(text); } catch { return { write: [], deny: [] }; }",
  "  const stack = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.stack : null;",
  "  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);",
  "  return { write: list(stack && stack.write), deny: list(stack && stack.deny) };",
  "}",
  "function sessionRole(envRole, declaredText) {",
  "  // Orchestrated identity wins outright: a stage the runtime spawned is",
  "  // exactly who the env says. Only a process without one falls to the",
  "  // declared file, and with neither this returns null — the floor-only",
  "  // posture every host keeps for an anonymous session.",
  "  if (envRole) return envRole;",
  "  return sessionRoleFromText(declaredText);",
  "}",
  "function stackPathRules(declaredText) {",
  "  let parsed;",
  "  try { parsed = JSON.parse(process.env.STA_STACK_PATH_RULES || '{}'); } catch { parsed = {}; }",
  "  const declared = declaredStackRulesFromText(declaredText);",
  "  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);",
  "  return { write: list(parsed && parsed.write).concat(declared.write), deny: list(parsed && parsed.deny).concat(declared.deny) };",
  "}",
  "function boundReadOnlyTarget(nodePath, target) {",
  `  let roots; try { roots = JSON.parse(process.env.${GUARD_TARGET_WORK_ROOTS_ENV} || '[]'); } catch { return null; }`,
  "  if (!Array.isArray(roots)) return null;",
  "  const absolute = nodePath.resolve(target);",
  "  for (const candidate of roots) {",
  "    if (!candidate || typeof candidate !== 'object' || typeof candidate.targetId !== 'string' || typeof candidate.path !== 'string' || candidate.access !== 'read' || !nodePath.isAbsolute(candidate.path)) continue;",
  "    const root = nodePath.resolve(candidate.path);",
  "    const relative = nodePath.relative(root, absolute);",
  "    if (relative === '' || (!relative.startsWith('..' + nodePath.sep) && relative !== '..' && !nodePath.isAbsolute(relative))) return candidate.targetId;",
  "  }",
  "  return null;",
  "}",
  "function boundReadOnlyWhy(targetId, role) {",
  "  return 'Blocked: Target \"' + targetId + '\" is bound read-only for this ' + (role || 'current role') + ' invocation; writing to it is refused.';",
  "}",
  "function knowledgeArtifactDenial(nodePath, target, role) {",
  "  // The Knowledge root can sit inside a granted work root, so this runs off",
  "  // the root the runtime named rather than off the workspace-relative path.",
  "  if (!role || !KNOWLEDGE_DENIED_ROLES.includes(role)) return null;",
  "  const kb = process.env.STA_KNOWLEDGE_ROOT;",
  "  // STA_KNOWLEDGE_ROOT_NAME is the managed-session marker: a launcher that",
  "  // resolved one named root sets it beside STA_KNOWLEDGE_ROOT, never half.",
  "  // A managed invocation missing the path cannot attribute its writes to any",
  "  // Knowledge root, so it denies before any permission decision; the hook",
  "  // resolves no default and reads no installation config (TOCTOU — the",
  "  // frozen selection must win). Unbound shells keep the legacy fail-open so",
  "  // single-repo mode is unchanged.",
  "  if (!kb) {",
  "    const rootName = process.env.STA_KNOWLEDGE_ROOT_NAME;",
  "    if (rootName) return { rel: target, why: knowledgeSelectionIncompleteWhy(rootName) };",
  "    return null;",
  "  }",
  "  const rel = nodePath.relative(nodePath.resolve(kb), nodePath.resolve(target)).replace(/\\\\/g, '/');",
  "  if (rel === '' || rel.startsWith('../') || nodePath.isAbsolute(rel)) return null;",
  "  for (const pattern of WORKSPACE_BA_ARTIFACTS) {",
  "    if (matchesGlob(pattern, rel)) return { rel: rel, why: knowledgeDenyWhy(role, pattern, kb) };",
  "  }",
  "  return null;",
  "}",
  "function knowledgeSelectionIncompleteWhy(rootName) {",
  "  return 'Not a role-boundary refusal: this session was launched as a managed Knowledge session (root name `' + rootName + '`) but its launch contract is incomplete — `STA_KNOWLEDGE_ROOT` is missing, so the guard cannot tell which Knowledge root this write belongs to and refuses before evaluating any permission (one session = one root). Relaunch through the launcher so the selection arrives whole.';",
  "}",
  "function knowledgeDenyWhy(role, pattern, knowledgeRoot) {",
  "  return '`' + role + '` implements what the Knowledge repository (`' + knowledgeRoot + '`) already decided, so it may not write `' + pattern + '` there — that artifact is written by the role that owns it, never by an implementation stage.';",
  "}",
  "function matchesGlob(pattern, target) {",
  "  const clean = (p) => p.replace(/\\\\/g, '/').replace(/^\\.\\//, '').replace(/^\\/+/, '');",
  "  const pat = clean(pattern);",
  "  let out = '';",
  "  for (let i = 0; i < pat.length; i++) {",
  "    const c = pat[i];",
  "    if (c === '/' && pat.slice(i) === '/**') { out += '(?:/.*)?'; break; }",
  "    if (c !== '*') { out += '\\\\^$+?.()|{}[]'.includes(c) ? '\\\\' + c : c; continue; }",
  "    if (pat[i + 1] !== '*') { out += '[^/]*'; continue; }",
  "    const slashAfter = pat[i + 2] === '/';",
  "    out += slashAfter ? '(?:.*/)?' : '.*';",
  "    i += slashAfter ? 2 : 1;",
  "  }",
  "  return new RegExp('^' + out + '$').test(clean(target));",
  "}",
];

/** A rule that cannot be written as a single-quoted JavaScript literal would generate a broken guard, so it is refused here rather than shipped. */
function jsRuleLiteral(value: string): string {
  if (/['\\\r\n]/.test(value)) {
    throw new Error(`guard rule "${value}" contains a quote, backslash or newline and cannot be rendered into a hook`);
  }
  return `'${value}'`;
}

/** The exact bytes each hook's `sta:guard-rules` block must contain, trailing newline included. */
export function renderGuardRuleBlock(): string {
  const list = (name: string, values: readonly string[]) => `const ${name} = [${values.map(jsRuleLiteral).join(", ")}];`;
  return [
    GUARD_RULES_OPEN,
    "// GENERATED from orchestrator/src/agents/pathPermissions.ts (T-V5-020) — the one authored",
    "// declaration of this framework's guard rule data. `sta --check-bindings` fails on a hand edit;",
    "// `node scripts/regenerate-renderings.mjs` rewrites it. No require, no import: CJS and ESM both.",
    list("UNIVERSAL_DENY", UNIVERSAL_DENY),
    list("WORKSPACE_BA_ARTIFACTS", WORKSPACE_BA_ARTIFACTS),
    list("FRAMEWORK_PAYLOAD_ARTIFACTS", FRAMEWORK_PAYLOAD_ARTIFACTS),
    list("KNOWLEDGE_DENIED_ROLES", KNOWLEDGE_DENIED_ROLES),
    ...GUARD_RULE_FUNCTION_SOURCE,
    GUARD_RULES_CLOSE,
    "",
  ].join("\n");
}

export interface PathRules {
  write: string[];
  deny: string[];
  /**
   * What this role's run needs to read.
   *
   * Deliberately not enforced as a block, unlike write/deny. Reading is
   * non-destructive, and a read guard that got one path wrong would trap an
   * agent mid-run in exchange for no safety at all — the pipeline's rule is
   * that a guard must never trap an agent. What this is for is assembly and
   * checking: it tells the orchestrator what to put in front of a role, and
   * `checkPathRules` holds it to the one rule that has teeth.
   */
  read: string[];
}

/** Exactly what `contracts/<agent>.yaml` declares — no stack layout merged in. What `--check-contracts` holds to the role-shaped rule. */
export function contractPathRules(agent: AgentStage | string, projectRoot: string = defaultProjectRoot()): PathRules {
  const contract = loadAgentContract(agent, projectRoot);
  return {
    write: contract.permissions.write,
    deny: contract.permissions.deny,
    read: contract.permissions.read,
  };
}

/**
 * The rules actually applied to a run: the contract's role boundary plus the
 * layout globs of the stack this workspace recorded.
 *
 * The contract can no longer say `server/**` or `prisma/**` — those describe a
 * Node/Prisma repository, not a backend engineer — so the stack half comes from
 * `stacks/<profile>/stack.yaml`, keyed by the profile in
 * `.agent-team/config.yaml` and expanded over its recorded `source_roots`. A
 * workspace that recorded no stack resolves the Node/frontend profiles, which
 * carry the exact globs the contracts used to hold, so nothing that is writable
 * today stops being writable.
 */
export function pathRulesFor(agent: AgentStage | string, projectRoot: string = defaultProjectRoot(), layoutRoot: string = projectRoot): PathRules {
  const contract = contractPathRules(agent, projectRoot);
  const stack = loadTargetConfig(layoutRoot)?.stack;
  const layout = resolveStackPathRules({
    role: String(agent),
    projectRoot: layoutRoot,
    profile: stack?.profile,
    sourceRoots: stack?.source_roots,
  });
  const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return {
    write: merge(contract.write, layout.write),
    deny: merge(contract.deny, layout.deny),
    read: merge(contract.read, layout.read),
  };
}

/** A Target binding grants a root, while the contract and that Target's stack
 * layout grant paths inside it. New paths are denied until scoped explicitly. */
export function targetPathRules(
  agent: AgentStage | string,
  projectRoot: string = defaultProjectRoot(),
  targetRoot: string = projectRoot,
): PathRules {
  const contract = pathRulesFor(agent, projectRoot, targetRoot);
  return {
    write: contract.write.filter((glob) => glob !== "**"),
    deny: [...new Set([...WORKSPACE_BA_ARTIFACTS, ...contract.deny])],
    read: contract.read,
  };
}

export type WriteDecision =
  | { allowed: true }
  | { allowed: false; reason: string; rule: "universal-deny" | "framework-deny" | "agent-deny" | "not-allowed" };

/**
 * Decides whether an agent may write a repo-relative path.
 *
 * Order is deliberate and not interchangeable: universal denies outrank
 * everything, the Framework payload is off limits to every stage, an agent's
 * own deny outranks its allow, and anything the allow list does not cover is
 * refused. Allow-by-default would mean a new directory is writable by every
 * agent the moment it appears, which is the opposite of an ownership model.
 */
export function canWritePath(rules: PathRules, relPath: string): WriteDecision {
  for (const pattern of UNIVERSAL_DENY) {
    if (matchesGlob(pattern, relPath)) {
      return { allowed: false, rule: "universal-deny", reason: `no agent may write ${pattern}` };
    }
  }
  for (const pattern of FRAMEWORK_PAYLOAD_ARTIFACTS) {
    if (matchesGlob(pattern, relPath)) {
      return { allowed: false, rule: "framework-deny", reason: frameworkPayloadDenyWhy(pattern) };
    }
  }
  for (const pattern of rules.deny) {
    if (matchesGlob(pattern, relPath)) {
      return { allowed: false, rule: "agent-deny", reason: `this role's contract denies ${pattern}` };
    }
  }
  if (rules.write.some((pattern) => matchesGlob(pattern, relPath))) return { allowed: true };

  return {
    allowed: false,
    rule: "not-allowed",
    reason:
      rules.write.length === 0
        ? "this role's contract grants no write paths at all"
        : `not covered by this role's write paths (${rules.write.join(", ")})`,
  };
}

export class PathDeniedError extends Error {
  constructor(
    public readonly agent: AgentStage | string,
    public readonly relPath: string,
    public readonly decision: Extract<WriteDecision, { allowed: false }>,
  ) {
    super(`${agent} may not write ${relPath}: ${decision.reason}`);
    this.name = "PathDeniedError";
  }
}

/** The orchestrator's enforcement point — it knows which agent it invoked, so identity is not in question here. */
export function assertCanWrite(
  agent: AgentStage | string,
  relPath: string,
  projectRoot: string = defaultProjectRoot(),
): void {
  const decision = canWritePath(pathRulesFor(agent, projectRoot), relPath);
  if (!decision.allowed) throw new PathDeniedError(agent, relPath, decision);
}

/** Repo-relative form of an absolute path, or null when it falls outside the repo entirely. */
export function toRepoRelative(absPath: string, projectRoot: string = defaultProjectRoot()): string | null {
  const rel = path.relative(projectRoot, absPath).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("../")) return null;
  return rel;
}

export interface PathRulesCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * The surface a *role* contract may name. Everything here is part of
 * this pipeline's own vocabulary: documents, policies, contracts, registries.
 * Anything else in an engineer contract describes a repository's layout, which
 * belongs to `stacks/<profile>/stack.yaml` — so the check is "is this glob part
 * of the pipeline?" rather than a list of the specific globs V5 moved, which a
 * new `src/**` would walk straight past.
 */
const ROLE_SHAPED_PREFIXES: readonly string[] = [
  "_docs/",
  ".claude/",
  ".codex/",
  ".opencode/",
  ".agents/",
  ".agent-team/",
  "policies/",
  "contracts/",
  "workflows/",
  "stacks/",
  "knowledge/",
  "decisions/",
  "orchestrator/",
];

const ROLE_SHAPED_FILES: readonly string[] = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "layout.yaml",
  "targets.yaml",
  "knowledge-policy.yaml",
  "test-pyramid.yaml",
  "escalation-policy.yaml",
  "model-tiers.yaml",
  "project.yaml",
];

function isRoleShapedGlob(glob: string): boolean {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  return ROLE_SHAPED_FILES.includes(normalized) || ROLE_SHAPED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * The engineer contracts must express a boundary, not a layout. Reported per
 * glob with the profile file that should hold it, so the fix is obvious rather
 * than a hunt.
 */
function checkContractsAreRoleShaped(projectRoot: string, problems: string[]): void {
  for (const role of STACK_SCOPED_ROLES) {
    let rules: PathRules;
    try {
      rules = contractPathRules(role, projectRoot);
    } catch {
      continue; // a missing/invalid contract is already reported by the contract pass
    }
    for (const [field, globs] of [
      ["read", rules.read],
      ["write", rules.write],
      ["deny", rules.deny],
    ] as const) {
      for (const glob of globs) {
        if (isRoleShapedGlob(glob)) continue;
        problems.push(
          `${role}: permissions.${field} declares "${glob}", which describes a repository layout rather than a role boundary — ` +
            `move it to stacks/<profile>/stack.yaml permissions.${role} (T-V5-023)`,
        );
      }
    }
  }
}

/**
 * Sanity-checks the declared rules themselves. A permission model with a rule
 * that can never match is not a stricter model — it is a role that silently
 * cannot do its job, which surfaces as a confusing block much later.
 */
export function checkPathRules(projectRoot: string = defaultProjectRoot()): PathRulesCheckResult {
  const problems: string[] = [];
  const agents = Object.values(AgentStage).filter((a) => a !== AgentStage.HUMAN);

  checkContractsAreRoleShaped(projectRoot, problems);

  for (const agent of agents) {
    let rules: PathRules;
    try {
      rules = pathRulesFor(agent, projectRoot);
    } catch (e) {
      problems.push(`${agent}: ${(e as Error).message}`);
      continue;
    }

    if (rules.write.length === 0) {
      problems.push(`${agent} declares no write paths — every write it attempts would be refused`);
    }
    if (rules.read.length === 0) {
      problems.push(`${agent} declares no read paths — nothing would be assembled for its run`);
    }

    // A document you cannot open is a document you cannot amend, and every doc in
    // this pipeline is amended rather than regenerated (`policies/documentation.md` §4). A role
    // allowed to write something it cannot read is a rule that contradicts itself.
    for (const target of rules.write) {
      const readable = rules.read.some((pattern) => matchesGlob(pattern, target) || pattern === target);
      if (!readable) {
        problems.push(
          `${agent}: may write "${target}" but no read path covers it — ` +
            "documents here are amended, not regenerated, so writing without reading cannot work",
        );
      }
    }

    // A write pattern fully shadowed by a deny is dead: it can never permit anything.
    for (const allow of rules.write) {
      const shadow = [...UNIVERSAL_DENY, ...rules.deny].find((deny) => matchesGlob(deny, allow) || deny === allow);
      if (shadow) {
        problems.push(`${agent}: write "${allow}" can never apply — "${shadow}" denies everything it would match`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
