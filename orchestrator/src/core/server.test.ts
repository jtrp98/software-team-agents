import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { makeCoreHome, makeKnowledgeRoot, type CoreTestHome } from "./coreFixture.testSupport.js";
import { openCore, type StaCore } from "./core.js";
import { runOverlayPath } from "./corePaths.js";
import { addKnowledge } from "./knowledgeRegistry.js";
import { saveMachineConfig } from "./machineConfig.js";
import type { SegmentLauncher, SegmentLaunchSpec } from "./processes.js";
import { createCoreServer } from "./server.js";
import { FILE_PROTECTOR, SecretStore } from "./secretStore.js";
import type { CommanderInvoker } from "./commander.js";
import type { RuntimeConnectStatus } from "./runtimeConnect.js";

/** Obvious placeholder, not a credential. */
const PLACEHOLDER = ["changeme", "placeholder", "server"].join("-");

class Launcher implements SegmentLauncher {
  launches: Array<SegmentLaunchSpec & { pid: number }> = [];
  alive = new Set<number>();
  launch(spec: SegmentLaunchSpec) { const pid = 4000 + this.launches.length; this.launches.push({ ...spec, pid }); this.alive.add(pid); return { pid }; }
  isAlive(pid: number) { return this.alive.has(pid); }
  kill(pid: number) { this.alive.delete(pid); }
}

const commander: CommanderInvoker = {
  async invoke(request) {
    return { status: "OK", text: JSON.stringify({ decision: request.prompt.includes("Phase: START") ? "proceed" : "ready_for_review", summary: "ok", risks: [] }), diagnostics: [] };
  },
};

describe("STA Core Local API + Web", () => {
  let env: CoreTestHome;
  let core: StaCore;
  let server: http.Server;
  let port: number;
  let launcher: Launcher;
  const token = "t".repeat(48);
  let timetable: string;

  beforeEach(async () => {
    env = makeCoreHome();
    timetable = makeKnowledgeRoot(env.base, "timetable-knowledge", { modules: ["timetableai"], targets: [{ id: "timetable-api", remote: "https://github.com/acme/timetable-api.git" }] });
    const companyA = makeKnowledgeRoot(env.base, "company-a-knowledge", { modules: ["billing"], targets: [{ id: "billing-api", remote: "https://github.com/acme/billing-api.git" }] });
    addKnowledge("timetable", timetable, { configPath: env.installationConfig });
    addKnowledge("company-a", companyA, { configPath: env.installationConfig });
    saveMachineConfig({ workspace: { allowed_roots: [env.base] }, intent: { provider: "offline" } }, path.join(env.home, "machine.yaml"));
    launcher = new Launcher();
    const statuses: RuntimeConnectStatus[] = [];
    core = openCore({
      home: env.home,
      launcher,
      commander,
      tasks: { pause: () => [], unpause: () => [] },
      detectRuntimes: async () => statuses,
      secrets: new SecretStore(path.join(env.home, "secrets"), FILE_PROTECTOR, {}),
    });
    server = createCoreServer({ core, token, version: "test" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    core.close();
    env.cleanup();
  });

  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { "x-sta-token": token, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any, headers: response.headers };
  };

  it("answers /api only (no served page) and refuses a request without the token", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(404);
    expect((await call("GET", "/api/runs", undefined, { "x-sta-token": "wrong" })).status).toBe(401);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: `evil.example:${port}`, "x-sta-token": token } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(421);
  });

  it("Knowledge page data and the module selector are filtered per Knowledge", async () => {
    const list = await call("GET", "/api/knowledge");
    expect(list.body.map((k: { name: string }) => k.name)).toEqual(["company-a", "timetable"]);
    const modules = await call("GET", "/api/knowledge/timetable/modules");
    expect(modules.body.modules).toEqual(["timetableai"]);
    expect(modules.body.targets.map((t: { targetId: string }) => t.targetId)).toEqual(["timetable-api"]);
    expect((await call("GET", "/api/knowledge/company-a/modules")).body.modules).toEqual(["billing"]);
  });

  it("select Knowledge + Module, start a run from Thai text, watch status, pause and resume", async () => {
    const start = await call("POST", "/api/runs", { knowledge: "timetable", module: "timetableai", text: "ทำงานที่พร้อมให้หมดจน QA ผ่าน แล้วหยุดให้ฉันตรวจ ห้าม push ห้าม merge ห้าม deploy" });
    expect(start.status).toBe(200);
    expect(start.body.intent.source).toBe("offline");
    expect(start.body.run.knowledge.name).toBe("timetable");
    const runId = start.body.run.runId as string;
    await core.runs.tick();
    let detail = await call("GET", `/api/runs/${runId}`);
    expect(detail.body.run.status).toBe("RUNNING");
    expect(detail.body.summary.statusLabel).toBe("กำลังทำงาน");
    const listed = await call("GET", "/api/runs?status=RUNNING");
    expect(listed.body.map((r: { runId: string }) => r.runId)).toEqual([runId]);
    // A cross-Knowledge module is refused with the reason.
    expect((await call("POST", "/api/runs", { knowledge: "timetable", module: "billing", text: "work" })).status).toBe(400);
    // Pause before the bounded run is frozen still applies once it is.
    expect((await call("POST", `/api/runs/${runId}/pause`)).body.status).toBe("PAUSING");
    fs.writeFileSync(path.join(path.dirname(runOverlayPath(runId, env.home)), "segment-1.exit.json"), JSON.stringify({ segment: 1, exitCode: 4 }));
    launcher.alive.clear();
    await core.runs.tick();
    detail = await call("GET", `/api/runs/${runId}`);
    expect(detail.body.run.status).toBe("PAUSED");
    expect((await call("POST", `/api/runs/${runId}/resume`)).body.status).toBe("QUEUED");
  });

  it("browser disconnect does not stop work; reconnecting shows the same state", async () => {
    const start = await call("POST", "/api/runs", { knowledge: "timetable", module: "timetableai", text: "ทำงานที่พร้อมให้หมด" });
    const runId = start.body.run.runId as string;
    // A client that goes away mid-request.
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/runs/${runId}`, headers: { "x-sta-token": token } }, (res) => { res.destroy(); resolve(); });
      req.on("error", () => resolve());
      req.end();
    });
    await core.runs.tick();
    fs.appendFileSync(launcher.launches[0]!.logPath, "[bounded-run] froze run run-9: x\n[bounded-run] COMPLETED\n");
    fs.writeFileSync(path.join(path.dirname(runOverlayPath(runId, env.home)), "segment-1.exit.json"), JSON.stringify({ segment: 1, exitCode: 0 }));
    launcher.alive.clear();
    await core.runs.tick();
    // "Reopen the browser": a fresh request sees the finished, persisted state.
    const detail = await call("GET", `/api/runs/${runId}`);
    expect(detail.body.run.status).toBe("READY_FOR_REVIEW");
    expect(detail.body.run.boundedRunId).toBe("run-9");
    const prep = await call("GET", `/api/runs/${runId}/prepare-commit`);
    expect(prep.body.note).toMatch(/ไม่ push/);
  });

  it("settings: the Intent key is accepted and never returned; invalid settings are refused", async () => {
    const put = await call("PUT", "/api/settings/intent-key", { apiKey: PLACEHOLDER });
    expect(JSON.stringify(put.body)).not.toContain("changeme");
    expect(put.body.intentKey.configured).toBe(true);
    const settings = await call("GET", "/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain("changeme");
    expect(settings.body.machine.language).toBe("th");
    const bad = await call("PUT", "/api/settings", { machine: { ...settings.body.machine, commander: { order: ["not-a-runtime"] } } });
    expect(bad.status).toBe(400);
    const reordered = await call("PUT", "/api/settings", { machine: { ...settings.body.machine, commander: { ...settings.body.machine.commander, order: ["codex", "claude-code", "agy", "zcode"] } } });
    expect(reordered.body.machine.commander.order).toEqual(["codex", "claude-code", "antigravity", "zcode"]);
  });

  it("runtime cards come from detection plus health; remove-registration is refused while a run is open", async () => {
    const runtimes = await call("POST", "/api/runtimes/refresh");
    expect(Object.keys(runtimes.body.health)).toEqual(["claude-code", "codex", "antigravity", "zcode"]);
    await call("POST", "/api/runs", { knowledge: "company-a", module: "billing", text: "work" });
    expect((await call("DELETE", "/api/knowledge/company-a")).status).toBe(409);
  });
});
