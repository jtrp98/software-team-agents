import { TaskRegistry } from "../../orchestrator/taskRegistry.js";
import { formatRunRouting } from "../../observability/runLog.js";
import type { TaskStatusKind } from "../../orchestrator/taskStatus.js";

/** Status glyphs: ✅ 🔄 ⏳ — extended with the two states only pause/cancel can produce. */
export const STATUS_EMOJI: Record<TaskStatusKind, string> = {
  DEPLOYED: "✅",
  RUNNING: "🔄",
  WAITING_FOR_HUMAN: "⏳",
  WAITING_FOR_DEPENDENCY: "⏳",
  BLOCKED: "⛔",
  PAUSED: "⏸️",
  CANCELLED: "🚫",
};

export function printListing(registry: TaskRegistry): void {
  const listing = registry.list();
  if (listing.length === 0) {
    console.log("[orchestrator] no tasks in this store yet.");
    return;
  }

  // Which batch each task falls into, so the listing shows what could run
  // together rather than leaving it to be worked out from depends_on by hand.
  const layerOf = new Map<string, number>();
  try {
    registry.readyLayers().forEach((layer, i) => layer.forEach((t) => layerOf.set(t.taskId, i + 1)));
  } catch {
    // A store too broken to graph is still worth listing — the rows below are
    // what would tell someone why.
  }

  for (const { task, status } of listing) {
    const agent = status.currentAgent ? ` agent=${status.currentAgent}` : "";
    const waiting = status.waitingOn?.length ? ` waiting_on=${status.waitingOn.join(",")}` : "";
    const reason = status.reason ? ` — ${status.reason}` : "";
    const layer = layerOf.has(task.taskId) ? ` batch=${layerOf.get(task.taskId)}` : "";
    const emoji = STATUS_EMOJI[status.kind] ?? " ";
    const latestRun = registry.runsForTask(task.taskId).at(-1);
    const route = latestRun ? ` ${formatRunRouting(latestRun)}` : "";
    console.log(
      `  ${emoji} ${task.taskId.padEnd(12)} ${status.kind.padEnd(22)} ${status.state.padEnd(16)}${agent}${layer}${waiting}${route}${reason}`,
    );
  }

  const stats = layerOf.size > 0 ? registry.parallelism() : null;
  if (stats && stats.widest > 1) {
    console.log(
      `[orchestrator] ${stats.tasks} tasks in ${stats.layers} batch(es); up to ${stats.widest} could run at once ` +
        "(the orchestrator still runs one task at a time; the lock only makes that safe against " +
        "two processes racing on the same task, it doesn't make batches run concurrently).",
    );
  }
}

/**
 * The "real-time" half of the dashboard — polls the store and re-renders `printListing`'s
 * table. There is no server/UI layer in this project (CLAUDE.md's stack is Next.js for the
 * *product* this pipeline builds, not for the pipeline's own tooling), so "real-time" here means
 * a terminal view that refreshes itself, the same shape every other CLI in this space (docker
 * stats, kubectl get pods --watch) uses for the same job.
 *
 * `iterations`/`sleep`/`clear` are injectable so this is actually testable — the default `sleep`
 * really waits and `clear` really clears the screen, but a test can run a handful of iterations
 * instantly and assert on what got rendered, rather than needing to kill a runaway process.
 */
export async function watchListing(
  registry: TaskRegistry,
  opts: { intervalMs: number; iterations: number; sleep?: (ms: number) => Promise<void>; clear?: () => void },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clear = opts.clear ?? (() => console.clear());
  for (let i = 0; i < opts.iterations; i++) {
    clear();
    console.log(`[orchestrator] watching — refreshes every ${Math.round(opts.intervalMs / 1000)}s, Ctrl+C to stop`);
    printListing(registry);
    if (i < opts.iterations - 1) await sleep(opts.intervalMs);
  }
}
