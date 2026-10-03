import * as path from "node:path";
import { renderGuardRuleBlock, targetPathRules } from "../agents/pathPermissions.js";
import type { RuntimeAgentRequest } from "./runtimeAdapter.js";

/** Adapter-owned hooks only: no dependency on project scripts or mutable role files. */
export function codexPreToolGuardScript(req: RuntimeAgentRequest, runHome: string): string {
  const targets = req.workRoots ?? [];
  const roots = (targets.length ? targets : [{ path: req.cwd, access: "write" as const }]).map((root) => {
    let write = [...req.guards.writeAllow];
    let deny = [...req.guards.writeDeny, ".codex/**", ".agents/**"];
    if (targets.length && root.access === "write" && req.autonomy !== "read-only") {
      if (!req.role) throw new Error("Codex Target writes require a role");
      const contractRoot = req.bindingRoot ?? req.knowledgeRoot ?? req.cwd;
      const owned = targetPathRules(req.role, contractRoot, root.path, req.knowledgeRoot ?? contractRoot);
      write = owned.write;
      deny = [...deny, ...owned.deny];
    }
    return { path: path.resolve(root.path), access: req.autonomy === "read-only" ? "read" : root.access, write, deny };
  });
  const policy = { cwd: path.resolve(req.cwd), runHome: path.resolve(runHome), receiptPath: path.join(runHome, "guard-verdicts.jsonl"), roots, packetAllow: targets.length ? req.guards.writeAllow : [], forbidden: req.guards.forbidCommands };
  return `'use strict';\nconst fs = require('node:fs');\nconst path = require('node:path');\n${renderGuardRuleBlock()}\nconst policy = ${JSON.stringify(policy)};\n${GUARD_BODY}`;
}

// No eval or shell parsing guesswork: edits go through apply_patch. The small
// shell read allow-list cannot execute scripts, redirect output, or open an
// interactive process. Build/test commands are run by STA's exit-check runner.
const GUARD_BODY = String.raw`
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function realLocation(input) {
  const absolute = path.resolve(input);
  let ancestor = absolute;
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
}
function writeDenial(file) {
  if (!file || file.includes('\0')) return 'missing or invalid patch path';
  const absolute = path.resolve(policy.cwd, file);
  if (inside(policy.runHome, absolute)) return 'the hook home belongs to STA';
  const root = policy.roots.find((root) => inside(root.path, absolute));
  if (!root) return 'patch path is outside the granted roots: ' + file;
  if (root.access !== 'write') return 'patch path is in a read-only root: ' + file;
  const realRoot = realLocation(root.path);
  const real = realLocation(absolute);
  if (!inside(realRoot, real)) return 'patch path escapes through a symlink: ' + file;
  // Check both names: a symlink within the root cannot alias a denied artifact.
  for (const candidate of [absolute, real]) {
    const relative = path.relative(candidate === real ? realRoot : root.path, candidate).replace(/\\/g, '/');
    if ([...UNIVERSAL_DENY, ...FRAMEWORK_PAYLOAD_ARTIFACTS, ...root.deny].some((glob) => matchesGlob(glob, relative))) return 'denied patch path: ' + file;
    if (!root.write.some((glob) => matchesGlob(glob, relative))) return 'patch path is not covered by the role grant: ' + file;
    if (policy.packetAllow.length && !policy.packetAllow.some((glob) => matchesGlob(glob, relative))) return 'patch path is outside the packet grant: ' + file;
  }
  return null;
}
function patchDenial(command) {
  const lines = command.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return 'unsupported patch envelope';
  let edits = 0;
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (header) {
      edits++;
      const denial = writeDenial(header[2]);
      if (denial) return denial;
    } else if (line.startsWith('*** ') && line !== '*** End of File') return 'unrecognised patch directive';
  }
  return edits ? null : 'patch has no recognised file edits';
}
function shellDenial(command) {
  // These characters can evaluate, expand, chain, redirect, or continue input
  // in supported shells. Refuse them even inside quotes: this is an allow-list.
  if (/[\r\n\x00$\x60;&|<>(){}\[\]!%@]/.test(command)) return 'shell expressions and redirections are refused; use apply_patch for edits';
  const tokens = command.match(/"[^"\\]*"|'[^']*'|[^\s"']+/g) || [];
  if (tokens.join(' ') !== command.trim().replace(/\s+/g, ' ')) return 'unsupported shell quoting';
  const args = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
  const executable = args.shift() || '';
  if (policy.forbidden.some((name) => executable.toLowerCase() === name.toLowerCase())) return 'command denied by packet: ' + executable;
  const flags = {
    rg: new Set(['--files', '--hidden', '--no-ignore', '-n', '-l', '-i', '-s', '-S', '-F', '-e', '-g', '--glob', '--', '--no-heading', '--color=never']),
    cat: new Set(['--']),
    'Get-Content': new Set(['-LiteralPath', '-Path', '-TotalCount', '-Tail', '-Raw']),
    'Get-ChildItem': new Set(['-LiteralPath', '-Path', '-Recurse', '-File', '-Directory', '-Name', '-Force']),
    pwd: new Set(),
    'Get-Location': new Set(),
  };
  if (!Object.prototype.hasOwnProperty.call(flags, executable)) return 'only simple read commands are allowed; edit through apply_patch and let STA run build/test checks';
  if ((executable === 'pwd' || executable === 'Get-Location') && args.length) return 'unexpected arguments to location command';
  if (args.some((arg) => arg.startsWith('-') && !flags[executable].has(arg))) return 'unsupported read-command option';
  return null;
}
function decide(input) {
  if (!input || input.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string') return 'invalid PreToolUse event';
  const args = input.tool_input;
  const approval = approvalChannelDenial(path, fs, policy.cwd, args);
  if (approval) return approval;
  const tool = input.tool_name;
  if (tool === 'apply_patch') return typeof args?.command === 'string' ? patchDenial(args.command) : 'missing patch command';
  if (['Bash', 'PowerShell', 'exec_command', 'shell_command'].includes(tool)) return typeof args?.command === 'string' ? shellDenial(args.command) : 'missing shell command';
  if (tool === 'write_stdin') return args?.chars ? 'interactive command input is refused' : null;
  if (['update_plan', 'view_image'].includes(tool)) return null;
  return 'unsupported local tool is refused by the write guard: ' + tool;
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'STA pre-tool write guard: ' + reason } }));
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const reason = decide(input);
    fs.appendFileSync(policy.receiptPath, JSON.stringify({ tool: input.tool_name, decision: reason ? 'deny' : 'allow' }) + '\n');
    if (reason) deny(reason);
  } catch (error) { deny('cannot evaluate the grant: ' + String(error)); }
});
process.on('uncaughtException', (error) => { deny('guard error: ' + String(error)); process.exit(0); });
`;
