import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { runTargetCli } from "./cli.js";
import { PreflightError, workspacePreflight, type RoleRunOptions } from "./devCommand.js";
import { loadTargetConfig, writeTargetConfig } from "./targetMeta.js";
import { stringify as stringifyYaml } from "yaml";

/**
 * V10 TASK-027 — the preflight dependencies step is per session, not per
 * role. The workspace is the Knowledge root, so the one required dependency
 * is that its Target mapping resolves on this machine; guard coverage was
 * already per runtime (guardCoverage.test.ts) and stays untouched.
 *
 * Fixtures mirror guardCoverage.test.ts's, per that file's own convention of
 * staying self-contained to avoid colliding with concurrent edits.
 */

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-preflight-${prefix}-`));
  roots.push(root);
  return root;
}
function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
function makeTarget(): string {
  const target = tmpRoot("repo");
  fs.mkdirSync(path.join(target, ".git"));
  write(target, "src/example.ts", 'export const example = () => "app logic";\n');
  write(target, "package.json", '{"name":"my-project","version":"0.0.1"}\n');
  write(target, "package-lock.json", '{"lockfileVersion":3}\n');
  return target;
}
function makeKnowledgeRepo(): string {
  const k = tmpRoot("kb");
  fs.mkdirSync(path.join(k, ".git"));
  fs.mkdirSync(path.join(k, "knowledge"));
  write(k, "targets.yaml", "schema_version: 1\ntargets: []\n");
  write(k, "knowledge/sales/requirement/REQ-1.yaml", "id: REQ-1\nowner: ba\n");
  return k;
}

const AGENT_MD = (name: string): string => `---\nname: ${name}\ndescription: does ${name} work\n---\n\nInstructions for ${name}.\n`;
const FRAMEWORK_HOOK_SCRIPTS = [
  "block-git.js",
  "block-outside-repo.js",
  "block-doc-rewrite.js",
  "block-path-permissions.js",
  "require-green-before-stop.js",
  "block-secret-leak.js",
] as const;
const FRAMEWORK_GUARD_SETTINGS = JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        ["Bash", "block-git.js"],
        ["Write", "block-outside-repo.js"],
        ["Write", "block-doc-rewrite.js"],
        ["Edit", "block-path-permissions.js"],
      ].map(([matcher, script]) => ({ matcher, hooks: [{ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] }] })),
      SubagentStop: [
        { hooks: ["require-green-before-stop.js", "block-secret-leak.js"].map((script) => ({ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] })) },
      ],
      Stop: [
        { hooks: ["require-green-before-stop.js", "block-secret-leak.js"].map((script) => ({ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] })) },
      ],
    },
  },
  null,
  2,
);

function guardPayload(): { relPath: string; content: string }[] {
  return [
    { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
    { relPath: ".claude/agents/business-analyst.md", content: AGENT_MD("business-analyst") },
    { relPath: ".claude/settings.json", content: FRAMEWORK_GUARD_SETTINGS },
    ...FRAMEWORK_HOOK_SCRIPTS.map((script) => ({ relPath: `.claude/hooks/${script}`, content: `// ${script}\n` })),
    { relPath: ".opencode/plugin/sta-guards.js", content: "// sta-guards\n" },
  ];
}

function fakeFramework(version: string, files: { relPath: string; content: string }[]): string {
  const fwRoot = tmpRoot("fw");
  write(fwRoot, path.join("orchestrator", "dist", "cli.js"), "#!/usr/bin/env node\n");
  const entries = files.map((f) => {
    write(fwRoot, path.join("templates", f.relPath), f.content);
    const content = fs.readFileSync(path.join(fwRoot, "templates", f.relPath));
    return { path: f.relPath.replaceAll("\\", "/"), sha256: sha256Of(content), size_bytes: content.length };
  });
  write(
    fwRoot,
    path.join("templates", "manifest.json"),
    `${JSON.stringify({ schema_version: 1, framework_version: version, generated_at: "2026-01-01T00:00:00Z", files: entries }, null, 2)}\n`,
  );
  const profile = stringifyYaml({
    stack: "node",
    kind: "backend",
    language: "typescript",
    runtime: "node",
    frameworks: ["node"],
    database: [],
    api: ["rest"],
    package_manager: "npm",
    commands: { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" },
    capabilities: ["testing"],
  });
  write(fwRoot, "templates/stacks/node/stack.yaml", profile);
  return fwRoot;
}

const NO_INSTALLATION = path.join(os.tmpdir(), "sta-preflight-no-installation", "installation.yaml");

/** Captures console output while a CLI invocation runs. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.map(String).join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** An initialized BA workspace (the V10 session shape) on a fake framework. */
async function initializedKnowledge(): Promise<{ knowledge: string; fw: string; templatesDir: string }> {
  const knowledge = makeKnowledgeRepo();
  const fw = fakeFramework("1.0.0", guardPayload());
  expect(await runTargetCli(["init", "--role", "ba"], knowledge, fw, { installationConfigPath: NO_INSTALLATION })).toBe(0);
  return { knowledge, fw, templatesDir: path.join(fw, "templates") };
}

function sessionPreflight(workspaceRoot: string, role: "ba" | "dev", options: RoleRunOptions = {}) {
  return workspacePreflight(role, {
    targetRoot: workspaceRoot,
    installationConfigPath: NO_INSTALLATION,
    probe: () => ({ available: true }),
    ...options,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("V10 TASK-027 — preflight dependencies are per session, not per role", () => {
  it("a workspace with no target mapping opens: no bound targets, nothing fails, and the preflight order is unchanged", async () => {
    const { knowledge, fw, templatesDir } = await initializedKnowledge();

    const ctx = workspacePreflight("ba", {
      targetRoot: knowledge,
      templatesDir,
      installationConfigPath: NO_INSTALLATION,
      probe: () => ({ available: true }),
    });

    expect(ctx.role).toBe("ba");
    expect(ctx.targetWorkRoots).toEqual([]);
    expect(ctx.checks.find((check) => check.name === "Targets")).toBeUndefined();
    // The fixed step order survives the rewrite of the dependencies step:
    // init/role match → framework major → guard coverage → managed files →
    // session dependencies → runtime probe.
    const names = ctx.checks.map((check) => check.name);
    expect(names).toEqual(["Workspace", "Initialization", "Framework compatibility", "Guards wired", "Managed files", "Runtime (claude)"]);
  });

  it("a target mapping naming a path that does not exist fails preflight with the fix", async () => {
    const { knowledge, fw, templatesDir } = await initializedKnowledge();
    write(
      knowledge,
      "targets.yaml",
      "schema_version: 1\ntargets:\n  - target_id: api\n    name: Orders API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n",
    );
    write(
      path.join(knowledge, ".workflow"),
      "targets.local.yaml",
      `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(path.join(tmpRoot("unmapped"), "api-missing"))}\n`,
    );

    let error: unknown;
    try {
      sessionPreflight(knowledge, "ba", { templatesDir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PreflightError);
    const failed = (error as PreflightError).failed;
    expect(failed.name).toBe("Targets");
    expect(failed.detail).toMatch(/is not an existing directory/);
    expect(failed.detail).toMatch(/targets\.local\.yaml/);
  });

  it("a target mapping that resolves feeds the session's read-only guard channel", async () => {
    const { knowledge, fw, templatesDir } = await initializedKnowledge();
    const target = makeTarget();
    write(
      knowledge,
      "targets.yaml",
      "schema_version: 1\ntargets:\n  - target_id: api\n    name: Orders API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n",
    );
    write(
      path.join(knowledge, ".workflow"),
      "targets.local.yaml",
      `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(target)}\n`,
    );

    const ctx = sessionPreflight(knowledge, "ba", { templatesDir });
    expect(ctx.checks.find((check) => check.name === "Targets")?.ok).toBe(true);
    expect(ctx.targetWorkRoots).toEqual([
      { targetId: "api", path: fs.realpathSync.native(target), access: "read" },
    ]);
    // The loadLocalTargetMapping rules hold: a Target at the Knowledge root
    // itself is refused, not silently mapped.
    write(
      path.join(knowledge, ".workflow"),
      "targets.local.yaml",
      `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(knowledge)}\n`,
    );
    expect(() => sessionPreflight(knowledge, "ba", { templatesDir })).toThrow(/overlaps Knowledge root/);
  });

  it("an unbound target workspace opens too — the role no longer decides what a session must resolve", async () => {
    const target = makeTarget();
    const fw = fakeFramework("1.0.0", guardPayload());
    const initialized = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(initialized.code, initialized.err).toBe(0);
    const config = loadTargetConfig(target)!;
    config.knowledge = { path: makeKnowledgeRepo() };
    writeTargetConfig(target, config);

    // This is the exact shape that used to fail closed on "Knowledge".
    const ctx = sessionPreflight(target, "dev", { templatesDir: path.join(fw, "templates") });
    expect(ctx.knowledge?.via).toBe("workspace-config");
    expect(ctx.checks.find((check) => check.name === "Knowledge (BA workspace role)")).toBeUndefined();
    expect(ctx.checks.find((check) => check.name === "Target writable")).toBeUndefined();
  });
});
