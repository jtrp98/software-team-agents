import * as fs from "node:fs";
import { CliUsageError, cliVersion } from "../../cli.js";
import { flagValue } from "../support.js";
import { serve, serviceStatus, startService, stopService } from "../../core/service.js";
import { createProductionRuntimeRegistry } from "../composition/runtimeRegistry.js";
import { detectRuntimes } from "../../core/runtimeConnect.js";
import { executorPortFor } from "../../runtime/executorPort.js";
import type { RuntimeAgentRequest, RuntimeAgentResult } from "../../runtime/runtimeAdapter.js";
import { corePaths } from "../../core/corePaths.js";
import { loadMachineConfig } from "../../core/machineConfig.js";

/**
 * `sta start` / `sta stop` / `sta core <serve|status|start|stop|detect-runtimes|commander-job>`.
 *
 * `serve` is the service body (what `start` launches detached); the two job
 * subcommands are the Core's own child processes and are not meant to be
 * typed by a person.
 */

export async function runStartVerb(rest: string[]): Promise<number> {
  const port = flagValue(rest, "--port");
  const { started, record } = await startService({ port: port ? Number(port) : undefined });
  const th = loadMachineConfig().language === "th";
  console.log(started
    ? (th ? `STA Core เริ่มทำงานแล้ว (pid ${record.pid})` : `STA Core started (pid ${record.pid})`)
    : (th ? `STA Core ทำงานอยู่แล้ว (pid ${record.pid})` : `STA Core is already running (pid ${record.pid})`));
  console.log(`Local API: http://127.0.0.1:${record.port}/api — team UI: STA Platform`);
  return 0;
}

export async function runStopServiceVerb(): Promise<number> {
  const stopped = await stopService();
  const th = loadMachineConfig().language === "th";
  console.log(stopped
    ? (th ? "STA Core หยุดแล้ว — งานที่กำลังรัน (segment) ยังทำต่อ และจะถูก reconcile เมื่อเปิดใหม่" : "STA Core stopped — running segments continue and are reconciled on the next start")
    : (th ? "STA Core ไม่ได้ทำงานอยู่" : "STA Core is not running"));
  return 0;
}

async function commanderJob(rest: string[]): Promise<number> {
  const input = flagValue(rest, "--input");
  const output = flagValue(rest, "--output");
  if (!input || !output) throw new CliUsageError("core commander-job: --input and --output are required");
  const job = JSON.parse(fs.readFileSync(input, "utf8")) as { runtimeId: string; prompt: string; cwd: string };
  const write = (result: Pick<RuntimeAgentResult, "status" | "text" | "failureClass" | "retryAt" | "diagnostics">) => fs.writeFileSync(output, JSON.stringify(result), "utf8");
  try {
    const registry = createProductionRuntimeRegistry(job.cwd);
    const adapter = registry.tryGet(job.runtimeId);
    if (!adapter) {
      write({ status: "UNAVAILABLE", failureClass: "PROVIDER_UNAVAILABLE", text: "", diagnostics: [`runtime ${job.runtimeId} is not registered`] });
      return 0;
    }
    // The Commander only reads and answers: read-only autonomy, no write
    // grant, git refused; the runtime runs directly with the user's own login.
    const request: RuntimeAgentRequest = {
      taskId: `commander-${Date.now()}`,
      stage: "commander",
      cwd: job.cwd,
      prompt: job.prompt,
      autonomy: "read-only",
      guards: { writeAllow: [], writeDeny: [], forbidCommands: ["git"], exitChecks: [] },
      env: { STA_ROLE: "" },
      timeoutMs: 15 * 60_000,
    };
    const port = executorPortFor(adapter);
    const result = await port.execute(await port.prepare(request));
    write({ status: result.status, text: result.text, failureClass: result.failureClass, retryAt: result.retryAt, diagnostics: result.diagnostics });
    return 0;
  } catch (error) {
    write({ status: "ERROR", text: "", diagnostics: [`commander job failed: ${error instanceof Error ? error.message : String(error)}`] });
    return 0;
  }
}

export async function runCoreVerb(rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "serve": {
      const port = flagValue(args, "--port");
      const running = await serve({ version: cliVersion(), ...(port ? { port: Number(port) } : {}) });
      const shutdown = () => void running.close().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return new Promise<number>(() => { /* serves until shutdown */ });
    }
    case "start":
      return runStartVerb(args);
    case "stop":
      return runStopServiceVerb();
    case "status": {
      const status = await serviceStatus();
      if (args.includes("--json")) console.log(JSON.stringify({ ...status, record: status.record ? { ...status.record, token: undefined } : null }, null, 2));
      else console.log(status.running ? `STA Core: running (pid ${status.record!.pid}) — ${status.url}` : "STA Core: not running — `sta start`");
      return status.running ? 0 : 3;
    }
    case "detect-runtimes": {
      const output = flagValue(args, "--output");
      const statuses = await detectRuntimes(createProductionRuntimeRegistry(corePaths().home));
      if (output) fs.writeFileSync(output, JSON.stringify(statuses, null, 2), "utf8");
      else console.log(JSON.stringify(statuses, null, 2));
      return 0;
    }
    case "commander-job":
      return commanderJob(args);
    default:
      throw new CliUsageError("core: expected serve | start | stop | status | detect-runtimes");
  }
}
