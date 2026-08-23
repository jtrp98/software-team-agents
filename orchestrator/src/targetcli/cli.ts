#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFrameworkRoot } from "./roots.js";
import { runTargetInit } from "./initCommand.js";
import { gatherStatus, renderStatus } from "./statusCommand.js";
import { TargetSyncConflictError, planSync, runTargetSync } from "./syncEngine.js";
import { readTargetManifest, isTargetInitialized, loadTargetConfig, TargetNotInitializedError } from "./targetMeta.js";
import { installedFrameworkVersion } from "./version.js";
import { runBa, runDev, type RuntimeName } from "./devCommand.js";
import { assetsForRole, type RoleName } from "./roleWorkspace.js";

/**
 * T-TARGET-01 + T-ROLE-03/04 — the Target-first, role-aware entry point.
 *
 * `software-team-agents init|sync|status|dev|ba`, always executed against the
 * repository the user's shell is standing in (process.cwd(), or --target-root).
 * Nothing here requires — or even accepts — cd-ing into the Framework repo;
 * that repo resolves itself from this file's installed location. `dev` runs a
 * DEV session from a Target; `ba` runs a BA session from the Knowledge repo.
 */

export const TARGET_USAGE =
  "usage: software-team-agents <command> [options]\n" +
  "\n" +
  "commands:\n" +
  "  init      detect this workspace and initialize Framework metadata + managed assets\n" +
  "  sync      bring Framework-managed files up to the installed Framework version\n" +
  "  status    show role, workspace, roots, versions, sync state, readiness\n" +
  "  dev       preflight, then launch an agent runtime from this Target (DEV)\n" +
  "  ba        preflight, then launch an agent runtime from this Knowledge repo (BA; Target never required)\n" +
  "\n" +
  "options:\n" +
  "  --target-root <path>   operate on <path> instead of the current directory\n" +
  "  --role <ba|dev>        init: say what this workspace is when markers are ambiguous\n" +
  "  --force                sync/init: overwrite locally-modified managed files (backed up first)\n" +
  "  --no-auto-sync         dev/ba: refuse to run when managed assets are outdated\n" +
  "  --runtime <name>       dev/ba: claude (default) or codex\n" +
  "  --json                 status: machine-readable output\n" +
  "  -h, --help             show this help\n" +
  "  --version              show the installed Framework version\n";

export interface TargetCliArgs {
  command?: "init" | "sync" | "status" | "dev" | "ba";
  targetRoot?: string;
  role?: RoleName;
  force: boolean;
  autoSync: boolean;
  runtime: RuntimeName;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Pure argv parser — no console/exit, directly testable. */
export function parseTargetArgs(argv: string[]): TargetCliArgs {
  const args: TargetCliArgs = { force: false, autoSync: true, runtime: "claude", json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "init":
      case "sync":
      case "status":
      case "dev":
      case "ba":
        if (args.command) throw new Error(`only one command may be given (got both ${args.command} and ${arg})`);
        args.command = arg;
        break;
      case "--target-root":
        args.targetRoot = argv[++i];
        if (!args.targetRoot) throw new Error("--target-root requires a path");
        break;
      case "--role": {
        const value = argv[++i] as RoleName | undefined;
        if (value !== "ba" && value !== "dev") throw new Error(`--role must be ba or dev (got ${value ?? "nothing"})`);
        args.role = value;
        break;
      }
      case "--force":
        args.force = true;
        break;
      case "--no-auto-sync":
        args.autoSync = false;
        break;
      case "--runtime": {
        const value = argv[++i] as RuntimeName | undefined;
        if (value !== "claude" && value !== "codex") throw new Error(`--runtime must be claude or codex (got ${value ?? "nothing"})`);
        args.runtime = value;
        break;
      }
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

export async function runTargetCli(argv: string[], cwd: string, frameworkRootFrom?: string): Promise<number> {
  const args = parseTargetArgs(argv);
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
          role: args.role,
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
            include: config?.role ? assetsForRole(config.role) : undefined,
            now: new Date().toISOString(),
            force: args.force,
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
          return 0;
        } catch (e) {
          if (e instanceof TargetSyncConflictError) {
            console.error("[software-team-agents] sync stopped — local modifications would be lost:");
            for (const conflict of e.plan.conflicts) {
              console.error(`  ! ${conflict.path} — ${conflict.detail}`);
              console.error(
                conflict.kind === "user-modified"
                  ? "    recovery: revert the edit, claim the file via .agent-team/config.yaml overrides, or re-run with --force"
                  : "    recovery: move/rename your file aside, then re-run software-team-agents sync",
              );
            }
            return 2;
          }
          throw e;
        }
      }

      case "status": {
        const status = gatherStatus({ targetRoot: targetRootArg, templatesDir: path.join(frameworkRoot, "templates") });
        if (args.json) console.log(JSON.stringify(status, null, 2));
        else console.log(renderStatus(status));
        return 0;
      }

      case "dev": {
        return await runDev({
          targetRoot: targetRootArg,
          templatesDir: path.join(frameworkRoot, "templates"),
          runtime: args.runtime,
          autoSync: args.autoSync,
        });
      }

      case "ba": {
        return await runBa({
          targetRoot: targetRootArg,
          templatesDir: path.join(frameworkRoot, "templates"),
          runtime: args.runtime,
          autoSync: args.autoSync,
        });
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
