import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { runTargetCli } from "./cli.js";
import { isInsideFrameworkRoot, resolveFrameworkRoot, resolveRoots } from "./roots.js";
import { devPreflight, runBa, runDev } from "./devCommand.js";
import { loadTargetConfig, readTargetManifest, writeTargetConfig, writeTargetManifest, defaultTargetConfig } from "./targetMeta.js";
import { configureKnowledgeRoot } from "../threeRepo/installation.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { runDoctor } from "../threeRepo/doctor.js";
import type { InstructionSurfaceEntry } from "../threeRepo/ownership.js";
import { stringify as stringifyYaml } from "yaml";
import { inspectBootstrapBlock, stripBootstrapBlock } from "./knowledgeRender.js";

/**
 * T-TARGET-18/19/20 + T-ROLE-22..26 — end-to-end tests against temporary
 * repositories. Everything runs through `runTargetCli`, the exact function the
 * bin calls. The workspace comes from the explicit cwd argument
 * (Target-first: the caller's location decides), and fixture Framework
 * installations stand in for the installed package so version upgrades are
 * deterministic.
 */

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-e2e-${prefix}-`));
  roots.push(root);
  return root;
}
function write(root: string, relative: string, content: string): void {
  const targetPath = path.join(root, relative);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}
function makeTarget(): string {
  const target = tmpRoot("repo");
  fs.mkdirSync(path.join(target, ".git")); // standalone-repo marker, inspected locally (no git invocation)
  write(target, "src/example.ts", 'export const example = () => "app logic";\n');
  write(target, "package.json", '{"name":"my-project","version":"0.0.1"}\n');
  write(target, "package-lock.json", '{"lockfileVersion":3}\n');
  return target;
}
function makeTargetWithOwnClaudeMd(): { target: string; original: string } {
  const target = makeTarget();
  const original =
    "\uFEFF# Project-owned Claude instructions\r\n\r\n" +
    Array.from({ length: 600 }, (_, index) => `Project rule ${index + 1}: preserve this prose exactly.\r\n`).join("") +
    "\r\nFinal project byte.\r\n";
  fs.writeFileSync(path.join(target, "CLAUDE.md"), original, "utf8");
  return { target, original };
}
function makeDotnetTarget(): string {
  const target = tmpRoot("dotnet");
  fs.mkdirSync(path.join(target, ".git"));
  write(target, "Acme.csproj", '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  return target;
}
function makeNestedDotnetTarget(): string {
  const target = tmpRoot("nested-dotnet");
  fs.mkdirSync(path.join(target, ".git"));
  write(target, "ClassOnlineWeb/ClassOnlineWeb.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
  return target;
}
function makePythonTarget(): string {
  const target = tmpRoot("python");
  fs.mkdirSync(path.join(target, ".git"));
  write(target, "pyproject.toml", "[project]\nname = 'acme'\n");
  return target;
}
function makeJavaTarget(): string {
  const target = tmpRoot("java");
  fs.mkdirSync(path.join(target, ".git"));
  write(target, "pom.xml", "<project></project>\n");
  return target;
}
function makeMixedTarget(): string {
  const target = makeDotnetTarget();
  write(target, "package.json", '{"name":"mixed"}\n');
  write(target, "package-lock.json", '{"lockfileVersion":3}\n');
  return target;
}
function makeBunTarget(): string {
  const target = tmpRoot("bun");
  fs.mkdirSync(path.join(target, ".git"));
  write(
    target,
    "package.json",
    JSON.stringify({ name: "bun-app", scripts: { build: "tsc", test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" }, dependencies: { express: "1.0.0" } }) + "\n",
  );
  write(target, "bun.lock", "lock-v1\n");
  return target;
}
function makeKnowledgeRepo(): string {
  const k = tmpRoot("kb");
  fs.mkdirSync(path.join(k, ".git"));
  fs.mkdirSync(path.join(k, "knowledge"));
  write(k, "targets.yaml", "schema_version: 1\ntargets: []\n");
  // Human-owned knowledge content that nothing in this architecture may overwrite.
  write(k, "knowledge/sales/requirement/REQ-1.yaml", "id: REQ-1\nowner: ba\n");
  return k;
}
const AGENT_MD = (name: string): string => `---\nname: ${name}\ndescription: does ${name} work\n---\n\nInstructions for ${name}.\n`;
const FRAMEWORK_GUARD_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      ["Bash", "block-git.js"],
      ["Write", "block-outside-repo.js"],
      ["Write", "block-doc-rewrite.js"],
      ["Edit", "block-path-permissions.js"],
    ].map(([matcher, script]) => ({ matcher, hooks: [{ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] }] })),
    SubagentStop: [{ hooks: ["require-green-before-stop.js", "block-secret-leak.js"].map((script) => ({ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] })) }],
    Stop: [{ hooks: ["require-green-before-stop.js", "block-secret-leak.js"].map((script) => ({ type: "command", command: "node", args: [`${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/${script}`] })) }],
  },
}, null, 2);
const FRAMEWORK_HOOK_SCRIPTS = [
  "block-git.js",
  "block-outside-repo.js",
  "block-doc-rewrite.js",
  "block-path-permissions.js",
  "require-green-before-stop.js",
  "block-secret-leak.js",
] as const;
function frameworkGuardFixtureFiles(): { relPath: string; content: string }[] {
  return [
    { relPath: ".claude/settings.json", content: FRAMEWORK_GUARD_SETTINGS },
    ...FRAMEWORK_HOOK_SCRIPTS.map((script) => ({ relPath: `.claude/hooks/${script}`, content: `// ${script}\n` })),
  ];
}

/** A fake installed-Framework package: `<fwRoot>/templates/**` + manifest.json. */
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
  write(fwRoot, "templates/stacks/frontend/stack.yaml", profile("frontend", "typescript", "npm", { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "npm run typecheck" }, "frontend"));
  write(fwRoot, "templates/stacks/dotnet/stack.yaml", profile("dotnet", "csharp", "nuget", { install: "dotnet restore", build: "dotnet build", test: "dotnet test", lint: "dotnet format --verify-no-changes", typecheck: "dotnet build" }));
  write(fwRoot, "templates/stacks/python/stack.yaml", profile("python", "python", "uv", { install: "uv sync", build: "uv build", test: "pytest", lint: "ruff check", typecheck: "mypy ." }));
  write(fwRoot, "templates/stacks/java/stack.yaml", profile("java", "java", "maven", { install: "mvn dependency:resolve", build: "mvn package", test: "mvn test", lint: "mvn checkstyle:check", typecheck: "mvn compile" }));
  return fwRoot;
}

function dirHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const relChild = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, relChild);
      else out.set(relChild, sha256Of(fs.readFileSync(abs)));
    }
  };
  walk(root, "");
  return out;
}

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

const NO_INSTALLATION = "no-installation-here.yaml"; // deterministic: never reads the machine's real binding

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("software-team-agents — target-first end to end", () => {
  it("T-V3-06: injects one block into a large project CLAUDE.md, preserves outside edits, and backs up every write", async () => {
    const { target, original } = makeTargetWithOwnClaudeMd();
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: "CLAUDE.md", content: "# Framework template body\n" },
    ]);
    const claudeMd = path.join(target, "CLAUDE.md");

    const first = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(first.code).toBe(0);
    const injected = fs.readFileSync(claudeMd, "utf8");
    const inspected = inspectBootstrapBlock(injected);
    expect(inspected.state).toBe("valid");
    if (inspected.state !== "valid") throw new Error("expected a valid bootstrap block");
    expect(sha256Of(Buffer.from(inspected.outside))).toBe(sha256Of(Buffer.from(original)));
    expect(readTargetManifest(target).framework_blocks).toHaveLength(1);
    const firstBackup = fs.readdirSync(path.join(target, ".agent-team", "backups"))[0]!;
    expect(fs.readFileSync(path.join(target, ".agent-team", "backups", firstBackup, "CLAUDE.md"), "utf8")).toBe(original);

    const second = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(second.code).toBe(0);
    expect(fs.readFileSync(claudeMd, "utf8")).toBe(injected);
    expect((injected.match(/<!-- sta:bootstrap -->/g) ?? [])).toHaveLength(1);

    const projectEdit = `${inspected.block}${inspected.outside}Project-owned edit after setup.\r\n`;
    fs.writeFileSync(claudeMd, projectEdit, "utf8");
    const afterProjectEdit = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(afterProjectEdit.code).toBe(0);
    expect(fs.readFileSync(claudeMd, "utf8")).toBe(projectEdit);

    const editedInside = projectEdit.replace("# software-team-agents bootstrap", "# project changed the Framework block");
    fs.writeFileSync(claudeMd, editedInside, "utf8");
    const stopped = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(stopped.code).toBe(2);
    expect(stopped.err).toMatch(/inside the Framework bootstrap markers/);
    expect(stopped.err).toMatch(/backup|--force/);
    expect(fs.readFileSync(claudeMd, "utf8")).toBe(editedInside);

    const forced = await capture(() => runTargetCli(["sync", "--force"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(forced.code).toBe(0);
    const restored = fs.readFileSync(claudeMd, "utf8");
    expect(stripBootstrapBlock(restored)).toBe(inspected.outside + "Project-owned edit after setup.\r\n");
    const backupCopies = fs
      .readdirSync(path.join(target, ".agent-team", "backups"))
      .map((dir) => path.join(target, ".agent-team", "backups", dir, "CLAUDE.md"))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"));
    expect(backupCopies).toContain(editedInside);
  });

  it("T-V3-06: refuses malformed markers even with --force and honours an explicit override", async () => {
    const fw = fakeFramework("1.0.0", [{ relPath: "CLAUDE.md", content: "# Framework template body\n" }]);
    for (const malformed of [
      "<!-- sta:bootstrap -->\nunterminated\n# project\n",
      "<!-- sta:bootstrap -->\none\n<!-- sta:bootstrap -->\ntwo\n<!-- /sta:bootstrap -->\n# project\n",
    ]) {
      const target = makeTarget();
      fs.writeFileSync(path.join(target, "CLAUDE.md"), malformed, "utf8");
      const run = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(run.code).not.toBe(0);
      expect(run.err).toMatch(/malformed|marker pair|backup/i);
      writeTargetManifest(target, {
        schema_version: 1,
        framework_version: "0.0.0",
        installed_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: [],
      });
      const forced = await capture(() => runTargetCli(["sync", "--force"], target, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(forced.code).toBe(2);
      expect(forced.err).toMatch(/malformed|marker pair|backup/i);
      expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe(malformed);
    }

    const target = makeTarget();
    const projectBytes = "# project explicitly owns this file\n";
    fs.writeFileSync(path.join(target, "CLAUDE.md"), projectBytes, "utf8");
    const config = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
    config.overrides = ["CLAUDE.md"];
    writeTargetConfig(target, config);
    const run = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/override|explicit user choice|skipped/i);
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe(projectBytes);
    expect(readTargetManifest(target).framework_blocks).toBeUndefined();
  });

  it("T-V3-06: removing CLAUDE.md from the payload strips only the tracked block and restores exact original bytes", async () => {
    const { target, original } = makeTargetWithOwnClaudeMd();
    const fwV1 = fakeFramework("1.0.0", [{ relPath: "CLAUDE.md", content: "# Framework template body\n" }]);
    expect((await capture(() => runTargetCli(["init"], target, fwV1, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(inspectBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).state).toBe("valid");

    const fwV2 = fakeFramework("1.1.0", []);
    const removed = await capture(() => runTargetCli(["sync"], target, fwV2, { installationConfigPath: NO_INSTALLATION }));
    expect(removed.code).toBe(0);
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe(original);
    expect(readTargetManifest(target).framework_blocks).toBeUndefined();
    const backups = fs
      .readdirSync(path.join(target, ".agent-team", "backups"))
      .map((dir) => path.join(target, ".agent-team", "backups", dir, "CLAUDE.md"))
      .filter((file) => fs.existsSync(file));
    expect(backups.some((file) => inspectBootstrapBlock(fs.readFileSync(file, "utf8")).state === "valid")).toBe(true);
  });

  it("T-V3-02: merges every Framework guard into helper-shaped settings, preserves Graphify, and reports matching status/doctor counts", async () => {
    const target = makeTarget();
    const knowledge = makeKnowledgeRepo();
    const projectSettings = `{
  "hooks": {
    "PreToolUse": [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"graphify hint"}]}],
    "PostToolUse": [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"graphify update"}]}]
  },
  "permissions": {"deny":["WebFetch"]},
  "projectOnly": {"keep":"exact"}
}`;
    write(target, ".claude/settings.json", projectSettings);
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      ...frameworkGuardFixtureFiles(),
    ]);

    const initialized = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(initialized.code).toBe(0);
    const merged = fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8");
    expect(merged).toContain('{"type":"command","command":"graphify hint"}');
    expect(merged).toContain('{"type":"command","command":"graphify update"}');
    expect(JSON.parse(merged).permissions).toEqual({ deny: ["WebFetch"] });
    expect(readTargetManifest(target).files.some((file) => file.path === ".claude/settings.json")).toBe(false);
    const initialBackup = fs
      .readdirSync(path.join(target, ".agent-team", "backups"))
      .map((dir) => path.join(target, ".agent-team", "backups", dir, ".claude", "settings.json"))
      .find((file) => fs.existsSync(file));
    expect(initialBackup).toBeDefined();
    expect(fs.readFileSync(initialBackup!, "utf8")).toBe(projectSettings);

    const second = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(second.code).toBe(0);
    expect(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8")).toBe(merged);

    const statusRun = await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    const status = JSON.parse(statusRun.out) as { hooksInstalled: number; hooksRegistered: number; projectOwnedPaths: string[]; claude: { ready: boolean } };
    expect(status).toMatchObject({ hooksInstalled: 8, hooksRegistered: 8, claude: { ready: true } });
    expect(status.projectOwnedPaths).not.toContain(".claude/settings.json");
    const doctor = await runDoctor({ projectRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION, probe: async () => ({ available: true }) });
    expect(doctor.checks.find((check) => check.name === "Guard wiring (.claude/settings.json)")).toMatchObject({ status: "PASS", detail: "8/8 Framework guard registration(s) active" });

    const config = loadTargetConfig(target)!;
    config.knowledge = { path: knowledge };
    writeTargetConfig(target, config);
    const preflight = devPreflight({ targetRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
    expect(preflight.checks.find((check) => check.name === "Guards wired")).toMatchObject({ ok: true, detail: "8/8 Framework guard registration(s) active" });

    const unwired = JSON.parse(merged) as { hooks: { PreToolUse: unknown[] } };
    unwired.hooks.PreToolUse.pop();
    fs.writeFileSync(path.join(target, ".claude", "settings.json"), JSON.stringify(unwired), "utf8");
    expect(() => devPreflight({ targetRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) })).toThrow(/Guards wired.*7\/8.*software-team-agents sync/);
    expect((await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
  });

  it("T-V3-02: unmergeable settings stop sync/dev; --force backs up before replacement", async () => {
    const target = makeTarget();
    const knowledge = makeKnowledgeRepo();
    const fwBase = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      ...frameworkGuardFixtureFiles().filter((file) => file.relPath !== ".claude/settings.json"),
    ]);
    expect((await capture(() => runTargetCli(["init"], target, fwBase, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    const invalid = '{"hooks":[],';
    write(target, ".claude/settings.json", invalid);
    const fw = fakeFramework("1.0.1", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      ...frameworkGuardFixtureFiles(),
    ]);

    const stopped = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(stopped.code).toBe(2);
    expect(stopped.err).toMatch(/fix\/merge|overrides|--force/);
    expect(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8")).toBe(invalid);

    const config = loadTargetConfig(target)!;
    config.knowledge = { path: knowledge };
    writeTargetConfig(target, config);
    expect(() => devPreflight({ targetRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) })).toThrow(/Managed files|settings\.json/);

    const forced = await capture(() => runTargetCli(["sync", "--force"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(forced.code).toBe(0);
    expect(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8")).toBe(FRAMEWORK_GUARD_SETTINGS);
    const backupCopies = fs
      .readdirSync(path.join(target, ".agent-team", "backups"))
      .map((dir) => path.join(target, ".agent-team", "backups", dir, ".claude", "settings.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"));
    expect(backupCopies).toContain(invalid);
  });

  it("T-V3-02: settings override is reported as an explicit choice and remains launchable", async () => {
    const target = makeTarget();
    const knowledge = makeKnowledgeRepo();
    const projectSettings = '{"hooks":{"PreToolUse":[{"hooks":[{"command":"project only"}]}]}}';
    write(target, ".claude/settings.json", projectSettings);
    const config = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
    config.knowledge = { path: knowledge };
    config.overrides = [".claude/settings.json"];
    writeTargetConfig(target, config);
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      ...frameworkGuardFixtureFiles(),
    ]);

    const initialized = await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(initialized.code).toBe(0);
    expect(initialized.out).toMatch(/override|explicit user choice/i);
    expect(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8")).toBe(projectSettings);
    const preflight = devPreflight({ targetRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
    expect(preflight.checks.find((check) => check.name === "Guards wired")).toMatchObject({ ok: true, detail: expect.stringMatching(/explicit user choice/) });
  });

  it("init → status → sync all run from the Target directory; source stays in the Target", async () => {
    const target = makeTarget();
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[]}]}}' },
      { relPath: "CLAUDE.md", content: "# Framework instructions\n" },
    ]);

    const initRun = await capture(() => runTargetCli(["init"], target, fw));
    expect(initRun.code).toBe(0);
    expect(fs.existsSync(path.join(target, ".claude", "agents", "backend-engineer.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".codex", "agents", "backend-engineer.toml"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toContain("app logic");

    // Idempotent: a second init keeps identity config and application source intact.
    const configBefore = fs.readFileSync(path.join(target, ".agent-team", "config.yaml"), "utf8");
    expect((await capture(() => runTargetCli(["init"], target, fw))).code).toBe(0);
    expect(fs.readFileSync(path.join(target, ".agent-team", "config.yaml"), "utf8")).toBe(configBefore);
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toContain("app logic");

    const statusRun = await capture(() => runTargetCli(["status", "--json"], target, fw));
    expect(statusRun.code).toBe(0);
    const status = JSON.parse(statusRun.out) as { targetRoot: string; syncedVersion: string; managedFileCount: number; claude: { ready: boolean }; codex: { ready: boolean }; syncState: string; role?: string };
    expect(status.targetRoot.toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
    expect(status.syncedVersion).toBe("1.0.0");
    expect(status.syncState).toBe("UP_TO_DATE");
    expect(status.claude.ready).toBe(true);
    expect(status.codex.ready).toBe(true);
    expect(status.role).toBe("dev");

    // The engineer's work lands in the Target and never in the Framework.
    write(target, "src/more.ts", "// more app code\n");
    expect(fs.existsSync(path.join(target, "src", "more.ts"))).toBe(true);
    expect(fs.existsSync(path.join(fw, "src", "more.ts"))).toBe(false);
  });

  it("T-V1-16 — two Target workspaces under one Framework stay isolated: init/sync/status in A never touches B", async () => {
    const targetA = makeTarget();
    const targetB = makeTarget();
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[]}]}}' },
      { relPath: "CLAUDE.md", content: "# Framework instructions\n" },
    ]);

    expect((await capture(() => runTargetCli(["init"], targetB, fw))).code).toBe(0);
    const bBefore = [...dirHash(targetB).entries()];

    // A joins later, gets synced and upgraded — B must not move a byte.
    expect((await capture(() => runTargetCli(["init"], targetA, fw))).code).toBe(0);
    expect((await capture(() => runTargetCli(["sync"], targetA, fw))).code).toBe(0);
    const aStatus = JSON.parse((await capture(() => runTargetCli(["status", "--json"], targetA, fw))).out) as { targetRoot: string; targetId: string };
    expect(aStatus.targetId).not.toBeUndefined();

    const bAfter = [...dirHash(targetB).entries()];
    expect(bAfter).toEqual(bBefore);

    // Identities are per-workspace: A's config names A, and no manifest claims paths outside its repo.
    expect(fs.readFileSync(path.join(targetA, ".agent-team", "config.yaml"), "utf8")).toContain(path.basename(targetA));
    const manifestA = JSON.parse(fs.readFileSync(path.join(targetA, ".agent-team", "manifest.json"), "utf8")) as { files: { path: string }[] };
    for (const file of manifestA.files) {
      expect(file.path.startsWith("../") || path.isAbsolute(file.path), `manifest must not reach outside its workspace: ${file.path}`).toBe(false);
    }
  });

  it("T-V3-02 — status no longer reports a mergeable settings file as a project-owned collision", async () => {
    const target = makeTarget();
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      ...frameworkGuardFixtureFiles(),
    ]);
    // The project owned settings.json before the Framework ever arrived.
    fs.mkdirSync(path.join(target, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "settings.json"), '{"hooks":{"PreToolUse":[{"project":true}]}}', "utf8");

    const initRun = await capture(() => runTargetCli(["init"], target, fw));
    expect(initRun.code).toBe(0);

    const statusRun = await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(statusRun.code).toBe(0);
    const status = JSON.parse(statusRun.out) as { projectOwnedPaths: string[]; conflictCount: number; hooksInstalled: number; hooksRegistered: number };
    expect(status.projectOwnedPaths).toEqual([]);
    expect(status.conflictCount).toBe(0);
    expect(status).toMatchObject({ hooksInstalled: 8, hooksRegistered: 8 });

    const rendered = await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(rendered.out).not.toContain("project-owned paths left alone");
    expect(rendered.out).toContain("Framework guard registrations: 8/8 registered");

    // Claiming the path moves it out of the report — ownership is explicit now.
    const configPath = path.join(target, ".agent-team", "config.yaml");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace("overrides: []", 'overrides:\n  - .claude/settings.json'),
      "utf8",
    );
    const after = JSON.parse(await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION })).then((r) => r.out)) as {
      projectOwnedPaths: string[];
    };
    expect(after.projectOwnedPaths).toEqual([]);
  });

  it("fails invalid Targets with an understandable error and writes nothing", async () => {
    const notARepo = tmpRoot("plain"); // no .git marker
    const run = await capture(() => runTargetCli(["init"], notARepo));
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/not a Git repository/);
    expect(fs.existsSync(path.join(notARepo, ".agent-team"))).toBe(false);
  });

  it("refuses to treat the Framework repo itself as a workspace (pollution guard)", async () => {
    const guardRoot = resolveFrameworkRoot();
    expect(isInsideFrameworkRoot(guardRoot, guardRoot)).toBe(true);
    expect(() => resolveRoots({ targetRoot: guardRoot })).toThrow(/inside the Framework installation/);
  });

  it("upgrade v1→v2 updates managed files and removes stale ones while preserving Target source", async () => {
    const target = makeTarget();
    const fwV1 = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/agents/old-agent.md", content: AGENT_MD("old-agent") },
      { relPath: "CLAUDE.md", content: "# Framework instructions v1\n" },
    ]);
    expect((await capture(() => runTargetCli(["init"], target, fwV1, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(fs.existsSync(path.join(target, ".claude", "agents", "old-agent.md"))).toBe(true);
    const sourceBefore = fs.readFileSync(path.join(target, "src", "example.ts"), "utf8");

    const fwV2 = fakeFramework("2.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: `---\nname: backend-engineer\ndescription: does backend work, now better\n---\n\nImproved instructions.\n` },
      { relPath: "CLAUDE.md", content: "# Framework instructions v2\n" },
    ]);
    const syncRun = await capture(() => runTargetCli(["sync"], target, fwV2, { installationConfigPath: NO_INSTALLATION }));
    expect(syncRun.code).toBe(0);
    expect(syncRun.out).toContain("2.0.0");

    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe("# Framework instructions v2\n");
    expect(fs.readFileSync(path.join(target, ".claude", "agents", "backend-engineer.md"), "utf8")).toContain("now better");
    expect(fs.existsSync(path.join(target, ".claude", "agents", "old-agent.md"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toBe(sourceBefore);
    expect(readTargetManifest(target).framework_version).toBe("2.0.0");
  });

  it("conflict flow: local modification stops sync with recovery advice; --force overwrites after backing up", async () => {
    const target = makeTarget();
    const fwV1 = fakeFramework("1.0.0", [
      { relPath: "CLAUDE.md", content: "# Framework instructions v1\n" },
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
    ]);
    expect((await capture(() => runTargetCli(["init"], target, fwV1, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);

    const claudeMd = path.join(target, "CLAUDE.md");
    fs.writeFileSync(claudeMd, "# my local tweaks\n", "utf8");

    const fwV2 = fakeFramework("2.0.0", [
      { relPath: "CLAUDE.md", content: "# Framework instructions v2\n" },
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer-v2") },
    ]);
    const stopped = await capture(() => runTargetCli(["sync"], target, fwV2, { installationConfigPath: NO_INSTALLATION }));
    expect(stopped.code).toBe(2);
    expect(stopped.err).toContain("CLAUDE.md");
    expect(stopped.err).toMatch(/--force|overrides|revert/);
    expect(fs.readFileSync(claudeMd, "utf8")).toBe("# my local tweaks\n");

    const forced = await capture(() => runTargetCli(["sync", "--force"], target, fwV2, { installationConfigPath: NO_INSTALLATION }));
    expect(forced.code).toBe(0);
    expect(stripBootstrapBlock(fs.readFileSync(claudeMd, "utf8"))).toBe("# Framework instructions v2\n");
    const backupsDir = path.join(target, ".agent-team", "backups");
    const backupSession = fs.readdirSync(backupsDir)[0];
    expect(backupSession).toBeDefined();
    expect(fs.readFileSync(path.join(backupsDir, backupSession!, "CLAUDE.md"), "utf8")).toBe("# my local tweaks\n");
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toContain("app logic");
  });

  it("dev: preflight fails closed on conflicts and missing runtime, then launches FROM the Target with policy env", async () => {
    const target = makeTarget();
    const fw = fakeFramework("3.1.0", [
      { relPath: "CLAUDE.md", content: "# Framework launch instructions ก\n" },
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[]}]}}' },
    ]);
    const templatesDir = path.join(fw, "templates");

    // Uninitialized + unambiguous app repo → auto-initializes as DEV, then proceeds.
    // A DEV session needs a Knowledge binding even on first run — bind a sibling repo.
    const knowledge = makeKnowledgeRepo();
    const cfg = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
    cfg.knowledge = { path: knowledge };
    writeTargetConfig(target, cfg);

    let launchedCwd = "";
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    let launchedArgs: string[] | undefined;
    let launchedInstructionBytes = 0;
    const exitCode = await runDev({
      targetRoot: target,
      templatesDir,
      installationConfigPath: NO_INSTALLATION,
      probe: () => ({ available: true, detail: "claude 1.2.3" }),
      launch: (_cmd, args, cwd, env) => {
        launchedArgs = args;
        launchedCwd = cwd;
        launchedEnv = env;
        launchedInstructionBytes = fs.statSync(path.join(cwd, "CLAUDE.md")).size;
        return Promise.resolve(7);
      },
    });
    expect(launchedCwd.toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
    expect(launchedEnv?.AGENTCLAUDE_WRITABLE_WORK_ROOTS).toBe("[]");
    expect(launchedEnv?.AGENTCLAUDE_CONTEXT_CMD).toContain("orchestrator");
    expect(launchedEnv?.AGENTCLAUDE_CONTEXT_CMD).toContain("context");
    expect(launchedArgs).toEqual([]);
    expect(exitCode).toBe(7);
    const telemetry = new SqliteTaskStore(defaultStateDbPath(target));
    try {
      const rows = telemetry.allRuns();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ task_id: expect.stringMatching(/^session:dev:/), session_kind: "interactive", runtime: "claude", input_tokens: null, output_tokens: null });
      expect(rows[0].static_chars).toBeGreaterThan(0);
      expect(rows[0].instruction_surface_bytes).toBe(launchedInstructionBytes);
    } finally { telemetry.close(); }

    // Missing runtime fails closed.
    expect(() =>
      devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: false, detail: "not on PATH" }) }),
    ).toThrow(/not on PATH/);

    // A conflicted managed file stops dev — auto-sync never forces.
    const settings = path.join(target, ".claude", "settings.json");
    fs.writeFileSync(settings, '{"hooks":{"PreToolUse":[{"locally edited":true}]}}', "utf8");
    expect(() =>
      devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) }),
    ).toThrow(/conflicts/);
    expect(fs.readFileSync(settings, "utf8")).toContain("locally edited");
  });

  it("dev: a path the project already owned does NOT block the launch — same verdict as sync", async () => {
    // Regression: the block/skip rule lived inline in runTargetSync and was not
    // applied by workspacePreflight, so `sync` accepted a workspace that `dev`
    // refused — one workspace, two verdicts. Both now route through
    // isBlockingConflict.
    const target = makeTarget();
    const knowledge = makeKnowledgeRepo();
    // The project owns CLAUDE.md before this Framework is ever installed.
    write(target, "CLAUDE.md", "# the project's own instructions\n");

    const fw = fakeFramework("3.1.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: "CLAUDE.md", content: "# Framework instructions\n" },
    ]);
    const templatesDir = path.join(fw, "templates");

    expect((await capture(() => runTargetCli(["init"], target, fw))).code).toBe(0);
    const cfg = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
    cfg.knowledge = { path: knowledge };
    writeTargetConfig(target, cfg);

    // `sync` reconciles it through a block without claiming project prose ...
    expect((await capture(() => runTargetCli(["sync"], target, fw))).code).toBe(0);
    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe("# the project's own instructions\n");

    // ... so preflight must agree and remain ready.
    const ctx = devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
    const managed = ctx.checks.find((c) => c.name === "Managed files");
    expect(managed?.ok).toBe(true);
    expect(managed?.detail).toContain("up to date");
    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe("# the project's own instructions\n");
  });
});

describe("role workspace architecture (T-ROLE)", () => {
  const FW_V1_FILES = [
    // BA-workspace agents
    { relPath: ".claude/agents/business-analyst.md", content: AGENT_MD("business-analyst") },
    { relPath: ".claude/agents/system-analyst.md", content: AGENT_MD("system-analyst") },
    // Engineer agents
    { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
    // Shared tooling
    { relPath: ".claude/hooks/block-git.js", content: "module.exports = () => {};\n" },
    { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[]}]}}' },
    { relPath: "policies/coding.md", content: "# rules\n" },
    { relPath: "CLAUDE.md", content: "# Framework instructions v1\n" },
    // Pipeline-only payload
    { relPath: "contracts/backend-engineer.yaml", content: "role: backend-engineer\n" },
    { relPath: "workflows/bugfix.yml", content: "workflow: bugfix\n" },
  ];

  it("BA clone model: init+sync in the Knowledge repo materialize only BA assets; no Target exists anywhere (T-ROLE-22/23)", async () => {
    const knowledge = makeKnowledgeRepo();
    const knowledgeBefore = JSON.stringify([...dirHash(knowledge).entries()].sort());
    const fw = fakeFramework("1.0.0", FW_V1_FILES);
    const fwBefore = JSON.stringify([...dirHash(fw).entries()].sort());

    const initRun = await capture(() => runTargetCli(["init"], knowledge, fw));
    expect(initRun.code).toBe(0);
    expect(initRun.out).toMatch(/BA/);

    // Workspace-role profile: BA agents land; engineer agents and pipeline payload do not.
    expect(fs.existsSync(path.join(knowledge, ".claude", "agents", "business-analyst.md"))).toBe(true);
    expect(fs.existsSync(path.join(knowledge, ".claude", "agents", "system-analyst.md"))).toBe(true);
    expect(fs.existsSync(path.join(knowledge, ".claude", "hooks", "block-git.js"))).toBe(true);
    expect(fs.existsSync(path.join(knowledge, "policies", "coding.md"))).toBe(true);
    expect(fs.existsSync(path.join(knowledge, ".claude", "agents", "backend-engineer.md"))).toBe(false);
    expect(fs.existsSync(path.join(knowledge, "contracts"))).toBe(false);
    expect(fs.existsSync(path.join(knowledge, "workflows"))).toBe(false);
    // Codex renderings follow the included roster only.
    expect(fs.existsSync(path.join(knowledge, ".codex", "agents", "business-analyst.toml"))).toBe(true);
    expect(fs.existsSync(path.join(knowledge, ".codex", "agents", "backend-engineer.toml"))).toBe(false);

    // The Knowledge repo's own content survived untouched.
    expect(JSON.stringify([...dirHash(knowledge).entries()].sort())).not.toBe("{}");
    expect(fs.readFileSync(path.join(knowledge, "knowledge", "sales", "requirement", "REQ-1.yaml"), "utf8")).toContain("REQ-1");

    const status = JSON.parse(await capture(() => runTargetCli(["status", "--json"], knowledge, fw)).then((r) => r.out)) as {
      role?: string;
      syncState: string;
      syncedVersion?: string;
    };
    expect(status.role).toBe("ba");
    expect(status.syncState).toBe("UP_TO_DATE");

    // BA writes requirements into Knowledge — they exist there and nowhere else.
    write(knowledge, "requirements/example.md", "# Requirement example\n");
    expect(fs.existsSync(path.join(knowledge, "requirements", "example.md"))).toBe(true);
    expect(fs.existsSync(path.join(fw, "requirements", "example.md"))).toBe(false);

    // The Framework fixture is byte-for-byte unchanged by any of this.
    expect(JSON.stringify([...dirHash(fw).entries()].sort())).toBe(fwBefore);
    void knowledgeBefore;
  });

  it("T-V5-001 (characterization — red until T-V5-011): same-version template drift must not report UP_TO_DATE", async () => {
    // The live knowledge-schoolbright condition (F-02): the workspace synced at
    // 1.0.0-rc.3 and every managed file is pristine, but the installed
    // Framework's templates/ payload changed (there: policies/documentation.md
    // and CLAUDE.md) without a version bump — an npm-link live clone pinned
    // across many commits.
    const knowledge = makeKnowledgeRepo();
    const payload = (documentation: string, claude: string): { relPath: string; content: string }[] => [
      { relPath: ".claude/agents/business-analyst.md", content: AGENT_MD("business-analyst") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[]}]}}' },
      { relPath: "policies/documentation.md", content: documentation },
      { relPath: "CLAUDE.md", content: claude },
    ];
    const fw = fakeFramework("1.0.0-rc.3", payload("# Documentation policy\n", "# Framework instructions\n"));
    expect((await capture(() => runTargetCli(["init"], knowledge, fw))).code).toBe(0);

    // The payload changes; the version string does not.
    const fwDrifted = fakeFramework(
      "1.0.0-rc.3",
      payload(
        "# Documentation policy\n\nAdded prose after the last sync — no version bump shipped it.\n",
        "# Framework instructions\n\nUpdated bootstrap prose without a bump.\n",
      ),
    );

    const status = JSON.parse((await capture(() => runTargetCli(["status", "--json"], knowledge, fwDrifted))).out) as {
      syncState: string;
      syncedVersion?: string;
      conflictCount: number;
    };
    expect(status.syncedVersion).toBe("1.0.0-rc.3");
    // Both drifted files are pristine on disk — this is drift, not a conflict...
    expect(status.conflictCount).toBe(0);
    // ... so comparing version strings must not be allowed to call it fresh.
    expect(status.syncState).not.toBe("UP_TO_DATE");
  });

  it("ba command: preflight passes without any Target checkout and launches from Knowledge (T-ROLE-03/19)", async () => {
    const knowledge = makeKnowledgeRepo();
    const fw = fakeFramework("1.0.0", FW_V1_FILES);

    expect((await capture(() => runTargetCli(["init"], knowledge, fw))).code).toBe(0);

    let launchedCwd = "";
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    let launchedArgs: string[] | undefined;
    const exitCode = await runBa({
      targetRoot: knowledge,
      templatesDir: path.join(fw, "templates"),
      installationConfigPath: NO_INSTALLATION,
      probe: (cmd) => ({ available: true, detail: `${cmd} ready` }),
      launch: (_cmd, args, cwd, env) => {
        launchedArgs = args;
        launchedCwd = cwd;
        launchedEnv = env;
        return Promise.resolve(0);
      },
    });
    expect(exitCode).toBe(0);
    expect(launchedCwd.toLowerCase()).toBe(fs.realpathSync.native(knowledge).toLowerCase());
    expect(launchedEnv?.AGENTCLAUDE_WRITABLE_WORK_ROOTS).toBe("[]");
    expect(launchedEnv?.AGENTCLAUDE_CONTEXT_CMD).toContain("context");
    expect(launchedArgs).toEqual([]);
  });

  it("T-V3-01 — status and doctor report the same instruction surface without writing any file", async () => {
    const target = makeTarget();
    write(target, "CLAUDE.md", "# Project-owned routing\n");
    write(target, "CLAUDE.local.md", "# Local Claude override\n");
    write(target, "packages/app/AGENTS.md", "# Nested agent instructions\n");
    write(target, ".claude/settings.json", '{"hooks":{"PreToolUse":[{"project":true}]}}\n');
    const fw = fakeFramework("1.0.0", [
      { relPath: "CLAUDE.md", content: "# Framework instructions\n" },
      ...frameworkGuardFixtureFiles(),
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
    ]);
    expect((await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    const before = [...dirHash(target).entries()];

    const jsonRun = await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(jsonRun.code).toBe(0);
    const status = JSON.parse(jsonRun.out) as {
      instructionSurface: InstructionSurfaceEntry[];
      projectOwnedPaths: string[];
    };
    const stableSurface = status.instructionSurface.map(({ path: relativePath, owner, precedence, frameworkContributionPresent, consequence }) => ({
      path: relativePath,
      owner,
      precedence,
      frameworkContributionPresent,
      ...(consequence ? { consequence } : {}),
    }));
    expect(stableSurface).toMatchInlineSnapshot(`
      [
        {
          "frameworkContributionPresent": true,
          "owner": "framework",
          "path": ".claude/agents/backend-engineer.md",
          "precedence": "framework-managed",
        },
        {
          "frameworkContributionPresent": true,
          "owner": "target",
          "path": ".claude/settings.json",
          "precedence": "project-owned-merged",
        },
        {
          "frameworkContributionPresent": true,
          "owner": "framework",
          "path": ".codex/agents/backend-engineer.toml",
          "precedence": "framework-managed",
        },
        {
          "frameworkContributionPresent": true,
          "owner": "framework",
          "path": ".opencode/agent/backend-engineer.md",
          "precedence": "framework-managed",
        },
        {
          "frameworkContributionPresent": false,
          "owner": "target",
          "path": "CLAUDE.local.md",
          "precedence": "project-owned-untouched",
        },
        {
          "frameworkContributionPresent": true,
          "owner": "target",
          "path": "CLAUDE.md",
          "precedence": "project-owned-with-framework-block",
        },
        {
          "frameworkContributionPresent": false,
          "owner": "target",
          "path": "packages/app/AGENTS.md",
          "precedence": "project-owned-untouched",
        },
      ]
    `);
    expect(status.projectOwnedPaths).toEqual([]);

    const textRun = await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(textRun.out).not.toContain("Framework routing is not delivered to this workspace");
    expect(textRun.out).toContain("Framework guard registrations: 8/8 registered");
    expect(textRun.out).toContain("WARNING: nested instructions may shadow or contradict the root bootstrap (2)");
    expect(textRun.out).toContain("packages/app/AGENTS.md — project-owned and read-only");

    const doctor = await runDoctor({ projectRoot: target, templatesDir: path.join(fw, "templates"), installationConfigPath: NO_INSTALLATION });
    expect(doctor.instructionSurface).toEqual(status.instructionSurface);
    for (const row of doctor.checks.filter((entry) => entry.name.startsWith("Instruction surface:"))) {
      if (row.status !== "PASS") expect(row.fix).toBeTruthy();
    }
    const nestedChecks = doctor.checks.filter((entry) => /CLAUDE\.local\.md|packages\/app\/AGENTS\.md/.test(entry.name));
    expect(nestedChecks).toHaveLength(2);
    for (const row of nestedChecks) {
      expect(row.status).toBe("WARNING");
      expect(row.detail).toContain("may shadow or contradict the root bootstrap");
    }
    expect([...dirHash(target).entries()]).toEqual(before);
  });

  it("T-V3-03 — resolves and persists deterministic cross-stack fixture profiles", async () => {
    const fw = fakeFramework("1.0.0", []);
    const fixtures = [
      { name: "bun", root: makeBunTarget(), profile: "node" },
      { name: "dotnet", root: makeDotnetTarget(), profile: "dotnet" },
      { name: "nested-dotnet", root: makeNestedDotnetTarget(), profile: "dotnet" },
      { name: "python", root: makePythonTarget(), profile: "python" },
      { name: "java", root: makeJavaTarget(), profile: "java" },
    ];
    const golden: object[] = [];
    for (const fixture of fixtures) {
      const initialized = await capture(() => runTargetCli(["init"], fixture.root, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(initialized.code, `${fixture.name}: ${initialized.err}`).toBe(0);
      const stack = loadTargetConfig(fixture.root)!.stack!;
      expect(stack.profile).toBe(fixture.profile);
      expect(Buffer.byteLength(stringifyYaml({ stack })), `${fixture.name} profile budget`).toBeLessThanOrEqual(1536);
      const { detected_at: _detectedAt, fingerprint: _fingerprint, generated_hash: _generatedHash, ...stable } = stack;
      golden.push({ name: fixture.name, ...stable, fingerprint: "sha256:<stable>", generated_hash: "sha256:<stable>" });
    }
    expect(loadTargetConfig(fixtures[0]!.root)!.stack).toMatchObject({
      profile: "node",
      package_manager: "bun",
      commands: { install: "bun install", build: "bun run build", test: "bun run test", lint: "bun run lint", typecheck: "bun run typecheck" },
    });
    expect(loadTargetConfig(fixtures[1]!.root)!.stack).toMatchObject({
      profile: "dotnet",
      package_manager: "nuget",
      commands: { install: "dotnet restore", build: "dotnet build", test: "dotnet test", lint: "dotnet format --verify-no-changes", typecheck: "dotnet build" },
    });
    expect(Object.values(loadTargetConfig(fixtures[1]!.root)!.stack!.commands).some((command) => String(command).includes("npm"))).toBe(false);
    expect(loadTargetConfig(fixtures[2]!.root)!.stack!.source_roots).toEqual(["ClassOnlineWeb"]);
    for (const [lockfile, expectedManager] of [
      ["package-lock.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
    ] as const) {
      const managerTarget = tmpRoot(`manager-${expectedManager}`);
      fs.mkdirSync(path.join(managerTarget, ".git"));
      write(managerTarget, "package.json", '{"name":"manager-fixture","scripts":{"build":"tsc"}}\n');
      write(managerTarget, lockfile, "lock\n");
      expect((await capture(() => runTargetCli(["init"], managerTarget, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
      expect(loadTargetConfig(managerTarget)!.stack!.package_manager).toBe(expectedManager);
      expect(loadTargetConfig(managerTarget)!.stack!.commands.build).toBe(`${expectedManager} run build`);
    }
    expect(golden).toMatchInlineSnapshot(`
      [
        {
          "commands": {
            "build": "bun run build",
            "install": "bun install",
            "lint": "bun run lint",
            "test": "bun run test",
            "typecheck": "bun run typecheck",
          },
          "fingerprint": "sha256:<stable>",
          "generated_hash": "sha256:<stable>",
          "name": "bun",
          "package_manager": "bun",
          "profile": "node",
          "schema_paths": [],
          "source_roots": [
            ".",
          ],
        },
        {
          "commands": {
            "build": "dotnet build",
            "install": "dotnet restore",
            "lint": "dotnet format --verify-no-changes",
            "test": "dotnet test",
            "typecheck": "dotnet build",
          },
          "fingerprint": "sha256:<stable>",
          "generated_hash": "sha256:<stable>",
          "name": "dotnet",
          "package_manager": "nuget",
          "profile": "dotnet",
          "schema_paths": [],
          "source_roots": [
            ".",
          ],
        },
        {
          "commands": {
            "build": "dotnet build",
            "install": "dotnet restore",
            "lint": "dotnet format --verify-no-changes",
            "test": "dotnet test",
            "typecheck": "dotnet build",
          },
          "fingerprint": "sha256:<stable>",
          "generated_hash": "sha256:<stable>",
          "name": "nested-dotnet",
          "package_manager": "nuget",
          "profile": "dotnet",
          "schema_paths": [],
          "source_roots": [
            "ClassOnlineWeb",
          ],
        },
        {
          "commands": {
            "build": "uv build",
            "install": "uv sync",
            "lint": "ruff check",
            "test": "pytest",
            "typecheck": "mypy .",
          },
          "fingerprint": "sha256:<stable>",
          "generated_hash": "sha256:<stable>",
          "name": "python",
          "package_manager": "uv",
          "profile": "python",
          "schema_paths": [],
          "source_roots": [
            ".",
          ],
        },
        {
          "commands": {
            "build": "mvn package",
            "install": "mvn dependency:resolve",
            "lint": "mvn checkstyle:check",
            "test": "mvn test",
            "typecheck": "mvn compile",
          },
          "fingerprint": "sha256:<stable>",
          "generated_hash": "sha256:<stable>",
          "name": "java",
          "package_manager": "maven",
          "profile": "java",
          "schema_paths": [],
          "source_roots": [
            ".",
          ],
        },
      ]
    `);
  });

  it("T-V3-04 — renders stack.md from a dotnet profile and preserves overridden engineer prompts", async () => {
    const digestFramework = fakeFramework("1.0.0", [
      { relPath: ".claude/shared/stack.md", content: "template placeholder\n" },
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/agents/frontend-engineer.md", content: AGENT_MD("frontend-engineer") },
    ]);
    const dotnet = makeDotnetTarget();
    const initialized = await capture(() => runTargetCli(["init"], dotnet, digestFramework, { installationConfigPath: NO_INSTALLATION }));
    expect(initialized.code, initialized.err).toBe(0);
    const digest = fs.readFileSync(path.join(dotnet, ".claude", "shared", "stack.md"), "utf8");
    expect(digest).toContain("dotnet build");
    expect(digest).toContain("dotnet test");
    expect(digest).not.toMatch(/\bnpm\b/i);
    expect(readTargetManifest(dotnet).files.find((file) => file.path === ".claude/shared/stack.md")?.sha256).toBe(sha256Of(digest));

    const baseFramework = fakeFramework("1.0.0", []);
    const customized = makeTarget();
    expect((await capture(() => runTargetCli(["init"], customized, baseFramework, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    const config = loadTargetConfig(customized)!;
    config.overrides = [".claude/agents/backend-engineer.md", ".claude/agents/frontend-engineer.md"];
    writeTargetConfig(customized, config);
    const backend = "---\r\nname: backend-engineer\r\ndescription: project-owned backend prompt\r\n---\r\n\r\nCustom backend.\r\n";
    const frontend = "---\nname: frontend-engineer\ndescription: project-owned frontend prompt\n---\n\nCustom frontend.\n";
    write(customized, ".claude/agents/backend-engineer.md", backend);
    write(customized, ".claude/agents/frontend-engineer.md", frontend);
    const synced = await capture(() => runTargetCli(["sync"], customized, digestFramework, { installationConfigPath: NO_INSTALLATION }));
    expect(synced.code, synced.err).toBe(0);
    expect(fs.readFileSync(path.join(customized, ".claude", "agents", "backend-engineer.md"), "utf8")).toBe(backend);
    expect(fs.readFileSync(path.join(customized, ".claude", "agents", "frontend-engineer.md"), "utf8")).toBe(frontend);
  });

  it("T-V3-03 — ambiguity, absence and unsupported stacks stop before config is written", async () => {
    const fw = fakeFramework("1.0.0", []);
    const mixed = makeMixedTarget();
    const ambiguous = await capture(() => runTargetCli(["init"], mixed, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toMatch(/ambiguous.*--stack/i);
    expect(fs.existsSync(path.join(mixed, ".agent-team"))).toBe(false);
    expect((await capture(() => runTargetCli(["init", "--stack", "dotnet"], mixed, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(loadTargetConfig(mixed)!.stack!.profile).toBe("dotnet");

    const unknown = tmpRoot("unknown-stack");
    fs.mkdirSync(path.join(unknown, ".git"));
    write(unknown, "README.md", "no project evidence\n");
    const unresolved = await capture(() => runTargetCli(["init", "--role", "dev"], unknown, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(unresolved.code).toBe(1);
    expect(unresolved.err).toMatch(/could not be resolved.*--stack/i);
    expect(fs.existsSync(path.join(unknown, ".agent-team"))).toBe(false);

    const go = tmpRoot("go-stack");
    fs.mkdirSync(path.join(go, ".git"));
    write(go, "go.mod", "module example.test/acme\n");
    const unsupported = await capture(() => runTargetCli(["init"], go, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(unsupported.code).toBe(1);
    expect(unsupported.err).toMatch(/no shipped stack profile.*--stack/i);
    expect(fs.existsSync(path.join(go, ".agent-team"))).toBe(false);
  });

  it("T-V3-03 — fingerprint invalidation is one-shot, human edits survive, and family changes STOP", async () => {
    const fw = fakeFramework("1.0.0", []);
    const target = makeBunTarget();
    expect((await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    const configPath = path.join(target, ".agent-team", "config.yaml");
    const unchangedBefore = fs.readFileSync(configPath, "utf8");
    expect((await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe(unchangedBefore);

    write(target, "bun.lock", "lock-v2\n");
    const firstRedetection = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(firstRedetection.code).toBe(0);
    const afterRedetection = fs.readFileSync(configPath, "utf8");
    expect(afterRedetection).not.toBe(unchangedBefore);
    expect((await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe(afterRedetection);

    const human = loadTargetConfig(target)!;
    const previousFingerprint = human.stack!.fingerprint;
    human.stack!.commands.build = "custom-build --human-owned";
    writeTargetConfig(target, human);
    write(target, "bun.lock", "lock-v3\n");
    const preserved = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(preserved.code).toBe(0);
    expect(preserved.out).toContain("human-edited values were preserved");
    expect(loadTargetConfig(target)!.stack!.commands.build).toBe("custom-build --human-owned");
    expect(loadTargetConfig(target)!.stack!.fingerprint).not.toBe(previousFingerprint);
    const humanOnce = fs.readFileSync(configPath, "utf8");
    expect((await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe(humanOnce);

    fs.rmSync(path.join(target, "package.json"));
    fs.rmSync(path.join(target, "bun.lock"));
    write(target, "Acme.csproj", '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    const configBeforeStop = fs.readFileSync(configPath, "utf8");
    const manifestBeforeStop = fs.readFileSync(path.join(target, ".agent-team", "manifest.json"), "utf8");
    const stopped = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(stopped.code).toBe(1);
    expect(stopped.err).toMatch(/profile family changed.*STOP/i);
    expect(fs.readFileSync(configPath, "utf8")).toBe(configBeforeStop);
    expect(fs.readFileSync(path.join(target, ".agent-team", "manifest.json"), "utf8")).toBe(manifestBeforeStop);
  });

  it("T-V3-03 — status exposes the cached profile and doctor names the unresolved fix", async () => {
    const fw = fakeFramework("1.0.0", []);
    const target = makeBunTarget();
    expect((await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    const status = JSON.parse((await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out) as {
      stack?: { profile: string; package_manager: string };
      v3Configuration?: { configured: boolean; detail: string };
    };
    expect(status.stack).toMatchObject({ profile: "node", package_manager: "bun" });
    expect(status.v3Configuration).toEqual({
      configured: false,
      detail: expect.stringContaining("not configured — defaults apply"),
    });

    write(target, ".sta/config.yaml", "schema_version: 1\nexecution:\n  mode: auto\n  allow_paid_fallback: false\n");
    const configuredStatus = JSON.parse(
      (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out,
    ) as { v3Configuration: { configured: boolean; detail: string } };
    expect(configuredStatus.v3Configuration).toEqual({
      configured: true,
      detail: expect.stringContaining("mode=auto"),
    });

    const unresolved = makeTarget();
    writeTargetConfig(unresolved, defaultTargetConfig(path.basename(unresolved), "2026-01-01T00:00:00Z", "dev"));
    const doctor = await runDoctor({ projectRoot: unresolved, installationConfigPath: NO_INSTALLATION });
    const profileCheck = doctor.checks.find((entry) => entry.name.startsWith("Target profile"))!;
    expect(profileCheck.status).toBe("WARNING");
    expect(profileCheck.detail).toContain("unresolved");
    expect(profileCheck.fix).toContain("--stack");
  });

  it("does not let an observability write failure change an interactive session's exit code", async () => {
    const knowledge = makeKnowledgeRepo();
    const fw = fakeFramework("1.0.0", FW_V1_FILES);
    expect((await capture(() => runTargetCli(["init"], knowledge, fw))).code).toBe(0);
    const errorSpy = console.error;
    console.error = () => {};
    try {
      await expect(runBa({
        targetRoot: knowledge,
        templatesDir: path.join(fw, "templates"),
        installationConfigPath: NO_INSTALLATION,
        probe: () => ({ available: true }),
        launch: () => Promise.resolve(0),
        recordSession: () => { throw new Error("database locked"); },
      })).resolves.toBe(0);
    } finally { console.error = errorSpy; }
  });

  it("ba refuses an application repository — that is what --role is for, explicitly (T-ROLE-16)", async () => {
    const target = makeTarget(); // app markers, no knowledge markers
    const fw = fakeFramework("1.0.0", FW_V1_FILES);

    // `ba` in an app repo tells the user where they are.
    const wrongRun = await capture(() => runTargetCli(["ba"], target, fw));
    expect(wrongRun.code).toBe(1);
    expect(wrongRun.err).toMatch(/Target repository|--role/);

    // Explicit --role overrides detection at init time.
    const explicit = await capture(() => runTargetCli(["init", "--role", "dev"], target, fw));
    expect(explicit.code).toBe(0);
    expect(fs.existsSync(path.join(target, ".agent-team", "config.yaml"))).toBe(true);

    // An ambiguous repository requires the flag outright.
    const both = tmpRoot("both");
    fs.mkdirSync(path.join(both, ".git"));
    fs.mkdirSync(path.join(both, "knowledge"));
    write(both, "package.json", "{}");
    const ambiguousRun = await capture(() => runTargetCli(["init"], both, fw));
    expect(ambiguousRun.code).toBe(1);
    expect(ambiguousRun.err).toMatch(/--role ba or --role dev/);
  });

  it("DEV three-repo model: Knowledge required fail-closed, then read context while implementation lands in Target (T-ROLE-24/25)", async () => {
    const target = makeTarget();
    const knowledge = makeKnowledgeRepo();
    write(knowledge, "_docs/module/sales/requirement.md", "# Sales requirement: implement X\n");
    const fw = fakeFramework("1.0.0", FW_V1_FILES);
    const knowledgeBefore = JSON.stringify([...dirHash(knowledge).entries()].sort());
    const fwBefore = JSON.stringify([...dirHash(fw).entries()].sort());
    const templatesDir = path.join(fw, "templates");

    // No knowledge binding yet → DEV preflight fails closed with actionable advice.
    try {
      devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
      throw new Error("expected preflight failure");
    } catch (e) {
      expect((e as Error).message).toMatch(/Knowledge/);
    }

    // Bind the sibling Knowledge repo via the workspace config (T-ROLE-06).
    const config = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
    config.knowledge = { path: knowledge };
    writeTargetConfig(target, config);

    const ctx = devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
    expect(ctx.knowledge?.knowledgeRoot.toLowerCase()).toBe(fs.realpathSync.native(knowledge).toLowerCase());

    // DEV launches from Target...
    let launchedCwd = "";
    await runDev({
      targetRoot: target,
      templatesDir,
      installationConfigPath: NO_INSTALLATION,
      probe: () => ({ available: true }),
      launch: (_cmd, _args, cwd) => {
        launchedCwd = cwd;
        return Promise.resolve(0);
      },
    });
    expect(launchedCwd.toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());

    // ...reads the requirement from Knowledge...
    const requirementPath = path.join(ctx.knowledge!.knowledgeRoot, "_docs", "module", "sales", "requirement.md");
    expect(fs.readFileSync(requirementPath, "utf8")).toContain("implement X");

    // ...implements into Target...
    write(target, "src/sales.ts", "// implements REQ: implement X\n");
    expect(fs.readFileSync(path.join(target, "src", "sales.ts"), "utf8")).toContain("implements REQ");

    // ...and neither Knowledge nor Framework changed at all.
    expect(JSON.stringify([...dirHash(knowledge).entries()].sort())).toBe(knowledgeBefore);
    expect(JSON.stringify([...dirHash(fw).entries()].sort())).toBe(fwBefore);
  });

  it("workspaces registered under one role refuse the other command (write-policy clarity)", async () => {
    const knowledge = makeKnowledgeRepo();
    const fw = fakeFramework("1.0.0", FW_V1_FILES);
    expect((await capture(() => runTargetCli(["init"], knowledge, fw))).code).toBe(0);

    const wrongRole = await capture(() => runTargetCli(["dev"], knowledge, fw));
    expect(wrongRole.code).toBe(1);
    expect(wrongRole.err).toMatch(/registered as BA|software-team-agents ba/);
  });

  it("Framework upgrade reaches each workspace independently — no simultaneous sync required (T-ROLE-26)", async () => {
    const knowledge = makeKnowledgeRepo();
    const target = makeTarget();
    const fwV1 = fakeFramework("1.0.0", [
      { relPath: "CLAUDE.md", content: "# Framework instructions v1\n" },
      { relPath: ".claude/hooks/block-git.js", content: "module.exports = () => 1;\n" },
    ]);
    const templatesV1 = path.join(fwV1, "templates");

    expect((await capture(() => runTargetCli(["init"], knowledge, fwV1))).code).toBe(0);
    expect((await capture(() => runTargetCli(["init"], target, fwV1, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);
    expect(readTargetManifest(knowledge).framework_version).toBe("1.0.0");
    expect(readTargetManifest(target).framework_version).toBe("1.0.0");

    // Framework ships v2; only the BA upgrades their workspace today.
    const fwV2 = fakeFramework("2.0.0", [
      { relPath: "CLAUDE.md", content: "# Framework instructions v2\n" },
      { relPath: ".claude/hooks/block-git.js", content: "module.exports = () => 2;\n" },
    ]);
    expect((await capture(() => runTargetCli(["sync"], knowledge, fwV2))).code).toBe(0);

    expect(readTargetManifest(knowledge).framework_version).toBe("2.0.0");
    expect(stripBootstrapBlock(fs.readFileSync(path.join(knowledge, "CLAUDE.md"), "utf8"))).toBe("# Framework instructions v2\n");
    // The DEV workspace stays on v1 until its owner decides to sync.
    expect(readTargetManifest(target).framework_version).toBe("1.0.0");
    expect(stripBootstrapBlock(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8"))).toBe("# Framework instructions v1\n");

    // And the DEV's source was never part of any of it.
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toContain("app logic");
  });

  describe("T-WG1 — knowledge-bound-but-uninitialized detector", () => {
    it("unbound: no installation.yaml at all — status stays silent", async () => {
      const target = makeTarget();
      const fw = fakeFramework("1.0.0", FW_V1_FILES);
      expect((await capture(() => runTargetCli(["init"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out,
      ) as { knowledgeBoundButUninitialized?: string };
      expect(status.knowledgeBoundButUninitialized).toBeUndefined();

      const rendered = (await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out;
      expect(rendered).not.toMatch(/WARNING/);
    });

    it("initialized: installation.yaml binds a Knowledge root that IS init --role ba'd — status stays silent", async () => {
      const base = tmpRoot("wg1-init");
      const configPath = path.join(base, "installation.yaml");
      const knowledge = makeKnowledgeRepo();
      const fw = fakeFramework("1.0.0", FW_V1_FILES);

      expect((await capture(() => runTargetCli(["init"], knowledge, fw, { installationConfigPath: configPath }))).code).toBe(0);
      configureKnowledgeRoot(knowledge, configPath, fw);

      const target = makeTarget();
      expect((await capture(() => runTargetCli(["init", "--role", "dev"], target, fw, { installationConfigPath: configPath }))).code).toBe(0);

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: configPath }))).out,
      ) as { knowledgeBoundButUninitialized?: string };
      expect(status.knowledgeBoundButUninitialized).toBeUndefined();

      const rendered = (await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: configPath }))).out;
      expect(rendered).not.toMatch(/WARNING/);
    });

    it("bound-but-uninit: installation.yaml binds a marker-complete Knowledge root that was never `init --role ba`'d — WARNING with the fix command, from both BA and DEV status, plus a DEV preflight note", async () => {
      const base = tmpRoot("wg1-uninit");
      const configPath = path.join(base, "installation.yaml");
      const knowledge = makeKnowledgeRepo(); // markers present, never `init`'d
      const fw = fakeFramework("1.0.0", FW_V1_FILES);
      configureKnowledgeRoot(knowledge, configPath, fw);
      const knowledgeCanonical = fs.realpathSync.native(knowledge);

      // From the (uninitialized) Knowledge repo's own workspace — `status` still
      // works there without `init`, and it names its own binding.
      const fromKnowledge = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], knowledge, fw, { installationConfigPath: configPath }))).out,
      ) as { knowledgeBoundButUninitialized?: string };
      expect(fromKnowledge.knowledgeBoundButUninitialized?.toLowerCase()).toBe(knowledgeCanonical.toLowerCase());

      // From a DEV Target bound to that same (still uninitialized) Knowledge root.
      const target = makeTarget();
      const config = defaultTargetConfig(path.basename(target), "2026-01-01T00:00:00Z", "dev");
      config.knowledge = { path: knowledge };
      writeTargetConfig(target, config);
      expect((await capture(() => runTargetCli(["init", "--role", "dev"], target, fw, { installationConfigPath: configPath }))).code).toBe(0);

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: configPath }))).out,
      ) as { knowledgeBoundButUninitialized?: string };
      expect(status.knowledgeBoundButUninitialized?.toLowerCase()).toBe(knowledgeCanonical.toLowerCase());

      const rendered = (await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: configPath }))).out;
      expect(rendered).toMatch(/WARNING.*BA workspace role is not usable/);
      expect(rendered).toContain("software-team-agents init --role ba");

      // DEV preflight: a non-blocking note, not a failure — DEV still reads
      // Knowledge fine on markers alone.
      const templatesDir = path.join(fw, "templates");
      const ctx = devPreflight({ targetRoot: target, templatesDir, installationConfigPath: configPath, probe: () => ({ available: true }) });
      const note = ctx.checks.find((c) => c.name === "Knowledge (BA workspace role)");
      expect(note?.ok).toBe(true);
      expect(note?.detail).toMatch(/software-team-agents init --role ba/);
    });
  });

  describe("T-WG2 — roster-drift detection", () => {
    it("a hand-copied BA prompt (all 3 runtimes) in a dev workspace is flagged, never silently absorbed", async () => {
      const target = makeTarget();
      const fw = fakeFramework("1.0.0", FW_V1_FILES);
      expect((await capture(() => runTargetCli(["init", "--role", "dev"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);

      // Hand-copy business-analyst prompts into all three runtime renderings —
      // never part of the dev role's profile (assetsForRole excludes them),
      // never tracked by this Target's manifest.
      write(target, ".claude/agents/business-analyst.md", AGENT_MD("business-analyst"));
      write(target, ".codex/agents/business-analyst.toml", 'name = "business-analyst"\n');
      write(target, ".opencode/agent/business-analyst.md", AGENT_MD("business-analyst"));

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out,
      ) as { rosterDriftPaths: string[]; conflictCount: number };
      expect(new Set(status.rosterDriftPaths)).toEqual(
        new Set([".claude/agents/business-analyst.md", ".codex/agents/business-analyst.toml", ".opencode/agent/business-analyst.md"]),
      );
      expect(status.conflictCount).toBeGreaterThanOrEqual(3);

      const rendered = (await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out;
      expect(rendered).toMatch(/WARNING: roster drift/);
      expect(rendered).toContain(".claude/agents/business-analyst.md");
      expect(rendered).toContain("sync --force");

      // Plain `sync` (no --force) reports it as a conflict — same treatment as
      // an edited-managed file — and writes nothing.
      const syncRun = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(syncRun.code).toBe(2);
      expect(syncRun.err).toMatch(/business-analyst/);
      expect(fs.existsSync(path.join(target, ".claude", "agents", "business-analyst.md"))).toBe(true);

      // `sync --force` backs up and removes the drifted prompts.
      const forced = await capture(() => runTargetCli(["sync", "--force"], target, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(forced.code).toBe(0);
      expect(fs.existsSync(path.join(target, ".claude", "agents", "business-analyst.md"))).toBe(false);
      expect(fs.existsSync(path.join(target, ".codex", "agents", "business-analyst.toml"))).toBe(false);
      expect(fs.existsSync(path.join(target, ".opencode", "agent", "business-analyst.md"))).toBe(false);

      const after = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out,
      ) as { rosterDriftPaths: string[] };
      expect(after.rosterDriftPaths).toEqual([]);
    });

    it("an engineer prompt hand-copied into a BA (Knowledge) workspace is flagged the same way", async () => {
      const knowledge = makeKnowledgeRepo();
      const fw = fakeFramework("1.0.0", FW_V1_FILES);
      expect((await capture(() => runTargetCli(["init", "--role", "ba"], knowledge, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);

      write(knowledge, ".claude/agents/backend-engineer.md", AGENT_MD("backend-engineer"));

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], knowledge, fw, { installationConfigPath: NO_INSTALLATION }))).out,
      ) as { rosterDriftPaths: string[] };
      expect(status.rosterDriftPaths).toEqual([".claude/agents/backend-engineer.md"]);
    });

    it("a foreign file whose name does not match any known agent is still left alone (existing policy, unchanged)", async () => {
      const target = makeTarget();
      const fw = fakeFramework("1.0.0", FW_V1_FILES);
      expect((await capture(() => runTargetCli(["init", "--role", "dev"], target, fw, { installationConfigPath: NO_INSTALLATION }))).code).toBe(0);

      write(target, ".claude/agents/my-personal-notes.md", "# not an agent\n");

      const status = JSON.parse(
        (await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }))).out,
      ) as { rosterDriftPaths: string[]; conflictCount: number };
      expect(status.rosterDriftPaths).toEqual([]);
      expect(status.conflictCount).toBe(0);

      // Plain sync does not touch it, and reports no conflict for it either.
      const syncRun = await capture(() => runTargetCli(["sync"], target, fw, { installationConfigPath: NO_INSTALLATION }));
      expect(syncRun.code).toBe(0);
      expect(fs.existsSync(path.join(target, ".claude", "agents", "my-personal-notes.md"))).toBe(true);
    });
  });
});
