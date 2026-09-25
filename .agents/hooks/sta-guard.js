#!/usr/bin/env node
/*
 * sta-guard.js — the Antigravity (`agy`) half of this framework's tool-call guards.
 *
 * THE SEMANTICS ARE INVERTED, AND THAT IS THE WHOLE REASON THIS FILE EXISTS
 *
 *   Claude Code:  exit 0 = allow · exit 2 = block · exit 1 (broken hook) = ALLOW
 *   AGY:          stdout `{"decision":"allow"}` = allow · anything else, including a
 *                 non-zero exit or no output at all = DENY
 *
 * So the `.claude/hooks/*` scripts cannot be shared with AGY verbatim: they signal
 * through exit codes and deliberately fail OPEN, which under AGY's contract would
 * still deny (harmless) — but their allow path is silence, which AGY also denies.
 * This wrapper carries AGY's contract instead: the allow payload is printed on ONE
 * path only, and every other outcome — unparseable stdin, an input shape this does
 * not recognise, an internal throw, a rule that says no — leaves stdout without it.
 *
 * WHERE THE RULES COME FROM
 *
 * Not from here. The universal floor, the workspace artifact lists, the role reader
 * and the glob matcher are declared once in orchestrator/src/agents/pathPermissions.ts
 * and rendered into the `sta:guard-rules` block below — the same bytes `.claude/hooks/`
 * and `.opencode/plugin/sta-guards.js` carry. `sta --check-bindings` fails on a hand
 * edit; `node scripts/regenerate-renderings.mjs` rewrites it.
 *
 * WHAT THIS DOES NOT COVER
 *
 * State-changing git is not checked here, exactly as `block-outside-repo.js` leaves
 * shell commands alone: `run_command` carries a command line, not a destination path,
 * and a path guard that tried to parse shell would deny far more than it understands.
 * Doc-rewrite, secret-leak and exit checks have no AGY mechanism either.
 *
 * THIS FILE IS CURRENTLY INERT, AND ITS PARSER IS KNOWN WRONG
 *
 * Two facts were captured against a real agy 1.1.27 install
 * (planning/v6/v6-agy-spike-evidence.md §13) after this wrapper was written:
 *
 *   1. agy reads PreToolUse hooks only from the machine-global
 *      `~/.gemini/config/hooks.json`. The workspace `.agents/hooks.json` that
 *      names this file is never consulted, so nothing here runs today.
 *   2. The real payload is `{"toolCall": {"name": ..., "args": {...}}}` in
 *      camelCase, the hook's cwd is the directory holding hooks.json (not the
 *      workspace), and `workspacePaths` comes back empty. The extraction below
 *      matches none of that — it would deny every call rather than allow a
 *      legitimate write.
 *
 * Both are tracked as their own tasks. Until they land, treat this file as a
 * shipped skeleton, not as enforcement: the fail-closed direction below is the
 * only thing about it that is currently true.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.STA_WORKSPACE_ROOT || (process.cwd().replace(/\\/g, "/").endsWith("/.agents") ? path.resolve(process.cwd(), "..") : process.cwd());

/** Tools that carry a destination path. `run_command` is out of scope — see the header. */
const PATH_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

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

const ALLOW = JSON.stringify({ decision: 'allow' });

/**
 * The declared session-role file — the one channel a desktop role-play session
 * (ZCode, the V12 decision: no CLI, no launch path, no env channel) declares
 * the role it is playing through. `software-team-agents session-role` is the
 * only writer, and the path sits under `.workflow/`, which the universal floor
 * denies to every agent's file tools. Absent or unreadable means "no declared
 * role" and changes nothing.
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
    return deny('this guard could not parse the hook payload, so it cannot tell what is being written');
  }
  let verdict;
  try {
    verdict = run(input && typeof input === 'object' ? input : {});
  } catch (e) {
    return deny(`this guard itself failed (${e && e.message ? e.message : 'unknown error'}), so it cannot vouch for this tool call`);
  }
  if (verdict !== null) return deny(verdict);
  process.stdout.write(ALLOW);
  process.exit(0);
});

/** The one place the allow payload is withheld. Exit 0: the payload, not the code, is the decision. */
function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: String(reason) }));
  process.exit(0);
}

/** Null means allow. A string is the denial reason. */
function run(input) {
  const artifactDir = input && input.artifactDirectoryPath ? input.artifactDirectoryPath : null;
  const tool = toolName(input);
  if (tool === null) return 'this guard could not identify which tool is being called from the hook payload';
  if (!PATH_TOOLS.has(tool)) return null;

  const targets = pathCandidates(toolParameters(input));
  if (targets.length === 0) return `\`${tool}\` was called with no recognisable destination path, so this guard cannot check where it writes`;

  // Identity resolved once per call: env first, the declared session role only
  // when the orchestrator never named one. Null means anonymous — the floor
  // alone applies, exactly as it always has.
  const declaredText = readSessionRoleText();
  const role = sessionRole(process.env.STA_ROLE, declaredText);

  for (const target of targets) {
    const reason = checkOne(target, undefined, role, declaredText);
    if (reason !== null) return reason;
  }
  return null;
}

function toolName(input) {
  for (const value of [input.tool_name, input.toolName, input.tool, input.name, input.toolCall && input.toolCall.name]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function toolParameters(input) {
  const holders = [input.tool_info, input.toolInfo, input.toolCall, input];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const value of [holder.parameters, holder.tool_input, holder.toolInput, holder.input, holder.args]) {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
  }
  return {};
}

/**
 * Every string under a key naming a file or a path, one level deep. A key rule
 * rather than a list of field names: the real payload's spelling is unknown, and a
 * rule at least fails predictably where a guessed list fails silently.
 */
function pathCandidates(parameters) {
  const found = [];
  const collect = (object, depth) => {
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (typeof value === 'string' && value !== '' && /path|file/i.test(key)) {
        found.push(value);
      } else if (depth > 0 && value && typeof value === 'object') {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item && typeof item === 'object') collect(item, depth - 1);
        }
      }
    }
  };
  collect(parameters, 2);
  return found;
}

function checkOne(rawPath, input, role, declaredText) {
  const norm = String(rawPath).replace(/\\/g, "/");
  if (norm.includes("/.gemini/antigravity/") || (input && input.artifactDirectoryPath && norm.startsWith(String(input.artifactDirectoryPath).replace(/\\/g, "/")))) return null;
  const readOnlyTarget = boundReadOnlyTarget(path, path.resolve(root, rawPath));
  if (readOnlyTarget !== null) return boundReadOnlyWhy(readOnlyTarget, role);

  // Ahead of the work-root branch below, which allows anything the floor lets
  // through: a Knowledge root may itself sit inside a granted work root.
  const knowledgeDenial = knowledgeArtifactDenial(path, path.resolve(root, rawPath), role);
  if (knowledgeDenial !== null) return denyMessage(knowledgeDenial.rel, role, knowledgeDenial.why);
  const workRelative = toWritableWorkRelative(rawPath);
  if (workRelative !== null) {
    for (const pattern of UNIVERSAL_DENY) {
      if (matchesGlob(pattern, workRelative)) return denyMessage(workRelative, role || null, `no agent may write \`${pattern}\``);
    }
    const workFrameworkWhy = frameworkPayloadDenial(workRelative, role);
    if (workFrameworkWhy !== null) return denyMessage(workRelative, role, workFrameworkWhy);
    return null;
  }

  const rel = toRepoRelative(rawPath);
  if (rel === null) return denyOutsideRoot(rawPath);

  for (const pattern of UNIVERSAL_DENY) {
    if (matchesGlob(pattern, rel)) return denyMessage(rel, null, `no agent may write \`${pattern}\``);
  }

  // Framework payload — per stage, not per checkout.
  const frameworkWhy = frameworkPayloadDenial(rel, role);
  if (frameworkWhy !== null) return denyMessage(rel, role, frameworkWhy);

  if (!role) return null; // no env role and no declared session role: the floor above is all this can honestly enforce

  // The declaration's stack half travels only with the declaration's role: an
  // env identity must not inherit layout globs declared for a different role.
  const rules = readRules(role, process.env.STA_ROLE ? null : declaredText);
  if (!rules) return null; // unknown role or unreadable contract — the floor above still held

  for (const pattern of rules.deny) {
    if (matchesGlob(pattern, rel)) return denyMessage(rel, role, `\`${role}\`'s contract explicitly denies \`${pattern}\``);
  }
  if (rules.write.some((pattern) => matchesGlob(pattern, rel))) return null;

  return denyMessage(
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

/** Repo-relative, forward slashes. Null when the path escapes the workspace. */
function toRepoRelative(target) {
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../')) return null;
  return rel;
}

function readRules(role, declaredText) {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) return null; // never let an env var build a path
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'contracts', `${role}.yaml`), 'utf8');
  } catch {
    return null;
  }
  const write = readList(text, 'write');
  const deny = readList(text, 'deny');
  if (write === null) return null; // not the shape this reader understands
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

function denyMessage(rel, role, why) {
  const who = role ? `You are running as \`${role}\`.` : 'This path is off limits to every agent.';
  return [
    `Blocked: writing \`${rel}\` is outside this role's declared paths.`,
    who,
    why,
    'Each agent in this pipeline owns exactly one artifact (CLAUDE.md). If this file genuinely needs to change,',
    'say so in your handoff and let the role that owns it make the change. If the boundary itself is wrong,',
    'that is a `contracts/<role>.yaml` edit and a decision for the user, not something to work around here.',
  ].join(' ');
}

function denyOutsideRoot(rawPath) {
  return [
    `Blocked: writing to \`${rawPath}\`, which resolves outside the workspace root (${root}).`,
    'Every agent in this pipeline owns paths relative to the workspace root, and a write that lands outside it',
    'is either a bad path or scope the user never asked for. Tell the user what you were about to write and let',
    'them confirm or do it themselves.',
  ].join(' ');
}
