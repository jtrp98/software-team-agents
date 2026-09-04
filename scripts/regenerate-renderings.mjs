#!/usr/bin/env node
/**
 * Regenerates every derived rendering in THIS repo from its single source:
 *
 *   .claude/agents/<role>.md   → .codex/agents/<role>.toml · .opencode/agent/<role>.md
 *   .claude/commands/<name>.md → .opencode/commands/<name>.md · .agents/skills/<name>/SKILL.md
 *                                (+ <name>/agents/openai.yaml)
 *   taskClassifier.ts +        → workflows/<id>.yml   (T-V3TOK-110, ADR-007)
 *   workflowCatalog.ts
 *   pathPermissions.ts         → the `sta:guard-rules` block inside
 *                                .claude/hooks/block-path-permissions.js and
 *                                .opencode/plugin/sta-guards.js (T-V5-020)
 *   .claude/hooks/*            → .codex/hooks/* byte-mirrors
 *
 * Target projects get the same bytes at `sta sync` time (syncEngine); this
 * script exists for the Framework repo itself, where the mirrors are committed.
 * Run after editing any source:  npm --prefix orchestrator run build
 *                                node scripts/regenerate-renderings.mjs
 * `sta --check-bindings` verifies the result byte-for-byte.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINDING_RENDERINGS,
  COMMAND_RENDERINGS,
  defaultOpenCodePermissions,
  loadCommandGuardrails,
  listCommands,
} from "../orchestrator/dist/runtime/bindingGenerator.js";
import { renderStackDigest } from "../orchestrator/dist/profile/stackDigest.js";
import { generateWorkflowFiles } from "../orchestrator/dist/workflow/workflowCatalog.js";
import {
  GUARD_RULES_CLOSE,
  GUARD_RULES_OPEN,
  GUARD_RULE_HOSTS,
  renderGuardRuleBlock,
} from "../orchestrator/dist/agents/pathPermissions.js";
import { inspectMarkerBlock } from "../orchestrator/dist/targetcli/knowledgeRender.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lf = (s) => s.replace(/\r\n/g, "\n");

let written = 0;
function emit(relPath, content) {
  const dest = path.join(ROOT, ...relPath.split("/"));
  const next = Buffer.from(content, "utf8");
  const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (current && current.equals(next)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  console.log(`${current ? "update" : "add"} ${relPath}`);
  written++;
}

function removeStale(dir, keep) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!keep.has(e.name)) {
      fs.rmSync(path.join(ROOT, dir, e.name), { recursive: true, force: true });
      console.log(`remove stale ${dir}/${e.name}`);
      written++;
    }
  }
}

// --- agent renderings -------------------------------------------------------
const agentsDir = path.join(ROOT, ".claude", "agents");
const roleFiles = fs.existsSync(agentsDir)
  ? fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()
  : [];
if (roleFiles.length === 0) throw new Error("no .claude/agents/*.md sources found");
for (const spec of BINDING_RENDERINGS.filter((candidate) => candidate.kind === "agent-set")) {
  const keep = new Set();
  for (const f of roleFiles) {
    const md = fs.readFileSync(path.join(agentsDir, f), "utf8");
    const role = f.slice(0, -".md".length);
    keep.add(`${role}${spec.fileExtension}`);
    emit(`${spec.dir}/${role}${spec.fileExtension}`, spec.render(md));
  }
  removeStale(spec.dir, keep);
}
for (const spec of BINDING_RENDERINGS.filter((candidate) => candidate.kind === "root-file")) {
  emit(spec.targetPath, spec.render(fs.readFileSync(path.join(ROOT, spec.sourcePath), "utf8")));
}

emit(".claude/shared/stack.md", renderStackDigest(ROOT));

// --- command renderings -----------------------------------------------------
const commandsDir = path.join(ROOT, ".claude", "commands");
if (fs.existsSync(commandsDir)) {
  const rules = loadCommandGuardrails(ROOT);
  const names = listCommands(commandsDir);
  for (const spec of COMMAND_RENDERINGS) {
    const keep = new Set();
    for (const name of names) {
      const md = fs.readFileSync(path.join(commandsDir, `${name}.md`), "utf8");
      for (const [rel, bytes] of spec.render(name, md, rules)) {
        keep.add(rel.split("/")[0]);
        emit(`${spec.dir}/${rel}`, bytes);
      }
    }
    removeStale(spec.dir, keep);
  }
}

// --- guard rule block (T-V5-020) -------------------------------------------
// `UNIVERSAL_DENY`, the workspace artifact lists and the matcher are declared
// once in agents/pathPermissions.ts. Each hook carries them inside an
// `sta:guard-rules` marker pair; everything outside the markers is authored,
// host-specific code this script never touches.
{
  const expected = renderGuardRuleBlock();
  for (const host of GUARD_RULE_HOSTS) {
    const abs = path.join(ROOT, ...host.path.split("/"));
    if (!fs.existsSync(abs)) throw new Error(`${host.path} is missing — it carries the generated guard rules`);
    const current = lf(fs.readFileSync(abs, "utf8"));
    const inspected = inspectMarkerBlock(current, GUARD_RULES_OPEN, GUARD_RULES_CLOSE, "guard-rules");
    if (inspected.state !== "valid") {
      throw new Error(`${host.path}: expected one ${GUARD_RULES_OPEN} / ${GUARD_RULES_CLOSE} pair (${inspected.state})`);
    }
    if (inspected.block === expected) continue;
    // Spliced by index, never String.replace: the generated matcher contains
    // `$'` and `$)`, which a replacement string reinterprets as substitution
    // patterns and silently truncates the block.
    const at = current.indexOf(inspected.block);
    emit(host.path, current.slice(0, at) + expected + current.slice(at + inspected.block.length));
  }
}

// --- .codex/hooks mirror ----------------------------------------------------
// No Codex-side generator renders these, so they are straight byte-copies of
// `.claude/hooks/*` — the arrangement `--check-bindings` already enforces.
// Copying them here is what makes "mutate the declaration, regenerate every
// copy" true for the guard block above rather than a manual afterthought.
{
  const claudeHooks = path.join(ROOT, ".claude", "hooks");
  const isMirrored = (f) => f.endsWith(".js") || f === "package.json";
  const names = fs.existsSync(claudeHooks) ? fs.readdirSync(claudeHooks).filter(isMirrored).sort() : [];
  for (const name of names) {
    const source = fs.readFileSync(path.join(claudeHooks, name), "utf8");
    const dest = path.join(ROOT, ".codex", "hooks", name);
    // `--check-bindings` compares these normalized, so a mirror that differs
    // only in line endings is already correct — rewriting it would churn files
    // this task never changed.
    if (fs.existsSync(dest) && lf(fs.readFileSync(dest, "utf8")) === lf(source)) continue;
    emit(`.codex/hooks/${name}`, source);
  }
  const keep = new Set(names);
  for (const f of fs.existsSync(path.join(ROOT, ".codex", "hooks")) ? fs.readdirSync(path.join(ROOT, ".codex", "hooks")) : []) {
    if (isMirrored(f) && !keep.has(f)) {
      fs.rmSync(path.join(ROOT, ".codex", "hooks", f));
      console.log(`remove stale .codex/hooks/${f}`);
      written++;
    }
  }
}

// --- workflow files ---------------------------------------------------------
// `workflows/*.yml` is generated from the classifier plus the workflow catalog
// (ADR-007); hand-editing one is what `--check-workflows` now refuses.
{
  const result = generateWorkflowFiles(ROOT);
  for (const rel of result.written) {
    console.log(`update ${rel}`);
    written++;
  }
  for (const rel of result.removed) {
    console.log(`remove stale ${rel}`);
    written++;
  }
}

console.log(written === 0 ? "renderings already in sync" : `${written} file(s) changed`);
