import * as fs from "node:fs";
import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import { flagValue } from "../support.js";
import { createProductionRuntimeRegistry } from "../composition/runtimeRegistry.js";
import { corePaths } from "../../core/corePaths.js";
import { addKnowledge, listKnowledge, KnowledgeRegistryError } from "../../core/knowledgeRegistry.js";
import {
  assertAcceptableMachineRoot,
  canonicalPoolRuntimeId,
  LANGUAGES,
  loadMachineConfig,
  saveMachineConfig,
  type Language,
  type MachineConfig,
  type PoolRuntimeId,
} from "../../core/machineConfig.js";
import { detectRuntimes, type RuntimeConnectStatus } from "../../core/runtimeConnect.js";
import { SecretStore } from "../../core/secretStore.js";
import { resolveFrameworkRoot } from "../../targetcli/roots.js";

/**
 * `sta setup-machine --root C:\src --language th [...]` — first-time (and
 * repeatable) machine setup for STA Core. Idempotent: every step reads the
 * current state and changes only what differs; running it twice with the same
 * flags writes the same files and launches nothing.
 */

export const SETUP_MACHINE_USAGE =
  "sta setup-machine --root <dir> [--language th|en] [--intent-provider gemini|offline] [--intent-model <id>] [--intent-key-stdin] " +
  "[--commander-order a,b,..] [--engineer-order ..] [--reviewer-order ..] [--qa-order ..] [--knowledge <name>=<path>]... [--no-detect]";

function order(value: string | undefined, flag: string): PoolRuntimeId[] | undefined {
  if (!value) return undefined;
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const id = canonicalPoolRuntimeId(item);
    if (!id) throw new CliUsageError(`${flag}: unknown runtime "${item}" (claude-code, codex, agy, zcode)`);
    return id;
  });
  return ids;
}

function allValues(rest: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === flag && rest[i + 1] !== undefined) values.push(rest[i + 1]!);
  return values;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function renderRuntime(status: RuntimeConnectStatus, th: boolean): string {
  const parts = [
    status.installed ? `${status.version ?? "?"}` : (th ? "ไม่ได้ติดตั้ง" : "not installed"),
    `auth=${status.authentication}`,
    `roles=${Object.entries(status.securityRoles).filter(([, ok]) => ok).map(([role]) => role).join("/") || (th ? "ไม่มี (security)" : "none (security)")}`,
  ].filter(Boolean);
  return `  ${status.displayName.padEnd(18)} ${status.state.padEnd(15)} ${parts.join("  ")}`;
}

export async function runSetupMachineVerb(rest: string[]): Promise<number> {
  const rootFlag = flagValue(rest, "--root");
  if (!rootFlag) throw new CliUsageError(`setup-machine: --root <dir> is required\n${SETUP_MACHINE_USAGE}`);
  const languageFlag = flagValue(rest, "--language");
  if (languageFlag && !(LANGUAGES as readonly string[]).includes(languageFlag)) throw new CliUsageError("setup-machine: --language must be th or en");
  const provider = flagValue(rest, "--intent-provider");
  if (provider && provider !== "gemini" && provider !== "offline") throw new CliUsageError("setup-machine: --intent-provider must be gemini or offline");

  // 1. Validate and canonicalize the machine root.
  const resolvedRoot = path.resolve(rootFlag);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) throw new CliUsageError(`setup-machine: --root ${resolvedRoot} is not an existing directory`);
  const machineRoot = assertAcceptableMachineRoot(fs.realpathSync.native(resolvedRoot));

  // 2. Save the machine config (only what the flags change).
  const current = loadMachineConfig();
  const th = (languageFlag ?? current.language) === "th";
  const next: MachineConfig = {
    ...current,
    workspace: { allowed_roots: [...new Set([...current.workspace.allowed_roots, machineRoot])] },
    language: (languageFlag as Language | undefined) ?? current.language,
    intent: { ...current.intent, ...(provider ? { provider: provider as "gemini" | "offline" } : {}), ...(flagValue(rest, "--intent-model") ? { model: flagValue(rest, "--intent-model")! } : {}) },
    commander: { ...current.commander, ...(order(flagValue(rest, "--commander-order"), "--commander-order") ? { order: order(flagValue(rest, "--commander-order"), "--commander-order")! } : {}) },
    roles: {
      engineer: { ...current.roles.engineer, ...(order(flagValue(rest, "--engineer-order"), "--engineer-order") ? { order: order(flagValue(rest, "--engineer-order"), "--engineer-order")! } : {}) },
      reviewer: { ...current.roles.reviewer, ...(order(flagValue(rest, "--reviewer-order"), "--reviewer-order") ? { order: order(flagValue(rest, "--reviewer-order"), "--reviewer-order")! } : {}) },
      qa: { ...current.roles.qa, ...(order(flagValue(rest, "--qa-order"), "--qa-order") ? { order: order(flagValue(rest, "--qa-order"), "--qa-order")! } : {}) },
    },
  };
  const saved = saveMachineConfig(next);
  const paths = corePaths();
  console.log(th ? "1) Machine config" : "1) Machine config");
  console.log(`  ${paths.machineConfig}`);
  console.log(`  machine root: ${saved.workspace.allowed_roots.join(", ")}   language: ${saved.language}   intent: ${saved.intent.provider}/${saved.intent.model}`);

  // 3. Intent API key (stdin only — never a flag value, never echoed).
  if (rest.includes("--intent-key-stdin")) {
    const key = readStdin().trim();
    if (!key) throw new CliUsageError("setup-machine: --intent-key-stdin read nothing from stdin");
    const status = new SecretStore().set("intent-api-key", key);
    console.log(th ? `2) Intent API key บันทึกแล้ว (${status.source})` : `2) Intent API key stored (${status.source})`);
  } else {
    const status = new SecretStore().status("intent-api-key");
    console.log(th
      ? `2) Intent API key: ${status.configured ? `ตั้งค่าแล้ว (${status.source})` : "ยังไม่ได้ตั้ง — ใช้ตัวแปลแบบ offline จนกว่าจะตั้ง (Web: Settings หรือ --intent-key-stdin)"}`
      : `2) Intent API key: ${status.configured ? `configured (${status.source})` : "not set — the offline parser is used until it is (Web: Settings or --intent-key-stdin)"}`);
  }

  // 4. Knowledge roots.
  for (const spec of allValues(rest, "--knowledge")) {
    const eq = spec.indexOf("=");
    if (eq <= 0) throw new CliUsageError(`setup-machine: --knowledge expects <name>=<path> (got ${spec})`);
    const name = spec.slice(0, eq);
    const knowledgePath = spec.slice(eq + 1);
    const existing = listKnowledge({ configPath: paths.installationConfig }).find((entry) => entry.name === name);
    if (existing && path.resolve(existing.path).toLowerCase() === path.resolve(knowledgePath).toLowerCase()) {
      console.log(`  Knowledge ${name}: ${th ? "ลงทะเบียนไว้แล้ว" : "already registered"}`);
      continue;
    }
    try {
      const added = addKnowledge(name, knowledgePath, { machine: saved, configPath: paths.installationConfig, frameworkRoot: resolveFrameworkRoot() });
      console.log(`  Knowledge ${name}: ${added.state} (${added.path})`);
    } catch (error) {
      if (error instanceof KnowledgeRegistryError) console.log(`  ✗ Knowledge ${name}: ${error.message}`);
      else throw error;
    }
  }
  const knowledge = listKnowledge({ machine: saved, configPath: paths.installationConfig });
  console.log(th ? "3) Knowledge roots" : "3) Knowledge roots");
  if (knowledge.length === 0) console.log(th ? "  ยังไม่มี — sta knowledge add <name> <path>" : "  none yet — sta knowledge add <name> <path>");
  for (const entry of knowledge) console.log(`  ${entry.isDefault ? "●" : "○"} ${entry.name.padEnd(16)} ${entry.state.padEnd(8)} ${entry.path}  (${entry.targets.length} targets, ${entry.modules.length} modules)${entry.problems.length ? ` — ${entry.problems.join("; ")}` : ""}`);

  // 5. Runtimes.
  if (!rest.includes("--no-detect")) {
    console.log(th ? "4) Runtime ทั้ง 4 ตัว" : "4) The four runtimes");
    const statuses = await detectRuntimes(createProductionRuntimeRegistry(paths.home));
    fs.mkdirSync(path.dirname(paths.database), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(paths.database), "runtime-status.json"), JSON.stringify(statuses, null, 2), "utf8");
    for (const status of statuses) console.log(renderRuntime(status, th));
  }

  console.log(th ? "5) เสร็จ — ต่อไป: sta start (สั่งงานผ่าน sta work หรือ STA Platform)" : "5) Done — next: sta start (work via sta work or STA Platform)");
  return 0;
}
