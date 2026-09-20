import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPathForComparison,
  configureDefaultRoot,
  configureIdentities,
  configureKnowledgeRoot,
  configureNamedKnowledgeRoot,
  InstallationConfigError,
  loadInstallationConfig,
  normalizeKnowledgeRoots,
  type InstallationConfig,
  type InstallationConfigV2,
} from "./installation.js";
import { CliUsageError, runCli } from "../cli.js";

/**
 * V11 TASK-022 — the named-root writer (DR §2.4). The v1 compat writer keeps
 * writing v1 single-root for machines that never send a named operation (A5);
 * the first named operation migrates to v2 preserving identities and the
 * original root; every v2 write derives `knowledge_root` from `default_root`.
 */

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sta-install-cfg-")));
  roots.push(root);
  return root;
}
function initRepository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}
function readRaw(configPath: string): string {
  return fs.readFileSync(configPath, "utf8");
}
function writeV1Fixture(configPath: string, knowledgeRoot: string, identities?: { figma_email: string; claude_email: string }): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const identitiesYaml = identities
    ? `\nidentities:\n  figma_email: "${identities.figma_email}"\n  claude_email: "${identities.claude_email}"\n`
    : "";
  fs.writeFileSync(
    configPath,
    `schema_version: 1\nknowledge_root: "${knowledgeRoot.replaceAll("\\", "\\\\")}"${identitiesYaml}`,
    "utf8",
  );
}
function rootsOf(config: InstallationConfig): Record<string, string> {
  return config.schema_version === 2 ? { ...config.knowledge_roots } : { default: config.knowledge_root };
}
function asV2(config: InstallationConfig): InstallationConfigV2 {
  if (config.schema_version !== 2) throw new Error(`expected a schema v2 installation config, got schema_version ${config.schema_version}`);
  return config;
}
function defaultRootOf(config: InstallationConfig): string {
  return asV2(config).default_root;
}
function samePath(a: string, b: string): boolean {
  return canonicalPathForComparison(a) === canonicalPathForComparison(b);
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("V11 TASK-022 — the named-root writer migrates v1 to v2 (DR §2.4, fixture DR §8.1)", () => {
  it("keeps identities and the original root when the named path is the existing v1 root: the given name becomes the first entry and the default", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "local", "installation.yaml");
    initRepository(knowledge);
    writeV1Fixture(config, knowledge, { figma_email: "a@person.dev", claude_email: "a@person.dev" });

    const next = configureNamedKnowledgeRoot(knowledge, { rootName: "personal", configPath: config });

    const v2 = asV2(next);
    expect(Object.keys(v2.knowledge_roots).sort()).toEqual(["personal"]);
    expect(samePath(v2.knowledge_roots.personal as string, knowledge)).toBe(true);
    expect(v2.default_root).toBe("personal");
    // knowledge_root is computed from default_root, never independent
    expect(samePath(v2.knowledge_root, v2.knowledge_roots[v2.default_root] as string)).toBe(true);
    expect(next.identities).toEqual({ figma_email: "a@person.dev", claude_email: "a@person.dev" });
    // the written file round-trips through the loader with the same identities
    const loaded = loadInstallationConfig(config);
    expect(loaded.schema_version).toBe(2);
    expect(loaded.identities).toEqual({ figma_email: "a@person.dev", claude_email: "a@person.dev" });
    const normalized = normalizeKnowledgeRoots(loaded);
    expect(normalized.defaultRoot).toBe("personal");
    expect(samePath(normalized.roots.personal as string, knowledge)).toBe(true);
  });

  it("keeps the original root as 'default' when the named path is new; the default moves only with --default", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const other = path.join(root, "other-root");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(other);
    writeV1Fixture(config, knowledge, { figma_email: "b@person.dev", claude_email: "b@person.dev" });

    const migrated = configureNamedKnowledgeRoot(other, { rootName: "work", configPath: config });
    const migratedV2 = asV2(migrated);
    expect(Object.keys(migratedV2.knowledge_roots).sort()).toEqual(["default", "work"]);
    expect(samePath(migratedV2.knowledge_roots.default as string, knowledge)).toBe(true);
    expect(samePath(migratedV2.knowledge_roots.work as string, other)).toBe(true);
    expect(migratedV2.default_root).toBe("default");
    expect(samePath(migratedV2.knowledge_root, knowledge)).toBe(true);
    expect(migrated.identities).toEqual({ figma_email: "b@person.dev", claude_email: "b@person.dev" });

    const retargeted = configureNamedKnowledgeRoot(other, { rootName: "work", makeDefault: true, configPath: config });
    expect(asV2(retargeted).default_root).toBe("work");
    expect(samePath(retargeted.knowledge_root, other)).toBe(true);
    expect(retargeted.identities).toEqual({ figma_email: "b@person.dev", claude_email: "b@person.dev" });
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("work");
  });

  it("creates the v2 installation directly when the first named operation runs on a machine with no installation file", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "local", "installation.yaml");
    initRepository(knowledge);

    const next = configureNamedKnowledgeRoot(knowledge, { rootName: "solo", configPath: config });
    expect(asV2(next).default_root).toBe("solo");
    expect(Object.keys(asV2(next).knowledge_roots)).toEqual(["solo"]);
    expect(loadInstallationConfig(config).schema_version).toBe(2);
  });

  it("updates an existing v2 entry in place: a repointed default entry carries knowledge_root with it", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const moved = path.join(root, "knowledge-moved");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(moved);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(knowledge, { rootName: "main", configPath: config });

    const repointed = configureNamedKnowledgeRoot(moved, { rootName: "main", configPath: config });
    const repointedV2 = asV2(repointed);
    expect(Object.keys(repointedV2.knowledge_roots)).toEqual(["main"]);
    expect(repointedV2.default_root).toBe("main");
    expect(samePath(repointedV2.knowledge_root, moved)).toBe(true);
    expect(samePath(loadInstallationConfig(config).knowledge_root, moved)).toBe(true);
  });

  it("refuses a named entry whose canonical path duplicates another root's path, leaving the file untouched", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(knowledge, { rootName: "main", configPath: config });
    const before = readRaw(config);

    expect(() => configureNamedKnowledgeRoot(knowledge, { rootName: "alias", configPath: config })).toThrow(InstallationConfigError);
    expect(() => configureNamedKnowledgeRoot(knowledge, { rootName: "alias", configPath: config })).toThrow(/already registered as "main"/);
    expect(readRaw(config)).toBe(before);
  });

  it("refuses naming a different path 'default' while migrating a v1 file — the original root keeps that name", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const other = path.join(root, "other-root");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(other);
    writeV1Fixture(config, knowledge);
    const before = readRaw(config);

    expect(() => configureNamedKnowledgeRoot(other, { rootName: "default", configPath: config })).toThrow(/keeps the name "default"/);
    expect(readRaw(config)).toBe(before);
  });

  it("refuses a named write over an existing-but-broken installation file instead of clobbering it", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    fs.writeFileSync(config, "schema_version: 99\n", "utf8");

    expect(() => configureNamedKnowledgeRoot(knowledge, { rootName: "main", configPath: config })).toThrow(InstallationConfigError);
    expect(readRaw(config)).toBe("schema_version: 99\n");
  });
});

describe("V11 TASK-022 — the v1 compat writer (A5: a machine without named operations keeps writing v1)", () => {
  it("writes and replaces v1 single-root when no named operation is sent, never migrating silently", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const newer = path.join(root, "newer-root");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(newer);

    const first = configureKnowledgeRoot(knowledge, config);
    expect(first.schema_version).toBe(1);
    expect(loadInstallationConfig(config)).toEqual({ schema_version: 1, knowledge_root: fs.realpathSync.native(knowledge) });

    const replaced = configureKnowledgeRoot(newer, config);
    expect(replaced.schema_version).toBe(1);
    expect(samePath(replaced.knowledge_root, newer)).toBe(true);
    expect(loadInstallationConfig(config).schema_version).toBe(1);
  });

  it("refuses the pathless form on a v2 installation instead of replacing the whole map, naming the named-entry writer", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(knowledge, { rootName: "main", configPath: config });
    const before = readRaw(config);

    expect(() => configureKnowledgeRoot(knowledge, config)).toThrow(/--root <name>/);
    expect(readRaw(config)).toBe(before);
    expect(loadInstallationConfig(config).schema_version).toBe(2);
  });

  it("keeps identities merging into a v1 file without migrating it", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    configureKnowledgeRoot(knowledge, config);

    const next = configureIdentities({ figma_email: "c@person.dev", claude_email: "c@person.dev" }, config);
    expect(next.schema_version).toBe(1);
    expect(loadInstallationConfig(config).schema_version).toBe(1);
    expect(loadInstallationConfig(config).identities).toEqual({ figma_email: "c@person.dev", claude_email: "c@person.dev" });
  });
});

describe("V11 TASK-022 — sta configure default-root (DR §2.4)", () => {
  it("switches the default on v2 without re-taking the path, recomputing knowledge_root and preserving identities", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const other = path.join(root, "other-root");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(other);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(other, { rootName: "work", configPath: config });

    const next = configureDefaultRoot("work", config);
    const nextV2 = asV2(next);
    expect(nextV2.default_root).toBe("work");
    expect(samePath(nextV2.knowledge_root, other)).toBe(true);
    expect(Object.keys(nextV2.knowledge_roots).sort()).toEqual(["default", "work"]);
    expect(samePath(nextV2.knowledge_root, nextV2.knowledge_roots.work as string)).toBe(true);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("work");
  });

  it("is a no-op that leaves the file byte-identical when the named root is already the default", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(knowledge, { rootName: "main", configPath: config });
    const before = readRaw(config);

    expect(asV2(configureDefaultRoot("main", config)).default_root).toBe("main");
    expect(readRaw(config)).toBe(before);

    writeV1Fixture(path.join(root, "v1.yaml"), knowledge);
    const v1Before = readRaw(path.join(root, "v1.yaml"));
    expect(configureDefaultRoot("default", path.join(root, "v1.yaml")).schema_version).toBe(1);
    expect(readRaw(path.join(root, "v1.yaml"))).toBe(v1Before);
  });

  it("refuses an unknown root name with the deterministic list and the current default, leaving the file untouched", () => {
    const root = tempRoot();
    const knowledge = path.join(root, "knowledge");
    const other = path.join(root, "other-root");
    const config = path.join(root, "installation.yaml");
    initRepository(knowledge);
    initRepository(other);
    configureKnowledgeRoot(knowledge, config);
    configureNamedKnowledgeRoot(other, { rootName: "work", configPath: config });
    const before = readRaw(config);

    expect(() => configureDefaultRoot("personal", config)).toThrow(
      /unknown Knowledge root "personal"; available roots: default, work; default: default/,
    );
    expect(readRaw(config)).toBe(before);
  });

  it("refuses when there is no installation file yet", () => {
    const root = tempRoot();
    const config = path.join(root, "missing", "installation.yaml");
    expect(() => configureDefaultRoot("main", config)).toThrow(/no installation config/);
  });
});

describe("V11 TASK-022 — the configure CLI surface (DR §2.4)", () => {
  it("writes a named v2 entry and switches the default through the CLI", async () => {
    const root = tempRoot();
    const framework = path.join(root, "framework");
    const knowledge = path.join(root, "knowledge");
    const other = path.join(root, "other-root");
    const config = path.join(root, "installation.yaml");
    initRepository(framework);
    initRepository(knowledge);
    initRepository(other);

    expect(await runCli(["configure", "knowledge-root", knowledge, "--root", "main", "--config-path", config], framework)).toBe(0);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("main");
    expect(await runCli(["configure", "knowledge-root", other, "--root", "work", "--config-path", config], framework)).toBe(0);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("main");
    expect(await runCli(["configure", "knowledge-root", other, "--root", "work", "--default", "--config-path", config], framework)).toBe(0);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("work");
    expect(await runCli(["configure", "default-root", "--root", "main", "--config-path", config], framework)).toBe(0);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("main");
  });

  it("refuses the v2 pathless form through the CLI with exit 1", async () => {
    const root = tempRoot();
    const framework = path.join(root, "framework");
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(framework);
    initRepository(knowledge);
    await runCli(["configure", "knowledge-root", knowledge, "--root", "main", "--config-path", config], framework);

    expect(await runCli(["configure", "knowledge-root", knowledge, "--config-path", config], framework)).toBe(1);
    expect(loadInstallationConfig(config).schema_version).toBe(2);
  });

  it("usage-refuses --default without --root and default-root without --root", async () => {
    const root = tempRoot();
    const framework = path.join(root, "framework");
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(framework);
    initRepository(knowledge);

    await expect(runCli(["configure", "knowledge-root", knowledge, "--default", "--config-path", config], framework)).rejects.toThrow(CliUsageError);
    await expect(runCli(["configure", "default-root", "--config-path", config], framework)).rejects.toThrow(CliUsageError);
    expect(fs.existsSync(config)).toBe(false);
  });

  it("still refuses an unknown default-root name through the CLI with exit 1", async () => {
    const root = tempRoot();
    const framework = path.join(root, "framework");
    const knowledge = path.join(root, "knowledge");
    const config = path.join(root, "installation.yaml");
    initRepository(framework);
    initRepository(knowledge);
    await runCli(["configure", "knowledge-root", knowledge, "--root", "main", "--config-path", config], framework);

    expect(await runCli(["configure", "default-root", "--root", "nope", "--config-path", config], framework)).toBe(1);
    expect(defaultRootOf(loadInstallationConfig(config))).toBe("main");
  });
});
