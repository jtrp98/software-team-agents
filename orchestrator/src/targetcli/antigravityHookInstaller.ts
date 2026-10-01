import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGY_GUARD_WRAPPER_PATH } from "../runtime/bindingGenerator.js";

export const AGY_MANAGED_MACHINE_HOOK_KEY = "sta-guard";

export const AGY_GUARDED_TOOLS_LIST: readonly string[] = [
  "find_by_name",
  "grep_search",
  "list_dir",
  "multi_replace_file_content",
  "notebook_edit",
  "replace_file_content",
  "run_command",
  "sed_file",
  "view_file",
  "write_to_file",
];

export const AGY_GUARDED_TOOLS_MATCHER = AGY_GUARDED_TOOLS_LIST.join("|");

export interface AntigravityInstallOptions {
  targetRoot: string;
  machineHooksPath?: string;
  backupDir?: string;
}

export interface AntigravityInstallResult {
  ok: boolean;
  hooksPath: string;
  backupPath?: string;
  targetRoot: string;
  guardScriptPath: string;
  command: string;
  message: string;
}

export interface AntigravityUninstallOptions {
  machineHooksPath?: string;
  restore?: boolean;
}

export interface AntigravityUninstallResult {
  ok: boolean;
  hooksPath: string;
  restoredFrom?: string;
  removedKeys: string[];
  message: string;
}

export function defaultMachineHooksPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "hooks.json");
}

export function buildAgyHookCommand(targetRoot: string, guardScriptPath: string): string {
  const normTarget = path.resolve(targetRoot);
  const normScript = path.resolve(guardScriptPath).replace(/\\/g, "/");
  const scriptArg = normScript.includes(" ") ? `"${normScript}"` : normScript;
  if (process.platform === "win32") {
    return `set STA_WORKSPACE_ROOT=${normTarget}&& node ${scriptArg}`;
  }
  return `STA_WORKSPACE_ROOT="${normTarget}" node ${scriptArg}`;
}

export function installAntigravityHook(options: AntigravityInstallOptions): AntigravityInstallResult {
  const targetRoot = path.resolve(options.targetRoot);
  const guardScript = path.resolve(targetRoot, ...AGY_GUARD_WRAPPER_PATH.split("/"));

  if (!fs.existsSync(guardScript)) {
    throw new Error(
      `no ${AGY_GUARD_WRAPPER_PATH} in ${targetRoot} — run \`software-team-agents sync\` in that workspace first`,
    );
  }

  const hooksPath = path.resolve(options.machineHooksPath ?? defaultMachineHooksPath());
  const configDir = path.dirname(hooksPath);
  fs.mkdirSync(configDir, { recursive: true });

  let backupPath: string | undefined;
  let existingHooks: Record<string, unknown> = {};

  if (fs.existsSync(hooksPath)) {
    const raw = fs.readFileSync(hooksPath, "utf8");
    backupPath = path.join(options.backupDir ?? configDir, "hooks.json.bak");
    fs.writeFileSync(backupPath, raw, "utf8");

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingHooks = parsed as Record<string, unknown>;
      }
    } catch {
      // If unparseable, backup preserved above and we reinitialize cleanly
      existingHooks = {};
    }
  }

  const hookCommand = buildAgyHookCommand(targetRoot, guardScript);

  const managedEntry = {
    PreToolUse: [
      {
        matcher: AGY_GUARDED_TOOLS_MATCHER,
        hooks: [
          {
            type: "command",
            command: hookCommand,
            timeout: 30,
          },
        ],
      },
    ],
  };

  const updatedHooks: Record<string, unknown> = {
    ...existingHooks,
    [AGY_MANAGED_MACHINE_HOOK_KEY]: managedEntry,
  };

  fs.writeFileSync(hooksPath, JSON.stringify(updatedHooks, null, 2) + "\n", "utf8");

  const message = [
    `[software-team-agents] Antigravity machine-level hook installed successfully:`,
    backupPath ? `  - Backup created: ${backupPath}` : `  - New configuration file created`,
    `  - Config file:    ${hooksPath}`,
    `  - Target root:    ${targetRoot}`,
    `  - Guard script:   ${guardScript}`,
    `  - Command:        ${hookCommand}`,
    `  - Guarded tools:  ${AGY_GUARDED_TOOLS_MATCHER}`,
  ].join("\n");

  return {
    ok: true,
    hooksPath,
    backupPath,
    targetRoot,
    guardScriptPath: guardScript,
    command: hookCommand,
    message,
  };
}

export function uninstallAntigravityHook(options: AntigravityUninstallOptions = {}): AntigravityUninstallResult {
  const hooksPath = path.resolve(options.machineHooksPath ?? defaultMachineHooksPath());
  const configDir = path.dirname(hooksPath);
  const backupPath = path.join(configDir, "hooks.json.bak");

  if (options.restore && fs.existsSync(backupPath)) {
    const backupContent = fs.readFileSync(backupPath, "utf8");
    fs.writeFileSync(hooksPath, backupContent, "utf8");
    return {
      ok: true,
      hooksPath,
      restoredFrom: backupPath,
      removedKeys: [],
      message: `[software-team-agents] Restored ${hooksPath} from ${backupPath}`,
    };
  }

  if (!fs.existsSync(hooksPath)) {
    return {
      ok: true,
      hooksPath,
      removedKeys: [],
      message: `[software-team-agents] No hooks configuration found at ${hooksPath}`,
    };
  }

  const raw = fs.readFileSync(hooksPath, "utf8");
  let parsed: Record<string, unknown> = {};
  try {
    const val = JSON.parse(raw);
    if (val && typeof val === "object" && !Array.isArray(val)) {
      parsed = val as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const removedKeys: string[] = [];
  for (const k of [AGY_MANAGED_MACHINE_HOOK_KEY, "sta-guards"]) {
    if (k in parsed) {
      delete parsed[k];
      removedKeys.push(k);
    }
  }

  fs.writeFileSync(hooksPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");

  return {
    ok: true,
    hooksPath,
    removedKeys,
    message: removedKeys.length > 0
      ? `[software-team-agents] Removed [${removedKeys.join(", ")}] from ${hooksPath}`
      : `[software-team-agents] No STA hook entries found in ${hooksPath}`,
  };
}
