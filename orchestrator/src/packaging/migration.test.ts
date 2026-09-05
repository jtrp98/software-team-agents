import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CURRENT_STA_SCHEMA_VERSION, readInstallManifest, writeInstallManifest } from "./installManifest.js";
import { NoMigrationPathError, STA_MIGRATIONS, migrateSta, type StaMigrationStep } from "./migration.js";

const roots: string[] = [];
function tmpProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-migrate-project-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function initManifest(root: string, schemaVersion: number): void {
  writeInstallManifest(root, {
    schema_version: schemaVersion,
    framework_version: "0.1.0",
    installed_at: "2026-08-20T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
    files: [],
  });
}

describe("STA_MIGRATIONS", () => {
  it("is empty in production — no breaking manifest shape change has shipped yet", () => {
    expect(STA_MIGRATIONS).toEqual([]);
  });
});

describe("migrateSta", () => {
  it("is a no-op when the project is already on the current schema version", () => {
    const root = tmpProjectRoot();
    initManifest(root, CURRENT_STA_SCHEMA_VERSION);
    const result = migrateSta(root, "2026-08-21T09:00:00Z");
    expect(result).toEqual({
      from: CURRENT_STA_SCHEMA_VERSION,
      to: CURRENT_STA_SCHEMA_VERSION,
      appliedSteps: [],
      backupDir: null,
    });
    expect(fs.existsSync(path.join(root, ".sta", "backups"))).toBe(false);
  });

  it("runs an injected step, backing up the pre-migration manifest first, and updates schema_version", () => {
    const root = tmpProjectRoot();
    initManifest(root, CURRENT_STA_SCHEMA_VERSION - 1);
    fs.writeFileSync(path.join(root, "marker.txt"), "untouched\n", "utf8");

    const step: StaMigrationStep = {
      from: CURRENT_STA_SCHEMA_VERSION - 1,
      to: CURRENT_STA_SCHEMA_VERSION,
      migrate: (projectRoot) => fs.writeFileSync(path.join(projectRoot, "marker.txt"), "migration ran\n", "utf8"),
    };

    const result = migrateSta(root, "2026-08-21T09:00:00Z", [step]);

    expect(result.from).toBe(CURRENT_STA_SCHEMA_VERSION - 1);
    expect(result.to).toBe(CURRENT_STA_SCHEMA_VERSION);
    expect(result.appliedSteps).toEqual([CURRENT_STA_SCHEMA_VERSION]);
    expect(result.backupDir).toBeTruthy();
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("migration ran\n");
    expect(readInstallManifest(root).schema_version).toBe(CURRENT_STA_SCHEMA_VERSION);

    const backedUpManifest = JSON.parse(fs.readFileSync(path.join(result.backupDir!, "manifest.json"), "utf8"));
    expect(backedUpManifest.schema_version).toBe(CURRENT_STA_SCHEMA_VERSION - 1); // the pre-migration snapshot, for rollback
  });

  it("chains multiple injected steps in order", () => {
    const root = tmpProjectRoot();
    initManifest(root, CURRENT_STA_SCHEMA_VERSION - 2);
    fs.writeFileSync(path.join(root, "marker.txt"), "", "utf8");

    const steps: StaMigrationStep[] = [
      {
        from: CURRENT_STA_SCHEMA_VERSION - 2,
        to: CURRENT_STA_SCHEMA_VERSION - 1,
        migrate: (projectRoot) => fs.appendFileSync(path.join(projectRoot, "marker.txt"), "first\n", "utf8"),
      },
      {
        from: CURRENT_STA_SCHEMA_VERSION - 1,
        to: CURRENT_STA_SCHEMA_VERSION,
        migrate: (projectRoot) => fs.appendFileSync(path.join(projectRoot, "marker.txt"), "second\n", "utf8"),
      },
    ];

    const result = migrateSta(root, "2026-08-21T09:00:00Z", steps);

    expect(result.appliedSteps).toEqual([CURRENT_STA_SCHEMA_VERSION - 1, CURRENT_STA_SCHEMA_VERSION]);
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("throws NoMigrationPathError when no step covers the project's schema_version", () => {
    const root = tmpProjectRoot();
    initManifest(root, CURRENT_STA_SCHEMA_VERSION - 1);
    expect(() => migrateSta(root, "2026-08-21T09:00:00Z", [])).toThrow(NoMigrationPathError);
  });
});
