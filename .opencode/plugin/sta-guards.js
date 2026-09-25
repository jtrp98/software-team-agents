/*
 * sta-guards.js — the OpenCode half of this framework's tool-call guards.
 * Generated into every workspace by `sta init`/`sync` and auto-loaded by
 * OpenCode from `.opencode/plugin/` — no config wiring needed (verified on
 * OpenCode 1.18.21).
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
 *                                  .unenforced post-hoc; porting them is
 *                                  roadmap, not a silent gap.
 *
 * WHY THE DEFAULT POSTURE MATTERS
 *
 * OpenCode's headless default is allow-all (spike §7) — fail-open. This
 * plugin plus the bindings' permission blocks are what make a run guarded at
 * all; if this file goes missing, `sta status` reports OpenCode NOT READY and
 * the adapter refuses the run before spawn (V13 TASK-014) instead of
 * launching anything unguarded.
 *
 * IDENTITY AND ENVIRONMENT
 *
 * Same channel as the Claude-side hooks: `STA_ROLE` (set by the
 * orchestrator per stage) selects whose contract applies; without it a
 * direct-mode session's per-role authority arrives only through a verified
 * STA-issued attempt grant (`.workflow/attempt-grant.json`, written only by
 * `sta grant issue` — V13 TASK-012); with neither only the universal floor
 * holds, plus the governed-artifact denial an unassigned session owns.
 * `STA_WRITABLE_WORK_ROOTS` (JSON array of absolute paths) grants the
 * canonical Target roots in three-repo mode; invalid input grants nothing.
 *
 * WHERE THE RULES COME FROM
 *
 * Not from here. The universal floor, the workspace artifact lists, the role
 * reader and the glob matcher are declared once in
 * orchestrator/src/agents/pathPermissions.ts and rendered into the
 * `sta:guard-rules` block below (T-V5-020) — the same bytes this plugin and
 * `.claude/hooks/` both carry. Outside the markers: OpenCode-specific code.
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
const crypto = import("node:crypto");

/** Tools that take a destination path. Bash stays out of scope here exactly as it does in block-outside-repo.js. */
const PATH_TOOLS = new Set(["write", "edit", "multiedit", "patch", "notebookedit"]);

/** Keys known to carry a destination path across opencode tool versions/shapes. */
const PATH_ARG_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"];

// sta:guard-rules-start
// GENERATED from orchestrator/src/agents/pathPermissions.ts (T-V5-020) — the one authored
// declaration of this framework's guard rule data. `sta --check-bindings` fails on a hand edit;
// `node scripts/regenerate-renderings.mjs` rewrites it. No require, no import: CJS and ESM both.
const UNIVERSAL_DENY = ['.git/**', 'node_modules/**', '.workflow/**', 'dist/**', 'knowledge/_roles/**'];
const WORKSPACE_BA_ARTIFACTS = ['_docs/module/*/requirement.md', '_docs/module/*/design.md', '_docs/module/*/design-archive.md', '_docs/module/*/test-plan.md', '_docs/module/*/plan.md', '_docs/module/*/uxui/**', '_docs/status.md', 'knowledge/**', 'decisions/**', 'targets.yaml', 'knowledge-policy.yaml'];
const FRAMEWORK_PAYLOAD_ARTIFACTS = ['contracts/**', 'workflows/**', 'stacks/**', 'layout.yaml', 'test-pyramid.yaml', 'escalation-policy.yaml'];
const KNOWLEDGE_DENIED_ROLES = ['backend-engineer', 'frontend-engineer', 'devops'];
const UNASSIGNED_SESSION_DENY = ['_docs/**'];
const ATTEMPT_GRANT_REL_PATH = '.workflow/attempt-grant.json';
const ATTEMPT_GRANT_KEY_REL_PATH = '.workflow/sta-grant-key';
function unassignedSessionDenial(relative) {
  // A session with no identity holds no governed-artifact authority: read,
  // discover and propose is all an unassigned direct session may do, so the
  // role-owned document tree stays out of its file tools' reach. What turns
  // the per-role layer on is a verified grant, never a claim.
  for (const pattern of UNASSIGNED_SESSION_DENY) {
    if (matchesGlob(pattern, relative)) return unassignedSessionDenyWhy(pattern);
  }
  return null;
}
function unassignedSessionDenyWhy(pattern) {
  return '`' + pattern + '` is governed work — role-owned artifacts change through STA dispatch, not a direct session. Propose the change and let STA assign the role that owns it; a per-role write bound comes only from a valid attempt grant.';
}
function canonicalGrantJson(value) {
  // The same normalization STA signs under: sorted keys, undefined dropped.
  // The grant bytes must hash identically on both ends or every signature
  // fails, so this stays small and stands still.
  const normalize = (v) => Array.isArray(v) ? v.map(normalize)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => [key, normalize(val)])) : v;
  return JSON.stringify(normalize(value));
}
function grantSignatureValid(token, createHmac, keyHex) {
  // HMAC-SHA256 over every field but `signature`, compared constant-time.
  // A hand-written file fails here unless it also carries STA's key — and
  // even then STA's own issuance record is what completes a write.
  if (!token || typeof token !== 'object' || Array.isArray(token)) return false;
  if (typeof token.signature !== 'string' || !/^[0-9a-f]{64}$/.test(token.signature)) return false;
  const unsigned = {};
  for (const key of Object.keys(token)) { if (key !== 'signature') unsigned[key] = token[key]; }
  const expected = createHmac('sha256', keyHex).update(canonicalGrantJson(unsigned)).digest('hex');
  if (expected.length !== token.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.signature.charCodeAt(i);
  return diff === 0;
}
function attemptGrantFromText(text, createHmac, keyHex, nowMs) {
  // The STA-issued attempt grant: the one channel a direct-mode session's
  // per-role authority arrives through, written only by `sta grant issue`
  // after STA's own dispatch decision. Anything absent, unreadable,
  // off-shape, unsigned or expired is 'no grant' — the floor posture,
  // never an error. The env identity wins outright when an orchestrator
  // set one; a grant is read only when it did not.
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.attempt_grant !== 1) return null;
  if (typeof parsed.role !== 'string' || !/^[a-z][a-z0-9-]*$/.test(parsed.role)) return null;
  if (typeof parsed.grant_id !== 'string' || !/^agr_[0-9a-f]{32}$/.test(parsed.grant_id)) return null;
  if (typeof parsed.expires_at !== 'string' || !Number.isFinite(Date.parse(parsed.expires_at))) return null;
  if (Date.parse(parsed.expires_at) <= nowMs) return null;
  if (!grantSignatureValid(parsed, createHmac, keyHex)) return null;
  const stack = parsed.scope && typeof parsed.scope === 'object' && !Array.isArray(parsed.scope) ? parsed.scope.stack : null;
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return { grantId: parsed.grant_id, role: parsed.role, stack: { write: list(stack && stack.write), deny: list(stack && stack.deny) } };
}
function frameworkPayloadDenial(relative, role) {
  // Bound to the stage, not to the checkout: one workspace carries both the
  // Framework payload and the Knowledge documents, so where a write lands
  // says nothing about whether it is allowed. The role arrives resolved:
  // the env identity when the orchestrator spawned this process, otherwise
  // a direct-mode session's verified attempt grant.
  if (!role) return null;
  for (const pattern of FRAMEWORK_PAYLOAD_ARTIFACTS) {
    if (matchesGlob(pattern, relative)) return frameworkPayloadDenyWhy(pattern);
  }
  return null;
}
function frameworkPayloadDenyWhy(pattern) {
  return '`' + pattern + '` is Framework payload — `sta sync` materialises it and a person edits it. No agent contract grants it, so no stage may write it; change it in the Framework repository and sync.';
}
function stackPathRules(grant) {
  let parsed;
  try { parsed = JSON.parse(process.env.STA_STACK_PATH_RULES || '{}'); } catch { parsed = {}; }
  const granted = grant ? grant.stack : { write: [], deny: [] };
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return { write: list(parsed && parsed.write).concat(granted.write), deny: list(parsed && parsed.deny).concat(granted.deny) };
}
function boundReadOnlyTarget(nodePath, target) {
  let roots; try { roots = JSON.parse(process.env.STA_TARGET_WORK_ROOTS || '[]'); } catch { return null; }
  if (!Array.isArray(roots)) return null;
  const absolute = nodePath.resolve(target);
  for (const candidate of roots) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.targetId !== 'string' || typeof candidate.path !== 'string' || candidate.access !== 'read' || !nodePath.isAbsolute(candidate.path)) continue;
    const root = nodePath.resolve(candidate.path);
    const relative = nodePath.relative(root, absolute);
    if (relative === '' || (!relative.startsWith('..' + nodePath.sep) && relative !== '..' && !nodePath.isAbsolute(relative))) return candidate.targetId;
  }
  return null;
}
function boundReadOnlyWhy(targetId, role) {
  return 'Blocked: Target "' + targetId + '" is bound read-only for this ' + (role || 'current role') + ' invocation; writing to it is refused.';
}
function knowledgeArtifactDenial(nodePath, target, role) {
  // The Knowledge root can sit inside a granted work root, so this runs off
  // the root the runtime named rather than off the workspace-relative path.
  if (!role || !KNOWLEDGE_DENIED_ROLES.includes(role)) return null;
  const kb = process.env.STA_KNOWLEDGE_ROOT;
  // STA_KNOWLEDGE_ROOT_NAME is the managed-session marker: a launcher that
  // resolved one named root sets it beside STA_KNOWLEDGE_ROOT, never half.
  // A managed invocation missing the path cannot attribute its writes to any
  // Knowledge root, so it denies before any permission decision; the hook
  // resolves no default and reads no installation config (TOCTOU — the
  // frozen selection must win). Unbound shells keep the legacy fail-open so
  // single-repo mode is unchanged.
  if (!kb) {
    const rootName = process.env.STA_KNOWLEDGE_ROOT_NAME;
    if (rootName) return { rel: target, why: knowledgeSelectionIncompleteWhy(rootName) };
    return null;
  }
  const rel = nodePath.relative(nodePath.resolve(kb), nodePath.resolve(target)).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../') || nodePath.isAbsolute(rel)) return null;
  for (const pattern of WORKSPACE_BA_ARTIFACTS) {
    if (matchesGlob(pattern, rel)) return { rel: rel, why: knowledgeDenyWhy(role, pattern, kb) };
  }
  return null;
}
function knowledgeSelectionIncompleteWhy(rootName) {
  return 'Not a role-boundary refusal: this session was launched as a managed Knowledge session (root name `' + rootName + '`) but its launch contract is incomplete — `STA_KNOWLEDGE_ROOT` is missing, so the guard cannot tell which Knowledge root this write belongs to and refuses before evaluating any permission (one session = one root). Relaunch through the launcher so the selection arrives whole.';
}
function knowledgeDenyWhy(role, pattern, knowledgeRoot) {
  return '`' + role + '` implements what the Knowledge repository (`' + knowledgeRoot + '`) already decided, so it may not write `' + pattern + '` there — that artifact is written by the role that owns it, never by an implementation stage.';
}
function matchesGlob(pattern, target) {
  const clean = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const pat = clean(pattern);
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '/' && pat.slice(i) === '/**') { out += '(?:/.*)?'; break; }
    if (c !== '*') { out += '\\^$+?.()|{}[]'.includes(c) ? '\\' + c : c; continue; }
    if (pat[i + 1] !== '*') { out += '[^/]*'; continue; }
    const slashAfter = pat[i + 2] === '/';
    out += slashAfter ? '(?:.*/)?' : '.*';
    i += slashAfter ? 2 : 1;
  }
  return new RegExp('^' + out + '$').test(clean(target));
}
// sta:guard-rules-end

let rootCache = null;

export const StaGuards = async ({ project }) => {
  const [fsMod, pathMod, cryptoMod] = await Promise.all([fs, path, crypto]);
  const nodeFs = fsMod.default ?? fsMod;
  const nodePath = pathMod.default ?? pathMod;
  const nodeCrypto = cryptoMod.default ?? cryptoMod;

  // The workspace this session runs in — project.worktree is what opencode
  // hands plugins; cwd is the fallback. Normalized once per process.
  const rawRoot = (project && project.worktree) || process.cwd();
  const root = normalize(nodePath, rawRoot);

  rootCache = { nodeFs, nodePath, nodeCrypto, root };

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

    // Identity resolved once per call: env first, a verified attempt grant
    // only when the orchestrator never named one. Null means unassigned — the
    // floor plus the governed-artifact denial, exactly as the direct-mode
    // contract says.
    const grant = readAttemptGrant();
    const role = process.env.STA_ROLE || (grant ? grant.role : null);

    const readOnlyTarget = boundReadOnlyTarget(np, target);
    if (readOnlyTarget !== null) return boundReadOnlyWhy(readOnlyTarget, role);

    // Ahead of `evaluateRules`, which allows anything the floor lets through
    // inside a work root: a Knowledge root may itself sit inside one.
    const knowledgeDenial = knowledgeArtifactDenial(np, target, role);
    if (knowledgeDenial !== null) return denyMessage(knowledgeDenial.rel, role, knowledgeDenial.why);

    if (isUnder(target, root)) return evaluateRules(rawPath, target, role, grant);
    for (const workRoot of writableWorkRoots(np)) {
      if (isUnder(target, workRoot)) return evaluateRules(rawPath, target, role, grant);
    }
    return denyOutsideRoot(rawPath, root);
  }

  /**
   * The STA-issued attempt grant — the one channel a direct-mode session's
   * per-role authority arrives through (V13 TASK-012). `sta grant issue` is
   * the only writer, the path sits under `.workflow/`, which the universal
   * floor denies to every agent's file tools, and the signature check inside
   * the generated block makes a self-written file worthless. Absent,
   * unreadable, unsigned or expired means "no grant" and changes nothing.
   */
  function readAttemptGrant() {
    const { nodeFs: nf, nodePath: npath, nodeCrypto: ncrypto, root: wsRoot } = rootCache;
    let text;
    try {
      text = nf.readFileSync(npath.join(wsRoot, ATTEMPT_GRANT_REL_PATH), "utf8");
    } catch {
      return null;
    }
    let keyHex;
    try {
      keyHex = nf.readFileSync(npath.join(wsRoot, ATTEMPT_GRANT_KEY_REL_PATH), "utf8").trim();
    } catch {
      return null;
    }
    return attemptGrantFromText(text, ncrypto.createHmac, keyHex, Date.now());
  }

  /**
   * Inside an allowed root: apply the universal floor, then the role's
   * contract — repo-relative for workspace paths, work-root-relative for
   * canonical Target roots (mirrors block-path-permissions.js's split).
   */
  function evaluateRules(rawPath, target, role, grant) {
    const { nodePath: np } = rootCache;
    const workRelative = toWritableWorkRelative(np, target);
    const rel = workRelative !== null ? workRelative : relativeWithin(np, root, target);
    if (rel === null) return null;

    for (const pattern of UNIVERSAL_DENY) {
      if (matchesGlob(pattern, rel)) {
        return denyMessage(rel, role || null, `no agent may write \`${pattern}\``);
      }
    }

    // Framework payload — per stage, not per checkout. Mirrors
    // block-path-permissions.js.
    const frameworkWhy = frameworkPayloadDenial(rel, role);
    if (frameworkWhy !== null) return denyMessage(rel, role, frameworkWhy);

    if (!role) {
      // Unassigned session: governed work is role-owned, so the document tree
      // is refused even on the floor. Everything else keeps the floor posture.
      const unassignedWhy = unassignedSessionDenial(rel);
      if (unassignedWhy) return denyMessage(rel, null, unassignedWhy);
      return null;
    }

    // The declaration's stack half travels only with the declaration's role: an
    // env identity must not inherit layout globs declared for a different role.
    const rules = readRules(nodeFs, nodePath, root, role, process.env.STA_ROLE ? null : grant);
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
      roots = JSON.parse(process.env.STA_WRITABLE_WORK_ROOTS || "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(roots)) return [];
    return roots.filter((c) => typeof c === "string" && np.isAbsolute(c)).map((r) => normalize(np, r));
  }

  function toWritableWorkRelative(np, target) {
    let roots;
    try {
      roots = JSON.parse(process.env.STA_WRITABLE_WORK_ROOTS || "[]");
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
function readRules(nodeFs, nodePath, root, role, grant) {
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
  // Contract = role boundary, stack profile = layout. The layout half arrives
  // from the orchestrator on the STA_ROLE channel, because no
  // dependency-free reader here can join .agent-team/config.yaml to stacks/;
  // a declared session role carries its own pre-resolved half beside the role.
  const stack = stackPathRules(grant);
  return { write: write.concat(stack.write), deny: (deny === null ? [] : deny).concat(stack.deny) };
}

function readList(text, key) {
  const m = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m").exec(text);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
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
