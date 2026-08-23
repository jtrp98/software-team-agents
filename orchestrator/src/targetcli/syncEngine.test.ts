import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { renderCodexBinding } from "../runtime/bindingGenerator.js";
import {
  planSync,
  runTargetSync,
  TargetDowngradeBlockedError,
  TargetSyncConflictError,
} from "./syncEngine.js";
import { classifySyncState } from "./version.js";
import { defaultTargetConfig, readTargetManifest, writeTargetConfig } from "./targetMeta.js";

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
  return dir;
}

function gitTarget(): string {
  const target = tmpRoot("target");
  fs.mkdirSync(path.join(target, ".git")); // standalone-repo marker, inspected locally like installation.ts does
  return target;
}

const V1_FILES: FixtureFile[] = [
  { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer", "builds backend") },
  { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"a":1}]}}' },
];

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

describe("sync-state classification (packaging checklist: READY/OUTDATED/INCOMPATIBLE)", () => {
  it("distinguishes up-to-date, patch/minor drift, and major incompatibility", () => {
    expect(classifySyncState("1.2.0", "1.2.0")).toBe("UP_TO_DATE");
    expect(classifySyncState("1.2.0", "1.3.0")).toBe("OUTDATED");
    expect(classifySyncState("1.3.0", "1.2.9")).toBe("OUTDATED");
    expect(classifySyncState("1.2.0", "2.0.0")).toBe("INCOMPATIBLE");
    expect(classifySyncState("2.0.0", "1.2.0")).toBe("INCOMPATIBLE");
  });
});
