import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import { apiDiscoveryStage } from "./apiDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return apiDiscoveryStage(now).discover(root);
}

function apiOf(result: DiscoveryResult, id: string): KnowledgeItemOf<"api"> {
  const item = result.items.find((i) => i.id === id);
  if (!item || item.kind !== "api") throw new Error(`expected an api item with id ${id}`);
  return item;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-api-discovery-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("apiDiscoveryStage — route scanning", () => {
  it("reports skipped when there is no spec and no route calls", async () => {
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no OpenAPI");
  });

  it("finds router.<method>() calls and extracts method + path", async () => {
    write(
      path.join(root, "src", "routes", "users.ts"),
      ['import { Router } from "express";', "const router = Router();", 'router.get("/users/:id", handler);', "export default router;"].join(
        "\n",
      ),
    );

    const result = await discover(root);
    const item = apiOf(result, "API-GET-USERS-ID");
    expect(checkKnowledgeItem(item)).toEqual([]);
    expect(item.payload.method).toBe("GET");
    expect(item.payload.path).toBe("/users/:id");
    expect(item.body).toContain("src/routes/users.ts");
  });

  it("finds app.<method>() calls too, and handles several routes in one file", async () => {
    write(
      path.join(root, "app.ts"),
      ['app.post("/login", loginHandler);', 'app.delete("/sessions/:id", logoutHandler);'].join("\n"),
    );
    const result = await discover(root);
    expect(result.items.map((i) => i.id).sort()).toEqual(["API-DELETE-SESSIONS-ID", "API-POST-LOGIN"]);
    expect(result.sources).toHaveLength(1); // one file, one source
  });

  it("ignores test files and node_modules", async () => {
    write(path.join(root, "src", "routes", "users.test.ts"), 'router.get("/should-not-appear", h);');
    write(path.join(root, "node_modules", "pkg", "index.js"), 'app.get("/ignored", h);');
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(true);
  });
});

describe("apiDiscoveryStage — OpenAPI spec", () => {
  it("parses an openapi.yaml file's paths into items with contract_name and shapes", async () => {
    write(
      path.join(root, "openapi.yaml"),
      [
        "paths:",
        "  /users:",
        "    get:",
        "      operationId: listUsers",
        "      responses:",
        "        '200': { description: ok }",
        "    post:",
        "      operationId: createUser",
        "      requestBody:",
        "        content:",
        "          application/json: {}",
        "      responses:",
        "        '201': { description: created }",
      ].join("\n"),
    );

    const result = await discover(root);
    const list = apiOf(result, "API-GET-USERS");
    expect(checkKnowledgeItem(list)).toEqual([]);
    expect(list.payload.contract_name).toBe("listUsers");
    expect(list.payload.response_shape).toBe("200");

    const create = apiOf(result, "API-POST-USERS");
    expect(create.payload.contract_name).toBe("createUser");
    expect(create.payload.request_shape).toBe("application/json");
    expect(create.payload.response_shape).toBe("201");
  });

  it("lets the spec win over a route scan for the same endpoint", async () => {
    write(path.join(root, "src", "routes", "users.ts"), 'router.get("/users", listHandler);');
    write(
      path.join(root, "openapi.yaml"),
      ["paths:", "  /users:", "    get:", "      operationId: listUsers", "      responses:", "        '200': { description: ok }"].join("\n"),
    );

    const result = await discover(root);
    const items = result.items.filter((i) => i.id === "API-GET-USERS");
    expect(items).toHaveLength(1);
    expect((items[0] as KnowledgeItemOf<"api">).payload.contract_name).toBe("listUsers");
  });

  it("does not fail discovery on an unparsable spec file — falls back to whatever routes were found", async () => {
    write(path.join(root, "openapi.yaml"), "not: [valid, yaml");
    write(path.join(root, "src", "routes", "users.ts"), 'router.get("/users", h);');
    const result = await discover(root);
    expect(result.items.map((i) => i.id)).toEqual(["API-GET-USERS"]);
  });
});

describe("apiDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/ and passes --check-knowledge", async () => {
    write(path.join(root, "src", "routes", "users.ts"), 'router.get("/users", h);\nrouter.post("/users", h);');
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(apiDiscoveryStage(() => NOW), root, NOW);

    const stage = state.stages.find((s) => s.id === "api")!;
    expect(stage.status).toBe("done");
    expect(stage.knowledge_ids.sort()).toEqual(["API-GET-USERS", "API-POST-USERS"]);
    expect(fs.existsSync(path.join(root, "knowledge", "_project", "api", "API-GET-USERS.yaml"))).toBe(true);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("marks the stage skipped when nothing is found", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(apiDiscoveryStage(() => NOW), root, NOW);
    expect(state.stages.find((s) => s.id === "api")!.status).toBe("skipped");
  });
});
