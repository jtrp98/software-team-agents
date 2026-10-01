import * as path from "node:path";
import { runtimeRegistryFor, type CliDependencies } from "../composition/runtimeRegistry.js";
import { CliUsageError } from "../../cli.js";
import { createSta, defaultRunStoreDir, type ExecuteRequest, type ExecuteResult } from "../../execute/execute.js";
import type { RuntimeAutonomy } from "../../runtime/runtimeAdapter.js";

/**
 * `sta execute` — the direct execution primitive on the command line.
 *
 *   sta execute --runtime <id> --task <text> [...]      start a run, print its JSON result
 *
 * `--workspace` is where the run executes — the role's definition and guard
 * wiring are read from there. To change code in a Target from a Knowledge
 * workspace, keep the workspace there and add `--role <role> --writable-target
 * <id|path>` (repeatable): the Target becomes a write root the guard checks
 * against that role, and the workspace stays read-only.
 *   sta execute resume <run-id> [--context <text>]     continue a run after approval / partial
 *   sta execute approve <run-id> --request <id> (--yes|--no) --by <name> [--note <text>]
 *   sta execute show <run-id>                          the run tree it belongs to
 *
 * Any caller may use it — a person, a Controller session, or an executor
 * already inside a run (its `STA_RUN_ID` makes the new run its child). The
 * result always comes back to the caller; STA decides nothing further.
 *
 * Exit codes: 0 completed, 1 failed, 3 needs_approval, 4 partial.
 */

const VALUE_FLAGS = new Set([
  "--runtime", "--task", "--workspace", "--role", "--context", "--parent-run", "--write-path", "--autonomy", "--action",
  "--max-depth", "--max-children", "--max-runs", "--timeout-ms", "--model", "--effort", "--run-store", "--project-root",
  "--request", "--by", "--note", "--writable-target",
]);
const BOOLEAN_FLAGS = new Set(["--write", "--no-delegate", "--yes", "--no"]);

interface Parsed {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

function parse(rest: string[]): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), booleans: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined) throw new CliUsageError(`execute: ${arg} needs a value`);
      parsed.values.set(arg, [...(parsed.values.get(arg) ?? []), value]);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      parsed.booleans.add(arg);
    } else if (arg.startsWith("--")) {
      throw new CliUsageError(`execute: unrecognized flag ${arg}`);
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

const one = (p: Parsed, flag: string): string | undefined => p.values.get(flag)?.at(-1);

function int(p: Parsed, flag: string): number | undefined {
  const raw = one(p, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new CliUsageError(`execute: ${flag} must be a non-negative integer`);
  return n;
}

const EXIT: Record<ExecuteResult["status"], number> = { completed: 0, failed: 1, needs_approval: 3, partial: 4 };

export async function runExecuteVerb(rest: string[], defaultProjectRoot: string, dependencies: CliDependencies = {}): Promise<number> {
  const p = parse(rest);
  const workspace = one(p, "--workspace");
  const projectRoot = path.resolve(one(p, "--project-root") ?? workspace ?? defaultProjectRoot);
  const sta = createSta({
    registry: runtimeRegistryFor(projectRoot, dependencies),
    runStore: one(p, "--run-store") ?? defaultRunStoreDir(process.env, projectRoot),
    cwd: defaultProjectRoot,
    staCommand: process.env.STA_EXECUTE_CMD || "sta",
  });
  const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

  const [sub, runId] = p.positionals;
  if (sub === "show") {
    if (!runId) throw new CliUsageError("execute show: a run id is required");
    print(sta.tree(runId));
    return sta.run(runId) ? 0 : 1;
  }
  if (sub === "approve") {
    const requestId = one(p, "--request");
    if (!runId || !requestId) throw new CliUsageError("execute approve: <run-id> and --request <id> are required");
    if (p.booleans.has("--yes") === p.booleans.has("--no")) throw new CliUsageError("execute approve: pass exactly one of --yes or --no");
    const result = sta.approve({ runId, requestId, approved: p.booleans.has("--yes"), by: one(p, "--by") ?? "", note: one(p, "--note") });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (sub === "resume") {
    if (!runId) throw new CliUsageError("execute resume: a run id is required");
    const result = await sta.resume(runId, { parentRunId: one(p, "--parent-run"), context: one(p, "--context") });
    print(result);
    return EXIT[result.status];
  }
  if (sub !== undefined) throw new CliUsageError(`execute: unknown subcommand ${sub}`);

  const runtime = one(p, "--runtime");
  const task = one(p, "--task");
  if (!runtime || !task) throw new CliUsageError("execute: --runtime <id> and --task <text> are required");
  const write = p.booleans.has("--write") ? true : undefined;
  const writePaths = p.values.get("--write-path");
  const request: ExecuteRequest = {
    runtime,
    task,
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    ...(one(p, "--role") ? { role: one(p, "--role") } : {}),
    ...(p.values.get("--writable-target") ? { writableTargets: p.values.get("--writable-target") } : {}),
    ...(one(p, "--context") ? { context: one(p, "--context") } : {}),
    ...(one(p, "--parent-run") ? { parentRunId: one(p, "--parent-run") } : {}),
    permissions: {
      ...(write || writePaths ? { write: true } : {}),
      ...(writePaths ? { writePaths } : {}),
      ...(p.booleans.has("--no-delegate") ? { delegate: false } : {}),
      ...(one(p, "--autonomy") ? { autonomy: one(p, "--autonomy") as RuntimeAutonomy } : {}),
    },
    limits: {
      ...(int(p, "--max-depth") !== undefined ? { maxDepth: int(p, "--max-depth") } : {}),
      ...(int(p, "--max-children") !== undefined ? { maxChildren: int(p, "--max-children") } : {}),
      ...(int(p, "--max-runs") !== undefined ? { maxTotalRuns: int(p, "--max-runs") } : {}),
      ...(int(p, "--timeout-ms") !== undefined ? { timeoutMs: int(p, "--timeout-ms") } : {}),
    },
    ...(p.values.get("--action") ? { actions: p.values.get("--action") } : {}),
    ...(one(p, "--model") ? { model: one(p, "--model") } : {}),
    ...(one(p, "--effort") ? { effort: one(p, "--effort") } : {}),
  };
  const result = await sta.execute(request);
  print(result);
  return EXIT[result.status];
}
