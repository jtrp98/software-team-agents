import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommanderInvocation, CommanderInvoker } from "./commander.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import { corePaths } from "./corePaths.js";

/**
 * Child processes of STA Core. The Core never runs a model in its own
 * process: a bounded-run segment and a commander turn each run in a child, so
 * the HTTP loop stays responsive, a crash in a runtime adapter cannot take the
 * service down, and a segment survives a service restart (it is detached and
 * writes its log and exit record to files the Core reads back).
 */

/** The compiled `sta` entry next to this module (`dist/cli.js`). */
export function staCliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

/**
 * Environment for a Core child: the service's own environment minus every
 * variable that could carry another run's identity or Knowledge selection.
 * The child resolves its Knowledge root only from the explicit `--root` and
 * `--core-run` pin.
 */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of ["STA_KNOWLEDGE_ROOT", "STA_KNOWLEDGE_ROOT_NAME", "STA_RUN_ID", "STA_RUN_STORE", "STA_ROLE", "STA_WRITABLE_WORK_ROOTS", "STA_TARGET_WORK_ROOTS"]) delete env[key];
  return env;
}

export interface SegmentLaunchSpec {
  args: readonly string[];
  cwd: string;
  logPath: string;
}

export interface SegmentLauncher {
  launch(spec: SegmentLaunchSpec): { pid: number };
  isAlive(pid: number): boolean;
  /** Emergency stop only — the normal stop is the engine's own task pause. */
  kill(pid: number): void;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const productionSegmentLauncher: SegmentLauncher = {
  launch(spec) {
    fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
    const fd = fs.openSync(spec.logPath, "a");
    try {
      const child = spawn(process.execPath, [staCliEntry(), ...spec.args], {
        cwd: spec.cwd,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        env: childEnvironment(),
      });
      child.unref();
      if (child.pid === undefined) throw new Error("the segment process did not start");
      return { pid: child.pid };
    } finally {
      fs.closeSync(fd);
    }
  },
  isAlive: processIsAlive,
  kill(pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else {
      try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    }
  },
};

/** Runs `sta core commander-job` and reads its JSON result back. */
export function childProcessCommanderInvoker(options: { home?: string; timeoutMs?: number } = {}): CommanderInvoker {
  return {
    invoke(request: CommanderInvocation) {
      const dir = path.join(corePaths(options.home).runsDir, request.runId, "commander");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = `${Date.now()}-${request.runtimeId}`;
      const input = path.join(dir, `${stamp}.in.json`);
      const output = path.join(dir, `${stamp}.out.json`);
      fs.writeFileSync(input, JSON.stringify({ runtimeId: request.runtimeId, prompt: request.prompt, cwd: request.cwd }), "utf8");
      return new Promise<Pick<RuntimeAgentResult, "status" | "text" | "failureClass" | "retryAt" | "diagnostics">>((resolve) => {
        const child = spawn(process.execPath, [staCliEntry(), "core", "commander-job", "--input", input, "--output", output], {
          cwd: request.cwd,
          windowsHide: true,
          stdio: "ignore",
          env: childEnvironment(),
        });
        const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20 * 60_000);
        const finish = (diagnostic?: string) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(fs.readFileSync(output, "utf8")));
          } catch {
            resolve({ status: "ERROR", text: "", diagnostics: [diagnostic ?? "commander job produced no result"] });
          }
        };
        child.on("error", (error) => finish(`commander job failed to start: ${error.message}`));
        child.on("exit", (code) => finish(`commander job exited ${code ?? "by signal"} without a result`));
      });
    },
  };
}
