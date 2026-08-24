import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFrameworkManagedPaths, ownerOfPath } from "./ownership.js";
import { assertStandaloneKnowledgeRoot, configureKnowledgeRoot, loadInstallationConfig } from "./installation.js";
import { assertTargetCanStartNewTask, assertTargetIdsImmutable, loadTargetRegistry, writeTargetRegistry, type TargetRegistry } from "./targets.js";
import { loadLocalTargetMapping } from "./localTargets.js";
import { runCli } from "../cli.js";

const roots: string[] = [];
function tempRoot(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-three-repo-")); roots.push(root); return root; }
function write(file: string, body: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, "utf8"); }
function registryYaml(entries: string): string { return `schema_version: 1\ntargets:\n${entries}`; }
function initRepository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("three-repo ownership", () => {
  it("keeps Knowledge and Target owned paths out of framework manifests", () => {
    expect(ownerOfPath("targets.yaml")).toBe("knowledge");
    expect(ownerOfPath("knowledge/_roles/ba.yaml")).toBe("knowledge");
    expect(ownerOfPath("AGENTS.md")).toBe("target");
    expect(ownerOfPath(".claude/settings.json")).toBe("target");
    expect(() => assertFrameworkManagedPaths(["policies/coding.md", "knowledge-policy.yaml"])).toThrow(/project-owned/);
  });
});

describe("installation Knowledge root", () => {
  it("validates the root before persisting one canonical Knowledge root", () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const config = path.join(root, "local", "installation.yaml");
    initRepository(framework); initRepository(knowledge);
    expect(configureKnowledgeRoot(knowledge, config, framework).knowledge_root).toBe(fs.realpathSync.native(knowledge));
    expect(loadInstallationConfig(config)).toEqual({ schema_version: 1, knowledge_root: fs.realpathSync.native(knowledge) });
    expect(() => configureKnowledgeRoot(path.join(root, "missing"), config, framework)).toThrow(/not an existing directory/);
    expect(() => configureKnowledgeRoot(knowledge, path.join(knowledge, "installation.yaml"), framework)).toThrow(/installation-local/);
    fs.mkdirSync(path.join(root, "target", ".git"), { recursive: true });
    expect(() => configureKnowledgeRoot(knowledge, path.join(root, "target", "installation.yaml"), framework)).toThrow(/Framework or Target/);
  });
  it("configures a root through the CLI without accepting it as a task-run override", async () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const config = path.join(root, "installation.yaml");
    initRepository(framework); initRepository(knowledge);
    expect(await runCli(["configure", "knowledge-root", knowledge, "--config-path", config], framework)).toBe(0);
    expect(loadInstallationConfig(config).knowledge_root).toBe(fs.realpathSync.native(knowledge));
  });
  it("rejects non-Git roots, linked worktrees, and Framework overlap during configuration", () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const config = path.join(root, "installation.yaml");
    initRepository(framework); fs.mkdirSync(knowledge);
    expect(() => configureKnowledgeRoot(knowledge, config, framework)).toThrow(/not a standalone Git repository/);
    fs.rmSync(knowledge, { recursive: true });
    fs.mkdirSync(knowledge); fs.writeFileSync(path.join(knowledge, ".git"), "gitdir: ../.git/worktrees/knowledge\n");
    expect(() => configureKnowledgeRoot(knowledge, config, framework)).toThrow(/linked worktree/);
    expect(() => assertStandaloneKnowledgeRoot(knowledge)).toThrow(/linked worktree/);
    expect(() => configureKnowledgeRoot(framework, config, framework)).toThrow(/must not overlap/);
  });
});

describe("declared identities (T-UX3 identity gate)", () => {
  it("configures identities through the CLI into the same installation config as the Knowledge root", async () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const config = path.join(root, "local", "installation.yaml");
    initRepository(framework); initRepository(knowledge);
    expect(await runCli(["configure", "knowledge-root", knowledge, "--config-path", config], framework)).toBe(0);
    expect(await runCli(["configure", "identity", "--figma-email", "Same@Person.dev ", "--claude-email", "same@person.dev", "--config-path", config], framework)).toBe(0);

    const loaded = loadInstallationConfig(config);
    // The Knowledge root binding survives an identity declaration — independent acts, one file.
    expect(loaded.knowledge_root).toBe(fs.realpathSync.native(knowledge));
    expect(loaded.identities).toEqual({ figma_email: "Same@Person.dev", claude_email: "same@person.dev" });
  });

  it("refuses to declare identities without a bound Knowledge root, and without both emails", async () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const config = path.join(root, "local", "installation.yaml");
    initRepository(framework);
    expect(await runCli(["configure", "identity", "--figma-email", "a@b.dev", "--claude-email", "a@b.dev", "--config-path", config], framework)).toBe(1);
    expect(fs.existsSync(config)).toBe(false);

    const knowledge = path.join(root, "knowledge");
    initRepository(knowledge);
    await runCli(["configure", "knowledge-root", knowledge, "--config-path", config], framework);
    expect(await runCli(["configure", "identity", "--figma-email", "a@b.dev", "--config-path", config], framework)).toBe(1);
    expect(loadInstallationConfig(config).identities).toBeUndefined();
  });

  it("rejects a malformed email through the same schema a later load applies", async () => {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const config = path.join(root, "installation.yaml");
    initRepository(framework); initRepository(knowledge);
    await runCli(["configure", "knowledge-root", knowledge, "--config-path", config], framework);
    expect(await runCli(["configure", "identity", "--figma-email", "not-an-email", "--claude-email", "a@b.dev", "--config-path", config], framework)).toBe(1);
    // Nothing half-written: the previous valid state is still what loads.
    expect(loadInstallationConfig(config).identities).toBeUndefined();
  });
});

describe("Target registry", () => {
  it("accepts a second Target without changing framework source and resolves lifecycle correctly", () => {
    const knowledge = tempRoot();
    write(path.join(knowledge, "targets.yaml"), registryYaml("  - target_id: sb-web-helper\n    name: SB Web Helper\n    remote_url: https://github.com/Jabjai-Corporation/sb-web-helper.git\n    status: active\n  - target_id: school-api\n    name: School API\n    remote_url: git@github.com:Jabjai-Corporation/school-api.git\n    status: retired\n"));
    const registry = loadTargetRegistry(knowledge);
    expect(registry.targets).toHaveLength(2);
    expect(() => assertTargetCanStartNewTask(registry, "school-api")).toThrow(/retired/);
    expect(() => assertTargetCanStartNewTask(registry, "missing")).toThrow(/unknown/);
  });

  it("rejects duplicate ids and credentials in remotes", () => {
    const knowledge = tempRoot();
    write(path.join(knowledge, "targets.yaml"), registryYaml("  - target_id: duplicate\n    name: First\n    remote_url: https://github.com/a/first.git\n    status: active\n  - target_id: duplicate\n    name: Second\n    remote_url: https://token@github.com/a/second.git\n    status: active\n"));
    expect(() => loadTargetRegistry(knowledge)).toThrow(/duplicate/);
  });
  it("rejects malformed id, blank name, and invalid lifecycle state", () => {
    const knowledge = tempRoot();
    write(path.join(knowledge, "targets.yaml"), registryYaml("  - target_id: Bad_Id\n    name: '   '\n    remote_url: https://github.com/a/x.git\n    status: paused\n"));
    expect(() => loadTargetRegistry(knowledge)).toThrow(/invalid/);
  });

  it("does not permit a known Target name to change its immutable identity", () => {
    const previous: TargetRegistry = { schema_version: 1, targets: [{ target_id: "old", name: "Same", remote_url: "https://github.com/a/x.git", status: "active" }] };
    const next: TargetRegistry = { schema_version: 1, targets: [{ target_id: "new", name: "Same", remote_url: "https://github.com/a/x.git", status: "retired" }] };
    expect(() => assertTargetIdsImmutable(previous, next)).toThrow(/immutable/);
  });
  it("does not permit a Target to bypass immutable identity by changing its name too", () => {
    const previous: TargetRegistry = { schema_version: 1, targets: [{ target_id: "old", name: "Old name", remote_url: "https://github.com/a/x.git", status: "active" }] };
    const next: TargetRegistry = { schema_version: 1, targets: [{ target_id: "new", name: "New name", remote_url: "https://github.com/a/x.git", status: "retired" }] };
    expect(() => assertTargetIdsImmutable(previous, next)).toThrow(/immutable/);
  });
  it("enforces immutable ids on the registry writer", () => {
    const knowledge = tempRoot();
    const old: TargetRegistry = { schema_version: 1, targets: [{ target_id: "old", name: "Old", remote_url: "https://github.com/a/x.git", status: "active" }] };
    writeTargetRegistry(knowledge, old);
    const changed: TargetRegistry = { schema_version: 1, targets: [{ target_id: "new", name: "New", remote_url: "https://github.com/a/x.git", status: "active" }] };
    expect(() => writeTargetRegistry(knowledge, changed)).toThrow(/immutable/);
  });
  it("requires soft-retire rather than deleting or replacing a registered Target remote", () => {
    const previous: TargetRegistry = { schema_version: 1, targets: [{ target_id: "one", name: "One", remote_url: "https://github.com/a/one.git", status: "active" }] };
    expect(() => assertTargetIdsImmutable(previous, { schema_version: 1, targets: [] })).toThrow(/deleted.*retired/);
    expect(() => assertTargetIdsImmutable(previous, { schema_version: 1, targets: [{ ...previous.targets[0], remote_url: "https://github.com/a/two.git" }] })).toThrow(/remote_url is immutable/);
  });
});

describe("local Target mapping", () => {
  function setup(): { framework: string; knowledge: string; targets: string[] } {
    const root = tempRoot(); const framework = path.join(root, "framework"); const knowledge = path.join(root, "knowledge"); const first = path.join(root, "first"); const second = path.join(root, "second");
    [framework, knowledge, first, second].forEach(initRepository);
    write(path.join(knowledge, "targets.yaml"), registryYaml("  - target_id: first\n    name: First\n    remote_url: https://github.com/a/first.git\n    status: active\n  - target_id: second\n    name: Second\n    remote_url: https://github.com/a/second.git\n    status: active\n"));
    return { framework, knowledge, targets: [first, second] };
  }
  it("canonicalizes valid local paths", () => {
    const { framework, knowledge, targets } = setup(); const registry = loadTargetRegistry(knowledge);
    write(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  first:\n    path: ${targets[0]}\n  second:\n    path: ${targets[1]}\n`);
    expect(loadLocalTargetMapping(knowledge, registry, framework).map((entry) => entry.path)).toEqual(targets.map((target) => fs.realpathSync.native(target)));
  });
  it("rejects unknown, missing, duplicate and root-overlapping mappings", () => {
    const { framework, knowledge, targets } = setup(); const registry = loadTargetRegistry(knowledge); const local = path.join(knowledge, ".workflow", "targets.local.yaml");
    write(local, `schema_version: 1\ntargets:\n  unknown:\n    path: ${targets[0]}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/unknown/);
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${path.join(knowledge, "missing")}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/not an existing directory/);
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${targets[0]}\n  second:\n    path: ${targets[0]}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/overlaps Target/);
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${knowledge}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/overlaps Knowledge/);
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${framework}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/overlaps Framework/);
    const nested = path.join(targets[0], "nested"); initRepository(nested);
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${targets[0]}\n  second:\n    path: ${nested}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/overlaps Target/);
  });
  it("rejects a Target that is not a standalone Git top-level or is a linked worktree", () => {
    const { framework, knowledge, targets } = setup(); const registry = loadTargetRegistry(knowledge); const local = path.join(knowledge, ".workflow", "targets.local.yaml");
    fs.rmSync(path.join(targets[0], ".git"), { recursive: true });
    write(local, `schema_version: 1\ntargets:\n  first:\n    path: ${targets[0]}\n`);
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/not a standalone Git repository/);
    fs.writeFileSync(path.join(targets[0], ".git"), "gitdir: ../.git/worktrees/first\n");
    expect(() => loadLocalTargetMapping(knowledge, registry, framework)).toThrow(/linked worktree/);
  });
});
