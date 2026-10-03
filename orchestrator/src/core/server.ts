import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { StaCore } from "./core.js";
import { diffOfRun, projectBoundedRun } from "./engineProjection.js";
import { interpretCommand, IntentRejectedError, providerFromConfig, validateIntent, type IntentResult } from "./intent.js";
import {
  addKnowledge,
  KnowledgeRegistryError,
  listKnowledge,
  listModules,
  removeKnowledgeRegistration,
  resolveKnowledge,
  setDefaultKnowledge,
  validateKnowledge,
} from "./knowledgeRegistry.js";
import { MachineConfigError, POOL_RUNTIME_IDS, saveMachineConfig, type MachineConfigInput } from "./machineConfig.js";
import { WorkRunError } from "./workRunService.js";
import { SETTLED_STATUSES, type WorkRun } from "./workRunStore.js";
import { t } from "./i18n.js";

/**
 * The Local API — the only door into STA Core for the Web UI and for
 * `sta work`. A thin translation layer: every rule lives in the Core.
 *
 * Exposure: bound to 127.0.0.1 only. Every `/api` request must carry the
 * per-start token (`x-sta-token`), which the Core writes into its own
 * machine-local service record and injects into the page it serves; a
 * cross-origin page cannot read it and the server answers no CORS. The Host
 * header must name the loopback origin, which defeats DNS rebinding. Secrets
 * are accepted on PUT and never returned.
 */

export interface ServerOptions {
  core: StaCore;
  token: string;
  version: string;
  /** Overrides the web asset directory (tests). */
  webRoot?: string;
  onShutdown?: () => void;
  fetchImpl?: typeof fetch;
}

export function newServiceToken(): string {
  return randomBytes(24).toString("hex");
}

export function defaultWebRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value;
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function runSummary(run: WorkRun, language: "th" | "en") {
  const snapshot = run.snapshot as { tasks?: Array<{ status: string }>; changedFiles?: unknown[]; currentTask?: string | null; currentStage?: string | null } | null;
  return {
    runId: run.runId,
    knowledge: run.knowledge.name,
    module: run.module,
    status: run.status,
    statusLabel: t(language, `status.${run.status}` as never),
    statusReason: run.statusReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    commander: run.commander.current,
    workers: run.workers,
    currentTask: snapshot?.currentTask ?? null,
    currentStage: snapshot?.currentStage ?? null,
    tasksTotal: snapshot?.tasks?.length ?? null,
    tasksDone: snapshot?.tasks?.filter((task) => task.status === "DONE" || task.status === "CHECKPOINTED").length ?? null,
    changedFiles: snapshot?.changedFiles?.length ?? null,
    fallbacks: run.fallbacks.length,
    openGates: run.humanGates.filter((gate) => gate.resolvedAt === null).length,
  };
}

/** Routes whose second segment is a fixed word, not an id. */
const FIXED_ROUTES = new Set(["PUT settings/intent-key", "DELETE settings/intent-key", "POST runtimes/refresh", "POST intent/preview"]);

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function createCoreServer(options: ServerOptions): http.Server {
  const { core } = options;
  const webRoot = options.webRoot ?? defaultWebRoot();
  let boundPort = 0;

  const serveAsset = (res: http.ServerResponse, file: string): void => {
    const resolved = path.resolve(webRoot, file);
    if (!resolved.startsWith(path.resolve(webRoot) + path.sep)) throw new HttpError(404, "not found");
    let body: string;
    try {
      body = fs.readFileSync(resolved, "utf8");
    } catch {
      throw new HttpError(404, "not found");
    }
    if (file === "index.html") body = body.replace("__STA_TOKEN__", options.token).replace("__STA_LANG__", core.machine().language);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  };

  const interpret = async (body: Record<string, unknown>): Promise<IntentResult> => {
    const knowledgeName = str(body, "knowledge")!;
    const knowledge = resolveKnowledge(knowledgeName, core.paths.installationConfig);
    const modules = listModules(knowledge.path);
    const moduleName = str(body, "module", false);
    const machine = core.machine();
    const context = { knowledge: knowledge.name, module: moduleName, modules, language: machine.language };
    if (body.intent !== undefined) {
      const { intent, overrides } = validateIntent(body.intent, context);
      return { intent, source: "offline", overrides, warnings: [] };
    }
    const text = str(body, "text")!;
    let apiKey: string | undefined;
    try {
      apiKey = core.secrets.get("intent-api-key");
    } catch {
      apiKey = undefined;
    }
    return interpretCommand(text, context, providerFromConfig(machine, apiKey, options.fetchImpl));
  };

  const findRun = (id: string): WorkRun => {
    const run = core.store.get(id);
    if (!run) throw new HttpError(404, `no such work run: ${id}`);
    return run;
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const language = core.machine().language;

    if (parts[0] !== "api") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const file = parts.length === 0 ? "index.html" : parts.join("/");
      if (!/^[a-z0-9._/-]+$/i.test(file)) throw new HttpError(404, "not found");
      serveAsset(res, ["app.js", "app.css", "favicon.svg"].includes(file) ? file : "index.html");
      return undefined;
    }
    if (!tokenMatches(options.token, req.headers["x-sta-token"] as string | undefined)) throw new HttpError(401, "missing or invalid STA token");
    const body = method === "POST" || method === "PUT" ? await readJson(req) : {};
    const [, resource, id, action] = parts;

    const literalKey = `${method} ${parts.slice(1).join("/")}`;
    const patternKey = `${method} ${resource ?? ""}${id !== undefined ? "/:id" : ""}${action !== undefined ? `/${action}` : ""}`;
    switch (FIXED_ROUTES.has(literalKey) ? literalKey : patternKey) {
      case "GET health":
        return { ok: true, pid: process.pid, port: boundPort, version: options.version };
      case "POST shutdown":
        setTimeout(() => options.onShutdown?.(), 50);
        return { ok: true };
      case "GET state": {
        const machine = core.machine();
        const runs = core.store.list();
        return {
          version: options.version,
          language: machine.language,
          machineRoots: machine.workspace.allowed_roots,
          intent: { provider: machine.intent.provider, model: machine.intent.model, key: core.secrets.status("intent-api-key") },
          counts: Object.fromEntries(["RUNNING", "PAUSED", "WAITING_FOR_HUMAN", "PAUSED_RUNTIME_EXHAUSTED", "READY_FOR_REVIEW", "FAILED"].map((s) => [s, runs.filter((r) => r.status === s).length])),
        };
      }
      case "GET knowledge":
        return listKnowledge({ machine: core.machine(), configPath: core.paths.installationConfig });
      case "POST knowledge":
        return addKnowledge(str(body, "name")!, str(body, "path")!, { makeDefault: body.makeDefault === true, machine: core.machine(), configPath: core.paths.installationConfig });
      case "GET knowledge/:id/modules": {
        const knowledge = resolveKnowledge(id!, core.paths.installationConfig);
        const summary = listKnowledge({ machine: core.machine(), configPath: core.paths.installationConfig }).find((entry) => entry.name === knowledge.name);
        return { knowledge: knowledge.name, modules: listModules(knowledge.path), targets: summary?.targets ?? [] };
      }
      case "POST knowledge/:id/validate":
        return validateKnowledge(id!, { machine: core.machine(), configPath: core.paths.installationConfig });
      case "POST knowledge/:id/default":
        setDefaultKnowledge(id!, core.paths.installationConfig);
        return { ok: true };
      case "DELETE knowledge/:id": {
        const open = core.store.list({ knowledge: id }).filter((run) => !SETTLED_STATUSES.has(run.status));
        if (open.length > 0) throw new HttpError(409, `Knowledge ${id} has open work runs (${open.map((run) => run.runId).join(", ")}); stop them first`);
        removeKnowledgeRegistration(id!, core.paths.installationConfig);
        return { ok: true, note: "registration removed; the repository on disk was not touched" };
      }
      case "POST intent/preview":
        return interpret(body);
      case "POST runs": {
        const result = await interpret(body);
        if (result.intent.action !== "work") {
          const existing = core.store.latestOpen(result.intent.knowledge_root, result.intent.module);
          if (!existing) throw new HttpError(404, `no open work run for ${result.intent.module}`);
          const updated = result.intent.action === "pause" ? core.runs.pause(existing.runId)
            : result.intent.action === "resume" ? core.runs.resume(existing.runId)
              : result.intent.action === "stop" ? core.runs.stop(existing.runId)
                : existing;
          setImmediate(() => void core.runs.tick());
          return { run: updated, intent: result };
        }
        const run = core.runs.create({
          knowledge: result.intent.knowledge_root,
          module: result.intent.module,
          commandText: typeof body.text === "string" ? body.text : `sta work ${result.intent.module}`,
          intent: result.intent,
          intentSource: body.source === "cli" ? "cli" : result.source,
          overrides: result.overrides,
          autonomy: body.autonomy === "full" ? "full" : undefined,
        });
        setImmediate(() => void core.runs.tick());
        return { run, intent: result };
      }
      case "GET runs": {
        const statuses = url.searchParams.get("status")?.split(",").filter(Boolean) as WorkRun["status"][] | undefined;
        return core.store.list({ knowledge: url.searchParams.get("knowledge") ?? undefined, module: url.searchParams.get("module") ?? undefined, statuses }).map((run) => runSummary(run, language));
      }
      case "GET runs/:id": {
        const run = findRun(id!);
        return { run, summary: runSummary(run, language), events: core.store.events(run.runId, 300), runtimeEvents: core.health.eventsForRun(run.runId).slice(-300) };
      }
      case "POST runs/:id/pause":
        return core.runs.pause(id!);
      case "POST runs/:id/resume": {
        const run = core.runs.resume(id!);
        setImmediate(() => void core.runs.tick());
        return run;
      }
      case "POST runs/:id/stop":
        return core.runs.stop(id!, { force: body.force === true });
      case "POST runs/:id/approve":
        return core.runs.approve(id!, str(body, "by")!, str(body, "note", false));
      case "POST runs/:id/send-back":
        return core.runs.sendBack(id!, str(body, "by")!, str(body, "note")!);
      case "POST runs/:id/refresh": {
        await core.runs.refreshSnapshot(id!, true);
        return findRun(id!);
      }
      case "GET runs/:id/diff": {
        const run = findRun(id!);
        if (!run.boundedRunId) return { diff: "", truncated: false, note: "no work has been frozen yet" };
        const projection = projectBoundedRun(run.knowledge.path, run.boundedRunId);
        if (!projection) return { diff: "", truncated: false, note: "the bounded run is not readable yet" };
        return diffOfRun(projection);
      }
      case "GET runs/:id/prepare-commit": {
        const run = findRun(id!);
        const snapshot = run.snapshot as { baseBranch?: string; runBranch?: string; targetRoot?: string } | null;
        return {
          note: language === "th"
            ? "STA ไม่ push / merge / deploy เอง — คำสั่งด้านล่างให้คนรันเองหลังตรวจแล้ว (checkpoint commits อยู่บน run branch แล้ว)"
            : "STA never pushes, merges or deploys — a person runs these after review (the checkpoint commits are already on the run branch)",
          targetRoot: snapshot?.targetRoot ?? null,
          commands: snapshot?.runBranch && snapshot.baseBranch
            ? [`git -C "${snapshot.targetRoot}" log --oneline ${snapshot.baseBranch}..${snapshot.runBranch}`, `git -C "${snapshot.targetRoot}" switch ${snapshot.baseBranch}`, `git -C "${snapshot.targetRoot}" merge --ff-only ${snapshot.runBranch}`]
            : [],
        };
      }
      case "GET runs/:id/log": {
        const run = findRun(id!);
        const index = Number(url.searchParams.get("segment") ?? run.segments.length);
        const segment = run.segments.find((s) => s.index === index);
        if (!segment) return { log: "" };
        try {
          const text = fs.readFileSync(segment.logPath, "utf8");
          return { log: text.slice(-60_000) };
        } catch {
          return { log: "" };
        }
      }
      case "GET runtimes": {
        const statuses = core.runtimeStatus();
        return { statuses, health: core.health.snapshot([...POOL_RUNTIME_IDS]) };
      }
      case "POST runtimes/refresh":
        return { statuses: await core.refreshRuntimeStatus(), health: core.health.snapshot([...POOL_RUNTIME_IDS]) };
      case "POST runtimes/:id/clear-health":
        core.health.clear(id!);
        return { ok: true };
      case "POST runtimes/:id/test":
        if (!(POOL_RUNTIME_IDS as readonly string[]).includes(id!)) throw new HttpError(404, `unknown runtime ${id}`);
        return core.testRuntime(id!);
      case "GET settings": {
        const machine = core.machine();
        return { machine, intentKey: core.secrets.status("intent-api-key") };
      }
      case "PUT settings": {
        const next = body.machine as MachineConfigInput | undefined;
        if (!next || typeof next !== "object") throw new HttpError(400, "machine is required");
        return { machine: saveMachineConfig(next, core.paths.machineConfig) };
      }
      case "PUT settings/intent-key": {
        const key = str(body, "apiKey")!;
        return { intentKey: core.secrets.set("intent-api-key", key) };
      }
      case "DELETE settings/intent-key":
        core.secrets.delete("intent-api-key");
        return { intentKey: core.secrets.status("intent-api-key") };
      default:
        throw new HttpError(404, `no route ${method} ${url.pathname}`);
    }
  };

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!allowedHosts.includes(host)) {
      res.writeHead(421, { "content-type": "text/plain" });
      res.end("misdirected request: STA Core answers only on its loopback origin");
      return;
    }
    route(req, res)
      .then((payload) => {
        if (res.headersSent) return;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(payload ?? null));
      })
      .catch((error: unknown) => {
        if (res.headersSent) return;
        const status = error instanceof HttpError ? error.status
          : error instanceof WorkRunError ? error.status
            : error instanceof IntentRejectedError || error instanceof KnowledgeRegistryError || error instanceof MachineConfigError ? 400
              : 500;
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") boundPort = address.port;
  });
  return server;
}
