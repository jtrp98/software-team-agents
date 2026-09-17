import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readTemplateManifest, sha256Of } from "../packaging/templateManifest.js";
import { runTargetSync } from "./syncEngine.js";
import { loadTargetConfig, writeTargetConfig } from "./targetMeta.js";

/**
 * V10 TASK-020 — one managed payload.
 *
 * The regression this file exists for is silent: the old BA asset profile
 * dropped `contracts/`, and the guard hook returns null (allow) when it cannot
 * read `contracts/<role>.yaml` from the workspace root. A workspace missing
 * them looks guarded and enforces nothing per role.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL_TEMPLATES = path.join(REPO_ROOT, "templates");
const HOOK = path.join(REPO_ROOT, ".claude", "hooks", "block-path-permissions.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-payload-${prefix}-`));
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

/** A Target-shaped workspace: `dev` sync resolves a stack profile from real project files. */
function targetWorkspace(): string {
  const root = tmpRoot("tgt");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: { next: "15.0.0", react: "19.0.0" } }, null, 2),
    "utf8",
  );
  return root;
}

/** A templates dir carrying only `keep`-matching files — the shape a pre-V10 BA workspace was synced from. */
function narrowedTemplates(keep: (relPath: string) => boolean): string {
  const dir = tmpRoot("fw");
  const manifest = readTemplateManifest(REAL_TEMPLATES);
  const files = manifest.files.filter((f) => keep(f.path));
  for (const file of files) {
    const dest = path.join(dir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REAL_TEMPLATES, ...file.path.split("/")), dest);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, files }, null, 2), "utf8");
  return dir;
}

/** The pre-V10 BA profile, reproduced here so the fixture does not depend on code this task removed. */
const LEGACY_BA_AGENTS = new Set(["business-analyst", "system-analyst", "project-manager", "test-planner", "uxui-designer"]);
function legacyBaProfile(relPath: string): boolean {
  if (relPath === "CLAUDE.md" || relPath === "AGENTS.md") return true;
  if (relPath.startsWith(".claude/agents/")) return relPath.endsWith(".md") && LEGACY_BA_AGENTS.has(path.basename(relPath, ".md"));
  if (relPath.startsWith(".claude/hooks/") || relPath.startsWith(".claude/scripts/") || relPath.startsWith(".claude/shared/")) return true;
  if (relPath === ".claude/settings.json") return true;
  if (relPath.startsWith(".opencode/plugin/")) return true;
  if (relPath.startsWith(".agents/hooks/") || relPath === ".agents/hooks.json") return true;
  if (relPath.startsWith("policies/")) return true;
  if (relPath === ".github/workflows/knowledge-ci.yml") return true;
  if (relPath === "model-tiers.yaml") return true;
  if (relPath.startsWith(".claude/commands/")) return relPath !== ".claude/commands/verify.md";
  return false;
}

/** Exit code from the real hook, run as a host would run it. */
function hookVerdict(workspaceRoot: string, relPath: string, role?: string): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: workspaceRoot };
  delete env.STA_ROLE;
  delete env.STA_WRITABLE_WORK_ROOTS;
  delete env.STA_TARGET_WORK_ROOTS;
  delete env.STA_KNOWLEDGE_ROOT;
  if (role) env.STA_ROLE = role;
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(workspaceRoot, ...relPath.split("/")) } }),
    encoding: "utf8",
    env,
    cwd: workspaceRoot,
    timeout: 60000,
  });
  return { status: res.status, stderr: res.stderr ?? "" };
}

describe("V10 TASK-020 — the one payload reaches a workspace", () => {
  it("syncs contracts/ into a Knowledge workspace, so the hook's per-role layer is live rather than failing open", () => {
    const ws = knowledgeWorkspace();
    runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role: "ba", now: "2026-09-16T00:00:00Z" });

    // D7: every contract the hook can be asked for has to be on disk.
    for (const agent of ["backend-engineer", "frontend-engineer", "qa-engineer", "devops", "security", "business-analyst", "system-analyst", "project-manager", "test-planner", "uxui-designer", "setup"]) {
      expect(fs.existsSync(path.join(ws, "contracts", `${agent}.yaml`)), agent).toBe(true);
    }

    // And the layer they feed actually refuses something: backend-engineer's
    // own contract denies `_docs/module/**`. With no contract on disk the hook
    // returns null and this write is allowed — the silent failure.
    const denied = hookVerdict(ws, "_docs/module/m/design.md", "backend-engineer");
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("backend-engineer");

    // The pre-V10 BA payload, synced into its own workspace, allows that exact
    // write: no contract on disk, so the per-role layer is skipped entirely.
    // This is what the assertion above is protecting against, reproduced rather
    // than described.
    const legacy = knowledgeWorkspace();
    runTargetSync({ targetRoot: legacy, templatesDir: narrowedTemplates(legacyBaProfile), role: "ba", now: "2026-09-16T00:00:00Z" });
    expect(fs.existsSync(path.join(legacy, "contracts"))).toBe(false);
    expect(hookVerdict(legacy, "_docs/module/m/design.md", "backend-engineer").status).toBe(0);
  });

  it("also lands the rest of the pipeline payload and the BA prompts in the same workspace", () => {
    const ws = knowledgeWorkspace();
    runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role: "ba", now: "2026-09-16T00:00:00Z" });

    for (const rel of ["layout.yaml", "test-pyramid.yaml", "escalation-policy.yaml", "model-tiers.yaml", ".claude/commands/verify.md", ".github/workflows/knowledge-ci.yml"]) {
      expect(fs.existsSync(path.join(ws, ...rel.split("/"))), rel).toBe(true);
    }
    for (const agent of ["business-analyst", "backend-engineer"]) {
      expect(fs.existsSync(path.join(ws, ".claude", "agents", `${agent}.md`)), agent).toBe(true);
    }
    expect(fs.readdirSync(path.join(ws, "workflows")).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(ws, "stacks"))).toBe(true);
  });

  it("upgrades a workspace synced under the old BA profile: adds what it never had, keeps a user override", () => {
    const ws = knowledgeWorkspace();
    runTargetSync({ targetRoot: ws, templatesDir: narrowedTemplates(legacyBaProfile), role: "ba", now: "2026-09-16T00:00:00Z" });
    expect(fs.existsSync(path.join(ws, "contracts"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".claude", "agents", "backend-engineer.md"))).toBe(false);

    // A file this workspace's owner claimed and rewrote.
    const claimed = "policies/coding.md";
    const mine = "# my own coding policy\n";
    fs.writeFileSync(path.join(ws, ...claimed.split("/")), mine, "utf8");
    writeTargetConfig(ws, {
      ...(loadTargetConfig(ws) ?? { schema_version: 1 as const, target_id: "fixture", registered_at: "2026-09-16T00:00:00Z" }),
      role: "ba",
      overrides: [claimed],
    });

    const result = runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role: "ba", now: "2026-09-16T01:00:00Z" });

    expect(fs.existsSync(path.join(ws, "contracts", "backend-engineer.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude", "agents", "backend-engineer.md"))).toBe(true);
    expect(fs.readFileSync(path.join(ws, ...claimed.split("/")), "utf8")).toBe(mine);
    expect(result.performed.some((entry) => entry.path === claimed && entry.action === "override")).toBe(true);
    expect(result.performed.some((entry) => entry.path === "contracts/backend-engineer.yaml" && entry.action === "add")).toBe(true);

    // The manifest now tracks the files the profile used to hide, so a later
    // sync can clean them up like any other managed path.
    const tracked = new Set(JSON.parse(fs.readFileSync(path.join(ws, ".agent-team", "manifest.json"), "utf8")).files.map((f: { path: string }) => f.path));
    expect(tracked.has("contracts/backend-engineer.yaml")).toBe(true);
    expect(sha256Of(fs.readFileSync(path.join(ws, "contracts", "backend-engineer.yaml"), "utf8"))).toBe(
      readTemplateManifest(REAL_TEMPLATES).files.find((f) => f.path === "contracts/backend-engineer.yaml")!.sha256,
    );
  });
});

describe("V10 TASK-022 — one roster, so every role's renderings land in any workspace", () => {
  // Three runtimes render the same roster from the same prompts. The old
  // per-role asset filter made the count depend on which command opened the
  // workspace, which is exactly what roster drift then reported as a conflict.
  const RENDERINGS: readonly [dir: string, suffix: string][] = [
    [".claude/agents", ".md"],
    [".codex/agents", ".toml"],
    [".opencode/agent", ".md"],
  ];

  const rosterOf = (root: string, dir: string, suffix: string): string[] =>
    fs.readdirSync(path.join(root, ...dir.split("/")))
      .filter((name) => name.endsWith(suffix))
      .map((name) => path.basename(name, suffix))
      .sort();

  it("materialises the full roster for every runtime, whichever role the workspace records", () => {
    const expected = rosterOf(REAL_TEMPLATES, ".claude/agents", ".md");
    expect(expected.length).toBe(11);

    for (const [role, ws] of [["ba", knowledgeWorkspace()], ["dev", targetWorkspace()]] as const) {
      // `dev` sync renders a stack profile; name it so the fixture does not
      // depend on profile detection, which is not what this test is about.
      runTargetSync({ targetRoot: ws, templatesDir: REAL_TEMPLATES, role, now: "2026-09-17T00:00:00Z", explicitStack: role === "dev" ? "node" : undefined });
      for (const [dir, suffix] of RENDERINGS) {
        expect(rosterOf(ws, dir, suffix), `${role} -> ${dir}`).toEqual(expected);
      }
    }
  });
});
