import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The role-binding generator (OFF10 M2 / OFF03 P7): one role, two renderings,
 * ONE source of truth.
 *
 * `.claude/agents/<role>.md` is where a role's definition is authored. The
 * `.codex/agents/<role>.toml` file is a *rendering* of the same definition into
 * Codex's official custom-agent schema (OFF02 S6: name/description/
 * developer_instructions) — generated, never hand-maintained, so the two can
 * no longer drift the way they had (OFF05 DP3). `checkBindings()` fails when
 * what is on disk stops matching what this module would generate, and — since
 * OFF10 M3 — it also fails when the straight `.codex/hooks/*.js` mirrors stop
 * matching their `.claude/hooks/*` sources.
 *
 * WHAT IS DELIBERATELY NOT CARRIED OVER
 * - `tools` — Claude tool names are provider vocabulary; Codex configures tools
 *   its own way.
 * - `model` — model ids do not translate across vendors, and guessing them is
 *   exactly the "เดายิงมั่ว" the T110 header ruled out. Codex-side models come
 *   from its own `[agents]` defaults or explicit options.
 * - `version` — Claude frontmatter bookkeeping.
 * - `effort` IS carried over, as `model_reasoning_effort`, because it is a
 *   reasoning-depth intent rather than a vendor id.
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
// checkBindings — the `--check-bindings` validator (OFF03 U6)
// ---------------------------------------------------------------------------

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
 * Every `.claude/agents/<role>.md` must have a generated twin at
 * `.codex/agents/<role>.toml` that byte-matches what this module renders today;
 * every `.toml` must have its authoring source. This is what keeps the second
 * rendering from becoming a stale hand-edited copy — the same job
 * `--check-workflows` does for workflows against the classifier.
 */
export function checkBindings(projectRoot: string): BindingCheckResult {
  const problems: string[] = [];
  const claudeDir = path.join(projectRoot, ".claude", "agents");
  const codexDir = path.join(projectRoot, ".codex", "agents");

  const mdRoles = listRoles(claudeDir);
  if (mdRoles.length === 0) {
    return { ok: false, problems: [`no agent definitions found in ${claudeDir}`] };
  }

  const renderedTomls = new Set<string>();
  for (const role of mdRoles) {
    let expected: string;
    try {
      expected = renderCodexBinding(fs.readFileSync(path.join(claudeDir, `${role}.md`), "utf8"));
    } catch (e) {
      problems.push(`${role}: cannot parse .claude/agents/${role}.md — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    renderedTomls.add(`${role}.toml`);

    const tomlPath = path.join(codexDir, `${role}.toml`);
    if (!fs.existsSync(tomlPath)) {
      problems.push(`${role}: missing .codex/agents/${role}.toml — regenerate the codex bindings`);
      continue;
    }
    const actual = fs.readFileSync(tomlPath, "utf8").replace(/\r\n/g, "\n");
    if (actual !== expected) {
      problems.push(
        `${role}: .codex/agents/${role}.toml does not match the rendering of .claude/agents/${role}.md — regenerate the codex bindings`,
      );
    }
  }

  try {
    for (const f of fs.readdirSync(codexDir)) {
      if (f.endsWith(".toml") && !renderedTomls.has(f)) {
        problems.push(`${f.slice(0, -".toml".length)}: orphan .codex/agents/${f} with no .claude/agents/${f.replace(".toml", ".md")} source`);
      }
    }
  } catch {
    problems.push(`no .codex/agents directory at ${codexDir} — nothing has been generated yet`);
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
