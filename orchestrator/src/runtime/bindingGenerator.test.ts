import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBindings, parseAgentMd, renderCodexBinding } from "./bindingGenerator.js";
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

describe("checkBindings", () => {
  function writeSources(role: string): void {
    fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), SAMPLE_MD.replace("qa-engineer", role));
  }
  function writeGenerated(role: string): void {
    const md = fs.readFileSync(path.join(root, ".claude", "agents", `${role}.md`), "utf8");
    fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), renderCodexBinding(md));
  }

  it("passes when every binding is the current rendering of its source", () => {
    writeSources("qa-engineer");
    writeGenerated("qa-engineer");
    writeSources("setup");
    writeGenerated("setup");
    expect(checkBindings(root)).toEqual({ ok: true, problems: [] });
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
});

describe("checkBindings — hook parity (M3)", () => {
  function writeBindingPair(role: string): void {
    const md = SAMPLE_MD.replace("qa-engineer", role);
    fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), md);
    fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), renderCodexBinding(md));
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
