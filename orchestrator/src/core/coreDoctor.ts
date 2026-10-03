import * as fs from "node:fs";
import { corePaths } from "./corePaths.js";
import { listKnowledge } from "./knowledgeRegistry.js";
import { loadMachineConfig } from "./machineConfig.js";
import type { RuntimeConnectStatus } from "./runtimeConnect.js";
import { SecretStore } from "./secretStore.js";
import { serviceStatus } from "./service.js";
import * as path from "node:path";

/**
 * The STA Core section of `sta doctor`: service, machine root, language,
 * Knowledge roots, Intent and the four runtimes. Read-only — it reads the
 * cached runtime detection rather than re-running runtime CLIs.
 */
export async function coreDoctorLines(): Promise<string[]> {
  const lines: string[] = [];
  let machine;
  try {
    machine = loadMachineConfig();
  } catch (error) {
    return [`✗ STA Core machine config: ${error instanceof Error ? error.message : String(error)}`];
  }
  const th = machine.language === "th";
  const service = await serviceStatus();
  lines.push("— STA Core —");
  lines.push(`STA Core        ${service.running ? `${th ? "ทำงาน" : "Running"} (${service.url})` : th ? "ไม่ได้ทำงาน — sta start" : "Not running — sta start"}`);
  lines.push(`Machine root    ${machine.workspace.allowed_roots.join(", ") || (th ? "ยังไม่ได้ตั้ง — sta setup-machine --root <dir>" : "not set — sta setup-machine --root <dir>")}`);
  lines.push(`Language        ${machine.language === "th" ? "Thai" : "English"}`);
  lines.push("Knowledge Roots");
  try {
    const roots = listKnowledge({ machine });
    if (roots.length === 0) lines.push(th ? "  (ยังไม่มี — sta knowledge add <name> <path>)" : "  (none — sta knowledge add <name> <path>)");
    for (const root of roots) lines.push(`  ${root.isDefault ? "●" : "○"} ${root.name.padEnd(14)} ${root.state.padEnd(8)} ${root.path}${root.problems.length ? ` — ${root.problems[0]}` : ""}`);
  } catch (error) {
    lines.push(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = new SecretStore().status("intent-api-key");
  lines.push(`Intent          Provider: ${machine.intent.provider} · Model: ${machine.intent.model} · ${key.configured ? `key: ${key.source}` : th ? "key: ยังไม่ได้ตั้ง (ใช้ offline parser)" : "key: not set (offline parser)"}`);
  lines.push("Runtime");
  let statuses: RuntimeConnectStatus[] | null = null;
  try {
    statuses = JSON.parse(fs.readFileSync(path.join(path.dirname(corePaths().database), "runtime-status.json"), "utf8")) as RuntimeConnectStatus[];
  } catch { /* not detected yet */ }
  if (!statuses) lines.push(th ? "  (ยังไม่ได้ตรวจ — sta setup-machine หรือหน้า Runtime › ตรวจทั้งหมดอีกครั้ง)" : "  (not detected yet — sta setup-machine or Runtime › Re-check all)");
  for (const status of statuses ?? []) {
    lines.push(`  ${status.displayName.padEnd(18)} ${status.state === "CONNECTED" ? "ready" : status.state.toLowerCase()} · roles: ${Object.entries(status.securityRoles).filter(([, ok]) => ok).map(([role]) => role).join("/") || "none"}`);
  }
  return lines;
}
