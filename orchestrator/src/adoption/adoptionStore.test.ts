import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listKnowledgeFiles, RESERVED_DIRS } from "../knowledge/knowledgeStore.js";
import { computeAdoptionStatus, newAdoptionState, type AdoptionState } from "./adoptionModel.js";
import {
  ADOPTION_DIRNAME,
  AdoptionStateError,
  backupExisting,
  checkAdoptionManifest,
  newAdoptionManifest,
  readAdoptionManifest,
  readAdoptionState,
  recordManifestEntry,
  relativeToRepo,
  writeAdoptionManifest,
  writeAdoptionState,
} from "./adoptionStore.js";

const NOW = "2026-08-20T09:00:00Z";
const LATER = "2026-08-21T09:00:00Z";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-store-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function acknowledged(): AdoptionState {
  const state: AdoptionState = {
    ...newAdoptionState(NOW),
    preflight: { detected_at: NOW, blockers: [], notes: ["checked"], acknowledged_by: null, acknowledged_at: null },
  };
  return { ...state, status: computeAdoptionStatus(state) };
}

describe("adoption state on disk", () => {
  it("reads back exactly what it wrote", () => {
    const root = project();
    const state = acknowledged();

    writeAdoptionState(state, root);

    expect(readAdoptionState(root)).toEqual({ state, problems: [] });
  });

  it("says nothing is wrong when adoption has simply never started", () => {
    expect(readAdoptionState(project())).toEqual({ state: null, problems: [] });
  });

  it("refuses to write a state that fails its own check, rather than storing something unreadable", () => {
    const root = project();
    const lying = { ...acknowledged(), status: "adopted" as const };

    expect(() => writeAdoptionState(lying, root)).toThrow(AdoptionStateError);
    expect(readAdoptionState(root).state).toBeNull();
  });

  it("reports a hand-broken file instead of throwing at the reader", () => {
    const root = project();
    writeAdoptionState(acknowledged(), root);
    const file = path.join(root, "knowledge", ADOPTION_DIRNAME, "STATE.yaml");
    fs.writeFileSync(file, "status: adopted\n  bad indent:\n", "utf8");

    const result = readAdoptionState(root);

    expect(result.state).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("is skipped by the knowledge item walk, like every other reserved directory", () => {
    const root = project();
    writeAdoptionState(acknowledged(), root);
    writeAdoptionManifest(newAdoptionManifest(NOW), root);

    expect(RESERVED_DIRS).toContain(ADOPTION_DIRNAME);
    expect(listKnowledgeFiles(root)).toEqual([]);
  });
});

describe("the manifest", () => {
  it("records one entry per path and does not re-record a path it already has", () => {
    const manifest = newAdoptionManifest(NOW);

    recordManifestEntry(manifest, { path: "knowledge/a/architecture/DES-1.yaml", action: "created", backup: null, stage: "legacy-docs", at: NOW });
    recordManifestEntry(manifest, { path: "knowledge/a/architecture/DES-1.yaml", action: "replaced", backup: "knowledge/_adoption/backup/x", stage: "legacy-docs", at: LATER });

    // The first entry stands: what rollback needs to know is whether the path
    // existed *before adoption*, and a later entry would make it restore
    // adoption's own earlier output instead of removing the file.
    expect(manifest.entries).toEqual([
      { path: "knowledge/a/architecture/DES-1.yaml", action: "created", backup: null, stage: "legacy-docs", at: NOW },
    ]);
  });

  it("rejects a replaced entry with no backup — an undo that cannot undo", () => {
    const problems = checkAdoptionManifest({
      schema_version: 1,
      entries: [{ path: "knowledge/a.yaml", action: "replaced", backup: null, stage: "legacy-docs", at: NOW }],
      created_at: NOW,
      updated_at: NOW,
    });

    expect(problems).toEqual(["knowledge/a.yaml: recorded as replaced but has no backup — rollback could not restore it"]);
  });

  it("rejects a created entry that carries a backup, because one of the two is wrong", () => {
    const problems = checkAdoptionManifest({
      schema_version: 1,
      entries: [{ path: "knowledge/a.yaml", action: "created", backup: "knowledge/_adoption/backup/a.yaml", stage: "legacy-docs", at: NOW }],
      created_at: NOW,
      updated_at: NOW,
    });

    expect(problems).toEqual(["knowledge/a.yaml: recorded as created but carries a backup — one of the two is wrong"]);
  });

  it("accepts a path outside knowledge/, and leaves refusing it to rollback", () => {
    // Deliberate: a pattern here would reject the whole manifest over one bad
    // line, so a project with one bad entry could not be rolled back at all.
    const problems = checkAdoptionManifest({
      schema_version: 1,
      entries: [{ path: "src/index.ts", action: "created", backup: null, stage: "legacy-docs", at: NOW }],
      created_at: NOW,
      updated_at: NOW,
    });

    expect(problems).toEqual([]);
  });

  it("round-trips through disk", () => {
    const root = project();
    const manifest = newAdoptionManifest(NOW);
    recordManifestEntry(manifest, { path: "knowledge/a.yaml", action: "created", backup: null, stage: "legacy-plan", at: NOW });

    writeAdoptionManifest(manifest, root);

    expect(readAdoptionManifest(root)).toEqual({ manifest, problems: [] });
  });
});

describe("backups", () => {
  it("copies a file into the backup tree under its own repo-relative path", () => {
    const root = project();
    const target = path.join(root, "knowledge", "sales", "requirement", "REQ-001.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "the original\n", "utf8");

    const backup = backupExisting(target, root);

    expect(backup).toBe("knowledge/_adoption/backup/knowledge/sales/requirement/REQ-001.yaml");
    expect(fs.readFileSync(path.join(root, ...backup.split("/")), "utf8")).toBe("the original\n");
  });

  it("gives repo-relative paths forward slashes, whatever the platform separator is", () => {
    const root = project();

    expect(relativeToRepo(path.join(root, "knowledge", "a", "b.yaml"), root)).toBe("knowledge/a/b.yaml");
  });
});
