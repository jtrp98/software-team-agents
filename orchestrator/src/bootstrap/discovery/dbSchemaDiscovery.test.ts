import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import { readBootstrapState } from "../bootstrapStore.js";
import { dbSchemaDiscoveryStage } from "./dbSchemaDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

const SCHEMA = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`;

async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return dbSchemaDiscoveryStage(now).discover(root);
}

function dbSchemaOf(result: DiscoveryResult, id: string): KnowledgeItemOf<"db-schema"> {
  const item = result.items.find((i) => i.id === id);
  if (!item || item.kind !== "db-schema") throw new Error(`expected a db-schema item with id ${id}`);
  return item;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-db-discovery-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("dbSchemaDiscoveryStage", () => {
  it("reports skipped with a note when prisma/schema.prisma does not exist", async () => {
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no prisma/schema.prisma");
  });

  it("reports skipped when the file exists but declares no models yet", async () => {
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), "// nothing here yet\n", "utf8");
    const result = await discover(root);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no model blocks");
  });

  it("parses each model into a schema-valid db-schema item with its fields", async () => {
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), SCHEMA, "utf8");

    const result = await discover(root);
    expect(result.items.map((i) => i.id).sort()).toEqual(["DB-Post", "DB-User"]);

    const user = dbSchemaOf(result, "DB-User");
    expect(checkKnowledgeItem(user)).toEqual([]);
    expect(user.payload.model).toBe("User");
    expect(user.payload.fields).toEqual([
      { name: "id", type: "Int", optional: false },
      { name: "email", type: "String", optional: false },
      { name: "name", type: "String?", optional: true },
      { name: "posts", type: "Post[]", optional: false },
      { name: "createdAt", type: "DateTime", optional: false },
    ]);
  });

  it("derives relations from field types that name another declared model", async () => {
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), SCHEMA, "utf8");

    const result = await discover(root);
    expect(dbSchemaOf(result, "DB-User").payload.relations).toEqual(["Post"]);
    expect(dbSchemaOf(result, "DB-Post").payload.relations).toEqual(["User"]);
  });

  it("cites the same registered source across every model from the same file", async () => {
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), SCHEMA, "utf8");

    const result = await discover(root);
    expect(result.sources).toHaveLength(1);
    const sourceId = result.sources[0]!.id;
    expect(dbSchemaOf(result, "DB-User").sources[0]!.source_id).toBe(sourceId);
    expect(dbSchemaOf(result, "DB-Post").sources[0]!.source_id).toBe(sourceId);
    // Line-range locators differ per model even though the source_id is shared.
    expect(dbSchemaOf(result, "DB-User").sources[0]!.locator).not.toBe(dbSchemaOf(result, "DB-Post").sources[0]!.locator);
  });
});

describe("dbSchemaDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/, registers one source, and passes --check-knowledge", async () => {
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), SCHEMA, "utf8");

    const sourceId = (await discover(root)).sources[0]!.id;
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(dbSchemaDiscoveryStage(() => NOW), root, NOW);

    const stage = state.stages.find((s) => s.id === "db-schema")!;
    expect(stage.status).toBe("done");
    expect(stage.knowledge_ids.sort()).toEqual(["DB-Post", "DB-User"]);

    expect(fs.existsSync(path.join(root, "knowledge", "_project", "db-schema", "DB-User.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "knowledge", "_sources", `${sourceId}.yaml`))).toBe(true);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);

    const { state: reread } = readBootstrapState(root);
    expect(reread!.status).toBe("discovering");
  });

  it("marks the stage skipped when there is no schema.prisma, and still settles it", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(dbSchemaDiscoveryStage(() => NOW), root, NOW);
    expect(state.stages.find((s) => s.id === "db-schema")!.status).toBe("skipped");
  });
});
