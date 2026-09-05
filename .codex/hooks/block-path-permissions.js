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
 * So it takes identity from `AGENTCLAUDE_ROLE`, which the runtime executor and adapters set on
 * the child process before spawning an agent. When the orchestrator is
 * driving, the role is known and the agent's own rules apply. When a person is driving
 * interactively, there is no role, and this falls back to the UNIVERSAL_DENY floor -- the paths
 * no agent may write under any circumstances.
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
const WORKSPACE_DEV_ARTIFACTS = ['contracts/**', 'workflows/**', 'stacks/**', 'layout.yaml', 'test-pyramid.yaml', 'escalation-policy.yaml'];
function readWorkspaceRole(nodeFs, nodePath, workspaceRoot) {
  let text;
  try { text = nodeFs.readFileSync(nodePath.join(workspaceRoot, '.agent-team', 'config.yaml'), 'utf8'); } catch { return null; }
  const m = /^\s*role:\s*(ba|dev)\s*$/m.exec(text);
  return m ? m[1] : null;
}
function workspaceDenyWhy(role) {
  const kb = process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
  if (role === 'dev') return 'Requirements, designs, plans, test-plans, UX artifacts and registry files live in the Knowledge repository' + (kb ? ' (`' + kb + '`)' : '') + '. Run `software-team-agents ba` from the Knowledge workspace instead; this workspace (`role: dev` in .agent-team/config.yaml) owns app code plus review/security/deploy docs only.';
  return 'Contracts, workflows, stacks and pipeline policy are engineer payload for a Target checkout. Run engineering work with `software-team-agents dev` from a Target workspace; this workspace (`role: ba` in .agent-team/config.yaml) owns analysis docs and knowledge items only.';
}
function stackPathRules() {
  let parsed;
  try { parsed = JSON.parse(process.env.AGENTCLAUDE_STACK_PATH_RULES || '{}'); } catch { return { write: [], deny: [] }; }
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return { write: list(parsed && parsed.write), deny: list(parsed && parsed.deny) };
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

  // Three-repo runtime hands this hook only canonical write roots selected by
  // preflight. A Target path is outside the Framework contract's relative
  // globs, so evaluate the universal floor relative to that Target and allow
  // it only after the runtime supplied a matching root.
  const workRelative = toWritableWorkRelative(target);
  if (workRelative !== null) {
    for (const pattern of UNIVERSAL_DENY) {
      if (matchesGlob(pattern, workRelative)) return deny(workRelative, process.env.AGENTCLAUDE_ROLE || null, `no agent may write \`${pattern}\``);
    }
    return null;
  }

  const rel = toRepoRelative(target);
  if (rel === null) return null; // outside the repo -- block-outside-repo.js owns that case

  for (const pattern of UNIVERSAL_DENY) {
    if (matchesGlob(pattern, rel)) {
      return deny(rel, null, `no agent may write \`${pattern}\``);
    }
  }

  // Workspace-level rules — identity-independent, so
  // they hold for interactive runs where no AGENTCLAUDE_ROLE is set. A `role:
  // dev` workspace owns app code plus the engineer-written docs
  // (review/security/deploy); every analysis artifact and registry file
  // belongs to the Knowledge repository, named here from
  // AGENTCLAUDE_KNOWLEDGE_ROOT when the launch provided it. A `role: ba`
  // workspace mirrors this for the engineer/pipeline payload.
  const wsRole = readWorkspaceRole(fs, path, root);
  if (wsRole === 'dev') {
    for (const pattern of WORKSPACE_BA_ARTIFACTS) {
      if (matchesGlob(pattern, rel)) return deny(rel, null, workspaceDenyWhy('dev'));
    }
  } else if (wsRole === 'ba') {
    for (const pattern of WORKSPACE_DEV_ARTIFACTS) {
      if (matchesGlob(pattern, rel)) return deny(rel, null, workspaceDenyWhy('ba'));
    }
  }

  const role = process.env.AGENTCLAUDE_ROLE;
  if (!role) return null; // interactive run: the floor above is all this can honestly enforce

  const rules = readRules(role);
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
  try { roots = JSON.parse(process.env.AGENTCLAUDE_WRITABLE_WORK_ROOTS || '[]'); } catch { return null; }
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
function readRules(role) {
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
  // channel as AGENTCLAUDE_ROLE. Both halves arrive together or neither does,
  // so a missing channel over-restricts rather than letting a path through.
  const stack = stackPathRules();
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
