import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyCleanup, CleanupUnmanagedWorkspaceError, planCleanup, renderCleanupPlan } from "./cleanupCommand.js";
import { runTargetSync } from "./syncEngine.js";
import { defaultTargetConfig, loadTargetConfig, readTargetManifest, writeTargetConfig } from "./targetMeta.js";
import { GITIGNORE_BLOCK_CLOSE, GITIGNORE_BLOCK_OPEN } from "./knowledgeRender.js";
import { rollbackSta } from "../packaging/rollback.js";
import { runTargetCli } from "./cli.js";

/**
 * V10 TASK-029 — reversible payload cleanup for a workspace the framework no
 * longer manages. The invariants under test are the destructive-action guard
 * rails: plan-only by default, an explicit human `--yes` moves anything,
 * manifest-tracked files only, user overrides untouched, and the backup
 * snapshot rolls back with the ordinary rollback mechanism.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL_TEMPLATES = path.join(REPO_ROOT, "templates");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-cleanup-${prefix}-`));
  roots.push(root);
  return root;
}

function knowledgeWorkspace(): string {
  const root = tmpRoot("ws");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "knowledge"));
  fs.writeFileSync(path.join(root, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
  return root;
}

/** A workspace that really synced the shipped payload, plus two files that were never the framework's. */
function managedWorkspace(): { ws: string; untracked: string; untrackedBytes: string } {
  const ws = knowledgeWorkspace();
  runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role: "ba", now: "2026-09-17T00:00:00Z" });
  // sync alone never writes config.yaml (init does); a managed workspace has one.
  writeTargetConfig(ws, defaultTargetConfig(path.basename(ws), "2026-09-17T00:00:00Z", "ba"));
  const untracked = path.join(ws, "src", "app.ts");
  fs.mkdirSync(path.dirname(untracked), { recursive: true });
  const untrackedBytes = "export const app = () => 1;\n";
  fs.writeFileSync(untracked, untrackedBytes, "utf8");
  return { ws, untracked, untrackedBytes };
}

function dirHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git") continue;
      if (rel === "" && name === ".agent-team" && !fs.existsSync(path.join(dir, name, "manifest.json"))) {
        // after a cleanup+rollback the backup snapshot still exists (rollback
        // never deletes it); excluding backups/ lets before/after compare.
        continue;
      }
      if (rel === ".agent-team" && name === "backups") continue;
      const abs = path.join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, key);
      else out.set(key, fs.readFileSync(abs).toString("hex"));
    }
  };
  walk(root, "");
  return out;
}

describe("V10 TASK-029 — payload cleanup is reversible and guarded", () => {
  it("plans manifest-tracked files only, and a dry run touches nothing on disk", async () => {
    const { ws } = managedWorkspace();
    const before = dirHash(ws);

    const plan = planCleanup({ targetRoot: ws });
    const render = renderCleanupPlan(plan);
    expect(render.movedCount).toBeGreaterThan(50);
    expect(plan.entries.map((e) => e.path)).toContain("contracts/qa-engineer.yaml");
    expect(plan.entries.map((e) => e.path)).toContain("CLAUDE.md");
    expect(plan.gitignoreBlock).toBe(true);

    // The CLI dry run exits 0 and changes not one byte.
    const code = await runTargetCli(["cleanup", "--dry-run"], ws, REPO_ROOT);
    expect(code).toBe(0);
    expect(dirHash(ws)).toEqual(before);
  });

  it("moves only manifest files, keeps user overrides and non-manifest files, and strips the managed gitignore block", async () => {
    const { ws, untracked, untrackedBytes } = managedWorkspace();

    // Claim one payload file the way a user would.
    const config = loadTargetConfig(ws)!;
    config.overrides = [...config.overrides, "policies/coding.md"];
    writeTargetConfig(ws, config);

    const plan = planCleanup({ targetRoot: ws });
    expect(plan.entries.find((e) => e.path === "policies/coding.md")?.action).toBe("keep-override");

    const result = applyCleanup(plan, "2026-09-17T01:02:03.000Z");
    expect(result.moved).toContain("contracts/qa-engineer.yaml");
    expect(result.keptOverrides).toEqual(["policies/coding.md"]);
    expect(fs.existsSync(path.join(ws, "policies", "coding.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "contracts", "qa-engineer.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".claude", "agents", "backend-engineer.md"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".agent-team", "manifest.json"))).toBe(false);

    // A non-manifest file is byte-identical.
    expect(fs.readFileSync(untracked, "utf8")).toBe(untrackedBytes);

    // The managed block is gone; the project's own rules (outside the block) survive.
    const gitignore = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
    expect(gitignore).not.toContain(GITIGNORE_BLOCK_OPEN);
    expect(gitignore).not.toContain(GITIGNORE_BLOCK_CLOSE);
    expect(result.gitignoreStripped).toBe(true);
    expect(fs.existsSync(path.join(result.backupDir, ".gitignore"))).toBe(true);
  });

  it("a claimed .gitignore keeps its managed block and is reported", () => {
    const ws = knowledgeWorkspace();
    runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role: "ba", now: "2026-09-17T00:00:00Z" });
    writeTargetConfig(ws, defaultTargetConfig(path.basename(ws), "2026-09-17T00:00:00Z", "ba"));
    const config = loadTargetConfig(ws)!;
    config.overrides = [...config.overrides, ".gitignore"];
    writeTargetConfig(ws, config);

    const plan = planCleanup({ targetRoot: ws });
    expect(plan.gitignoreClaimed).toBe(true);
    expect(plan.gitignoreBlock).toBe(false);

    const result = applyCleanup(plan, "2026-09-17T01:02:03.000Z");
    expect(result.gitignoreStripped).toBe(false);
    expect(fs.readFileSync(path.join(ws, ".gitignore"), "utf8")).toContain(GITIGNORE_BLOCK_OPEN);
  });

  it("rolls back with the ordinary mechanism: every moved file returns byte-identical and the workspace is managed again", () => {
    const { ws } = managedWorkspace();
    const before = dirHash(ws);

    const plan = planCleanup({ targetRoot: ws });
    applyCleanup(plan, "2026-09-17T01:02:03.000Z");
    expect(fs.existsSync(path.join(ws, "CLAUDE.md"))).toBe(false);

    rollbackSta(ws);
    expect(dirHash(ws)).toEqual(before);
    expect(() => readTargetManifest(ws)).not.toThrow();
  });

  it("the CLI gate: without --yes nothing moves (exit 64); --yes is the human confirmation; an unmanaged workspace gets advice, not a crash", async () => {
    const { ws } = managedWorkspace();

    const refused = await runTargetCli(["cleanup"], ws, REPO_ROOT);
    expect(refused).toBe(64);
    expect(fs.existsSync(path.join(ws, "contracts", "qa-engineer.yaml"))).toBe(true);

    const confirmed = await runTargetCli(["cleanup", "--yes"], ws, REPO_ROOT);
    expect(confirmed).toBe(0);
    expect(fs.existsSync(path.join(ws, "contracts", "qa-engineer.yaml"))).toBe(false);
    expect(fs.readdirSync(path.join(ws, ".agent-team", "backups")).some((name) => name.endsWith("-cleanup"))).toBe(true);

    // A workspace the framework never managed is told what's what, not crashed on.
    const unmanaged = knowledgeWorkspace();
    const code = await runTargetCli(["cleanup"], unmanaged, REPO_ROOT);
    expect(code).toBe(0);

    expect(() => planCleanup({ targetRoot: unmanaged })).toThrow(CleanupUnmanagedWorkspaceError);
  });

  it("tracks the framework's version in the manifest snapshot so rollback restores the same Framework version", () => {
    const { ws } = managedWorkspace();
    const versionBefore = readTargetManifest(ws).framework_version;
    const plan = planCleanup({ targetRoot: ws });
    const result = applyCleanup(plan, "2026-09-17T01:02:03.000Z");
    const snapshot = JSON.parse(fs.readFileSync(path.join(result.backupDir, "manifest.json"), "utf8")) as { framework_version: string };
    expect(snapshot.framework_version).toBe(versionBefore);
  });
});
