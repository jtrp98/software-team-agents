import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freshnessOf } from "../../knowledge/freshness.js";
import { digestOfSource } from "../../knowledge/sourceDigest.js";
import type { KnowledgeItem } from "../../knowledge/knowledgeModel.js";
import type { DiscoveryStage } from "../bootstrapRunner.js";
import { repositoryDiscoveryStage } from "./repositoryDiscovery.js";
import { documentationDiscoveryStage } from "./documentationDiscovery.js";
import { dbSchemaDiscoveryStage } from "./dbSchemaDiscovery.js";
import { apiDiscoveryStage } from "./apiDiscovery.js";
import { architectureDiscoveryStage } from "./architectureDiscovery.js";

/**
 * The test that was missing, and the reason a real bug survived 1239 others:
 * every module here was tested on its own, and the defect lived in the
 * *disagreement between two of them*. Discovery recorded `sha256:<16 hex>` of
 * one string while freshness recomputed `sha256:<64 hex>` of another, so a
 * freshly discovered item reported `source-changed` — T71's strongest signal —
 * about files nobody had touched. Every stage passed. Every freshness test
 * passed.
 *
 * So this file asserts the contract that spans them: what discovery writes,
 * freshness must read back as `fresh` on an untouched tree, and as
 * `source-changed` the moment the material really moves.
 */

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-freshness-"));
  roots.push(root);

  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "app", scripts: { test: "vitest" }, dependencies: { express: "^4", next: "^15" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, "README.md"), "# App\n\nWhat this service does.\n\n## Setup\n\nRun it.\n");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "ops.md"), "# Operations\n\nHow it is run in production.\n");

  fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "prisma", "schema.prisma"),
    [
      "model Staff {",
      "  id    String  @id",
      "  name  String",
      "  shifts Shift[]",
      "}",
      "",
      "model Shift {",
      "  id      String @id",
      "  staffId String",
      "  staff   Staff  @relation(fields: [staffId], references: [id])",
      "  note    String?",
      "}",
      "",
    ].join("\n"),
  );

  // Enough layer folders for T78 to infer a pattern, and a real route file for T77.
  for (const dir of ["routes", "services", "controllers"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, "routes", "shifts.ts"),
    ["import { requireAuth } from '../middleware/auth.js';", "", "router.get('/shifts', requireAuth, listShifts);", "router.post('/shifts', requireAuth, createShift);", ""].join("\n"),
  );

  fs.writeFileSync(
    path.join(root, "openapi.yaml"),
    ["openapi: 3.0.0", "paths:", "  /staff:", "    get:", "      operationId: listStaff", "      responses:", "        '200': {}", ""].join("\n"),
  );

  return root;
}

const STAGES: Array<[string, () => DiscoveryStage]> = [
  ["repository (T74)", () => repositoryDiscoveryStage(() => NOW)],
  ["documentation (T75)", () => documentationDiscoveryStage(() => NOW)],
  ["db-schema (T76)", () => dbSchemaDiscoveryStage(() => NOW)],
  ["api (T77)", () => apiDiscoveryStage(() => NOW)],
  ["architecture (T78)", () => architectureDiscoveryStage(() => NOW)],
];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("what discovery records, freshness can recompute", () => {
  for (const [label, build] of STAGES) {
    it(`${label}: every item reads back fresh on an untouched tree`, async () => {
      const root = project();
      const result = await build().discover(root);
      expect(result.items.length).toBeGreaterThan(0);

      const notFresh = result.items
        .map((item) => ({ item, freshness: freshnessOf(item, { now: NOW, projectRoot: root }) }))
        .filter(({ freshness }) => freshness.verdict !== "fresh")
        .map(({ item, freshness }) => `${item.id}: ${freshness.verdict} (${freshness.reason})`);

      expect(notFresh).toEqual([]);
    });

    it(`${label}: every registered source digest matches its material`, async () => {
      const root = project();
      const result = await build().discover(root);

      const mismatched = result.sources
        .filter((source) => source.digest !== null)
        .filter((source) => source.digest !== digestOfSource(source.locator, root))
        .map((source) => `${source.id} (${source.locator})`);

      expect(mismatched).toEqual([]);
    });
  }
});

describe("freshness still notices a real change", () => {
  it("reports source-changed once the line an item cites is edited", async () => {
    const root = project();
    const items = (await dbSchemaDiscoveryStage(() => NOW).discover(root)).items;
    const shift = items.find((i) => i.id === "DB-Shift") as KnowledgeItem;
    expect(freshnessOf(shift, { now: NOW, projectRoot: root }).verdict).toBe("fresh");

    const schemaPath = path.join(root, "prisma", "schema.prisma");
    fs.writeFileSync(schemaPath, fs.readFileSync(schemaPath, "utf8").replace("note    String?", "note    String"));

    const after = freshnessOf(shift, { now: NOW, projectRoot: root });
    expect(after.verdict).toBe("source-changed");
    expect(after.changedSources).toEqual(shift.sources.map((s) => s.locator));
  });

  it("reports source-missing once the file an item cites is deleted", async () => {
    const root = project();
    const items = (await documentationDiscoveryStage(() => NOW).discover(root)).items;
    const readme = items.find((i) => i.id === "DES-DOC-README") as KnowledgeItem;
    expect(freshnessOf(readme, { now: NOW, projectRoot: root }).verdict).toBe("fresh");

    fs.rmSync(path.join(root, "README.md"));
    expect(freshnessOf(readme, { now: NOW, projectRoot: root }).verdict).toBe("source-missing");
  });

  it("leaves a folder-name signal unhashed rather than calling a real directory missing", async () => {
    const root = project();
    const result = await architectureDiscoveryStage(() => NOW).discover(root);
    for (const item of result.items) {
      expect(item.sources.every((s) => s.digest === null)).toBe(true);
      expect(freshnessOf(item, { now: NOW, projectRoot: root }).missingSources).toEqual([]);
    }
  });
});
