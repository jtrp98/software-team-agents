import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Neutral process plumbing shared by every adapter that drives an npm-installed
 * CLI (extracted from `claudeCodeAdapter.ts` so no adapter depends on a sibling
 * provider's module — the rule the `SpawnSync` extraction on the port file
 * already established).
 */

/** A way to invoke a CLI whose bare name `spawnSync` cannot execute on this machine. */
export interface ResolvedCommand {
  /** The executable to spawn instead of the bare command name. */
  file: string;
  /** Arguments inserted before the original argument list (e.g. an entry script path). */
  prefixArgs: string[];
}

export type CommandResolver = (command: string) => ResolvedCommand | null;

/**
 * What the npm-installed CLI actually wraps, per known install layout. Some
 * packages ship a platform binary under `bin/`; others a plain node script
 * (`cli.js`) that npm's shim invokes through node.
 */
const KNOWN_NPM_CLI_PACKAGES: Record<string, readonly string[]> = {
  claude: ["node_modules", "@anthropic-ai", "claude-code"],
  // The npm package is `opencode-ai`; its shim wraps bin/opencode.exe (verified
  // against a 1.18.21 Windows install during the T-OC0/T-OC6 spikes).
  opencode: ["node_modules", "opencode-ai"],
};

/** Everything `resolveNpmCliScript` touches, injectable so tests stay deterministic on any platform. */
export interface NpmShimProbe {
  /** Directories to scan, already split — the caller owns the delimiter. Defaults to PATH. */
  dirs?: readonly string[];
  /** Existence check. Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean;
  /** Node executable used to launch JS entries. Defaults to `process.execPath`. */
  execPath?: string;
}

/**
 * Windows default: an npm-installed CLI is a `.cmd`/`.ps1` shim, which
 * `spawnSync` cannot execute — it resolves only real executables, and Node's
 * security hardening refuses `.cmd`/`.bat` outright without a shell. Routing
 * arguments through cmd.exe would subject them to shell parsing (quoting,
 * `%VAR%`, caret escapes), which is what argv-style spawnSync exists to avoid.
 *
 * What the shim wraps is resolvable, though: either a native binary
 * (`bin/<command>.exe`) or a plain node script (`cli.js`), both sitting beside
 * the shim under `node_modules/<pkg>/`. Spawning those directly keeps argv
 * semantics intact with no shell in between. A directory counts only when the
 * shim itself is there — that marker is what separates "the `<cmd>` this user
 * put on PATH" from some unrelated project that happens to have the package as
 * a dependency.
 *
 * Returns null when nothing resolvable is found; the caller then reports
 * UNAVAILABLE exactly as it always did.
 */
export function resolveNpmCliScript(command: string, probe: NpmShimProbe = {}): ResolvedCommand | null {
  const pkgRel = KNOWN_NPM_CLI_PACKAGES[command];
  if (!pkgRel) return null;
  const exists = probe.exists ?? fs.existsSync;
  const dirs = probe.dirs ?? (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const hasShim =
      exists(path.join(dir, `${command}.cmd`)) || exists(path.join(dir, `${command}.ps1`));
    if (!hasShim) continue;
    const pkgDir = path.join(dir, ...pkgRel);
    const nativeBinary = path.join(pkgDir, "bin", `${command}.exe`);
    if (exists(nativeBinary)) return { file: nativeBinary, prefixArgs: [] };
    const jsEntry = path.join(pkgDir, "cli.js");
    if (exists(jsEntry)) return { file: probe.execPath ?? process.execPath, prefixArgs: [jsEntry] };
  }
  return null;
}

/**
 * The `sta` binary is bundled beside targetcli in this package, so interactive
 * lane launchers can point at it without relying on a Windows npm `.cmd` shim.
 */
export function resolveBundledStaCli(
  frameworkRoot: string,
  probe: Pick<NpmShimProbe, "exists" | "execPath"> = {},
): ResolvedCommand | null {
  const exists = probe.exists ?? fs.existsSync;
  const entry = path.join(frameworkRoot, "orchestrator", "dist", "cli.js");
  if (!exists(entry)) return null;
  return { file: probe.execPath ?? process.execPath, prefixArgs: [entry] };
}

function quoteCommandPart(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Shell-display form used only as an environment pointer; launches still use argv arrays. */
export function formatResolvedCommand(command: ResolvedCommand): string {
  return [command.file, ...command.prefixArgs].map(quoteCommandPart).join(" ");
}
