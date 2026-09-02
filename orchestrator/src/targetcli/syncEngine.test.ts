import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { renderCodexBinding, renderCodexSkill, renderOpenCodeBinding, defaultOpenCodePermissions, extractGuardrailRules } from "../runtime/bindingGenerator.js";
import {
  blockingConflicts,
  planSync,
  runTargetSync,
  TargetDowngradeBlockedError,
  TargetSyncConflictError,
} from "./syncEngine.js";
import { classifySyncState } from "./version.js";
import { defaultTargetConfig, readTargetManifest, writeTargetConfig } from "./targetMeta.js";
import { stripBootstrapBlock } from "./knowledgeRender.js";

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-target-${prefix}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const AGENT_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;

/** Builds a fake Framework templates/ directory — same manifest.json shape build:templates emits. */
interface FixtureFile {
  relPath: string;
  content: string;
}
function makeTemplatesDir(version: string, files: FixtureFile[]): string {
  const dir = tmpRoot("framework");
  const entries = files.map((f) => {
    const abs = path.join(dir, f.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    return { path: f.relPath, sha256: sha256Of(f.content), size_bytes: Buffer.byteLength(f.content) };
  });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify({ schema_version: 1, framework_version: version, generated_at: "2026-01-01T00:00:00Z", files: entries.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`,
    "utf8",
  );
  const stack = path.join(dir, "stacks", "node", "stack.yaml");
  fs.mkdirSync(path.dirname(stack), { recursive: true });
  fs.writeFileSync(
    stack,
    "stack: node\nkind: backend\nlanguage: typescript\nruntime: node\nframeworks: [express]\ndatabase: []\napi: [rest]\npackage_manager: npm\ncommands:\n  install: npm install\n  build: npm run build\n  test: npm test\n  lint: npm run lint\n  typecheck: npm run typecheck\ncapabilities: [testing]\n",
    "utf8",
  );
  return dir;
}

function gitTarget(): string {
  const target = tmpRoot("target");
  fs.mkdirSync(path.join(target, ".git")); // standalone-repo marker, inspected locally like installation.ts does
  fs.writeFileSync(path.join(target, "package.json"), '{"name":"fixture"}\n', "utf8");
  fs.writeFileSync(path.join(target, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  return target;
}

const V1_FILES: FixtureFile[] = [
  { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer", "builds backend") },
  { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/.claude/hooks/block-git.js"]}]}]}}' },
];

const GUARDRAILS: FixtureFile = {
  relPath: ".claude/commands/_shared/guardrails.md",
  content:
    "---\ndescription: shared guardrails\n---\nShared guardrails for every slash command below:\n\n1. Prompt shortcut only.\n2. Contracts and policies win.\n",
};
const COMMAND_MD = (name: string): string =>
  `---\ndescription: Shortcut ${name}.\nargument-hint: [topic]\n---\n@_shared/guardrails.md\n\nRun ${name}: $ARGUMENTS\n`;
const COMMAND_FILES: FixtureFile[] = [
  GUARDRAILS,
  { relPath: ".claude/commands/summarize.md", content: COMMAND_MD("summarize") },
];

describe("command renderings at sync (T-OCC2..3 / T-CXC2..3)", () => {
  it("sync generates both command mirror families from the shipped sources", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", [...V1_FILES, ...COMMAND_FILES]);

    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });

    const source = fs.readFileSync(path.join(target, ".claude", "commands", "summarize.md"), "utf8");
    const rules = extractGuardrailRules(fs.readFileSync(path.join(target, ".claude", "commands", "_shared", "guardrails.md"), "utf8"));
    expect(fs.readFileSync(path.join(target, ".opencode", "commands", "summarize.md"), "utf8")).toContain("Run summarize: $ARGUMENTS");
    expect(fs.readFileSync(path.join(target, ".agents", "skills", "summarize", "SKILL.md"), "utf8")).toBe(
      renderCodexSkill("summarize", source, rules),
    );
    expect(fs.readFileSync(path.join(target, ".agents", "skills", "summarize", "agents", "openai.yaml"), "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
    const manifest = readTargetManifest(target);
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining([".opencode/commands/summarize.md", ".agents/skills/summarize/SKILL.md"]));
  });

  it("removing a command from the payload removes its pristine mirrors and conflicts on edited ones", () => {
    const target = gitTarget();
    const withCommand = makeTemplatesDir("1.0.0", [...V1_FILES, ...COMMAND_FILES]);
    runTargetSync({ targetRoot: target, templatesDir: withCommand, now: "2026-01-01T00:00:00Z" });

    const withoutCommand = makeTemplatesDir("1.1.0", [...V1_FILES, GUARDRAILS]);
    const result = runTargetSync({ targetRoot: target, templatesDir: withoutCommand, now: "2026-01-02T00:00:00Z" });
    expect(result.performed.filter((p) => p.action === "remove-stale").map((p) => p.path)).toEqual(
      expect.arrayContaining([".opencode/commands/summarize.md", ".agents/skills/summarize/SKILL.md", ".agents/skills/summarize/agents/openai.yaml"]),
    );
    expect(fs.existsSync(path.join(target, ".opencode", "commands", "summarize.md"))).toBe(false);
  });

  it("an edited mirror of a removed command stops the run instead of silently deleting work", () => {
    const target = gitTarget();
    const withCommand = makeTemplatesDir("1.0.0", [...V1_FILES, ...COMMAND_FILES]);
    runTargetSync({ targetRoot: target, templatesDir: withCommand, now: "2026-01-01T00:00:00Z" });

    const mirrorPath = path.join(target, ".opencode", "commands", "summarize.md");
    fs.writeFileSync(mirrorPath, "---\ndescription: hand-edited\n---\nlocal work\n");
    const withoutCommand = makeTemplatesDir("1.1.0", [...V1_FILES, GUARDRAILS]);

    expect(() => runTargetSync({ targetRoot: target, templatesDir: withoutCommand, now: "2026-01-02T00:00:00Z" })).toThrow(TargetSyncConflictError);
  });
});

describe("safe sync engine", () => {
  it("first sync adds every managed file and generates codex renderings", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", V1_FILES);

    const result = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });

    expect(fs.existsSync(path.join(target, ".claude", "agents", "backend-engineer.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "settings.json"))).toBe(true);
    expect(fs.readFileSync(path.join(target, ".codex", "agents", "backend-engineer.toml"), "utf8")).toBe(
      renderCodexBinding(AGENT_MD("backend-engineer", "builds backend")),
    );
    const manifest = readTargetManifest(target);
    expect(manifest.framework_version).toBe("1.0.0");
    expect(result.skippedConflicts).toEqual([]);
    // Both shipped payload and derived rendering are claimed by the manifest.
    expect(manifest.files.map((f) => f.path)).toContain(".codex/agents/backend-engineer.toml");
  });

  it("re-sync without changes writes nothing new (idempotent)", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });

    const second = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-02T00:00:00Z" });

    expect(second.performed.filter((p) => p.action !== "unchanged")).toEqual([]);
    expect(second.backupDir).toBeUndefined();
  });

  it("an interrupted update (file written, manifest not yet updated) converges on the next sync without a false conflict", () => {
    // Simulates a crash between the file write and the manifest commit of an
    // upgrade: disk already carries the V2 bytes, the manifest still claims V1.
    // The invariant that matters: user work is never lost and the next sync
    // recognises the state instead of demanding --force.
    const v2Files: FixtureFile[] = [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer", "builds backend, v2 edition") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"a":2}]}}' },
    ];
    const target = gitTarget();
    const v1 = makeTemplatesDir("1.0.0", V1_FILES);
    const v2 = makeTemplatesDir("2.0.0", v2Files);
    runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-01T00:00:00Z" });

    // The crash: the upgrade's new bytes landed on disk but the manifest commit
    // never happened — so recovery runs against the same shipped v2 templates.
    for (const file of v2Files) fs.writeFileSync(path.join(target, file.relPath), file.content, "utf8");

    const recovery = runTargetSync({ targetRoot: target, templatesDir: v2, now: "2026-01-03T00:00:00Z" });
    expect(recovery.skippedConflicts).toEqual([]);
    // The interrupted primaries are recognised, never re-conflicted or rewritten;
    // only renderings derived from them may legitimately regenerate.
    expect(
      recovery.performed.filter((p) => ["add", "update", "restore"].includes(p.action) && p.path.startsWith(".claude/")),
    ).toEqual([]);
    expect(readTargetManifest(target).files.map((f) => f.sha256)).toContain(sha256Of(Buffer.from(v2Files[0]!.content)));
  });

  it("detects a user-modified managed file as a conflict and never overwrites silently", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });
    const settingsPath = path.join(target, ".claude", "settings.json");
    fs.writeFileSync(settingsPath, '{"hooks":{"PreToolUse":[{"edited":true}]}}', "utf8");

    try {
      runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-02T00:00:00Z" });
      throw new Error("expected TargetSyncConflictError");
    } catch (e) {
      expect(e).toBeInstanceOf(TargetSyncConflictError);
      const conflictError = e as TargetSyncConflictError;
      expect(conflictError.plan.conflicts.map((c) => c.path)).toEqual([".claude/settings.json"]);
      expect(conflictError.plan.conflicts[0]!.kind).toBe("user-modified");
    }
    // Local edit survived untouched.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe('{"hooks":{"PreToolUse":[{"edited":true}]}}');
  });

  it("--force overwrites a conflicted file after backing up the local copy", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });
    const settingsPath = path.join(target, ".claude", "settings.json");
    fs.writeFileSync(settingsPath, '{"local":"edit"}', "utf8");

    const result = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-02T00:00:00Z", force: true });

    expect(result.performed.find((p) => p.path === ".claude/settings.json")?.action).toBe("update");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(V1_FILES[1]!.content);
    expect(result.backupDir).toBeDefined();
    expect(fs.readFileSync(path.join(result.backupDir!, ".claude", "settings.json"), "utf8")).toBe('{"local":"edit"}');
  });

  it("reports an untracked pre-existing managed path, skips it, and never claims it", () => {
    const target = gitTarget();
    // The payload manages CLAUDE.md...
    const templatesDir = makeTemplatesDir("1.0.0", [...V1_FILES, { relPath: "CLAUDE.md", content: "# Framework instructions\n" }]);
    // ...but the project already had its own before init ever ran.
    fs.writeFileSync(path.join(target, "CLAUDE.md"), "# my own instructions\n", "utf8");

    const result = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });

    expect(result.skippedConflicts.map((c) => c.path)).toEqual(["CLAUDE.md"]);
    expect(result.skippedConflicts[0]!.kind).toBe("untracked-file");
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("# my own instructions\n");
    // Unclaimed: the manifest must not pretend the Framework owns it.
    expect(readTargetManifest(target).files.some((f) => f.path === "CLAUDE.md")).toBe(false);
    // Everything else still synced.
    expect(fs.existsSync(path.join(target, ".claude", "settings.json"))).toBe(true);
  });

  it("removes stale managed files only while pristine, conflicts once edited", () => {
    const target = gitTarget();
    const v1 = makeTemplatesDir("1.0.0", [...V1_FILES, { relPath: ".claude/agents/old-agent.md", content: AGENT_MD("old-agent", "legacy role") }]);
    runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-01T00:00:00Z" });

    // v2 drops old-agent.md; the pristine copy goes, cleanly.
    const v2 = makeTemplatesDir("2.0.0", V1_FILES);
    const result = runTargetSync({ targetRoot: target, templatesDir: v2, now: "2026-01-02T00:00:00Z" });
    expect(fs.existsSync(path.join(target, ".claude", "agents", "old-agent.md"))).toBe(false);
    expect(result.frameworkVersion).toBe("2.0.0");
    expect(readTargetManifest(target).files.some((f) => f.path.includes("old-agent"))).toBe(false);

    // A modified stale file is never deleted — it becomes a conflict.
    const target2 = gitTarget();
    runTargetSync({ targetRoot: target2, templatesDir: v1, now: "2026-01-01T00:00:00Z" });
    const stalePath = path.join(target2, ".claude", "agents", "old-agent.md");
    fs.writeFileSync(stalePath, "locally improved legacy agent", "utf8");
    expect(() => runTargetSync({ targetRoot: target2, templatesDir: v2, now: "2026-01-03T00:00:00Z" })).toThrow(TargetSyncConflictError);
    expect(fs.readFileSync(stalePath, "utf8")).toBe("locally improved legacy agent");
  });

  it("honours overrides: a claimed file survives sync even when upstream changed", () => {
    const target = gitTarget();
    const v1 = makeTemplatesDir("1.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-01T00:00:00Z" });
    writeTargetConfig(target, { ...defaultTargetConfig("my-project", "2026-01-01T00:00:00Z"), overrides: [".claude/settings.json"] });
    fs.writeFileSync(path.join(target, ".claude", "settings.json"), '{"project":"specific"}', "utf8");

    const v2 = makeTemplatesDir("1.1.0", [{ ...V1_FILES[0]! }, { relPath: ".claude/settings.json", content: '{"framework":"new-shape"}' }]);
    const result = runTargetSync({ targetRoot: target, templatesDir: v2, now: "2026-01-02T00:00:00Z" });

    expect(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8")).toBe('{"project":"specific"}');
    expect(result.performed.find((p) => p.path === ".claude/settings.json")?.action).toBe("override");
    expect(() => planSync({ targetRoot: target, templatesDir: v2, manifest: readTargetManifest(target), config: defaultTargetConfig("x", "now") })).not.toThrow();
  });

  it("keeps a claimed file out of the manifest, then safely merges it when the project removes the override", () => {
    // Regression: an override recorded the TEMPLATE's hash even though sync
    // never wrote the file. Un-claiming the path then read as "tracked file
    // edited after sync" (blocking) instead of "the project owns this path"
    // (skipped) — a workspace that sync had just accepted.
    const target = gitTarget();
    const v1 = makeTemplatesDir("1.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-01T00:00:00Z" });

    const settingsPath = path.join(target, ".claude", "settings.json");
    fs.writeFileSync(settingsPath, '{"project":"specific"}', "utf8");
    const claimed = { ...defaultTargetConfig("my-project", "2026-01-01T00:00:00Z"), overrides: [".claude/settings.json"] };
    writeTargetConfig(target, claimed);
    runTargetSync({ targetRoot: target, templatesDir: v1, config: claimed, manifest: readTargetManifest(target), now: "2026-01-02T00:00:00Z" });

    // A file sync deliberately left alone is not claimed in the manifest.
    expect(readTargetManifest(target).files.some((f) => f.path === ".claude/settings.json")).toBe(false);

    // Un-claiming it plans the structured guard merge instead of claiming the
    // whole file or mislabelling the project's bytes as a local edit.
    const unclaimed = defaultTargetConfig("my-project", "2026-01-01T00:00:00Z");
    writeTargetConfig(target, unclaimed);
    const plan = planSync({ targetRoot: target, templatesDir: v1, manifest: readTargetManifest(target), config: unclaimed });
    expect(plan.conflicts).toEqual([]);
    expect(blockingConflicts(plan)).toEqual([]);
    expect(plan.entries).toContainEqual(expect.objectContaining({ action: "update", path: ".claude/settings.json" }));
    expect(fs.readFileSync(settingsPath, "utf8")).toBe('{"project":"specific"}');
  });

  it("refuses to manage application source or escape the repo root", () => {
    const target = gitTarget();
    const bad = makeTemplatesDir("9.9.9", [
      { relPath: "src/payment.ts", content: "// application logic must never be framework-managed" },
      { relPath: "../escape.md", content: "nope" },
    ]);
    expect(() => runTargetSync({ targetRoot: target, templatesDir: bad, now: "2026-01-01T00:00:00Z" })).toThrow(/src\/payment\.ts|escape\.md/);
    expect(fs.existsSync(path.join(target, "src"))).toBe(false);
  });

  it("updates version metadata on upgrade so status can see OUTDATED before it", () => {
    const target = gitTarget();
    const v1 = makeTemplatesDir("1.2.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-01T00:00:00Z" });
    expect(readTargetManifest(target).framework_version).toBe("1.2.0");

    const v2 = makeTemplatesDir("1.3.0", [...V1_FILES, { relPath: ".claude/scripts/new-checker.js", content: "module.exports = () => true;\n" }]);
    runTargetSync({ targetRoot: target, templatesDir: v2, now: "2026-01-02T00:00:00Z" });

    const manifest = readTargetManifest(target);
    expect(manifest.framework_version).toBe("1.3.0");
    expect(manifest.installed_at).toBe("2026-01-01T00:00:00Z"); // installed_at survives upgrades
    expect(manifest.updated_at).toBe("2026-01-02T00:00:00Z");
    expect(fs.existsSync(path.join(target, ".claude", "scripts", "new-checker.js"))).toBe(true);
  });

  it("blocks cross-major downgrades unless --force; same-major moves pass (packaging checklist: downgrade)", () => {
    const target = gitTarget();
    const v2 = makeTemplatesDir("2.0.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir: v2, now: "2026-01-01T00:00:00Z" });

    // Installing an older major's payload must never happen silently.
    const v1 = makeTemplatesDir("1.9.0", V1_FILES);
    expect(() => runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-02T00:00:00Z" })).toThrow(TargetDowngradeBlockedError);
    expect(readTargetManifest(target).framework_version).toBe("2.0.0"); // untouched

    // Explicit --force accepts the destructive move.
    const forced = runTargetSync({ targetRoot: target, templatesDir: v1, now: "2026-01-03T00:00:00Z", force: true });
    expect(forced.frameworkVersion).toBe("1.9.0");
    expect(readTargetManifest(target).framework_version).toBe("1.9.0");

    // Same-major backwards steps are ordinary updates.
    const v13 = makeTemplatesDir("1.3.0", V1_FILES);
    runTargetSync({ targetRoot: target, templatesDir: v13, now: "2026-01-04T00:00:00Z" });
    const v12 = makeTemplatesDir("1.2.0", V1_FILES);
    expect(() => runTargetSync({ targetRoot: target, templatesDir: v12, now: "2026-01-05T00:00:00Z" })).not.toThrow();
  });
});

describe("safe sync engine — OpenCode renderings (T-OC2)", () => {
  it("generates .opencode/agent/<role>.md from agent sources on first sync and tracks it", () => {
    const target = gitTarget();
    const templatesDir = makeTemplatesDir("1.0.0", V1_FILES);

    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z" });

    const abs = path.join(target, ".opencode", "agent", "backend-engineer.md");
    expect(fs.existsSync(abs)).toBe(true);
    const expected = renderOpenCodeBinding(V1_FILES[0]!.content, defaultOpenCodePermissions());
    expect(fs.readFileSync(abs, "utf8")).toBe(expected);
    expect(readTargetManifest(target).files.map((f) => f.path)).toContain(".opencode/agent/backend-engineer.md");
  });

  it("regenerates the opencode rendering when its source changes", () => {
    const target = gitTarget();
    runTargetSync({ targetRoot: target, templatesDir: makeTemplatesDir("1.0.0", V1_FILES), now: "2026-01-01T00:00:00Z" });

    const updated = AGENT_MD("backend-engineer", "builds backend, now better");
    runTargetSync({ targetRoot: target, templatesDir: makeTemplatesDir("1.1.0", [{ ...V1_FILES[0]!, content: updated }]), now: "2026-01-02T00:00:00Z" });

    const abs = path.join(target, ".opencode", "agent", "backend-engineer.md");
    expect(fs.readFileSync(abs, "utf8")).toBe(renderOpenCodeBinding(updated, defaultOpenCodePermissions()));
  });

  it("remove-stale cleans a removed role's pristine rendering; an edited one conflicts instead", () => {
    const bothAgents: FixtureFile[] = [
      V1_FILES[0]!,
      { relPath: ".claude/agents/qa-engineer.md", content: AGENT_MD("qa-engineer", "verifies work") },
      V1_FILES[1]!,
    ];
    const onlyBackend = makeTemplatesDir("1.1.0", [V1_FILES[0]!]);

    // Pristine → removed silently (backed up).
    const clean = gitTarget();
    runTargetSync({ targetRoot: clean, templatesDir: makeTemplatesDir("1.0.0", bothAgents), now: "2026-01-01T00:00:00Z" });
    const result = runTargetSync({ targetRoot: clean, templatesDir: onlyBackend, now: "2026-01-02T00:00:00Z" });
    expect(fs.existsSync(path.join(clean, ".opencode", "agent", "qa-engineer.md"))).toBe(false);
    expect(result.performed.some((p) => p.path === ".opencode/agent/qa-engineer.md" && p.action === "remove-stale")).toBe(true);

    // Edited → blocks exactly like any other stale-modified file.
    const edited = gitTarget();
    runTargetSync({ targetRoot: edited, templatesDir: makeTemplatesDir("1.0.0", bothAgents), now: "2026-01-01T00:00:00Z" });
    fs.writeFileSync(path.join(edited, ".opencode", "agent", "qa-engineer.md"), "---\ndescription: mine\nmode: all\n---\nmine\n", "utf8");
    expect(() => runTargetSync({ targetRoot: edited, templatesDir: onlyBackend, now: "2026-01-03T00:00:00Z" })).toThrow(TargetSyncConflictError);
  });

  it("leaves a foreign pre-existing opencode agent file alone and unclaimed", () => {
    const target = gitTarget();
    fs.mkdirSync(path.join(target, ".opencode", "agent"), { recursive: true });
    fs.writeFileSync(path.join(target, ".opencode", "agent", "backend-engineer.md"), "---\ndescription: the project's own\nmode: all\n---\nowned\n", "utf8");

    runTargetSync({ targetRoot: target, templatesDir: makeTemplatesDir("1.0.0", V1_FILES), now: "2026-01-01T00:00:00Z" });

    expect(fs.readFileSync(path.join(target, ".opencode", "agent", "backend-engineer.md"), "utf8")).toContain("the project's own");
    expect(readTargetManifest(target).files.map((f) => f.path)).not.toContain(".opencode/agent/backend-engineer.md");
  });
});

// --- T-WG7 — DEV-workspace rendering of CLAUDE.md + the generated include ---

const DEV_V1: FixtureFile[] = [
  { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer", "builds backend") },
  { relPath: "CLAUDE.md", content: "# Rules\n\nRead `_docs/status.md` first.\n" },
  { relPath: "AGENTS.md", content: "generated at sync\n" },
];

function knowledgeRootFixture(): string {
  const root = tmpRoot("knowledge");
  fs.writeFileSync(path.join(root, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
  return root;
}

function installationConfigFixture(knowledgeRoot: string): string {
  const file = path.join(tmpRoot("install"), "installation.yaml");
  fs.writeFileSync(file, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`, "utf8");
  return file;
}

describe("DEV-workspace Knowledge rendering (T-WG7)", () => {
  it("renders CLAUDE.md with the banner and writes the include for a dev workspace", () => {
    const target = gitTarget();
    writeTargetConfig(target, defaultTargetConfig("app", "2026-01-01T00:00:00Z", "dev"));
    const knowledge = knowledgeRootFixture();

    const result = runTargetSync({
      targetRoot: target,
      templatesDir: makeTemplatesDir("1.0.0", DEV_V1),
      now: "2026-01-01T00:00:00Z",
      installationConfigPath: installationConfigFixture(knowledge),
    });

    const claude = fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8");
    expect(claude.startsWith("<!-- sta:bootstrap -->")).toBe(true);
    expect(claude).toContain(knowledge);
    expect(claude).toContain("Read `_docs/status.md` first."); // body preserved under the banner
    const include = fs.readFileSync(path.join(target, ".claude", "shared", "knowledge-root.md"), "utf8");
    expect(include).toContain(`KNOWLEDGE_ROOT=${knowledge}`);
    const paths = readTargetManifest(target).files.map((f) => f.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/shared/knowledge-root.md");
    expect(result.performed.some((p) => p.path === "CLAUDE.md" && p.action === "add")).toBe(true);
  });

  it("re-sync without changes leaves the rendered workspace untouched (idempotent)", () => {
    const target = gitTarget();
    writeTargetConfig(target, defaultTargetConfig("app", "now", "dev"));
    const installation = installationConfigFixture(knowledgeRootFixture());
    const templatesDir = makeTemplatesDir("1.0.0", DEV_V1);
    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z", installationConfigPath: installation });

    const second = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-02T00:00:00Z", installationConfigPath: installation });

    expect(second.performed.filter((p) => p.action !== "unchanged")).toEqual([]);
    expect(second.skippedConflicts).toEqual([]);
  });

  it("re-renders when the binding moves and reports updates, not conflicts", () => {
    const target = gitTarget();
    writeTargetConfig(target, defaultTargetConfig("app", "now", "dev"));
    const templatesDir = makeTemplatesDir("1.0.0", DEV_V1);
    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z", installationConfigPath: installationConfigFixture(knowledgeRootFixture()) });

    const moved = knowledgeRootFixture();
    const result = runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-02T00:00:00Z", installationConfigPath: installationConfigFixture(moved) });

    expect(result.skippedConflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toContain(moved);
    expect(fs.readFileSync(path.join(target, ".claude", "shared", "knowledge-root.md"), "utf8")).toContain(moved);
  });

  it("renders the BA bootstrap over a byte-identical template body and writes no Knowledge include", () => {
    const target = gitTarget();
    writeTargetConfig(target, defaultTargetConfig("kb", "now", "ba"));
    const templatesDir = makeTemplatesDir("1.0.0", DEV_V1);

    runTargetSync({ targetRoot: target, templatesDir, now: "2026-01-01T00:00:00Z", installationConfigPath: installationConfigFixture(knowledgeRootFixture()) });

    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe(DEV_V1[1]!.content);
    expect(fs.existsSync(path.join(target, ".claude", "shared", "knowledge-root.md"))).toBe(false);
  });

  it("injects only the delimited block into a foreign project-owned CLAUDE.md and records the binding include", () => {
    const target = gitTarget();
    writeTargetConfig(target, defaultTargetConfig("app", "now", "dev"));
    fs.writeFileSync(path.join(target, "CLAUDE.md"), "# The project's own instructions\n", "utf8");

    const result = runTargetSync({
      targetRoot: target,
      templatesDir: makeTemplatesDir("1.0.0", DEV_V1),
      now: "2026-01-01T00:00:00Z",
      installationConfigPath: installationConfigFixture(knowledgeRootFixture()),
    });

    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe("# The project's own instructions\n");
    expect(result.skippedConflicts.map((c) => c.path)).not.toContain("CLAUDE.md");
    expect(readTargetManifest(target).files.map((f) => f.path)).not.toContain("CLAUDE.md");
    expect(readTargetManifest(target).framework_blocks?.map((block) => block.path)).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(target, ".claude", "shared", "knowledge-root.md"), "utf8")).toContain("KNOWLEDGE_ROOT=");
  });
});

describe("T-V3-07 AGENTS.md rendered pointer ownership", () => {
  function sync(target: string, extra: Partial<Parameters<typeof runTargetSync>[0]> = {}) {
    writeTargetConfig(target, defaultTargetConfig("app", "now", "dev"));
    return runTargetSync({
      targetRoot: target,
      templatesDir: makeTemplatesDir("1.0.0", DEV_V1),
      now: "2026-01-01T00:00:00Z",
      installationConfigPath: installationConfigFixture(knowledgeRootFixture()),
      ...extra,
    });
  }

  it("adds and manifest-tracks the short pointer when AGENTS.md is absent", () => {
    const target = gitTarget();
    sync(target);
    const agents = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("[CLAUDE.md](CLAUDE.md)");
    expect(readTargetManifest(target).files.map((entry) => entry.path)).toContain("AGENTS.md");
  });

  it("injects only the managed block into project-owned AGENTS.md and preserves every outside byte", () => {
    const target = gitTarget();
    const own = "# Project rules\r\nKeep this exact.\r\n";
    fs.writeFileSync(path.join(target, "AGENTS.md"), own, "utf8");
    sync(target);
    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"))).toBe(own);
    expect(readTargetManifest(target).framework_blocks?.map((entry) => entry.path)).toContain("AGENTS.md");
    expect(readTargetManifest(target).files.map((entry) => entry.path)).not.toContain("AGENTS.md");
  });

  it("reduces a provable duplicate only with dedicated confirmation, backing up the full prior file", () => {
    const target = gitTarget();
    const duplicate = "# Same project rules\n";
    fs.writeFileSync(path.join(target, "CLAUDE.md"), duplicate, "utf8");
    fs.writeFileSync(path.join(target, "AGENTS.md"), duplicate, "utf8");
    const first = sync(target);
    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"))).toBe(duplicate);
    const second = sync(target, { now: "2026-01-02T00:00:00Z", manifest: readTargetManifest(target), config: undefined, confirmAgentsPointer: true });
    const reduced = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
    expect(reduced).toContain("[CLAUDE.md](CLAUDE.md)");
    expect(stripBootstrapBlock(reduced)).not.toBe(duplicate);
    expect(second.backupDir).toBeTruthy();
    expect(fs.readFileSync(path.join(second.backupDir!, "AGENTS.md"), "utf8")).toContain(duplicate);
  });

  it("never deletes AGENTS.md when a later payload drops it", () => {
    const target = gitTarget();
    sync(target);
    const before = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
    const config = defaultTargetConfig("app", "now", "dev");
    runTargetSync({ targetRoot: target, templatesDir: makeTemplatesDir("1.1.0", DEV_V1.filter((entry) => entry.relPath !== "AGENTS.md")), manifest: readTargetManifest(target), config, now: "2026-01-03T00:00:00Z", installationConfigPath: installationConfigFixture(knowledgeRootFixture()) });
    expect(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8")).toBe(before);
  });
});

describe("sync-state classification (packaging checklist: READY/OUTDATED/INCOMPATIBLE)", () => {
  it("uses version strings only for the major-version compatibility stop", () => {
    expect(classifySyncState("1.2.0", "1.2.0")).toBeUndefined();
    expect(classifySyncState("1.2.0", "1.3.0")).toBeUndefined();
    expect(classifySyncState("1.3.0", "1.2.9")).toBeUndefined();
    expect(classifySyncState("1.2.0", "2.0.0")).toBe("INCOMPATIBLE");
    expect(classifySyncState("2.0.0", "1.2.0")).toBe("INCOMPATIBLE");
  });
});
