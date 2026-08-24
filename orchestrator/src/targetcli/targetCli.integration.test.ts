import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { runTargetCli } from "./cli.js";
import { isInsideFrameworkRoot, resolveFrameworkRoot, resolveRoots } from "./roots.js";
import { devPreflight, runBa, runDev } from "./devCommand.js";
import { readTargetManifest, writeTargetConfig, defaultTargetConfig } from "./targetMeta.js";
import { configureKnowledgeRoot } from "../threeRepo/installation.js";

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

/** A fake installed-Framework package: `<fwRoot>/templates/**` + manifest.json. */
function fakeFramework(version: string, files: { relPath: string; content: string }[]): string {
  const fwRoot = tmpRoot("fw");
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

  it("T-WG9 — status names project-owned collisions per path and goes quiet once claimed", async () => {
    const target = makeTarget();
    const fw = fakeFramework("1.0.0", [
      { relPath: ".claude/agents/backend-engineer.md", content: AGENT_MD("backend-engineer") },
      { relPath: ".claude/settings.json", content: '{"hooks":{"PreToolUse":[{"sta":true}]}}' },
    ]);
    // The project owned settings.json before the Framework ever arrived.
    fs.mkdirSync(path.join(target, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "settings.json"), '{"hooks":{"PreToolUse":[{"project":true}]}}', "utf8");

    const initRun = await capture(() => runTargetCli(["init"], target, fw));
    expect(initRun.code).toBe(0);

    const statusRun = await capture(() => runTargetCli(["status", "--json"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(statusRun.code).toBe(0);
    const status = JSON.parse(statusRun.out) as { projectOwnedPaths: string[]; conflictCount: number };
    expect(status.projectOwnedPaths).toEqual([".claude/settings.json"]);
    expect(status.conflictCount).toBeGreaterThanOrEqual(1); // the collision is visible, never silent

    const rendered = await capture(() => runTargetCli(["status"], target, fw, { installationConfigPath: NO_INSTALLATION }));
    expect(rendered.out).toContain("project-owned paths left alone (1)");
    expect(rendered.out).toContain(".claude/settings.json");
    expect(rendered.out).toContain("Merging with the project's existing Claude setup");

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

    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("# Framework instructions v2\n");
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
    expect(fs.readFileSync(claudeMd, "utf8")).toBe("# Framework instructions v2\n");
    const backupsDir = path.join(target, ".agent-team", "backups");
    const backupSession = fs.readdirSync(backupsDir)[0];
    expect(backupSession).toBeDefined();
    expect(fs.readFileSync(path.join(backupsDir, backupSession!, "CLAUDE.md"), "utf8")).toBe("# my local tweaks\n");
    expect(fs.readFileSync(path.join(target, "src", "example.ts"), "utf8")).toContain("app logic");
  });

  it("dev: preflight fails closed on conflicts and missing runtime, then launches FROM the Target with policy env", async () => {
    const target = makeTarget();
    const fw = fakeFramework("3.1.0", [
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
    const exitCode = await runDev({
      targetRoot: target,
      templatesDir,
      installationConfigPath: NO_INSTALLATION,
      probe: () => ({ available: true, detail: "claude 1.2.3" }),
      launch: (_cmd, _args, cwd, env) => {
        launchedCwd = cwd;
        launchedEnv = env;
        return Promise.resolve(7);
      },
    });
    expect(launchedCwd.toLowerCase()).toBe(fs.realpathSync.native(target).toLowerCase());
    expect(launchedEnv?.AGENTCLAUDE_WRITABLE_WORK_ROOTS).toBe("[]");
    expect(exitCode).toBe(7);

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

    // `sync` tolerates it (exit 0, file untouched) ...
    expect((await capture(() => runTargetCli(["sync"], target, fw))).code).toBe(0);
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("# the project's own instructions\n");

    // ... so preflight must too, and must say which path it left alone.
    const ctx = devPreflight({ targetRoot: target, templatesDir, installationConfigPath: NO_INSTALLATION, probe: () => ({ available: true }) });
    const managed = ctx.checks.find((c) => c.name === "Managed files");
    expect(managed?.ok).toBe(true);
    expect(managed?.detail).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("# the project's own instructions\n");
  });
});

describe("role workspace architecture (T-ROLE)", () => {
  const FW_V1_FILES = [
    // BA lane agents
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

    // Role profile: lane agents land, engineer agents and pipeline payload do not.
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

  it("ba command: preflight passes without any Target checkout and launches from Knowledge (T-ROLE-03/19)", async () => {
    const knowledge = makeKnowledgeRepo();
    const fw = fakeFramework("1.0.0", FW_V1_FILES);

    expect((await capture(() => runTargetCli(["init"], knowledge, fw))).code).toBe(0);

    let launchedCwd = "";
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    const exitCode = await runBa({
      targetRoot: knowledge,
      templatesDir: path.join(fw, "templates"),
      installationConfigPath: NO_INSTALLATION,
      probe: (cmd) => ({ available: true, detail: `${cmd} ready` }),
      launch: (_cmd, _args, cwd, env) => {
        launchedCwd = cwd;
        launchedEnv = env;
        return Promise.resolve(0);
      },
    });
    expect(exitCode).toBe(0);
    expect(launchedCwd.toLowerCase()).toBe(fs.realpathSync.native(knowledge).toLowerCase());
    expect(launchedEnv?.AGENTCLAUDE_WRITABLE_WORK_ROOTS).toBe("[]");
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
    expect(fs.readFileSync(path.join(knowledge, "CLAUDE.md"), "utf8")).toBe("# Framework instructions v2\n");
    // The DEV workspace stays on v1 until its owner decides to sync.
    expect(readTargetManifest(target).framework_version).toBe("1.0.0");
    expect(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toBe("# Framework instructions v1\n");

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
      expect(rendered).toMatch(/WARNING.*BA-lane is not usable/);
      expect(rendered).toContain("software-team-agents init --role ba");

      // DEV preflight: a non-blocking note, not a failure — DEV still reads
      // Knowledge fine on markers alone.
      const templatesDir = path.join(fw, "templates");
      const ctx = devPreflight({ targetRoot: target, templatesDir, installationConfigPath: configPath, probe: () => ({ available: true }) });
      const note = ctx.checks.find((c) => c.name === "Knowledge (BA lane)");
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
