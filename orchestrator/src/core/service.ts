import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { openCore, type OpenCoreOptions, type StaCore } from "./core.js";
import { corePaths } from "./corePaths.js";
import { childEnvironment, processIsAlive, staCliEntry } from "./processes.js";
import { createCoreServer, newServiceToken } from "./server.js";

/**
 * STA Core as a background service: a detached user-level Node process that
 * serves the Local API on loopback and runs the control loop. Closing
 * the browser or the terminal changes nothing; reopening the UI reads the same
 * `core.db`. Deliberately not a Windows Service: it runs as the signed-in user
 * (no SYSTEM account, no Administrator), which is also the identity the
 * runtimes' own logins belong to.
 */

export interface ServiceRecord {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export function readServiceRecord(home?: string): ServiceRecord | null {
  try {
    return JSON.parse(fs.readFileSync(corePaths(home).serviceRecord, "utf8")) as ServiceRecord;
  } catch {
    return null;
  }
}

export async function pingService(record: ServiceRecord, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, { headers: { "x-sta-token": record.token }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json()) as { pid?: number };
    return body.pid === record.pid;
  } catch {
    return false;
  }
}

export async function serviceStatus(home?: string): Promise<{ running: boolean; record: ServiceRecord | null; url: string | null }> {
  const record = readServiceRecord(home);
  if (!record || !processIsAlive(record.pid)) return { running: false, record, url: null };
  const running = await pingService(record);
  return { running, record, url: running ? `http://127.0.0.1:${record.port}/` : null };
}

/** Starts the detached service if it is not already running; waits until it answers. */
export async function startService(options: { home?: string; port?: number; waitMs?: number } = {}): Promise<{ started: boolean; record: ServiceRecord }> {
  const current = await serviceStatus(options.home);
  if (current.running && current.record) return { started: false, record: current.record };
  const paths = corePaths(options.home);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const logFd = fs.openSync(path.join(paths.logsDir, "core.log"), "a");
  try {
    const child = spawn(process.execPath, [staCliEntry(), "core", "serve", ...(options.port ? ["--port", String(options.port)] : [])], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnvironment(),
      cwd: paths.home,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = await serviceStatus(options.home);
    if (status.running && status.record) return { started: true, record: status.record };
  }
  throw new Error(`STA Core did not answer within ${Math.round((options.waitMs ?? 15_000) / 1000)}s — see ${path.join(paths.logsDir, "core.log")}`);
}

export async function stopService(home?: string): Promise<boolean> {
  const status = await serviceStatus(home);
  if (!status.record) return false;
  if (status.running) {
    try {
      await fetch(`http://127.0.0.1:${status.record.port}/api/shutdown`, { method: "POST", headers: { "x-sta-token": status.record.token, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3_000) });
    } catch { /* fall through to the pid */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && processIsAlive(status.record.pid)) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (processIsAlive(status.record.pid)) {
    try { process.kill(status.record.pid); } catch { /* already gone */ }
  }
  fs.rmSync(corePaths(home).serviceRecord, { force: true });
  return true;
}

export interface ServeOptions extends OpenCoreOptions {
  port?: number;
  version: string;
  tickMs?: number;
  /** Runtime detection interval; 0 disables the periodic refresh. */
  detectEveryMs?: number;
  log?: (line: string) => void;
}

export interface RunningService {
  core: StaCore;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** The foreground service body (`sta core serve`): HTTP server + control loop + service record. */
export async function serve(options: ServeOptions): Promise<RunningService> {
  const core = openCore(options);
  const log = options.log ?? ((line: string) => console.log(`[sta-core] ${new Date().toISOString()} ${line}`));
  const token = newServiceToken();
  let closing: Promise<void> | null = null;
  const server = createCoreServer({ core, token, version: options.version, onShutdown: () => void running.close() });
  const preferred = options.port ?? core.machine().service.port;
  const port = await listenOnFirstFree(server, preferred, preferred === 0 ? 1 : 20);
  const record: ServiceRecord = { pid: process.pid, port, token, startedAt: Date.now(), version: options.version };
  fs.mkdirSync(path.dirname(core.paths.serviceRecord), { recursive: true });
  fs.writeFileSync(core.paths.serviceRecord, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  log(`listening on http://127.0.0.1:${port}/ (pid ${process.pid})`);

  // Restart recovery happens naturally: the first tick reads every unsettled
  // run from core.db and reconciles its segment from the log/exit record.
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await core.runs.tick(); } catch (error) { log(`tick failed: ${error instanceof Error ? error.message : String(error)}`); } finally { ticking = false; }
  };
  const tickTimer = setInterval(() => void tick(), options.tickMs ?? 3_000);
  void tick();
  const detect = () => core.refreshRuntimeStatus().then(() => log("runtime detection refreshed")).catch((error: unknown) => log(`runtime detection failed: ${error instanceof Error ? error.message : String(error)}`));
  if (options.detectEveryMs !== 0) void detect();
  const detectTimer = options.detectEveryMs === 0 ? null : setInterval(() => void detect(), options.detectEveryMs ?? 15 * 60_000);

  const running: RunningService = {
    core,
    port,
    token,
    close() {
      closing ??= (async () => {
        clearInterval(tickTimer);
        if (detectTimer) clearInterval(detectTimer);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        try {
          const current = JSON.parse(fs.readFileSync(core.paths.serviceRecord, "utf8")) as ServiceRecord;
          if (current.pid === process.pid) fs.rmSync(core.paths.serviceRecord, { force: true });
        } catch { /* nothing to remove */ }
        core.close();
        log("stopped (running segments continue; they are reconciled on the next start)");
      })();
      return closing;
    },
  };
  return running;
}

function listenOnFirstFree(server: import("node:http").Server, port: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let left = attempts;
    const tryListen = () => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && --left > 0) {
          candidate += 1;
          tryListen();
        } else reject(error);
      });
      server.listen(candidate, "127.0.0.1", () => {
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : candidate);
      });
    };
    tryListen();
  });
}
