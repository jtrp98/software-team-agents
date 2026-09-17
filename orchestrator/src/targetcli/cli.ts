#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFrameworkRoot } from "./roots.js";
import { runTargetInit } from "./initCommand.js";
import { gatherStatus, renderStatus } from "./statusCommand.js";
import { TargetSyncConflictError, runTargetSync } from "./syncEngine.js";
import { readTargetManifest, isTargetInitialized, loadTargetConfig, TargetNotInitializedError } from "./targetMeta.js";
import { installedFrameworkVersion } from "./version.js";
import { runSession, type RuntimeName } from "./devCommand.js";
import { applyCleanup, CleanupUnmanagedWorkspaceError, planCleanup, renderCleanupPlan, reportCleanupResult } from "./cleanupCommand.js";

/**
 * The single-workspace entry point: `software-team-agents init|sync|status|open`,
 * always executed against the repository the user's shell is standing in
 * (process.cwd(), or --target-root). Nothing here requires — or even accepts —
 * cd-ing into the Framework repo; that repo resolves itself from this file's
 * installed location. `open` runs the one interactive session kind, from the
 * Knowledge workspace the shell stands in. The retired two-lane names `ba` and
 * `dev` are caught and answered with this command — they are not aliases and
 * they do not run (V10 TASK-026, no deprecation period).
 */

/** A retired two-lane command name, caught so the error can name its replacement. */
export class RetiredCommandError extends Error {
  constructor(readonly retired: string) {
    super(`'${retired}' was retired in V10 — the two-lane (ba/dev) workspace layout is gone; open your session with: software-team-agents open`);
  }
}

export const TARGET_USAGE =
  "usage: software-team-agents <command> [options]\n" +
  "\n" +
  "commands:\n" +
  "  init      detect this workspace and initialize Framework metadata + managed assets\n" +
  "  sync      bring Framework-managed files up to the installed Framework version\n" +
  "  status    show role, workspace, roots, versions, sync state, readiness\n" +
  "  open      preflight, then launch an agent runtime from this Knowledge workspace\n" +
  "  cleanup   move this workspace's Framework payload into a backup and un-manage it (V10):\n" +
  "            manifest-tracked files only, overrides kept, reversible via sta rollback\n" +
  "\n" +
  "options:\n" +
  "  --target-root <path>   operate on <path> instead of the current directory\n" +
  "  --role <name>          retired: accepted and ignored — nothing keys off a recorded\n" +
  "                         role anymore (old configs still open untouched)\n" +
  "  --stack <name>         init/sync: explicitly resolve ambiguous Target stack evidence\n" +
  "  --force                sync/init: overwrite locally-modified managed files (backed up first)\n" +
  "  --confirm-agents-pointer sync: reduce a provable CLAUDE.md duplicate to the generated AGENTS.md pointer (backed up)\n" +
  "  --no-auto-sync         open: refuse to run when managed assets are outdated\n" +
  "  --runtime <name>       open: claude (default), codex, opencode or antigravity — guard coverage\n" +
  "                         differs per runtime (claude: enforced, opencode: partial, codex and\n" +
  "                         antigravity: unguarded); run\n" +
  "                         `sta runtimes` for the coverage detail behind each verdict\n" +
  "  --allow-unguarded-runtime  open: deliberately launch a runtime that enforces no guard\n" +
  "  --dry-run              cleanup: print the plan and touch nothing\n" +
  "  --yes                  cleanup: the human confirmation — move the payload for real\n" +
  "  --json                 status: machine-readable output\n" +
  "  -h, --help             show this help\n" +
  "  --version              show the installed Framework version\n";

export interface TargetCliArgs {
  command?: "init" | "sync" | "status" | "open" | "cleanup";
  targetRoot?: string;
  /** `--role` value, accepted for command-line compatibility and ignored (V10 TASK-026). */
  retiredRole?: string;
  stack?: string;
  force: boolean;
  confirmAgentsPointer: boolean;
  autoSync: boolean;
  runtime: RuntimeName;
  runtimeSelections: RuntimeName[];
  /** Explicit acceptance of a runtime that enforces no guard. */
  allowUnguardedRuntime: boolean;
  /** cleanup: plan only, no mutation. */
  dryRun: boolean;
  /** cleanup: the explicit human confirmation that the payload may move. */
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Pure argv parser — no console/exit, directly testable. */
export function parseTargetArgs(argv: string[]): TargetCliArgs {
  const args: TargetCliArgs = { force: false, confirmAgentsPointer: false, autoSync: true, runtime: "claude", runtimeSelections: [], allowUnguardedRuntime: false, dryRun: false, yes: false, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "init":
      case "sync":
      case "status":
      case "open":
      case "cleanup":
        if (args.command) throw new Error(`only one command may be given (got both ${args.command} and ${arg})`);
        args.command = arg;
        break;
      case "dev":
      case "ba":
        // Caught, not an alias: the answer names the one entry command (V10 TASK-026).
        throw new RetiredCommandError(arg);
      case "--target-root":
        args.targetRoot = argv[++i];
        if (!args.targetRoot) throw new Error("--target-root requires a path");
        break;
      case "--role": {
        // Accepted and ignored: nothing keys off a recorded role anymore
        // (V10 TASK-021 kept old configs readable; V10 TASK-026 retires the flag).
        const value = argv[++i];
        if (!value) throw new Error("--role requires a value");
        args.retiredRole = value;
        break;
      }
      case "--stack":
        args.stack = argv[++i];
        if (!args.stack) throw new Error("--stack requires a profile name");
        break;
      case "--force":
        args.force = true;
        break;
      case "--confirm-agents-pointer":
        args.confirmAgentsPointer = true;
        break;
      case "--no-auto-sync":
        args.autoSync = false;
        break;
      case "--runtime": {
        const value = argv[++i] as RuntimeName | undefined;
        if (value !== "claude" && value !== "codex" && value !== "opencode" && value !== "antigravity") {
          throw new Error(`--runtime must be claude, codex, opencode or antigravity (got ${value ?? "nothing"})`);
        }
        args.runtime = value;
        args.runtimeSelections.push(value);
        break;
      }
      case "--allow-unguarded-runtime":
        args.allowUnguardedRuntime = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--version":
        args.version = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return args;
}

function requireInitialized(targetRoot: string): ReturnType<typeof readTargetManifest> {
  if (!isTargetInitialized(targetRoot)) {
    throw new TargetNotInitializedError(
      `${targetRoot} has not been initialized — run \`software-team-agents init\` inside your project first`,
    );
  }
  return readTargetManifest(targetRoot);
}

export async function runTargetCli(
  argv: string[],
  cwd: string,
  frameworkRootFrom?: string,
  options: { installationConfigPath?: string } = {},
): Promise<number> {
  let args: TargetCliArgs;
  try {
    args = parseTargetArgs(argv);
  } catch (e) {
    if (e instanceof RetiredCommandError) {
      console.error(`[software-team-agents] ${e.message}`);
      return 64;
    }
    throw e;
  }
  if (args.retiredRole) {
    console.error(
      `[software-team-agents] WARNING: --role is retired and ignored (got --role ${args.retiredRole}) — a workspace records what its markers and config say; nothing keys off a recorded role anymore`,
    );
  }
  if (args.help || (!args.command && !args.version)) {
    console.log(TARGET_USAGE);
    return args.help ? 0 : 1;
  }

  // The framework root resolves from this file's own location — dev checkout or
  // installed package alike — never from the working directory. Tests name an
  // explicit origin so they can point at fixture installations instead.
  let frameworkRoot: string;
  try {
    frameworkRoot = resolveFrameworkRoot(frameworkRootFrom);
  } catch (e) {
    console.error(`[software-team-agents] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const targetRootArg = args.targetRoot ?? cwd;

  if (args.version) {
    console.log(installedFrameworkVersion(frameworkRoot));
    return 0;
  }

  try {
    switch (args.command) {
      case "init": {
        const result = runTargetInit({
          targetRoot: targetRootArg,
          templatesDir: path.join(frameworkRoot, "templates"),
          now: new Date().toISOString(),
          force: args.force,
          stack: args.stack,
          runtimes: args.runtimeSelections,
          installationConfigPath: options.installationConfigPath,
        });
        console.log(
          `[software-team-agents] ${result.role === "ba" ? "Knowledge" : "Target"} workspace ` +
            `${result.targetRoot} initialized as ${String(result.role).toUpperCase()} (id: ${path.basename(result.targetRoot)}, via ${result.roleVia}).`,
        );
        console.log(`[software-team-agents]   Framework: ${result.frameworkVersion}${result.wasInitialized ? " (re-initialized)" : ""}`);
        const added = result.sync.performed.filter((p) => p.action === "add").length;
        const updated = result.sync.performed.filter((p) => p.action === "update").length;
        const unchanged = result.sync.performed.filter((p) => p.action === "unchanged").length;
        console.log(`[software-team-agents]   managed assets: ${added} added, ${updated} updated, ${unchanged} already current`);
        // Surfaces the same environment prerequisite objects launch preflight
        // will later enforce; advisory here, not enforced.
        for (const prerequisite of result.prerequisites) {
          if (!prerequisite.ok) console.log(`[software-team-agents] ! ${prerequisite.name} — ${prerequisite.detail}; Fix: ${prerequisite.fix}`);
        }
        for (const action of result.sync.performed.filter((entry) => entry.action === "override")) {
          console.log(`[software-team-agents]   override     ${action.path} (${action.note ?? "explicit user choice"})`);
        }
        if (result.sync.backupDir) console.log(`[software-team-agents]   previous copies backed up in ${result.sync.backupDir}`);
        return 0;
      }

      case "sync": {
        const manifest = requireInitialized(targetRootArg);
        const config = loadTargetConfig(targetRootArg);
        const templatesDir = path.join(frameworkRoot, "templates");
        try {
          const result = runTargetSync({
            targetRoot: targetRootArg,
            templatesDir,
            manifest,
            config,
            role: config?.role,
            installationConfigPath: options.installationConfigPath,
            now: new Date().toISOString(),
            force: args.force,
            explicitStack: args.stack,
            confirmAgentsPointer: args.confirmAgentsPointer,
          });
          for (const action of result.performed) {
            if (action.action === "unchanged") continue;
            console.log(`[software-team-agents]   ${action.action.padEnd(12)} ${action.path}${action.note ? ` (${action.note})` : ""}`);
          }
          console.log(
            `[software-team-agents] synced to Framework ${result.frameworkVersion}` +
              `${result.previousVersion && result.previousVersion !== result.frameworkVersion ? ` (was ${result.previousVersion})` : ""}`,
          );
          if (result.backupDir) console.log(`[software-team-agents] previous copies backed up in ${result.backupDir}`);
          if (result.stackProfileMismatch) console.log(`[software-team-agents] WARNING: ${result.stackProfileMismatch}`);
          return 0;
        } catch (e) {
          if (e instanceof TargetSyncConflictError) {
            console.error("[software-team-agents] sync stopped — local modifications would be lost:");
            for (const conflict of e.plan.conflicts) {
              console.error(`  ! ${conflict.path} (${conflict.kind}) — ${conflict.detail}`);
              console.error(
                conflict.kind === "user-modified"
                  ? "    recovery: revert the edit, claim the file via .agent-team/config.yaml overrides, or re-run with --force"
                  : conflict.kind === "unmergeable-settings"
                    ? "    recovery: fix/merge .claude/settings.json manually, claim it in .agent-team/config.yaml overrides, or re-run with --force (backup first)"
                  : conflict.kind === "malformed-framework-block"
                    ? `    recovery: restore ${conflict.path} from .agent-team/backups or repair its Framework marker pair; --force will not guess`
                    : "    recovery: move/rename your file aside, then re-run software-team-agents sync",
              );
            }
            return 2;
          }
          throw e;
        }
      }

      case "status": {
        const status = gatherStatus({ targetRoot: targetRootArg, templatesDir: path.join(frameworkRoot, "templates"), installationConfigPath: options.installationConfigPath });
        if (args.json) console.log(JSON.stringify(status, null, 2));
        else console.log(renderStatus(status));
        return 0;
      }

      case "open": {
        return await runSession({
          targetRoot: targetRootArg,
          templatesDir: path.join(frameworkRoot, "templates"),
          runtime: args.runtime,
          autoSync: args.autoSync,
          allowUnguardedRuntime: args.allowUnguardedRuntime,
          installationConfigPath: options.installationConfigPath,
        });
      }

      case "cleanup": {
        // Destructive by design, so the shape is: plan always prints, an
        // explicit human `--yes` is what moves anything, and --dry-run is the
        // same plan with a no-mutation verdict.
        let plan;
        try {
          plan = planCleanup({ targetRoot: targetRootArg });
        } catch (e) {
          if (e instanceof CleanupUnmanagedWorkspaceError) {
            console.log(`[software-team-agents] ${e.message}`);
            return 0;
          }
          throw e;
        }
        const render = renderCleanupPlan(plan);
        if (render.movedCount === 0 && !plan.gitignoreBlock) {
          console.log(`[software-team-agents] nothing to clean up in ${targetRootArg} (no tracked payload on disk)`);
          return 0;
        }
        console.log(`[software-team-agents] cleanup plan for ${targetRootArg}:`);
        for (const line of render.lines) console.log(line);
        if (args.dryRun) {
          console.log("[software-team-agents] dry run — nothing was touched.");
          return 0;
        }
        if (!args.yes) {
          console.error(
            `[software-team-agents] cleanup is destructive: ${render.movedCount} payload file(s) would move into .agent-team/backups. ` +
              "Re-run with --yes (a person's confirmation) to perform it, or --dry-run to inspect without deciding.",
          );
          return 64;
        }
        const result = applyCleanup(plan, new Date().toISOString());
        reportCleanupResult(result, loadTargetConfig(targetRootArg));
        return 0;
      }

      default:
        // parseTargetArgs only ever yields the five commands above.
        console.error(`[software-team-agents] unknown command: ${String(args.command)}`);
        return 64;
    }
  } catch (e) {
    console.error(`[software-team-agents] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const isMain = (() => {
  // Compare realpaths: under `npm link` (a Windows junction) argv[1] carries
  // the junction path while this module resolves to the checkout — a plain
  // string compare would silently disable the whole CLI.
  try {
    if (!process.argv[1]) return false;
    const entry = fs.realpathSync.native(path.resolve(process.argv[1]));
    return entry === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  runTargetCli(process.argv.slice(2), process.cwd())
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
