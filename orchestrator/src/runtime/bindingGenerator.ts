import * as fs from "node:fs";
import * as path from "node:path";
import { renderStackDigest, stackDigestPath } from "../profile/stackDigest.js";
import { inspectBootstrapBlock } from "../targetcli/knowledgeRender.js";
import { isTargetInitialized, loadTargetConfig, readTargetManifest } from "../targetcli/targetMeta.js";
import { runtimesForWorkspace, type WorkspaceRuntime } from "../targetcli/roleWorkspace.js";

/**
 * The role-binding generator (OFF10 M2 / OFF03 P7): one role definition,
 * several renderings, ONE source of truth.
 *
 * `.claude/agents/<role>.md` is where a role's definition is authored. Each
 * other runtime gets a *rendered* binding generated from it — never
 * hand-maintained, so they can no longer drift the way they had (OFF05 DP3):
 *
 * - `.codex/agents/<role>.toml` — Codex's official custom-agent schema
 *   (OFF02 S6: name/description/developer_instructions), via
 *   `renderCodexBinding()`.
 * - `.opencode/agent/<role>.md` — OpenCode markdown agent (T-OC1), via
 *   `renderOpenCodeBinding()`. Its frontmatter carries only
 *   description/mode/permission: OpenCode names an agent by its filename, and
 *   its own permission system is the runtime half of this framework's guards
 *   (the spike in planning/v2 proved the headless default posture is
 *   allow-all, so every binding carries explicit rules).
 *
 * The same one-source rule covers prompt shortcuts (T-OCC2/T-CXC2): each
 * `.claude/commands/<name>.md` renders into `.opencode/commands/<name>.md`
 * and `.agents/skills/<name>/SKILL.md` (+ a fixed `agents/openai.yaml`) —
 * see `COMMAND_RENDERINGS` below.
 *
 * `checkBindings()` fails when what is on disk stops matching what this module
 * would generate, and — since OFF10 M3 — it also fails when the straight
 * `.codex/hooks/*.js` mirrors stop matching their `.claude/hooks/*` sources.
 *
 * WHAT IS DELIBERATELY NOT CARRIED OVER
 * - `tools` — Claude tool names are provider vocabulary; each runtime configures
 *   tools its own way.
 * - `model` — model ids do not translate across vendors, and guessing them is
 *   exactly the "เดายิงมั่ว" the T110 header ruled out. Codex-side models come
 *   from its own `[agents]` defaults or explicit options; OpenCode-side from its
 *   own provider config (`opencode.json` / `-m`), effort via `--variant`.
 * - `version` — Claude frontmatter bookkeeping.
 * - `effort` IS carried over for Codex, as `model_reasoning_effort`, because it
 *   is a reasoning-depth intent rather than a vendor id. The OpenCode rendering
 *   leaves it to the launch flag instead.
 */

export interface ParsedAgentMd {
  name: string;
  description: string;
  effort?: string;
  /** The markdown body after the frontmatter fence, LF-normalized. */
  body: string;
}

/** Parses the simple `key: value` frontmatter these agent files use (values may contain colons). */
export function parseAgentMd(md: string): ParsedAgentMd {
  const normalized = md.replace(/\r\n/g, "\n");
  const open = normalized.match(/^---\n/);
  if (!open) throw new Error("agent file has no frontmatter fence");
  const closeIndex = normalized.indexOf("\n---\n", open[0].length);
  if (closeIndex === -1) throw new Error("agent file frontmatter is never closed");
  const header = normalized.slice(open[0].length, closeIndex);
  const body = normalized.slice(closeIndex + "\n---\n".length);

  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1 || /^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0 && value.length > 0 && !fields.has(key)) fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name) throw new Error("agent frontmatter has no name field");
  if (!description) throw new Error("agent frontmatter has no description field");

  return {
    name,
    description,
    effort: fields.get("effort"),
    body: body.replace(/^\n+/, "").replace(/\s+$/, ""),
  };
}

/**
 * TOML literal strings ('…') end only at an unescaped single quote; the spec's
 * escape for one inside a literal string is doubling it. Everything else —
 * including the double quotes and Thai text these descriptions carry — passes
 * through untouched.
 */
function tomlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderCodexBinding(md: string): string {
  const parsed = parseAgentMd(md);
  // A multiline basic string cannot contain three consecutive quotes unescaped;
  // the escape (`\"""`) is exactly what `extractDeveloperInstructions` undoes,
  // so the pair stays lossless by construction. A backslash immediately before
  // a newline would be read as a line-continuation escape — refuse rather than
  // silently corrupt authored prose.
  const safeBody = parsed.body.replace(/"""/g, '\\"""');
  if (/\\$|\\\n/m.test(parsed.body)) {
    throw new Error(
      `agent body for ${parsed.name} ends a line with a backslash — move it inside a word or remove it; the generator will not emit an ambiguous TOML continuation`,
    );
  }

  const lines = [
    `name = ${tomlLiteral(parsed.name)}`,
    `description = ${tomlLiteral(parsed.description)}`,
  ];
  if (parsed.effort) lines.push(`model_reasoning_effort = ${tomlLiteral(parsed.effort)}`);
  lines.push('developer_instructions = """', safeBody, '"""', "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderOpenCodeBinding — the OpenCode markdown rendering (T-OC1)
// ---------------------------------------------------------------------------

/** Actions OpenCode's `permission:` frontmatter accepts (verified against 1.18 on the T-OC0 spike). */
export type OpenCodePermissionAction = "allow" | "ask" | "deny";

/**
 * Per-tool permission rules for one rendered agent. Keys are glob patterns as
 * OpenCode matches them (`git status*`, `plans/**`); values are actions.
 * OpenCode resolves overlapping patterns by specificity, not by listing order
 * (spike Q1), so this renderer is free to sort keys for stable output.
 */
export interface OpenCodePermissions {
  bash?: Record<string, OpenCodePermissionAction>;
  edit?: Record<string, OpenCodePermissionAction>;
  write?: Record<string, OpenCodePermissionAction>;
}

/**
 * The no-state-changing-git rule (policies/git.md) expressed as OpenCode bash
 * globs: the four read-only subcommands pass, every other `git` invocation is
 * denied. `withGitBashRules()` layers a caller's extra rules over these.
 */
export const GIT_READONLY_BASH_RULES: Readonly<Record<string, OpenCodePermissionAction>> = {
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git status*": "allow",
  "git *": "deny",
};

/** Merges caller rules over {@link GIT_READONLY_BASH_RULES}. A caller entry replaces a default one — re-allowing `git push`, say, is a visible choice, not a typo the merge hides. */
export function withGitBashRules(
  bash: Record<string, OpenCodePermissionAction> = {},
): Record<string, OpenCodePermissionAction> {
  return { ...GIT_READONLY_BASH_RULES, ...bash };
}

/**
 * The declarative permission set every rendered OpenCode binding carries
 * (T-OC2). The spike (planning/v2 §7) proved OpenCode's headless default
 * posture is allow-all, so the git rule travels with every binding; sync and
 * checkBindings both call this so what is generated and what is verified can
 * never disagree. Role-specific path rules are runtime-enforced by the
 * sta-guards plugin reading contracts/, mirroring how the Claude-side hook
 * works — not frozen into the rendering.
 */
export function defaultOpenCodePermissions(): OpenCodePermissions {
  return { bash: withGitBashRules() };
}

/** YAML double-quoted scalar — only `\` and `"` need escaping; Thai and colons pass through. */
function yamlDoubleQuoted(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Renders `.claude/agents/<role>.md` into an OpenCode markdown agent.
 *
 * Deterministic byte-for-byte (sorted permission keys) so `checkBindings`
 * can diff disk against source. The frontmatter deliberately carries no
 * `name` — OpenCode names an agent by its filename — and no model/tools/
 * version fields (see the file header).
 */
export function renderOpenCodeBinding(md: string, permissions?: OpenCodePermissions): string {
  const parsed = parseAgentMd(md);
  // A bare `---` line inside the body would be read back as the frontmatter
  // fence by any YAML/markdown reader that re-parses the emitted file
  // (checkBindings included), silently truncating the instructions. Refuse,
  // exactly like the TOML renderer refuses ambiguous continuations.
  if (/^---\s*$/m.test(parsed.body)) {
    throw new Error(
      `agent body for ${parsed.name} contains a bare '---' line — use '———' or wording instead; ` +
        `the generator will not emit a self-truncating frontmatter block`,
    );
  }

  const lines: string[] = ["---", `description: ${yamlDoubleQuoted(parsed.description)}`, "mode: all"];
  const toolOrder = ["bash", "edit", "write"] as const;
  let permissionEmitted = false;
  for (const tool of toolOrder) {
    const rules = permissions?.[tool];
    const patterns = Object.keys(rules ?? {}).sort();
    if (patterns.length === 0) continue;
    if (!permissionEmitted) {
      lines.push("permission:");
      permissionEmitted = true;
    }
    lines.push(`  ${tool}:`);
    for (const pattern of patterns) {
      lines.push(`    ${yamlDoubleQuoted(pattern)}: ${rules![pattern]}`);
    }
  }
  lines.push("---", "", parsed.body.trimEnd(), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command renderings (T-OCC2 / T-CXC2) — `.claude/commands/*.md` is also a
// one-source-of-truth family, rendered per runtime that has no Claude-style
// `@`-import:
//
// - `.opencode/commands/<name>.md` — OpenCode discovers these natively and
//   invokes them as `/name`. Its `@file` references resolve from the project
//   root, not from the command file's directory (T-OCC1 spike), so the shared
//   guardrails are inlined into the rendered body rather than imported.
// - `.agents/skills/<name>/SKILL.md` — Codex Agent Skills (custom prompts were
//   removed from codex-cli 0.117.0). Invoked explicitly as `$name`; the extra
//   `agents/openai.yaml` turns implicit activation off so a skill only runs
//   when a person types it (T-CXC1 spike proved the file parses and explicit
//   invocation still works).
//
// Both renderings drop `argument-hint:` — a Claude frontmatter field with no
// counterpart in either runtime — and replace the `@_shared/guardrails.md`
// import line with the guardrails' numbered rules inline.
// ---------------------------------------------------------------------------

export interface ParsedCommandMd {
  description: string;
  argumentHint?: string;
  /** The markdown body after the frontmatter fence, LF-normalized. */
  body: string;
}

/** Parses the `key: value` frontmatter the command sources use (no `name` — commands are named by filename). */
export function parseCommandMd(md: string): ParsedCommandMd {
  const normalized = md.replace(/\r\n/g, "\n");
  if (!normalized.match(/^---\n/)) throw new Error("command file has no frontmatter fence");
  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex === -1) throw new Error("command file frontmatter is never closed");
  const header = normalized.slice(4, closeIndex);
  const body = normalized.slice(closeIndex + "\n---\n".length);

  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0 && value.length > 0 && !fields.has(key)) fields.set(key, value);
  }

  const description = fields.get("description");
  if (!description) throw new Error("command frontmatter has no description field");
  return { description, argumentHint: fields.get("argument-hint"), body };
}

/**
 * The numbered guardrail rules from `_shared/guardrails.md`, ready to inline.
 * Only the numbered items survive — the include's own intro sentence talks
 * about `@`-imports, which no rendering below has.
 */
export function extractGuardrailRules(guardrailsMd: string): string {
  const parsed = parseCommandMd(guardrailsMd);
  const rules = parsed.body.split("\n").filter((l) => /^\d+\.\s/.test(l));
  if (rules.length === 0) throw new Error("_shared/guardrails.md carries no numbered rules to inline");
  return rules.join("\n");
}

/** Strips the `@_shared/guardrails.md` import line and surrounding blank lines from a command body. */
function bodyWithoutGuardrailsImport(body: string): string {
  return body
    .split("\n")
    .filter((l) => l.trim() !== "@_shared/guardrails.md")
    .join("\n")
    .replace(/^\n+/, "");
}

function withInlinedGuardrails(parsed: ParsedCommandMd, guardrailsRules: string): string {
  return `${guardrailsRules}\n\n${bodyWithoutGuardrailsImport(parsed.body).trimEnd()}\n`;
}

/** Renders one OpenCode slash command. Deterministic byte-for-byte; `$ARGUMENTS`/`$1..$n` pass through untouched. */
export function renderOpenCodeCommand(name: string, sourceMd: string, guardrailsRules: string): string {
  void name;
  const parsed = parseCommandMd(sourceMd);
  return ["---", `description: ${yamlDoubleQuoted(parsed.description)}`, "---", "", withInlinedGuardrails(parsed, guardrailsRules)].join("\n");
}

/** The fixed per-skill policy file: skills are human-typed shortcuts, never model-initiated (T-CXC1-d). */
export const CODEX_SKILL_OPENAI_YAML = "policy:\n  allow_implicit_invocation: false\n";

/** Renders one Codex Agent Skill's SKILL.md (`name` comes from the directory; `description` passes through verbatim). */
export function renderCodexSkill(name: string, sourceMd: string, guardrailsRules: string): string {
  const parsed = parseCommandMd(sourceMd);
  return ["---", `name: ${name}`, `description: ${parsed.description}`, "---", "", withInlinedGuardrails(parsed, guardrailsRules)].join("\n");
}

/**
 * Every generated-from-.claude/commands rendering target. One entry per
 * runtime; each maps a command name to the full set of files it generates
 * (Codex's skill layout is one subdirectory per command, not flat).
 */
export interface CommandRenderingSpec {
  /** Repo-relative directory (posix separators) the renderings live in. */
  dir: string;
  /** Paths relative to {@link dir} generated for one command name. */
  outputs(commandName: string): string[];
  render(commandName: string, sourceMd: string, guardrailsRules: string): Map<string, string>;
}

export const COMMAND_RENDERINGS: readonly CommandRenderingSpec[] = [
  {
    dir: ".opencode/commands",
    outputs: (n) => [`${n}.md`],
    render: (n, md, g) => new Map([[`${n}.md`, renderOpenCodeCommand(n, md, g)]]),
  },
  {
    dir: ".agents/skills",
    outputs: (n) => [`${n}/SKILL.md`, `${n}/agents/openai.yaml`],
    render: (n, md, g) =>
      new Map([
        [`${n}/SKILL.md`, renderCodexSkill(n, md, g)],
        [`${n}/agents/openai.yaml`, CODEX_SKILL_OPENAI_YAML],
      ]),
  },
];

/** Reads `_shared/guardrails.md` beside the command sources and returns its rules for inlining. */
export function loadCommandGuardrails(projectRoot: string): string {
  const md = fs.readFileSync(path.join(projectRoot, ".claude", "commands", "_shared", "guardrails.md"), "utf8");
  return extractGuardrailRules(md);
}

/** Top-level command names (flat `*.md`, `_shared/` excluded) sorted. */
export function listCommands(commandsDir: string): string[] {
  try {
    return fs
      .readdirSync(commandsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) out.push(...listFilesRecursive(path.join(dir, e.name)).map((f) => path.posix.join(e.name, f)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/**
 * One command-rendering family: every source command needs a byte-identical
 * generated set, and every generated file needs its authoring source.
 * Mirrors {@link checkRenderingSet} but multi-file per command and recursive
 * (the skills layout nests).
 */
function checkCommandRenderingSet(
  projectRoot: string,
  claudeDir: string,
  names: readonly string[],
  guardrailsRules: string,
  spec: CommandRenderingSpec,
  problems: string[],
): void {
  const targetDir = path.join(projectRoot, ...spec.dir.split("/"));
  const expectedFiles = new Set<string>();
  for (const name of names) {
    let rendered: Map<string, string>;
    try {
      rendered = spec.render(name, fs.readFileSync(path.join(claudeDir, `${name}.md`), "utf8"), guardrailsRules);
    } catch (e) {
      problems.push(`${name}: cannot parse .claude/commands/${name}.md — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const [rel, content] of rendered) {
      expectedFiles.add(rel);
      const twinPath = path.join(targetDir, ...rel.split("/"));
      if (!fs.existsSync(twinPath)) {
        problems.push(`${name}: missing ${spec.dir}/${rel} — regenerate the command bindings`);
        continue;
      }
      const actual = fs.readFileSync(twinPath, "utf8").replace(/\r\n/g, "\n");
      if (actual !== content) {
        problems.push(`${name}: ${spec.dir}/${rel} does not match the rendering of .claude/commands/${name}.md — regenerate the command bindings`);
      }
    }
  }

  for (const actualRel of listFilesRecursive(targetDir)) {
    if (!expectedFiles.has(actualRel)) {
      problems.push(`orphan ${spec.dir}/${actualRel} with no .claude/commands source — regenerate the command bindings`);
    }
  }
}

export interface BindingCheckResult {
  ok: boolean;
  problems: string[];
}

function listRoles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every generated-from-.claude rendering target, declared once here so
 * `checkBindings` verifies exactly what `runTargetSync` generates (T-OC2/T-OC3).
 * Adding a runtime adds one entry plus its renderer above — nowhere else.
 */
export interface AgentBindingRendering {
  kind: "agent-set";
  /** Repo-relative directory (posix separators) the rendering lives in. */
  dir: string;
  fileExtension: string;
  render(sourceMd: string): string;
}

export interface RootBindingRendering {
  kind: "root-file";
  sourcePath: string;
  targetPath: string;
  render(sourceMd: string): string;
}

export type BindingRendering = AgentBindingRendering | RootBindingRendering;

/** The Codex root instruction is a rendering of CLAUDE.md's managed bootstrap block, not another authored rules document. */
export function renderAgentsPointer(claudeMd: string): string {
  const inspected = inspectBootstrapBlock(claudeMd);
  if (inspected.state !== "valid") throw new Error("CLAUDE.md has no valid sta:bootstrap block");
  return `${inspected.block}Full operating rules: see [CLAUDE.md](CLAUDE.md).\n`;
}

export const BINDING_RENDERINGS: readonly BindingRendering[] = [
  { kind: "agent-set", dir: ".codex/agents", fileExtension: ".toml", render: (md) => renderCodexBinding(md) },
  {
    kind: "agent-set",
    dir: ".opencode/agent",
    fileExtension: ".md",
    render: (md) => renderOpenCodeBinding(md, defaultOpenCodePermissions()),
  },
  { kind: "root-file", sourcePath: "CLAUDE.md", targetPath: "AGENTS.md", render: renderAgentsPointer },
];

export function isAgentBindingRendering(spec: BindingRendering): spec is AgentBindingRendering {
  return spec.kind === "agent-set";
}

/** One generated rendering family: every source role needs a byte-identical twin, no orphans allowed. */
function checkRenderingSet(
  projectRoot: string,
  claudeDir: string,
  mdRoles: readonly string[],
  spec: { dir: string; fileExtension: string; render(md: string): string },
  problems: string[],
): void {
  const targetDir = path.join(projectRoot, ...spec.dir.split("/"));
  const renderedFiles = new Set<string>();
  for (const role of mdRoles) {
    let expected: string;
    try {
      expected = spec.render(fs.readFileSync(path.join(claudeDir, `${role}.md`), "utf8"));
    } catch (e) {
      problems.push(`${role}: cannot parse .claude/agents/${role}.md — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    renderedFiles.add(`${role}${spec.fileExtension}`);

    const twinPath = path.join(targetDir, `${role}${spec.fileExtension}`);
    if (!fs.existsSync(twinPath)) {
      problems.push(`${role}: missing ${spec.dir}/${role}${spec.fileExtension} — regenerate the bindings`);
      continue;
    }
    const actual = fs.readFileSync(twinPath, "utf8").replace(/\r\n/g, "\n");
    if (actual !== expected) {
      problems.push(
        `${role}: ${spec.dir}/${role}${spec.fileExtension} does not match the rendering of .claude/agents/${role}.md — regenerate the bindings`,
      );
    }
  }

  try {
    for (const f of fs.readdirSync(targetDir)) {
      if (f.endsWith(spec.fileExtension) && !renderedFiles.has(f)) {
        problems.push(`${f.slice(0, -spec.fileExtension.length)}: orphan ${spec.dir}/${f} with no .claude/agents/${f.replace(spec.fileExtension, ".md")} source`);
      }
    }
  } catch {
    problems.push(`no ${spec.dir} directory at ${targetDir} — nothing has been generated yet`);
  }
}

/**
 * Every `.claude/agents/<role>.md` must have a generated twin for each entry in
 * {@link BINDING_RENDERINGS} that byte-matches what this module renders today;
 * every rendering must have its authoring source. This is what keeps the
 * non-Claude renderings from becoming stale hand-edited copies — the same job
 * `--check-workflows` does for workflows against the classifier.
 */
export function checkBindings(projectRoot: string): BindingCheckResult {
  const problems: string[] = [];
  const claudeDir = path.join(projectRoot, ".claude", "agents");
  const config = loadTargetConfig(projectRoot);
  const manifest = isTargetInitialized(projectRoot) ? readTargetManifest(projectRoot) : undefined;
  // A non-workspace fixture keeps the historical all-renderings contract; an
  // initialized workspace checks exactly its recorded runtime set.
  const runtimes = config || manifest ? new Set(runtimesForWorkspace(config, manifest)) : new Set<WorkspaceRuntime>(["claude", "codex", "opencode"]);
  const renderingRuntime = (dir: string): WorkspaceRuntime => dir.startsWith(".codex/") || dir.startsWith(".agents/") ? "codex" : "opencode";

  const mdRoles = listRoles(claudeDir);
  if (mdRoles.length === 0) {
    return { ok: false, problems: [`no agent definitions found in ${claudeDir}`] };
  }

  for (const spec of BINDING_RENDERINGS) {
    if (spec.kind === "root-file" && !runtimes.has("codex")) continue;
    if (spec.kind === "agent-set" && !runtimes.has(renderingRuntime(spec.dir))) continue;
    if (spec.kind === "agent-set") {
      checkRenderingSet(projectRoot, claudeDir, mdRoles, spec, problems);
      continue;
    }
    const source = path.join(projectRoot, spec.sourcePath);
    const target = path.join(projectRoot, spec.targetPath);
    try {
      const expected = spec.render(fs.readFileSync(source, "utf8"));
      if (!fs.existsSync(target)) {
        problems.push(`missing ${spec.targetPath} — regenerate the bindings`);
        continue;
      }
      const actual = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
      if (actual === expected) continue;
      // A Target-owned root file may carry its own prose. In that ownership
      // class only the delimited Framework block is compared.
      const expectedBlock = inspectBootstrapBlock(expected);
      const actualBlock = inspectBootstrapBlock(actual);
      if (expectedBlock.state !== "valid" || actualBlock.state !== "valid" || actualBlock.block !== expectedBlock.block) {
        problems.push(`${spec.targetPath} does not match the rendering of ${spec.sourcePath} — regenerate the bindings`);
      }
    } catch (e) {
      problems.push(`cannot render ${spec.targetPath} from ${spec.sourcePath} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // T-V3TOK-021: the stack digest is generated from the two engineering
  // prompts, so PM/SA/QA never need to read whole engineering prompts merely
  // to discover the stack.
  const stackSources = ["backend-engineer.md", "frontend-engineer.md"];
  if (stackSources.every((file) => fs.existsSync(path.join(claudeDir, file)))) {
    try {
      const expected = renderStackDigest(projectRoot);
      const digest = stackDigestPath(projectRoot);
      if (!fs.existsSync(digest)) problems.push("missing .claude/shared/stack.md — regenerate renderings");
      else if (fs.readFileSync(digest, "utf8").replace(/\r\n/g, "\n") !== expected) {
        problems.push(".claude/shared/stack.md does not match the engineering-prompt digest — regenerate renderings");
      }
    } catch (e) {
      problems.push(`cannot render .claude/shared/stack.md — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- Command renderings (T-OCC3 / T-CXC3) --------------------------------
  // `.claude/commands/*.md` renders into every runtime that lacks Claude's
  // `@`-import. Skipped entirely when the source dir is absent: a workspace
  // that never received the commands payload has nothing to verify.
  const claudeCommandsDir = path.join(projectRoot, ".claude", "commands");
  if (fs.existsSync(claudeCommandsDir)) {
    const names = listCommands(claudeCommandsDir);
    if (names.length === 0) {
      problems.push(`no command definitions found in ${claudeCommandsDir}`);
    } else {
      let guardrailsRules: string;
      try {
        guardrailsRules = loadCommandGuardrails(projectRoot);
      } catch (e) {
        problems.push(`cannot load _shared/guardrails.md — ${e instanceof Error ? e.message : String(e)}`);
        guardrailsRules = "";
      }
      if (guardrailsRules !== "") {
      for (const spec of COMMAND_RENDERINGS) {
        if (!runtimes.has(renderingRuntime(spec.dir))) continue;
          checkCommandRenderingSet(projectRoot, claudeCommandsDir, names, guardrailsRules, spec, problems);
        }
      }
    }
  }

  // --- Hook parity (OFF10 M3 / OFF03 U2) -----------------------------------
  // The `.codex/hooks/*.js` copies exist because no Codex-side generator renders
  // them from anything else — they are straight mirrors of `.claude/hooks/*`,
  // and two of them once drifted so far they lost the writable-work-roots
  // support their sources had (OFF01 U2). Mirrors get one rule: byte-identity
  // with their source, checked here so the next silent divergence fails loudly.
  // Removal of the whole construct is a separate, verified decision (OFF05 B4)
  // — until Codex's load behaviour is proven on a real install, the mirror must
  // at least never disagree with what it claims to mirror.
  //
  // `package.json` is mirrored too, marker and all: it is what pins both
  // directories to CommonJS under an ESM host, and a mirror directory missing it
  // would fail exactly like the hooks themselves were never fixed — invisibly,
  // exit 1, enforcing nothing.
  const claudeHooksDir = path.join(projectRoot, ".claude", "hooks");
  const codexHooksDir = path.join(projectRoot, ".codex", "hooks");
  const isHookMirrorFile = (f: string) => f.endsWith(".js") || f === "package.json";
  const hookSources = fs.existsSync(claudeHooksDir)
    ? fs.readdirSync(claudeHooksDir).filter(isHookMirrorFile).sort()
    : [];
  if (hookSources.length > 0) {
    for (const f of hookSources) {
      const mirrorPath = path.join(codexHooksDir, f);
      if (!fs.existsSync(mirrorPath)) {
        problems.push(`${f}: missing .codex/hooks/${f} — re-copy .claude/hooks to .codex/hooks`);
        continue;
      }
      const source = fs.readFileSync(path.join(claudeHooksDir, f), "utf8").replace(/\r\n/g, "\n");
      const mirror = fs.readFileSync(mirrorPath, "utf8").replace(/\r\n/g, "\n");
      if (mirror !== source) {
        problems.push(`${f}: .codex/hooks/${f} differs from its .claude/hooks source — re-copy .claude/hooks to .codex/hooks`);
      }
    }
    try {
      const mirroredNames = new Set(hookSources);
      for (const f of fs.readdirSync(codexHooksDir)) {
        if (isHookMirrorFile(f) && !mirroredNames.has(f)) {
          problems.push(`${f}: orphan .codex/hooks/${f} with no .claude/hooks/${f} source`);
        }
      }
    } catch {
      problems.push(`no .codex/hooks directory at ${codexHooksDir} — re-copy .claude/hooks to .codex/hooks`);
    }
  }

  return { ok: problems.length === 0, problems };
}
