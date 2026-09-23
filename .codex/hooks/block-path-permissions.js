#!/usr/bin/env node
/*
 * PreToolUse guard: an agent doesn't get to write outside the paths its contract gives it.
 *
 * WHY THIS EXISTS
 *
 * `permissions.capabilities` in contracts/<agent>.yaml already said what *kind* of thing a role
 * may do -- write code, write docs, deploy. It never said *where*, so "backend-engineer may write
 * code" and "backend-engineer may rewrite design.md" were the same permission. This pipeline's
 * entire ownership model is about where: each agent owns exactly one artifact, and an engineer
 * that edits a contract has quietly changed the rule it was supposed to be implementing.
 *
 * THE IDENTITY PROBLEM, STATED PLAINLY
 *
 * Hooks carry no subagent identity -- `block-doc-rewrite.js` and `require-green-before-stop.js`
 * both hit this. `tool_name` and `tool_input` are all there is, so this hook cannot work out on
 * its own which of the eleven agents is about to write.
 *
 * So it takes identity from `STA_ROLE`, which the runtime executor and adapters set on
 * the child process before spawning an agent. When the orchestrator is driving, the role is
 * known and the agent's own rules apply. When a person is driving interactively, there is no
 * role and no way to derive one, so what remains is the UNIVERSAL_DENY floor, which needs no
 * environment at all. `role:` in .agent-team/config.yaml used to carry a second boundary here;
 * it said which repository the checkout was, and V10 leaves one workspace holding both the
 * Framework payload and the Knowledge documents, so it no longer separates anything.
 *
 * One exception gives interactive sessions an identity without an orchestrator: a desktop
 * role-play session (ZCode, the V12 decision) declares the role it is playing through
 * `.workflow/session-role.json`, written only by `software-team-agents session-role` --
 * never by a file tool, since the universal floor denies `.workflow/` to every agent. The
 * env var wins when it exists; the declaration is consulted only when it does not, so an
 * orchestrated run resolves identity exactly as before.
 *
 * That split is the honest design, not a compromise waiting to be fixed. A guard that enforced
 * nothing without an env var would be one forgotten export away from useless; a guard that
 * guessed at identity would block the wrong things. This one is strict where it knows who is
 * asking and still meaningful where it does not.
 *
 * WHERE THE RULES COME FROM
 *
 * Not from here. The universal floor, the workspace artifact lists, the role reader and the glob
 * matcher are declared once in orchestrator/src/agents/pathPermissions.ts and rendered into the
 * `sta:guard-rules` block below; --check-bindings fails on a hand edit. Outside the markers is
 * authored Claude-Code-specific code: identity, tool names, how a denial is reported.
 *
 * WHY IT PARSES YAML BY HAND
 *
 * The rules live in contracts/<agent>.yaml, next to everything else about the role -- one source
 * of truth, checked by --check-contracts. Hooks in this folder take no dependencies (see
 * tests/run.js on why), so there is no YAML parser here. The two keys this needs are written in
 * flow style (`write: ["a/**", "b/**"]`) specifically so a single regex reads them, and
 * .claude/tests/run.js checks this reader against the real contract files -- so a contract
 * reformatted into block style fails the self-test rather than silently disabling the guard.
 *
 * Exits 2 to block with an explanation on stderr; 0 to allow. Anything it cannot parse or
 * resolve is allowed through: this is an ownership guard, not the correctness guarantee, and a
 * guard that fails closed here would trap every agent in the project.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// sta:guard-rules-start
// GENERATED from orchestrator/src/agents/pathPermissions.ts (T-V5-020) — the one authored
// declaration of this framework's guard rule data. `sta --check-bindings` fails on a hand edit;
// `node scripts/regenerate-renderings.mjs` rewrites it. No require, no import: CJS and ESM both.
const UNIVERSAL_DENY = ['.git/**', 'node_modules/**', '.workflow/**', 'dist/**', 'knowledge/_roles/**'];
const WORKSPACE_BA_ARTIFACTS = ['_docs/module/*/requirement.md', '_docs/module/*/design.md', '_docs/module/*/design-archive.md', '_docs/module/*/test-plan.md', '_docs/module/*/plan.md', '_docs/module/*/uxui/**', '_docs/status.md', 'knowledge/**', 'decisions/**', 'targets.yaml', 'knowledge-policy.yaml'];
const FRAMEWORK_PAYLOAD_ARTIFACTS = ['contracts/**', 'workflows/**', 'stacks/**', 'layout.yaml', 'test-pyramid.yaml', 'escalation-policy.yaml'];
const KNOWLEDGE_DENIED_ROLES = ['backend-engineer', 'frontend-engineer', 'devops'];
const SESSION_ROLE_REL_PATH = '.workflow/session-role.json';
function frameworkPayloadDenial(relative, role) {
  // Bound to the stage, not to the checkout: one workspace carries both the
  // Framework payload and the Knowledge documents, so where a write lands
  // says nothing about whether it is allowed. The role arrives resolved:
  // the env identity when the orchestrator spawned this process, otherwise
  // a desktop role-play session's declared file.
  if (!role) return null;
  for (const pattern of FRAMEWORK_PAYLOAD_ARTIFACTS) {
    if (matchesGlob(pattern, relative)) return frameworkPayloadDenyWhy(pattern);
  }
  return null;
}
function frameworkPayloadDenyWhy(pattern) {
  return '`' + pattern + '` is Framework payload — `sta sync` materialises it and a person edits it. No agent contract grants it, so no stage may write it; change it in the Framework repository and sync.';
}
function sessionRoleFromText(text) {
  // The declared-session-role channel: a desktop role-play session has no
  // STA_ROLE env (no launch path sets one), so the role it is playing arrives
  // as this CLI-written file instead. The path sits under .workflow/, which
  // UNIVERSAL_DENY refuses to every agent's file tools, so a session cannot
  // rewrite its own declaration. Anything absent, unreadable or off-shape is
  // 'no declared role' — the floor-only posture, never an error.
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.role !== 'string' || !/^[a-z][a-z0-9-]*$/.test(parsed.role)) return null;
  return parsed.role;
}
function declaredStackRulesFromText(text) {
  // The stack half of the declaration, the same {write, deny} shape the
  // STA_STACK_PATH_RULES channel carries, pre-resolved by the same CLI call
  // the orchestrator uses. Malformed drops out empty, which over-restricts an
  // engineer role rather than letting a layout path through.
  if (typeof text !== 'string' || text === '') return { write: [], deny: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { write: [], deny: [] }; }
  const stack = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.stack : null;
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return { write: list(stack && stack.write), deny: list(stack && stack.deny) };
}
function sessionRole(envRole, declaredText) {
  // Orchestrated identity wins outright: a stage the runtime spawned is
  // exactly who the env says. Only a process without one falls to the
  // declared file, and with neither this returns null — the floor-only
  // posture every host keeps for an anonymous session.
  if (envRole) return envRole;
  return sessionRoleFromText(declaredText);
}
function stackPathRules(declaredText) {
  let parsed;
  try { parsed = JSON.parse(process.env.STA_STACK_PATH_RULES || '{}'); } catch { parsed = {}; }
  const declared = declaredStackRulesFromText(declaredText);
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return { write: list(parsed && parsed.write).concat(declared.write), deny: list(parsed && parsed.deny).concat(declared.deny) };
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

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The declared session-role file — the one channel a desktop role-play session
 * (ZCode, the V12 decision: no CLI, no launch path, no env channel) declares
 * the role it is playing through. `software-team-agents session-role` is the
 * only writer, and the path sits under `.workflow/`, which the universal floor
 * denies to every agent's file tools, so a session cannot rewrite its own
 * grant. Absent or unreadable means "no declared role" and changes nothing.
 */
function readSessionRoleText() {
  try {
    return fs.readFileSync(path.join(root, SESSION_ROLE_REL_PATH), 'utf8');
  } catch {
    return null;
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  let result;
  try {
    result = run(input || {});
  } catch {
    process.exit(0); // never trap an agent because this guard itself broke
  }
  if (result) {
    console.error(result);
    process.exit(2);
  }
  process.exit(0);
});

function run(input) {
  if (!WRITE_TOOLS.has(input.tool_name)) return null;

  const target = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '';
  if (!target) return null;

  // Identity resolved once per call: env first, the declared session role only
  // when the orchestrator never named one. Null means anonymous — the floor
  // alone applies, exactly as it always has.
  const declaredText = readSessionRoleText();
  const role = sessionRole(process.env.STA_ROLE, declaredText);

  const readOnlyTarget = boundReadOnlyTarget(path, path.resolve(root, target));
  if (readOnlyTarget !== null) return boundReadOnlyWhy(readOnlyTarget, role);

  // Ahead of the work-root branch below, which allows anything the floor lets
  // through: a Knowledge root may itself sit inside a granted work root.
  const knowledgeDenial = knowledgeArtifactDenial(path, path.resolve(root, target), role);
  if (knowledgeDenial !== null) return deny(knowledgeDenial.rel, role, knowledgeDenial.why);

  // Three-repo runtime hands this hook only canonical write roots selected by
  // preflight. A Target path is outside the Framework contract's relative
  // globs, so evaluate the universal floor relative to that Target and allow
  // it only after the runtime supplied a matching root.
  const workRelative = toWritableWorkRelative(target);
  if (workRelative !== null) {
    for (const pattern of UNIVERSAL_DENY) {
      if (matchesGlob(pattern, workRelative)) return deny(workRelative, role || null, `no agent may write \`${pattern}\``);
    }
    const workFrameworkWhy = frameworkPayloadDenial(workRelative, role);
    if (workFrameworkWhy !== null) return deny(workRelative, role, workFrameworkWhy);
    return null;
  }

  const rel = toRepoRelative(target);
  if (rel === null) return null; // outside the repo -- block-outside-repo.js owns that case

  for (const pattern of UNIVERSAL_DENY) {
    if (matchesGlob(pattern, rel)) {
      return deny(rel, null, `no agent may write \`${pattern}\``);
    }
  }

  // Framework payload — `sta sync` materialises it and a person edits it. The
  // rule used to key off `role:` in .agent-team/config.yaml, which said which
  // repository this checkout was; one workspace now carries the payload and the
  // Knowledge documents together, so the stage is the only thing left to key on.
  const frameworkWhy = frameworkPayloadDenial(rel, role);
  if (frameworkWhy !== null) return deny(rel, role, frameworkWhy);

  if (!role) return null; // no env role and no declared session role: the floor above is all this can honestly enforce

  // The declaration's stack half travels only with the declaration's role: an
  // env identity must not inherit layout globs declared for a different role.
  const rules = readRules(role, process.env.STA_ROLE ? null : declaredText);
  if (!rules) return null; // unknown role or unreadable contract -- fail open, see header

  for (const pattern of rules.deny) {
    if (matchesGlob(pattern, rel)) {
      return deny(rel, role, `\`${role}\`'s contract explicitly denies \`${pattern}\``);
    }
  }
  if (rules.write.some((pattern) => matchesGlob(pattern, rel))) return null;

  return deny(
    rel,
    role,
    rules.write.length === 0
      ? `\`${role}\`'s contract grants no write paths at all`
      : `\`${role}\` may write: ${rules.write.map((w) => '`' + w + '`').join(', ')}`,
  );
}

function toWritableWorkRelative(target) {
  let roots;
  try { roots = JSON.parse(process.env.STA_WRITABLE_WORK_ROOTS || '[]'); } catch { return null; }
  if (!Array.isArray(roots)) return null;
  const abs = path.resolve(path.isAbsolute(target) ? target : path.resolve(root, target));
  for (const rawRoot of roots) {
    if (typeof rawRoot !== 'string' || !path.isAbsolute(rawRoot)) continue;
    const rel = path.relative(rawRoot, abs).replace(/\\/g, '/');
    if (rel === '') return rel;
    if (!rel.startsWith('../') && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

/** Repo-relative, forward slashes. Null when the path escapes the repo. */
function toRepoRelative(target) {
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../')) return null;
  return rel;
}

/**
 * Reads `write:` and `deny:` out of one contract. Flow style only, by agreement --
 * see the header, and .claude/tests/run.js for the check that keeps the agreement.
 */
function readRules(role, declaredText) {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) return null; // never let an env var build a path
  const file = path.join(root, 'contracts', `${role}.yaml`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const write = readList(text, 'write');
  const deny = readList(text, 'deny');
  if (write === null) return null; // not the shape this reader understands -- fail open
  // The contract holds the role boundary; where this stack puts code
  // comes from stacks/<profile>/stack.yaml, which no dependency-free reader here
  // can resolve. The orchestrator resolves it and hands it over on the same
  // channel as STA_ROLE; a declared session role carries its own pre-resolved
  // half beside the role. Both halves arrive together or neither does,
  // so a missing channel over-restricts rather than letting a path through.
  const stack = stackPathRules(declaredText);
  return { write: write.concat(stack.write), deny: (deny === null ? [] : deny).concat(stack.deny) };
}

function readList(text, key) {
  const m = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm').exec(text);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s !== '');
}

function deny(rel, role, why) {
  const who = role ? `You are running as \`${role}\`.` : 'This path is off limits to every agent.';
  return [
    `Blocked: writing \`${rel}\` is outside this role's declared paths.`,
    '',
    who,
    why,
    '',
    'Each agent in this pipeline owns exactly one artifact (CLAUDE.md). Writing another role\'s',
    'file does not just cross a line on a diagram: an engineer that edits `design.md` has changed',
    'the contract it was supposed to implement, and the next agent inherits a rule nobody agreed to.',
    '',
    'If this file genuinely needs to change, say so in your handoff and let the role that owns it',
    'make the change. If the boundary itself is wrong, that is a contract edit — `contracts/<role>.yaml`',
    '— and a decision for the user, not something to work around here.',
  ].join('\n');
}
