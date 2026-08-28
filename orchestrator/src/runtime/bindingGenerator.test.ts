import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBindings,
  CODEX_SKILL_OPENAI_YAML,
  COMMAND_RENDERINGS,
  defaultOpenCodePermissions,
  extractGuardrailRules,
  GIT_READONLY_BASH_RULES,
  listCommands,
  loadCommandGuardrails,
  parseAgentMd,
  parseCommandMd,
  renderCodexBinding,
  renderAgentsPointer,
  renderCodexSkill,
  renderOpenCodeBinding,
  renderOpenCodeCommand,
  withGitBashRules,
} from "./bindingGenerator.js";
import { extractDeveloperInstructions } from "./codexAdapter.js";

/**
 * OFF10 M2 — one role definition, two renderings, zero drift.
 *
 * The .toml binding is a *rendering* of the .md source (OFF03 P7), so the
 * contract here is: rendering is deterministic, lossless for the fields it
 * carries (round-tripping through the adapter's own extractor), refuses to emit
 * ambiguous TOML rather than corrupting prose, and `checkBindings` catches every
 * way disk can diverge from source — missing twin, edited twin, orphan.
 */

const SAMPLE_MD = [
  "---",
  "name: qa-engineer",
  "description: Verify work against requirement.md and design.md — ask \"ตรวจงานหน่อย\" first.",
  "tools: Read, Glob, Grep",
  "model: sonnet",
  "effort: high",
  "version: 1",
  "---",
  "",
  "You are QA. Never mark verified without inspecting code.",
].join("\n");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-bindings-"));
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
  const claude = "<!-- sta:bootstrap -->\n# bootstrap\n<!-- /sta:bootstrap -->\n\n# Full rules\n";
  fs.writeFileSync(path.join(root, "CLAUDE.md"), claude, "utf8");
  fs.writeFileSync(path.join(root, "AGENTS.md"), renderAgentsPointer(claude), "utf8");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseAgentMd", () => {
  it("reads name/description/effort and leaves other fields out of the way", () => {
    const parsed = parseAgentMd(SAMPLE_MD);
    expect(parsed.name).toBe("qa-engineer");
    expect(parsed.effort).toBe("high");
    expect(parsed.description).toContain('ask "ตรวจงานหน่อย"');
    expect(parsed.body).toBe("You are QA. Never mark verified without inspecting code.");
  });

  it("keeps colons inside values — only the first colon splits", () => {
    const parsed = parseAgentMd("---\nname: x\ndescription: owns: the: thing\n---\nbody");
    expect(parsed.description).toBe("owns: the: thing");
  });

  it("fails loudly when name or description is missing", () => {
    expect(() => parseAgentMd("no frontmatter at all")).toThrow(/fence/);
    expect(() => parseAgentMd("---\ntools: Read\n---\nbody")).toThrow(/name/);
  });
});

describe("renderCodexBinding", () => {
  it("is deterministic and carries description/effort/body but no vendor model or tools", () => {
    const a = renderCodexBinding(SAMPLE_MD);
    const b = renderCodexBinding(SAMPLE_MD);
    expect(a).toBe(b);
    expect(a).toContain("model_reasoning_effort = 'high'");
    expect(a).toContain('developer_instructions = """');
    expect(a).not.toContain("sonnet");
    expect(a.endsWith('"""\n')).toBe(true);
  });

  it("escapes single quotes in literal strings by doubling them (TOML literal rule)", () => {
    const md = SAMPLE_MD.replace(
      "Verify work against",
      "It's about verifying — work against",
    );
    const out = renderCodexBinding(md);
    const descriptionLine = out.split("\n").find((l) => l.startsWith("description = "))!;
    expect(descriptionLine.startsWith("description = '")).toBe(true);
    expect(descriptionLine.endsWith("'")).toBe(true);
    expect(descriptionLine).toContain("It''s about verifying");
  });

  it("escapes triple quotes in the body so the multiline string stays intact", () => {
    const rendered = renderCodexBinding(SAMPLE_MD + '\nSay \\"\\"\\" never.\n');
    void rendered;
    const tricky = SAMPLE_MD + "\nNever emit \"\"\" in output.";
    const out = renderCodexBinding(tricky);
    expect(out).toContain('\\""');
  });

  it("round-trips losslessly through the adapter's own extractor (M1+M2 meet)", () => {
    const rendered = renderCodexBinding(SAMPLE_MD);
    const parsed = parseAgentMd(SAMPLE_MD);
    expect(extractDeveloperInstructions(rendered)).toBe(parsed.body);
  });

  it("refuses a body whose line ends with a backslash instead of emitting an ambiguous continuation", () => {
    const trailing = SAMPLE_MD + "\nC:\\path\\";
    expect(() => renderCodexBinding(trailing)).toThrow(/backslash/);
  });
});

describe("renderOpenCodeBinding", () => {
  it("is deterministic, carries description/mode:all/body, and never emits vendor fields", () => {
    const a = renderOpenCodeBinding(SAMPLE_MD);
    const b = renderOpenCodeBinding(SAMPLE_MD);
    expect(a).toBe(b);
    expect(a).toContain('description: "Verify work against requirement.md and design.md — ask \\"ตรวจงานหน่อย\\" first."');
    expect(a).toContain("mode: all");
    expect(a).toContain("You are QA. Never mark verified without inspecting code.");
    expect(a).not.toContain("sonnet");
    expect(a).not.toContain("tools:");
    expect(a).not.toContain("version:");
    // No `name:` — OpenCode names an agent by its filename.
    expect(a).not.toMatch(/^name:/m);
  });

  it("keeps Thai prose lossless in the body", () => {
    const rendered = renderOpenCodeBinding(SAMPLE_MD + "\nรายงานผลเป็นภาษาไทยเมื่อผู้ใช้ถามเป็นภาษาไทย.");
    expect(rendered).toContain("รายงานผลเป็นภาษาไทยเมื่อผู้ใช้ถามเป็นภาษาไทย.");
  });

  it("renders permission rules sorted, with patterns quoted so globs survive YAML", () => {
    const rendered = renderOpenCodeBinding(SAMPLE_MD, {
      bash: { "git status*": "allow", "git *": "deny" },
      write: { "_docs/module/**": "deny", "**": "allow" },
    });
    const bashIndex = rendered.indexOf("  bash:");
    const writeIndex = rendered.indexOf("  write:");
    expect(bashIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(bashIndex);
    const bashSection = rendered.slice(bashIndex, rendered.indexOf("  edit:") === -1 ? writeIndex : rendered.indexOf("  edit:"));
    expect(bashSection.indexOf('"git *"')).toBeLessThan(bashSection.indexOf('"git status*"'));
    expect(rendered).toContain('"git status*": allow');
    expect(rendered).toContain('"git *": deny');
    expect(rendered).toContain('"**": allow');
  });

  it("omits the permission section entirely when nothing is given", () => {
    expect(renderOpenCodeBinding(SAMPLE_MD)).not.toContain("permission");
    expect(renderOpenCodeBinding(SAMPLE_MD, {})).not.toContain("permission");
  });

  it("refuses a bare '---' line inside the body instead of emitting a self-truncating fence", () => {
    const tricky = SAMPLE_MD + "\n---\nOops, this reads as a new frontmatter block.\n";
    expect(() => renderOpenCodeBinding(tricky)).toThrow(/---/);
  });

  it("round-trips the body byte-for-byte through parseAgentMd", () => {
    const parsed = parseAgentMd(SAMPLE_MD);
    const rendered = renderOpenCodeBinding(SAMPLE_MD, { bash: GIT_READONLY_BASH_RULES });
    const reparsedBody = rendered.slice(rendered.indexOf("\n---\n") + 5).trim();
    expect(reparsedBody).toBe(parsed.body.trim());
  });

  it("withGitBashRules layers caller rules over the read-only git set", () => {
    const merged = withGitBashRules({ "npm test*": "allow" });
    expect(merged["git *"]).toBe("deny");
    expect(merged["git status*"]).toBe("allow");
    expect(merged["npm test*"]).toBe("allow");
    const overridden = withGitBashRules({ "git push": "ask" });
    expect(overridden["git push"]).toBe("ask");
  });
});

describe("checkBindings", () => {
  function writeSources(role: string): void {
    fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), SAMPLE_MD.replace("qa-engineer", role));
  }
  function writeGenerated(role: string): void {
    const md = fs.readFileSync(path.join(root, ".claude", "agents", `${role}.md`), "utf8");
    fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), renderCodexBinding(md));
    fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "agent", `${role}.md`),
      renderOpenCodeBinding(md, defaultOpenCodePermissions()),
    );
  }

  it("passes when every binding is the current rendering of its source", () => {
    writeSources("qa-engineer");
    writeGenerated("qa-engineer");
    writeSources("setup");
    writeGenerated("setup");
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });

  it("renders AGENTS.md as the bootstrap block plus a CLAUDE.md pointer and detects drift", () => {
    writeSources("qa-engineer");
    writeGenerated("qa-engineer");
    const pointer = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(pointer).toContain("<!-- sta:bootstrap -->");
    expect(pointer).toContain("[CLAUDE.md](CLAUDE.md)");
    fs.writeFileSync(path.join(root, "AGENTS.md"), pointer.replace("# bootstrap", "# drifted bootstrap"), "utf8");
    expect(checkBindings(root).problems.join("\n")).toMatch(/AGENTS\.md does not match/);
  });

  it("fails on drift when the .md source moves and the .toml does not follow", () => {
    writeSources("qa-engineer");
    writeGenerated("qa-engineer");
    fs.writeFileSync(
      path.join(root, ".claude", "agents", "qa-engineer.md"),
      SAMPLE_MD.replace("inspecting code", "inspecting code twice"),
    );
    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/qa-engineer.*does not match/);
  });

  it("fails on a missing twin and on an orphan rendering, naming the fix for each", () => {
    writeSources("qa-engineer");
    // A rendering with no authoring source anywhere = orphan.
    fs.writeFileSync(path.join(root, ".codex", "agents", "ghost-role.toml"), 'name = "ghost-role"\n');
    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/missing \.codex\/agents\/qa-engineer\.toml/);
    expect(result.problems.join("\n")).toMatch(/orphan \.codex\/agents\/ghost-role\.toml/);
  });

  it("fails closed when no sources exist at all", () => {
    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/no agent definitions/);
  });

  it("verifies the OpenCode set too: drift, missing twin, and orphan each fail with their fix", () => {
    writeSources("qa-engineer");
    writeGenerated("qa-engineer");
    const opencodePath = path.join(root, ".opencode", "agent", "qa-engineer.md");

    // Drift: the .md source moved but only the codex twin followed.
    fs.writeFileSync(
      path.join(root, ".claude", "agents", "qa-engineer.md"),
      SAMPLE_MD.replace("inspecting code", "inspecting code twice"),
    );
    let result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/\.opencode\/agent\/qa-engineer\.md does not match/);

    // Missing twin.
    fs.rmSync(opencodePath);
    result = checkBindings(root);
    expect(result.problems.join("\n")).toMatch(/missing \.opencode\/agent\/qa-engineer\.md/);

    // Orphan rendering with no source (another role stays behind so the
    // no-sources-at-all guard does not short-circuit first).
    writeSources("setup");
    writeGenerated("setup");
    fs.writeFileSync(opencodePath, "---\ndescription: ghost\nmode: all\n---\nghost\n", "utf8");
    fs.rmSync(path.join(root, ".claude", "agents", "qa-engineer.md"));
    result = checkBindings(root);
    expect(result.problems.join("\n")).toMatch(/orphan \.opencode\/agent\/qa-engineer\.md/);
  });
});

// ---------------------------------------------------------------------------
// Command renderings (T-OCC2 / T-CXC2) — one shortcut source, three runtimes
// ---------------------------------------------------------------------------

const GUARDRAILS_MD = [
  "---",
  "description: Shared guardrails imported by every /command in this repo.",
  "---",
  "Shared guardrails for every slash command below (imported via `@_shared/guardrails.md`):",
  "",
  "1. This command is a **prompt shortcut only**.",
  "2. Your role contract and `policies/` always win.",
  "3. Never decide what is reserved for people.",
  "4. Engineers never edit `plan.md`.",
  "5. Never perform state-changing git and never write outside the resolved workspace roots.",
].join("\n");

const COMMAND_MD = [
  "---",
  "description: Summarize a file or topic as tight bullets, hard-capped at 30 lines.",
  "argument-hint: [file or topic]",
  "---",
  "@_shared/guardrails.md",
  "",
  "Summarize: $ARGUMENTS",
  "",
  "Default output: bullets only, cap **30 lines**.",
].join("\n");

describe("parseCommandMd", () => {
  it("reads description/argument-hint and keeps $ARGUMENTS placeholders intact", () => {
    const parsed = parseCommandMd(COMMAND_MD);
    expect(parsed.description).toContain("hard-capped at 30 lines");
    expect(parsed.argumentHint).toBe("[file or topic]");
    expect(parsed.body).toBe("@_shared/guardrails.md\n\nSummarize: $ARGUMENTS\n\nDefault output: bullets only, cap **30 lines**.");
  });

  it("fails loudly without a description", () => {
    expect(() => parseCommandMd("---\nargument-hint: x\n---\nbody")).toThrow(/description/);
  });
});

describe("extractGuardrailRules", () => {
  it("keeps only the numbered rules, dropping the include-specific intro", () => {
    const rules = extractGuardrailRules(GUARDRAILS_MD);
    expect(rules.split("\n")[0]).toBe("1. This command is a **prompt shortcut only**.");
    expect(rules).not.toContain("@_shared/guardrails.md");
    expect(rules.split("\n")).toHaveLength(5);
  });

  it("fails closed when the include carries no numbered rules", () => {
    expect(() => extractGuardrailRules("---\ndescription: x\n---\nprose only")).toThrow(/numbered rules/);
  });
});

describe("renderOpenCodeCommand", () => {
  const rules = extractGuardrailRules(GUARDRAILS_MD);

  it("is deterministic, drops argument-hint, inlines guardrails, keeps the body verbatim", () => {
    const a = renderOpenCodeCommand("summarize", COMMAND_MD, rules);
    const b = renderOpenCodeCommand("summarize", COMMAND_MD, rules);
    expect(a).toBe(b);
    expect(a).toMatch(/^---\ndescription: "Summarize a file or topic[^"]*"\n---\n\n/);
    expect(a).not.toContain("argument-hint");
    expect(a).not.toContain("@_shared/");
    expect(a).toContain("1. This command is a **prompt shortcut only**.");
    expect(a).toContain("Summarize: $ARGUMENTS");
    expect(a).toContain("Default output: bullets only, cap **30 lines**.");
  });

  it("keeps Thai prose lossless", () => {
    const rendered = renderOpenCodeCommand("x", COMMAND_MD + "\nสรุปเป็นภาษาไทยเมื่อผู้ใช้ถามเป็นภาษาไทย.", rules);
    expect(rendered).toContain("สรุปเป็นภาษาไทยเมื่อผู้ใช้ถามเป็นภาษาไทย.");
  });
});

describe("renderCodexSkill", () => {
  const rules = extractGuardrailRules(GUARDRAILS_MD);

  it("emits name+description frontmatter, inlines guardrails, drops Claude-only syntax", () => {
    const rendered = renderCodexSkill("summarize", COMMAND_MD, rules);
    expect(rendered).toMatch(/^---\nname: summarize\ndescription: Summarize[^\n]*\n---\n/);
    expect(rendered).not.toContain("argument-hint");
    expect(rendered).not.toContain("@_shared/");
    expect(rendered).toContain("$ARGUMENTS");
  });

  it("ships the fixed implicit-invocation-off policy beside every SKILL.md", () => {
    expect(CODEX_SKILL_OPENAI_YAML).toBe("policy:\n  allow_implicit_invocation: false\n");
  });
});

describe("COMMAND_RENDERINGS", () => {
  it("covers both mirror runtimes with their documented layouts", () => {
    expect(COMMAND_RENDERINGS.map((s) => s.dir)).toEqual([".opencode/commands", ".agents/skills"]);
    expect(COMMAND_RENDERINGS[0]!.outputs("summarize")).toEqual(["summarize.md"]);
    expect(COMMAND_RENDERINGS[1]!.outputs("summarize")).toEqual(["summarize/SKILL.md", "summarize/agents/openai.yaml"]);
  });

  it("renders every declared output for a sample command", () => {
    const rules = extractGuardrailRules(GUARDRAILS_MD);
    for (const spec of COMMAND_RENDERINGS) {
      const rendered = spec.render("checklist", COMMAND_MD, rules);
      expect([...rendered.keys()].sort()).toEqual([...spec.outputs("checklist")].sort());
      for (const content of rendered.values()) {
        expect(content).not.toContain("argument-hint");
        expect(content).not.toContain("@_shared/");
      }
    }
  });
});

describe("checkBindings — command renderings (T-OCC3/T-CXC3)", () => {
  function writeAgentPair(role: string): void {
    fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), SAMPLE_MD.replace("qa-engineer", role));
    fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), renderCodexBinding(SAMPLE_MD.replace("qa-engineer", role)));
    fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "agent", `${role}.md`),
      renderOpenCodeBinding(SAMPLE_MD.replace("qa-engineer", role), defaultOpenCodePermissions()),
    );
  }
  function writeCommands(names: string[]): void {
    fs.mkdirSync(path.join(root, ".claude", "commands", "_shared"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "commands", "_shared", "guardrails.md"), GUARDRAILS_MD);
    for (const n of names) fs.writeFileSync(path.join(root, ".claude", "commands", `${n}.md`), COMMAND_MD);
  }
  function writeRendered(): void {
    const rules = extractGuardrailRules(fs.readFileSync(path.join(root, ".claude", "commands", "_shared", "guardrails.md"), "utf8"));
    for (const spec of COMMAND_RENDERINGS) {
      for (const name of listCommands(path.join(root, ".claude", "commands"))) {
        for (const [rel, bytes] of spec.render(name, fs.readFileSync(path.join(root, ".claude", "commands", `${name}.md`), "utf8"), rules)) {
          const dest = path.join(root, spec.dir, ...rel.split("/"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, bytes);
        }
      }
    }
  }

  it("passes when both families byte-match their sources", () => {
    writeAgentPair("qa-engineer");
    writeCommands(["summarize"]);
    writeRendered();
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });

  it("catches drift, a missing twin, and an orphan in each family", () => {
    writeAgentPair("qa-engineer");
    writeCommands(["summarize", "outline"]);
    writeRendered();

    // Drift: source moves, mirrors stay.
    fs.writeFileSync(path.join(root, ".claude", "commands", "summarize.md"), COMMAND_MD.replace("30 lines", "25 lines"));
    let result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/\.opencode\/commands\/summarize\.md does not match/);
    expect(result.problems.join("\n")).toMatch(/\.agents\/skills\/summarize\/SKILL\.md does not match/);

    // Missing twin (one file of the skills pair).
    fs.rmSync(path.join(root, ".agents", "skills", "summarize", "agents", "openai.yaml"));
    result = checkBindings(root);
    expect(result.problems.join("\n")).toMatch(/missing \.agents\/skills\/summarize\/agents\/openai\.yaml/);

    // Orphan: a rendering whose source is gone (another command stays behind,
    // so the no-sources-at-all guard does not short-circuit first).
    fs.rmSync(path.join(root, ".claude", "commands", "summarize.md"));
    result = checkBindings(root);
    expect(result.problems.join("\n")).toMatch(/orphan \.opencode\/commands\/summarize\.md/);
    expect(result.problems.join("\n")).toMatch(/orphan \.agents\/skills\/summarize\//);
  });

  it("skips command verification entirely when the workspace carries no commands payload", () => {
    writeAgentPair("qa-engineer");
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });

  it("fails loud when _shared/guardrails.md is broken instead of rendering without guardrails", () => {
    writeAgentPair("qa-engineer");
    fs.mkdirSync(path.join(root, ".claude", "commands", "_shared"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "commands", "summarize.md"), COMMAND_MD);
    fs.writeFileSync(path.join(root, ".claude", "commands", "_shared", "guardrails.md"), "no fence at all");
    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/cannot load _shared\/guardrails\.md/);
  });
});

describe("checkBindings — hook parity (M3)", () => {
  function writeBindingPair(role: string): void {
    const md = SAMPLE_MD.replace("qa-engineer", role);
    fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), md);
    fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), renderCodexBinding(md));
    fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "agent", `${role}.md`),
      renderOpenCodeBinding(md, defaultOpenCodePermissions()),
    );
  }
  function writeHook(dir: "claude" | "codex", name: string, content: string): void {
    fs.mkdirSync(path.join(root, `.${dir}`, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, `.${dir}`, "hooks", name), content, "utf8");
  }

  it("skips the section entirely when there are no hook sources to mirror", () => {
    writeBindingPair("qa-engineer");
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });

  it("passes when every mirror is byte-identical (LF-normalized) to its source", () => {
    writeBindingPair("qa-engineer");
    fs.mkdirSync(path.join(root, ".codex", "hooks"), { recursive: true });
    writeHook("claude", "block-git.js", "export default 1;\n");
    // Mirror arrives with CRLF line endings — same file after normalization.
    writeHook("codex", "block-git.js", "export default 1;\r\n");
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });

  it("fails with the re-copy fix named when a mirror drifted or went missing", () => {
    writeBindingPair("qa-engineer");
    writeHook("claude", "block-git.js", "const NEW = writableRootsSupported;\n");
    writeHook("codex", "block-git.js", "const OLD = noWritableRootsHere;\n"); // the U2 shape
    writeHook("claude", "block-outside-repo.js", "guard();\n");

    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/block-git\.js differs from its \.claude\/hooks source/);
    expect(result.problems.join("\n")).toMatch(/block-outside-repo\.js: missing \.codex\/hooks\//);
    expect(result.problems.join("\n")).toMatch(/re-copy \.claude\/hooks to \.codex\/hooks/);
  });

  it("flags an orphan mirror with no source", () => {
    writeBindingPair("qa-engineer");
    writeHook("claude", "block-git.js", "x;\n");
    writeHook("codex", "block-git.js", "x;\n");
    writeHook("codex", "ghost-hook.js", "y;\n");

    const result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/orphan \.codex\/hooks\/ghost-hook\.js/);
  });

  it("the CommonJS marker is mirrored too — a missing one fails exactly like the hooks were never fixed", () => {
    // The ESM-host failure mode: both directories' .js guards are present and
    // identical, but only .claude/hooks carries the package.json that pins them
    // to CommonJS. Under a "type": "module" host the Codex copies exit 1 and
    // enforce nothing, invisibly.
    writeBindingPair("qa-engineer");
    const marker = JSON.stringify({ "//": "Pins every hook to CommonJS.", type: "commonjs" }, null, 2) + "\n";
    writeHook("claude", "block-git.js", "x;\n");
    writeHook("codex", "block-git.js", "x;\n");

    writeHook("claude", "package.json", marker);
    let result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/package\.json: missing \.codex\/hooks\//);

    writeHook("codex", "package.json", marker.replace("commonjs", "module"));
    result = checkBindings(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/package\.json differs from its \.claude\/hooks source/);

    writeHook("codex", "package.json", marker);
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
  });
});
