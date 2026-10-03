import { CliUsageError } from "../../cli.js";
import { flagValue, positionalArgs } from "../support.js";
import { openCore } from "../../core/core.js";
import { resolveKnowledge } from "../../core/knowledgeRegistry.js";
import { loadMachineConfig, type Language } from "../../core/machineConfig.js";
import { runSummary } from "../../core/server.js";
import { serviceStatus, startService, type ServiceRecord } from "../../core/service.js";
import { t } from "../../core/i18n.js";
import type { WorkRun } from "../../core/workRunStore.js";

/**
 * `sta work` — the CLI face of STA Core. It never orchestrates by itself:
 * every state change goes through the same Local API the STA Platform backend
 * uses (the service is started on demand), so CLI and Platform share one
 * implementation.
 * `sta work status` reads the Core database directly and works with the
 * service stopped. No Intent API is involved unless `--text` asks for it.
 *
 *   sta work <module> [--root <knowledge>] [--phase <n> | --task <id,...>] [--until next-gate] [--autonomy edit|full] [--text "<command>"]
 *   sta work status [<module>|<run-id>] [--root <knowledge>] [--json]
 *   sta work pause|resume|stop <module>|<run-id> [--root <knowledge>] [--force]
 *   sta work approve <module>|<run-id> --by <name> [--note <text>]
 *   sta work send-back <module>|<run-id> --by <name> --note <text>
 */

export const WORK_USAGE =
  "sta work <module> [--root <name>] [--phase <n> | --task <id,...>] [--until next-gate] [--autonomy edit|full] [--text \"<command>\"]\n" +
  "sta work status [<module>|<run-id>] [--root <name>] [--json]\n" +
  "sta work pause|resume|stop <module>|<run-id> [--root <name>] [--force]\n" +
  "sta work approve <module>|<run-id> --by <name> [--note <text>]   ·   sta work send-back <module>|<run-id> --by <name> --note <text>";

const SUBCOMMANDS = new Set(["status", "pause", "resume", "stop", "approve", "send-back", "list"]);

async function api(record: ServiceRecord, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${record.port}${path}`, {
    method,
    headers: { "x-sta-token": record.token, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function ensureService(autoStart: boolean): Promise<ServiceRecord> {
  const status = await serviceStatus();
  if (status.running && status.record) return status.record;
  if (!autoStart) throw new Error("STA Core is not running — `sta start` first");
  const { record } = await startService();
  return record;
}

function render(run: WorkRun, language: Language): string[] {
  const summary = runSummary(run, language);
  const th = language === "th";
  const lines = [
    `${run.runId}  ${summary.statusLabel}${run.statusReason ? ` — ${run.statusReason}` : ""}`,
    `  Knowledge: ${run.knowledge.name} (${run.knowledge.path})   Module: ${run.module}`,
    `  Commander: ${run.commander.current ?? "-"}   Engineer: ${run.workers.engineer ?? "-"}   Reviewer: ${run.workers.reviewer ?? "-"}   QA: ${run.workers.qa ?? "-"}`,
  ];
  if (summary.tasksTotal !== null) lines.push(`  ${th ? "งาน" : "Tasks"}: ${summary.tasksDone}/${summary.tasksTotal}   ${th ? "ไฟล์ที่เปลี่ยน" : "Changed files"}: ${summary.changedFiles ?? 0}${summary.currentTask ? `   ${th ? "ตอนนี้" : "Now"}: ${summary.currentTask} / ${summary.currentStage}` : ""}`);
  for (const fallback of run.fallbacks.slice(-6)) lines.push(`  ↳ ${fallback.role}: ${fallback.from} → ${fallback.to ?? "(none)"} (${fallback.failureClass})`);
  for (const gate of run.humanGates.filter((g) => g.resolvedAt === null)) lines.push(`  ⚑ ${gate.reason}`);
  lines.push(`  ${t(language, "report.not_done")}`);
  return lines;
}

function findRun(target: string, rootName: string | undefined): WorkRun {
  const core = openCore();
  try {
    if (target.startsWith("wr-")) {
      const run = core.store.get(target);
      if (!run) throw new Error(`no such work run: ${target}`);
      return run;
    }
    const knowledge = resolveKnowledge(rootName);
    const run = core.store.latestOpen(knowledge.name, target) ?? core.store.list({ knowledge: knowledge.name, module: target })[0];
    if (!run) throw new Error(`no work run for module ${target} in Knowledge ${knowledge.name}`);
    return run;
  } finally {
    core.close();
  }
}

export async function runWorkVerb(rest: string[]): Promise<number> {
  const positionals = positionalArgs(rest);
  const first = positionals[0];
  if (!first) throw new CliUsageError(`work: a module is required\n${WORK_USAGE}`);
  const rootName = flagValue(rest, "--root");
  const language = loadMachineConfig().language;
  const json = rest.includes("--json");

  if (!SUBCOMMANDS.has(first)) {
    const knowledge = resolveKnowledge(rootName);
    const phase = flagValue(rest, "--phase");
    const tasks = flagValue(rest, "--task");
    const until = flagValue(rest, "--until");
    const autonomy = flagValue(rest, "--autonomy");
    if (until && until !== "next-gate" && until !== "qa") throw new CliUsageError("work: --until accepts next-gate or qa (qa = every ready task until QA-verified, the default)");
    if (autonomy && autonomy !== "edit" && autonomy !== "full") throw new CliUsageError("work: --autonomy accepts edit or full");
    const text = flagValue(rest, "--text");
    const intent = {
      action: "work",
      knowledge_root: knowledge.name,
      module: first,
      scope: tasks ? "tasks" : phase ? "phase" : "ready_tasks",
      ...(phase ? { phase: Number(phase) } : {}),
      ...(tasks ? { tasks: tasks.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      completion_target: until === "next-gate" ? "next_gate" : "qa_passed",
      stop_for_human_review: true,
      allow_push: false,
      allow_merge: false,
      allow_deploy: false,
    };
    const record = await ensureService(true);
    const result = (await api(record, "POST", "/api/runs", {
      knowledge: knowledge.name,
      module: first,
      source: "cli",
      ...(autonomy ? { autonomy } : {}),
      ...(text ? { text } : { intent }),
    })) as { run: WorkRun; intent: { overrides: string[]; warnings: string[] } };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const line of render(result.run, language)) console.log(line);
      for (const line of [...result.intent.overrides, ...result.intent.warnings]) console.log(`  ! ${line}`);
      console.log(language === "th"
        ? `ทำงานต่อใน background แล้ว — ปิด terminal ได้ · ดูผล: sta work status ${first}${rootName ? ` --root ${rootName}` : ""} · API: http://127.0.0.1:${record.port}/api`
        : `Running in the background — you can close this terminal · sta work status ${first}${rootName ? ` --root ${rootName}` : ""} · API: http://127.0.0.1:${record.port}/api`);
    }
    return 0;
  }

  const target = positionals[1];
  if (first === "status" || first === "list") {
    const core = openCore();
    try {
      let runs: WorkRun[];
      if (target) runs = [findRun(target, rootName)];
      else runs = core.store.list(rootName ? { knowledge: resolveKnowledge(rootName).name } : {}).slice(0, 20);
      if (json) console.log(JSON.stringify(runs.map((run) => ({ ...runSummary(run, language), run })), null, 2));
      else if (runs.length === 0) console.log(language === "th" ? "ยังไม่มี work run" : "no work runs yet");
      else for (const run of runs) for (const line of render(run, language)) console.log(line);
      const status = await serviceStatus();
      if (!json && !status.running) console.log(language === "th" ? "(STA Core ไม่ได้ทำงานอยู่ — `sta start` เพื่อให้งานเดินต่อ)" : "(STA Core is not running — `sta start` to keep work moving)");
      return 0;
    } finally {
      core.close();
    }
  }

  if (!target) throw new CliUsageError(`work ${first}: a module or run id is required\n${WORK_USAGE}`);
  const run = findRun(target, rootName);
  const record = await ensureService(first === "resume");
  let updated: WorkRun;
  if (first === "approve") {
    const by = flagValue(rest, "--by");
    if (!by) throw new CliUsageError("work approve: --by <name> is required (an approval is a person's act)");
    updated = (await api(record, "POST", `/api/runs/${run.runId}/approve`, { by, note: flagValue(rest, "--note") })) as WorkRun;
  } else if (first === "send-back") {
    const by = flagValue(rest, "--by");
    const note = flagValue(rest, "--note");
    if (!by || !note) throw new CliUsageError("work send-back: --by <name> and --note <text> are required");
    updated = (await api(record, "POST", `/api/runs/${run.runId}/send-back`, { by, note })) as WorkRun;
  } else {
    updated = (await api(record, "POST", `/api/runs/${run.runId}/${first}`, first === "stop" ? { force: rest.includes("--force") } : {})) as WorkRun;
  }
  if (json) console.log(JSON.stringify(updated, null, 2));
  else for (const line of render(updated, language)) console.log(line);
  return 0;
}
