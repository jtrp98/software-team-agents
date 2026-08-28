import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { collectMigrationManifest, confirmCutover, copyMigrationSource, readMigrationManifest, transformMigratedKnowledge, verifyMigration, writeMigrationManifest } from "./knowledgeMigration.js";
import { configureKnowledgeRoot } from "./installation.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { sourceIdFor, writeSourceRecord } from "../knowledge/sourceRegistry.js";
import { AgentStage } from "../types.js";

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
    expect(migrated.schema_version).toBe(2); expect(migrated.version).toBe(3); expect(migrated.status).toBe("approved"); expect(migrated.target_ids).toEqual(["sb-web-helper"]);
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
    const options = { sourceRoot: source, knowledgeRoot: path.join(base, "knowledge"), now: "2026-08-21T01:00:00.000Z" };
    const manifest = collectMigrationManifest(options);
    copyMigrationSource(manifest, options); transformMigratedKnowledge(options);
    expect(verifyMigration(manifest, options).ok).toBe(false);
  });

  it("runs the full lifecycle — copy, verify, human-confirmed cutover — and rolls the binding back with the source byte-identical (T164)", () => {
    const base = root(); const source = path.join(base, "source"); const knowledge = path.join(base, "knowledge");
    // Standalone repos for every authority root, and a plain dir for the
    // installation config (configureKnowledgeRoot refuses configs inside any repo).
    for (const dir of [source, knowledge, path.join(base, "elsewhere")]) {
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    }
    write(path.join(source, "_docs", "a.md"), "docs");
    const realDocsDigest = digestOfSource("_docs/a.md", source)!;
    write(
      path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"),
      item().replace("digest: sha256:bad", `digest: ${realDocsDigest}`),
    );
    const options = { sourceRoot: source, knowledgeRoot: knowledge, now: "2026-08-21T01:00:00.000Z" };

    const manifest = collectMigrationManifest(options);
    copyMigrationSource(manifest, options); transformMigratedKnowledge(options); writeMigrationManifest(manifest, knowledge);

    // A migrated knowledge repo must carry its own Target registry and source
    // registry — the real schoolbright-knowledge has both; the fixture needs
    // them too or the verifier correctly refuses to bless the copy.
    fs.writeFileSync(
      path.join(knowledge, "targets.yaml"),
      "schema_version: 1\ntargets:\n  - target_id: sb-web-helper\n    name: SB Web Helper\n    remote_url: https://github.com/Jabjai-Corporation/sb-web-helper.git\n    status: active\n",
    );
    writeSourceRecord(
      {
        schema_version: 1,
        id: sourceIdFor("_docs/a.md"),
        type: "file",
        locator: "_docs/a.md",
        captured_at: "2026-08-21T00:00:00.000Z",
        captured_by: AgentStage.BACKEND_ENGINEER,
        digest: realDocsDigest,
        origin: { root: "knowledge", target_id: null },
      },
      knowledge,
    );

    const verification = verifyMigration(manifest, options);
    expect(verification.ok).toBe(true);

    const configPath = path.join(base, "installation.yaml");
    confirmCutover(verification, "I_CONFIRM_MIGRATION", configPath);
    configureKnowledgeRoot(knowledge, configPath);
    expect(parseYaml(fs.readFileSync(configPath, "utf8")).knowledge_root).toBe(fs.realpathSync.native(knowledge));

    // ROLLBACK: rebind elsewhere and drop the copied tree — the source must
    // stay byte-identical throughout, because migration never mutates it.
    configureKnowledgeRoot(path.join(base, "elsewhere"), configPath);
    fs.rmSync(path.join(knowledge, "_docs", "a.md"));
    expect(digestOfSource("_docs/a.md", source)).toBe(realDocsDigest);
    expect(fs.readFileSync(path.join(source, "knowledge", "pilot", "task", "BE-001.yaml"), "utf8")).toContain("schema_version: 1");
  });
});
