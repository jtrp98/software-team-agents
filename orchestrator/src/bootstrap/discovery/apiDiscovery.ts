import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type ApiPayload, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import { sourceIdFor } from "../../knowledge/sourceRegistry.js";
import { digestOfSource } from "../../knowledge/sourceDigest.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * API Discovery (T77) — the fourth Discovery stage in T73's flow.
 *
 * TASKS_V1.md names three possible sources: OpenAPI, gRPC proto, route
 * definitions. This stage covers the two that fit CLAUDE.md's fixed stack —
 * hand-rolled REST on Express, with no OpenAPI generation mandated but a
 * spec file sometimes present anyway. gRPC proto is deliberately not
 * implemented: nothing in the fixed stack produces one, and parsing
 * Protocol Buffers is a real undertaking with no real input in this
 * framework's own target projects to test it against — exactly the
 * "designing for a hypothetical requirement" CLAUDE.md warns against.
 *
 * TWO SOURCES, ONE ID SCHEME, SPEC WINS
 *
 * Both a scanned Express route and an OpenAPI path/method produce an item
 * id from the same `API-<METHOD>-<slug>` scheme. When both exist for the
 * same endpoint, the OpenAPI entry overwrites the scanned one — a written
 * spec is a stronger claim about the contract than a regex match against
 * the handler that happens to implement it.
 */

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".workflow",
  ".turbo",
  ".cache",
  "knowledge",
]);

const OPENAPI_FILENAMES = ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"];
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const ROUTE_CALL = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*(['"`])((?:(?!\2).)+)\2/gi;

function methodOf(raw: string): ApiPayload["method"] {
  const upper = raw.toUpperCase();
  return upper === "GET" || upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE" ? upper : "other";
}

function slugOf(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === "\n") line++;
  return line;
}

function apiItem(
  method: ApiPayload["method"],
  route: string,
  now: string,
  sourceId: string,
  locator: string,
  digest: string | null,
  extra: Partial<ApiPayload> = {},
): KnowledgeItemOf<"api"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `API-${method}-${slugOf(route)}`,
    kind: "api",
    title: `${method} ${route}`,
    body: `API Discovery (T77) found this endpoint at \`${locator}\`.`,
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    sources: [{ type: "file", locator, captured_at: now, digest, source_id: sourceId }],
    relations: [],
    payload: { method, path: route, contract_name: null, request_shape: null, response_shape: null, ...extra },
  };
}

// --- route definitions (Express) ---

function findSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue;
      found.push(abs);
    }
  };
  walk(root);
  return found;
}

function scanRoutes(root: string, now: string): { items: KnowledgeItemOf<"api">[]; sources: SourceRecord[] } {
  const items: KnowledgeItemOf<"api">[] = [];
  const sources: SourceRecord[] = [];

  for (const absPath of findSourceFiles(root)) {
    const content = fs.readFileSync(absPath, "utf8");
    ROUTE_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    let fileHasRoute = false;
    const relPath = path.relative(root, absPath).split(path.sep).join("/");

    while ((match = ROUTE_CALL.exec(content)) !== null) {
      if (!fileHasRoute) {
        fileHasRoute = true;
        sources.push({
          schema_version: KNOWLEDGE_SCHEMA_VERSION,
          id: sourceIdFor(relPath),
          type: "code",
          locator: relPath,
          captured_at: now,
          captured_by: AgentStage.SYSTEM_ANALYST,
          digest: digestOfSource(relPath, root),
        });
      }
      const method = methodOf(match[1]!);
      const route = match[3]!;
      const line = lineOf(content, match.index);
      const locator = `${relPath}#L${line}`;
      // Hashed from the locator, not from `match[0]`: the regex match is a
      // fragment of the line it sits on, and T71 recomputes the whole line.
      items.push(apiItem(method, route, now, sourceIdFor(relPath), locator, digestOfSource(locator, root)));
    }
  }

  return { items, sources };
}

// --- OpenAPI/Swagger spec ---

interface OpenApiOperation {
  operationId?: string;
  requestBody?: { content?: Record<string, unknown> };
  responses?: Record<string, unknown>;
}

interface OpenApiSpec {
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

function findSpecFile(root: string): string | null {
  for (const name of OPENAPI_FILENAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function scanOpenApiSpec(root: string, now: string): { items: KnowledgeItemOf<"api">[]; sources: SourceRecord[] } {
  const specPath = findSpecFile(root);
  if (!specPath) return { items: [], sources: [] };

  const content = fs.readFileSync(specPath, "utf8");
  let spec: OpenApiSpec;
  try {
    spec = parseYaml(content) as OpenApiSpec;
  } catch {
    return { items: [], sources: [] };
  }
  if (!spec.paths || typeof spec.paths !== "object") return { items: [], sources: [] };

  const relPath = path.relative(root, specPath).split(path.sep).join("/");
  // Every operation in the spec cites the file as a whole, so they share its
  // digest. Line-ranging an operation inside YAML/JSON is real parsing work with
  // a real chance of being wrong, and a digest that is coarser than it could be
  // still answers its question — one that cannot be recomputed answers nothing.
  const specDigest = digestOfSource(relPath, root);
  const source: SourceRecord = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: sourceIdFor(relPath),
    type: "api-spec",
    locator: relPath,
    captured_at: now,
    captured_by: AgentStage.SYSTEM_ANALYST,
    digest: specDigest,
  };

  const items: KnowledgeItemOf<"api">[] = [];
  for (const [route, operations] of Object.entries(spec.paths)) {
    if (!operations || typeof operations !== "object") continue;
    for (const httpMethod of HTTP_METHODS) {
      const operation = operations[httpMethod];
      if (!operation) continue;
      const requestShape = operation.requestBody?.content ? Object.keys(operation.requestBody.content).join(", ") : null;
      const responseShape = operation.responses ? Object.keys(operation.responses).join(", ") : null;
      items.push(
        apiItem(methodOf(httpMethod), route, now, source.id, relPath, specDigest, {
          contract_name: operation.operationId ?? null,
          request_shape: requestShape,
          response_shape: responseShape,
        }),
      );
    }
  }

  return { items, sources: items.length > 0 ? [source] : [] };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function apiDiscoveryStage(now: () => string = () => new Date().toISOString()): DiscoveryStage {
  return {
    id: "api",
    discover: (projectRoot: string): DiscoveryResult => {
      const timestamp = now();
      const routes = scanRoutes(projectRoot, timestamp);
      const spec = scanOpenApiSpec(projectRoot, timestamp);

      const byId = new Map<string, KnowledgeItemOf<"api">>();
      for (const item of routes.items) byId.set(item.id, item);
      for (const item of spec.items) byId.set(item.id, item); // spec is authoritative, wins on collision

      const items = [...byId.values()];
      const sources = [...routes.sources, ...spec.sources];

      if (items.length === 0) {
        return { items: [], sources: [], skipped: true, note: "no OpenAPI/Swagger spec and no router/app route calls found" };
      }
      return { items, sources };
    },
  };
}
