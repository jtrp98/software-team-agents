import * as path from "node:path";
import { AgentStage } from "../types.js";
import { defaultProjectRoot, loadAgentContract } from "./agentContract.js";

/**
 * Which paths each agent may write (T15).
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
  // A role workspace (T99) records that a *person* in a lane acknowledged a
  // change. An agent that could write one could mark its own work seen on that
  // person's behalf, which is the one thing V1.5's whole design forbids. So it
  // is denied at the floor rather than per contract: no agent, no mode, no
  // exception. The writer is a person, through the CLI.
  "knowledge/_roles/**",
];

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

export function pathRulesFor(agent: AgentStage | string, projectRoot: string = defaultProjectRoot()): PathRules {
  const contract = loadAgentContract(agent, projectRoot);
  return {
    write: contract.permissions.write,
    deny: contract.permissions.deny,
    read: contract.permissions.read,
  };
}

export type WriteDecision =
  | { allowed: true }
  | { allowed: false; reason: string; rule: "universal-deny" | "agent-deny" | "not-allowed" };

/**
 * Decides whether an agent may write a repo-relative path.
 *
 * Order is deliberate and not interchangeable: universal denies outrank
 * everything, an agent's own deny outranks its allow, and anything the allow
 * list does not cover is refused. Allow-by-default would mean a new directory
 * is writable by every agent the moment it appears, which is the opposite of an
 * ownership model.
 */
export function canWritePath(rules: PathRules, relPath: string): WriteDecision {
  for (const pattern of UNIVERSAL_DENY) {
    if (matchesGlob(pattern, relPath)) {
      return { allowed: false, rule: "universal-deny", reason: `no agent may write ${pattern}` };
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
 * Sanity-checks the declared rules themselves. A permission model with a rule
 * that can never match is not a stricter model — it is a role that silently
 * cannot do its job, which surfaces as a confusing block much later.
 */
export function checkPathRules(projectRoot: string = defaultProjectRoot()): PathRulesCheckResult {
  const problems: string[] = [];
  const agents = Object.values(AgentStage).filter((a) => a !== AgentStage.HUMAN);

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
