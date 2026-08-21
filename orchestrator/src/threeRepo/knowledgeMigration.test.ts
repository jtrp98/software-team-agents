import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { collectMigrationManifest, confirmCutover, copyMigrationSource, readMigrationManifest, transformMigratedKnowledge, verifyMigration, writeMigrationManifest } from "./knowledgeMigration.js";

function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "sta-migration-")); }
function write(file: string, text: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function item(): string { return `schema_version: 1\nid: BE-001\nkind: task\ntitle: Migrate\nbody: x\nrepo: null\nmodule: pilot\nowner: backend-engineer\nstatus: approved\nsensitive: false\nversion: 3\ncreated_at: 2026-08-21T00:00:00.000Z\nupdated_at: 2026-08-21T00:00:00.000Z\nsources:\n  - type: file\n    locator: _docs/a.md\n    captured_at: 2026-08-21T00:00:00.000Z\n    digest: sha256:bad\nrelations: []\npayload:\n  agent: backend-engineer\n  phase: 5\n  tag: backend\n  plan_status: pending\n  produces: []\n  consumes: []\n  contract_version: 2\n  orchestrator_task_id: null\n`; }

describe("three-repo knowledge migration", () => {
  it("copies only manifest inventory, preserves source, and transforms an approved item to v2", () => {
    const base = root(); const source = path.join(base, "source"); const knowledge = path.join(base, "knowledge");
    write(path.join(source, "_docs", "a.md"), "docs"); write(path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"), item());
    const options = { sourceRoot: source, knowledgeRoot: knowledge, now: "2026-08-21T01:00:00.000Z" };
    const manifest = collectMigrationManifest(options);
    expect(manifest.docs).toHaveLength(1); expect(manifest.knowledge).toHaveLength(1);
    copyMigrationSource(manifest, options); transformMigratedKnowledge(options); writeMigrationManifest(manifest, knowledge);
    expect(fs.readFileSync(path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"), "utf8")).toContain("schema_version: 1");
    const migrated = parseYaml(fs.readFileSync(path.join(knowledge, "knowledge", "pilot", "task", "BE-001.yaml"), "utf8")) as Record<string, unknown>;
    expect(migrated.schema_version).toBe(2); expect(migrated.version).toBe(4); expect(migrated.status).toBe("approved"); expect(migrated.target_ids).toEqual(["sb-web-helper"]);
    expect(readMigrationManifest(knowledge).docs[0].sha256).toBe(manifest.docs[0].sha256);
  });

  it("blocks cutover for verification mismatch or missing explicit human phrase", () => {
    const failed = { ok: false, problems: ["hash mismatch"], docs: 0, knowledgeYaml: 0, items: 0, fresh: 0 };
    expect(() => confirmCutover(failed, "I_CONFIRM_MIGRATION", "C:/installation.yaml")).toThrow(/blocked/);
    const green = { ...failed, ok: true, problems: [] };
    expect(() => confirmCutover(green, undefined, "C:/installation.yaml")).toThrow(/requires human/);
  });

  it("detects source changes during copy before any destination write", () => {
    const base = root(); const source = path.join(base, "source"); const knowledge = path.join(base, "knowledge");
    write(path.join(source, "_docs", "a.md"), "before"); write(path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"), item());
    const options = { sourceRoot: source, knowledgeRoot: knowledge, now: "2026-08-21T01:00:00.000Z" }; const manifest = collectMigrationManifest(options);
    write(path.join(source, "_docs", "a.md"), "after");
    expect(() => copyMigrationSource(manifest, options)).toThrow(/hash changed/);
    expect(fs.existsSync(path.join(knowledge, "_docs", "a.md"))).toBe(false);
  });

  it("reports count mismatch instead of permitting cutover", () => {
    const base = root(); const source = path.join(base, "source"); const knowledge = path.join(base, "knowledge");
    write(path.join(source, "_docs", "a.md"), "docs"); write(path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"), item());
    const options = { sourceRoot: source, knowledgeRoot: knowledge, now: "2026-08-21T01:00:00.000Z" }; const manifest = collectMigrationManifest(options);
    copyMigrationSource(manifest, options); transformMigratedKnowledge(options);
    expect(verifyMigration(manifest, options).ok).toBe(false);
  });
});
