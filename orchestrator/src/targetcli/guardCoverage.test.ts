import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { runTargetCli } from "./cli.js";
import { workspacePreflight, PreflightError, type RoleRunOptions } from "./devCommand.js";
import { gatherStatus, renderStatus } from "./statusCommand.js";
import { guardCoverage } from "./guardSettings.js";
import { loadTargetConfig, writeTargetConfig } from "./targetMeta.js";
import { stringify as stringifyYaml } from "yaml";

/**
 * Guard coverage is a launch requirement, not a support-level string: every
 * runtime must produce an explicit verdict, and `--runtime codex` must not be
 * able to start a session with none of the six guards active.
 *
 * These tests live in their own file rather than `targetCli.integration.test.ts`
 * to avoid colliding with concurrent edits to that file; the fixtures below
 * mirror its own.
 */

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-guard-${prefix}-`));
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

/** The payload every fixture workspace receives: agents, Claude guard wiring, and the OpenCode plugin. */
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
  const profile = (name: string, language: string, manager: string, commands: Record<string, string>, kind = "backend"): string =>
    stringifyYaml({
      stack: name,
      kind,
      language,
      runtime: name,
      frameworks: [name],
      database: [],
      api: ["rest"],
      package_manager: manager,
      commands,
      capabilities: ["testing"],
    });
  write(fwRoot, "templates/stacks/node/stack.yaml", profile("node", "typescript", "npm", { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" }));
  return fwRoot;
}

async function silently(fn: () => Promise<number>): Promise<number> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const NO_INSTALLATION = path.join(os.tmpdir(), "sta-guard-no-installation", "installation.yaml");

/** An initialized DEV workspace with every runtime binding materialised. */
async function initializedTarget(runtimes: string[] = ["claude", "codex", "opencode"]): Promise<{ target: string; fw: string; templatesDir: string }> {
  const target = makeTarget();
  const knowledge = makeKnowledgeRepo();
  const fw = fakeFramework("1.0.0", guardPayload());
  const argv = ["init", ...runtimes.flatMap((runtime) => ["--runtime", runtime])];
  expect(await silently(() => runTargetCli(argv, target, fw, { installationConfigPath: NO_INSTALLATION }))).toBe(0);
  const config = loadTargetConfig(target)!;
  config.knowledge = { path: knowledge };
  writeTargetConfig(target, config);
  return { target, fw, templatesDir: path.join(fw, "templates") };
}

function preflight(target: string, templatesDir: string, options: RoleRunOptions = {}) {
  return workspacePreflight("dev", {
    targetRoot: target,
    templatesDir,
    installationConfigPath: NO_INSTALLATION,
    probe: () => ({ available: true }),
    ...options,
  });
}

function guardCheck(checks: { name: string; ok: boolean; detail?: string }[]): { name: string; ok: boolean; detail?: string } | undefined {
  return checks.find((check) => check.name === "Guards wired");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("T-V5-008 — guard coverage is a launch requirement", () => {
  it("Codex reports NOT READY as unguarded — READY is unreachable without a verified guard mechanism", async () => {
    const { target, templatesDir } = await initializedTarget();
    const status = gatherStatus({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION });

    // The bindings are complete; only the missing guard mechanism holds it back.
    expect(fs.existsSync(path.join(target, ".codex", "agents", "backend-engineer.toml"))).toBe(true);
    expect(status.codex.ready).toBe(false);
    expect(status.codex.detail).toMatch(/UNGUARDED/);
    expect(status.codex.detail).toMatch(/no Codex guard mechanism/);
    expect(renderStatus(status)).toContain("Codex: NOT READY");
    expect(renderStatus(status)).not.toContain("Codex: READY");
  });

  it("`--runtime codex` fails preflight naming the gap, and no session is launched", async () => {
    const { target, templatesDir } = await initializedTarget();
    let error: unknown;
    try {
      preflight(target, templatesDir, { runtime: "codex" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PreflightError);
    const failed = (error as PreflightError).failed;
    expect(failed.name).toBe("Guards wired");
    expect(failed.detail).toMatch(/codex enforces no guard in this workspace/);
    expect(failed.detail).toMatch(/block-secret-leak/);
    expect(failed.detail).toMatch(/--allow-unguarded-runtime/);
  });

  it("`ba --runtime codex` fails preflight too — the Knowledge workspace is not exempt", async () => {
    const knowledge = makeKnowledgeRepo();
    const fw = fakeFramework("1.0.0", guardPayload());
    const templatesDir = path.join(fw, "templates");
    expect(await silently(() => runTargetCli(["init", "--role", "ba", "--runtime", "codex"], knowledge, fw, { installationConfigPath: NO_INSTALLATION }))).toBe(0);

    const baPreflight = (options: RoleRunOptions) =>
      workspacePreflight("ba", { targetRoot: knowledge, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }), ...options });

    expect(() => baPreflight({ runtime: "codex" })).toThrow(/codex enforces no guard in this workspace/);
    const acknowledged = baPreflight({ runtime: "codex", allowUnguardedRuntime: true });
    expect(acknowledged.guards.level).toBe("unguarded");
    expect(guardCheck(acknowledged.checks)?.detail).toMatch(/UNGUARDED, acknowledged/);
  });

  it("the acknowledgement flag launches, and the launch is recorded as unguarded", async () => {
    const { target, templatesDir } = await initializedTarget();
    const context = preflight(target, templatesDir, { runtime: "codex", allowUnguardedRuntime: true });
    expect(context.guards.level).toBe("unguarded");
    expect(context.guards.enforced).toEqual([]);
    expect(guardCheck(context.checks)).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/codex: UNGUARDED, acknowledged via --allow-unguarded-runtime/),
    });

    // The launch line itself states it, so the session transcript carries the fact.
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => logged.push(parts.map(String).join(" "));
    try {
      const { runDev } = await import("./devCommand.js");
      await runDev({
        targetRoot: target,
        templatesDir,
        runtime: "codex",
        allowUnguardedRuntime: true,
        installationConfigPath: NO_INSTALLATION,
        probe: () => ({ available: true }),
        launch: async () => 0,
        recordSession: () => {},
      });
    } finally {
      console.log = originalLog;
    }
    expect(logged.join("\n")).toContain("[UNGUARDED SESSION — acknowledged]");
  });

  it("preflight consults guard coverage for every runtime, not only claude", async () => {
    const { target, templatesDir } = await initializedTarget();
    for (const runtime of ["claude", "opencode"] as const) {
      const context = preflight(target, templatesDir, { runtime });
      expect(guardCheck(context.checks), `${runtime} produced no guard verdict`).toBeDefined();
      expect(context.guards.runtime).toBe(runtime);
    }
    // codex is the third: it produces a verdict too, and that verdict stops the launch.
    expect(() => preflight(target, templatesDir, { runtime: "codex" })).toThrow(/Guards wired/);
  });

  it("OpenCode's verdict names which guards it does and does not enforce", async () => {
    const { target, templatesDir } = await initializedTarget();
    const coverage = guardCoverage({ runtime: "opencode", targetRoot: target });
    expect(coverage.level).toBe("partial");
    expect(coverage.detail).toMatch(/enforces block-outside-repo and block-path-permissions/);
    expect(coverage.detail).toMatch(/each binding's permission block enforces block-git/);
    expect(coverage.detail).toMatch(/block-doc-rewrite, block-secret-leak and require-green-before-stop have no OpenCode mechanism/);
    expect(coverage.enforced).toContain("pre-tool-guard");
    expect(coverage.unenforced).toContain("exit-guard");

    const status = gatherStatus({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION });
    expect(status.opencode.ready).toBe(true);
    expect(status.opencode.detail).toMatch(/block-secret-leak/);

    // Remove the plugin and OpenCode's default allow-all posture is reported as unguarded.
    fs.rmSync(path.join(target, ".opencode", "plugin", "sta-guards.js"));
    expect(guardCoverage({ runtime: "opencode", targetRoot: target }).level).toBe("unguarded");
    expect(() => preflight(target, templatesDir, { runtime: "opencode" })).toThrow(/opencode enforces no guard/);
  });

  it("no guard that is enforced today becomes unenforced: a broken Claude wiring still fails, flag or not", async () => {
    const { target, templatesDir } = await initializedTarget();

    // Baseline: fully wired Claude passes with its unchanged verdict wording.
    expect(guardCheck(preflight(target, templatesDir).checks)).toMatchObject({
      ok: true,
      detail: "8/8 Framework guard registration(s) active",
    });

    const settingsPath = path.join(target, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] } };
    settings.hooks.PreToolUse.pop();
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    // The registration gap fails preflight ...
    expect(() => preflight(target, templatesDir)).toThrow(/Guards wired.*7\/8.*software-team-agents sync/);
    // ... and the acknowledgement flag cannot excuse it. A repairable fault
    // is never a deliberate choice.
    expect(() => preflight(target, templatesDir, { allowUnguardedRuntime: true })).toThrow(/Guards wired.*7\/8.*software-team-agents sync/);
    expect(gatherStatus({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION }).claude.ready).toBe(false);

    // Unreadable settings stay a hard failure under the flag too.
    fs.writeFileSync(settingsPath, "{not json", "utf8");
    expect(() => preflight(target, templatesDir, { allowUnguardedRuntime: true })).toThrow(/Guards wired/);
  });

  it("the flag does not weaken a runtime whose guards are present: opencode keeps its partial verdict", async () => {
    const { target, templatesDir } = await initializedTarget();
    const context = preflight(target, templatesDir, { runtime: "opencode", allowUnguardedRuntime: true });
    expect(context.guards.level).toBe("partial");
    expect(guardCheck(context.checks)?.detail).not.toMatch(/UNGUARDED/);
  });
});
