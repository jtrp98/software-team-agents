/*
 * sta-guards.js — the OpenCode half of this framework's tool-call guards
 * (planning/v2 T-OC6). Generated into every workspace by `sta init`/`sync`
 * and auto-loaded by OpenCode from `.opencode/plugin/` — no config wiring
 * needed (verified on the T-OC0 spike, OpenCode 1.18.21).
 *
 * WHAT ENFORCES WHAT ON THIS RUNTIME
 *
 *   git state-changing commands  → declarative `permission.bash` globs inside
 *                                  each `.opencode/agent/<role>.md` binding
 *                                  (specificity wins — spike Q1). NOT here.
 *   writes outside the workspace → HERE (tool.execute.before)
 *   contract path ownership      → HERE (`contracts/<role>.yaml`, same flow-
 *                                  style reader as block-path-permissions.js)
 *   universal deny floor         → HERE (.git/, node_modules/, .workflow/,
 *                                  dist/, knowledge/_roles/)
 *   doc-rewrite / secret-leak / exit checks
 *                                → NOT enforced on OpenCode v1. The adapter
 *                                  reports them via RuntimeGuardReport
 *                                  .unenforced so T111 covers them post-hoc;
 *                                  porting them is roadmap, not a silent gap.
 *
 * WHY THE DEFAULT POSTURE MATTERS
 *
 * OpenCode's headless default is allow-all (spike §7) — fail-open. This
 * plugin plus the bindings' permission blocks are what make a run guarded at
 * all; if this file goes missing, `sta status` reports OpenCode NOT READY and
 * the adapter downgrades its guard report instead of pretending.
 *
 * IDENTITY AND ENVIRONMENT
 *
 * Same channel as the Claude-side hooks: `AGENTCLAUDE_ROLE` (set by the
 * orchestrator per stage) selects whose contract applies; without it only the
 * universal floor holds — an interactive run has no role to check against.
 * `AGENTCLAUDE_WRITABLE_WORK_ROOTS` (JSON array of absolute paths) grants the
 * canonical Target roots in three-repo mode; invalid input grants nothing.
 *
 * FAILURE CONTRACT — identical to every hook in `.claude/hooks/`
 *
 * Anything this plugin cannot parse or resolve is ALLOWED through: a guard
 * that fails closed on malformed input breaks unrelated work. Denial happens
 * by throwing from `tool.execute.before` (verified: the throw reaches the
 * model as a named error while the run itself continues).
 */

const fs = import("node:fs");
const path = import("node:path");

/** Tools that take a destination path. Bash stays out of scope here exactly as it does in block-outside-repo.js. */
const PATH_TOOLS = new Set(["write", "edit", "multiedit", "patch", "notebookedit"]);

/** Keys known to carry a destination path across opencode tool versions/shapes. */
const PATH_ARG_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"];

/** Paths no agent may write, whatever its contract says. Mirrors UNIVERSAL_DENY in pathPermissions.ts and block-path-permissions.js. */
const UNIVERSAL_DENY = [".git/**", "node_modules/**", ".workflow/**", "dist/**", "knowledge/_roles/**"];

/** T-UX13/T-WG3: analysis artifacts and registry files whose home is the Knowledge repo, never a Target workspace. Mirrors WORKSPACE_BA_ARTIFACTS in block-path-permissions.js. Engineer-owned docs (review/security/deploy) stay writable here. */
const WORKSPACE_BA_ARTIFACTS = [
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

/** T-WG3 mirror image: engineer/pipeline payload that belongs to a Target checkout, never a BA workspace. */
const WORKSPACE_DEV_ARTIFACTS = ["contracts/**", "workflows/**", "stacks/**", "layout.yaml", "test-pyramid.yaml", "escalation-policy.yaml"];

/** Reads `role:` out of .agent-team/config.yaml (written by `software-team-agents init`). Null when absent/unreadable — the rule then stays inactive, like any legacy workspace. */
function readWorkspaceRole(nodeFs, nodePath, workspaceRoot) {
  let text;
  try {
    text = nodeFs.readFileSync(nodePath.join(workspaceRoot, ".agent-team", "config.yaml"), "utf8");
  } catch {
    return null;
  }
  const m = /^\s*role:\s*(ba|dev)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** T-WG3 — the why-text for a workspace-role deny, naming the Knowledge root when the launch supplied one. Mirrors block-path-permissions.js. */
function workspaceDenyWhy(role) {
  if (role === "dev") {
    const kb = process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
    return (
      "Requirements, designs, plans, test-plans, UX artifacts and registry files live in the Knowledge repository" +
      (kb ? ` (\`${kb}\`)` : "") +
      ". Run `software-team-agents ba` from the Knowledge workspace instead; this workspace " +
      "(`role: dev` in .agent-team/config.yaml) owns app code plus review/security/deploy docs only."
    );
  }
  return (
    "Contracts, workflows, stacks and pipeline policy are engineer payload for a Target checkout. " +
    "Run engineering work with `software-team-agents dev` from a Target workspace; this workspace " +
    "(`role: ba` in .agent-team/config.yaml) owns analysis docs and knowledge items only."
  );
}

let rootCache = null;

export const StaGuards = async ({ project }) => {
  const [fsMod, pathMod] = await Promise.all([fs, path]);
  const nodeFs = fsMod.default ?? fsMod;
  const nodePath = pathMod.default ?? pathMod;

  // The workspace this session runs in — project.worktree is what opencode
  // hands plugins; cwd is the fallback. Normalized once per process.
  const rawRoot = (project && project.worktree) || process.cwd();
  const root = normalize(nodePath, rawRoot);

  rootCache = { nodeFs, nodePath, root };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String((input && input.tool) || "").toLowerCase();
      if (!PATH_TOOLS.has(tool)) return;
      let reason = null;
      try {
        reason = check(output && output.args ? output.args : {});
      } catch {
        return; // never trap an agent because this guard itself broke
      }
      if (reason) throw new Error(reason);
    },
  };

  function check(args) {
    let rawPath = null;
    for (const key of PATH_ARG_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value !== "") {
        rawPath = value;
        break;
      }
    }
    if (!rawPath) return null;
    return checkOne(rawPath);
  }

  function checkOne(rawPath) {
    const { nodePath: np } = rootCache;
    const target = normalize(np, np.resolve(root, rawPath));

    if (isUnder(target, root)) return evaluateRules(rawPath, target);
    for (const workRoot of writableWorkRoots(np)) {
      if (isUnder(target, workRoot)) return evaluateRules(rawPath, target);
    }
    return denyOutsideRoot(rawPath, root);
  }

  /**
   * Inside an allowed root: apply the universal floor, then the role's
   * contract — repo-relative for workspace paths, work-root-relative for
   * canonical Target roots (mirrors block-path-permissions.js's split).
   */
  function evaluateRules(rawPath, target) {
    const { nodePath: np } = rootCache;
    const workRelative = toWritableWorkRelative(np, target);
    const rel = workRelative !== null ? workRelative : relativeWithin(np, root, target);
    if (rel === null) return null;

    for (const pattern of UNIVERSAL_DENY) {
      if (matchesGlob(pattern, rel)) {
        return denyMessage(rel, process.env.AGENTCLAUDE_ROLE || null, `no agent may write \`${pattern}\``);
      }
    }

    // T-WG3 (extends T-UX13): workspace-level rule — identity-independent, so
    // it holds for interactive sessions too. Mirrors block-path-permissions.js.
    const wsRole = readWorkspaceRole(nodeFs, nodePath, root);
    if (wsRole === "dev") {
      for (const pattern of WORKSPACE_BA_ARTIFACTS) {
        if (matchesGlob(pattern, rel)) {
          return denyMessage(rel, null, workspaceDenyWhy("dev"));
        }
      }
    } else if (wsRole === "ba") {
      for (const pattern of WORKSPACE_DEV_ARTIFACTS) {
        if (matchesGlob(pattern, rel)) {
          return denyMessage(rel, null, workspaceDenyWhy("ba"));
        }
      }
    }

    const role = process.env.AGENTCLAUDE_ROLE;
    if (!role) return null; // interactive run: the floor above is all this can honestly enforce

    const rules = readRules(nodeFs, nodePath, root, role);
    if (!rules) return null; // unknown role or unreadable contract — fail open

    for (const pattern of rules.deny) {
      if (matchesGlob(pattern, rel)) {
        return denyMessage(rel, role, `\`${role}\`'s contract explicitly denies \`${pattern}\``);
      }
    }
    if (rules.write.some((pattern) => matchesGlob(pattern, rel))) return null;

    return denyMessage(
      rel,
      role,
      rules.write.length === 0
        ? `\`${role}\`'s contract grants no write paths at all`
        : `\`${role}\` may write: ${rules.write.map((w) => "`" + w + "`").join(", ")}`,
    );
  }

  /** Canonical Target roots come only from runtime preflight. Invalid input grants nothing. */
  function writableWorkRoots(np) {
    let roots;
    try {
      roots = JSON.parse(process.env.AGENTCLAUDE_WRITABLE_WORK_ROOTS || "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(roots)) return [];
    return roots.filter((c) => typeof c === "string" && np.isAbsolute(c)).map((r) => normalize(np, r));
  }

  function toWritableWorkRelative(np, target) {
    let roots;
    try {
      roots = JSON.parse(process.env.AGENTCLAUDE_WRITABLE_WORK_ROOTS || "[]");
    } catch {
      return null;
    }
    if (!Array.isArray(roots)) return null;
    for (const rawRoot of roots) {
      if (typeof rawRoot !== "string" || !np.isAbsolute(rawRoot)) continue;
      const rel = relativeWithin(np, normalize(np, rawRoot), target);
      if (rel !== null) return rel;
    }
    return null;
  }
};

function relativeWithin(np, ancestor, target) {
  const rel = np.relative(ancestor, target).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("../") || np.isAbsolute(rel)) return null;
  return rel;
}

/** Case-insensitive on Windows, backslashes normalized to forward slashes, no trailing slash. */
function normalize(np, p) {
  let n = np.resolve(p).replace(/\\/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function isUnder(target, root) {
  return target === root || target.startsWith(root + "/");
}

/**
 * Reads `write:` and `deny:` out of one contract. Flow style only, by
 * agreement with the other hooks — .claude/tests/run.js checks this reader
 * against the real contract files, and contracts/ ships next to this plugin
 * in every DEV workspace.
 */
function readRules(nodeFs, nodePath, root, role) {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) return null; // never let an env var build a path
  let text;
  try {
    text = nodeFs.readFileSync(nodePath.join(root, "contracts", `${role}.yaml`), "utf8");
  } catch {
    return null;
  }
  const write = readList(text, "write");
  const deny = readList(text, "deny");
  if (write === null) return null; // not the shape this reader understands — fail open
  return { write, deny: deny === null ? [] : deny };
}

function readList(text, key) {
  const m = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m").exec(text);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
}

/** `*` within a segment, `**` across segments. Mirrors matchesGlob() in block-path-permissions.js / pathPermissions.ts. */
function matchesGlob(pattern, target) {
  const clean = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let out = "";
  const pat = clean(pattern);
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "/" && pat.slice(i) === "/**") {
      out += "(?:/.*)?";
      break;
    }
    if (c === "*") {
      if (pat[i + 1] === "*") {
        const slashAfter = pat[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$").test(clean(target));
}

function denyMessage(rel, role, why) {
  const who = role ? `You are running as \`${role}\`.` : "This path is off limits to every agent.";
  return [
    `Blocked: writing \`${rel}\` is outside this role's declared paths.`,
    "",
    who,
    why,
    "",
    "Each agent in this pipeline owns exactly one artifact (CLAUDE.md). Writing another role's",
    "file does not just cross a line on a diagram: an engineer that edits `design.md` has changed",
    "the contract it was supposed to implement, and the next agent inherits a rule nobody agreed to.",
    "",
    "If this file genuinely needs to change, say so in your handoff and let the role that owns it",
    "make the change. If the boundary itself is wrong, that is a contract edit — `contracts/<role>.yaml`",
    "— and a decision for the user, not something to work around here.",
  ].join("\n");
}

function denyOutsideRoot(rawPath, root) {
  return [
    `Blocked: writing to \`${rawPath}\`, which resolves outside the workspace root (${root}).`,
    "",
    "Every agent in this pipeline owns paths relative to the workspace root — `_docs/module/<name>/`,",
    "app source, `.claude/...` — and a write that lands outside it is either a bad path or scope",
    "the user never asked for. If this really is intentional, tell the user what you were about to",
    "write and let them confirm or do it themselves.",
  ].join("\n");
}
