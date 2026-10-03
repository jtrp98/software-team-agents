import * as fs from "node:fs";
import { z } from "zod";
import { AgentStage } from "../types.js";
import { openCoreDb } from "../core/coreDb.js";
import { RuntimeHealthStore } from "../core/runtimeHealth.js";
import { classifyRuntimeResult } from "./runtimeFailureClass.js";
import type { RuntimeAgentResult, RuntimeProbe } from "./runtimeAdapter.js";

/**
 * The STA Core route overlay — how a `bounded-run` child the Core launched
 * learns the user's per-role runtime order and shares runtime health.
 *
 * Activated only by an explicit `--core-run <overlay.json>` flag (never by an
 * environment variable, never implicitly). What it can change is deliberately
 * narrow:
 *   - the level-4 candidate ORDER for engineer/reviewer/qa stages (an explicit
 *     `--runtime` flag or a per-role `routing.by_role` still outranks it);
 *   - availability: a runtime cooling down in shared health reads as
 *     unavailable, so routing skips it before dispatch;
 *   - it records each dispatch's outcome into shared health.
 * It cannot add a runtime, relax a certification, capability, approval
 * isolation or write-scope gate — those all run after it, unchanged — and it
 * pins the Knowledge root the run must be using (`assertPinnedKnowledge`).
 */

const OverlaySchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  knowledge: z.object({ name: z.string().min(1), path: z.string().min(1) }),
  module: z.string().min(1),
  role_orders: z.object({
    engineer: z.array(z.string().min(1)).min(1),
    reviewer: z.array(z.string().min(1)).min(1),
    qa: z.array(z.string().min(1)).min(1),
  }),
  /** Runtimes the Core already knows cannot run unattended now (not installed, login required), with why. */
  unavailable: z.record(z.string(), z.string()).default({}),
  /** Segment number, so the child's exit record answers to exactly one launch. */
  segment: z.number().int().positive().default(1),
  health_db: z.string().min(1),
  health_policy: z.object({
    quota_cooldown_minutes: z.number().positive(),
    rate_limit_cooldown_minutes: z.number().positive(),
    unavailable_cooldown_minutes: z.number().positive(),
    auth_cooldown_minutes: z.number().positive(),
    timeout_retry_limit: z.number().int().min(1),
    timeout_cooldown_minutes: z.number().positive(),
  }),
});
export type CoreRouteOverlay = z.infer<typeof OverlaySchema>;

export class CoreRouteOverlayError extends Error {}

interface ActiveOverlay {
  overlay: CoreRouteOverlay;
  health: RuntimeHealthStore;
  close: () => void;
}

let active: ActiveOverlay | null = null;

export function parseCoreRouteOverlay(raw: unknown): CoreRouteOverlay {
  const parsed = OverlaySchema.safeParse(raw);
  if (!parsed.success) throw new CoreRouteOverlayError(`core route overlay is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function activateCoreRouteOverlay(file: string): CoreRouteOverlay {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CoreRouteOverlayError(`cannot read core route overlay ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const overlay = parseCoreRouteOverlay(raw);
  deactivateCoreRouteOverlay();
  const db = openCoreDb(overlay.health_db);
  active = { overlay, health: new RuntimeHealthStore(db, overlay.health_policy), close: () => db.close() };
  return overlay;
}

/** Test seam: install an overlay with an already-open health store. */
export function installCoreRouteOverlayForTest(overlay: CoreRouteOverlay, health: RuntimeHealthStore): void {
  deactivateCoreRouteOverlay();
  active = { overlay, health, close: () => {} };
}

export function deactivateCoreRouteOverlay(): void {
  active?.close();
  active = null;
}

export function activeCoreRouteOverlay(): CoreRouteOverlay | null {
  return active?.overlay ?? null;
}

/** Which Core route a pipeline stage follows; null = the stage keeps normal routing. */
export function coreRouteRoleFor(stage: AgentStage): "engineer" | "reviewer" | "qa" | null {
  switch (stage) {
    case AgentStage.BACKEND_ENGINEER:
    case AgentStage.FRONTEND_ENGINEER:
      return "engineer";
    case AgentStage.REVIEWER:
    case AgentStage.SECURITY:
      return "reviewer";
    case AgentStage.QA_ENGINEER:
      return "qa";
    default:
      return null;
  }
}

export function coreOverlayOrderFor(stage: AgentStage): string[] | undefined {
  if (!active) return undefined;
  const role = coreRouteRoleFor(stage);
  return role ? [...active.overlay.role_orders[role]] : undefined;
}

/** Folds shared runtime health into a probe map: a cooling runtime reads as unavailable with its reason. */
export function applyCoreRuntimeHealth(
  availability: Readonly<Record<string, RuntimeProbe>> | undefined,
): Readonly<Record<string, RuntimeProbe>> | undefined {
  if (!active) return availability;
  const merged: Record<string, RuntimeProbe> = { ...(availability ?? {}) };
  for (const runtimeId of new Set([...Object.keys(merged), ...Object.values(active.overlay.role_orders).flat()])) {
    const known = active.overlay.unavailable[runtimeId];
    if (known) {
      merged[runtimeId] = { ...(merged[runtimeId] ?? {}), available: false, reason: `STA Core — ${known}` };
      continue;
    }
    const view = active.health.view(runtimeId);
    if (!view.usable) merged[runtimeId] = { ...(merged[runtimeId] ?? {}), available: false, reason: `STA Core runtime health — ${view.skipReason}` };
  }
  return merged;
}

/** Records one dispatch's outcome into shared health. Never throws: health is advisory to the engine. */
export function reportCoreRuntimeOutcome(runtimeId: string, role: string, result: Pick<RuntimeAgentResult, "status" | "failureClass" | "retryAt" | "diagnostics">): void {
  if (!active) return;
  try {
    const runId = active.overlay.run_id;
    if (result.status === "OK") {
      active.health.recordSuccess(runtimeId, { runId, role });
      return;
    }
    const failureClass = classifyRuntimeResult(result);
    if (!failureClass) return;
    active.health.recordFailure({
      runtimeId,
      failureClass,
      reason: result.diagnostics.join("; ").slice(0, 1000) || result.status,
      ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}),
      runId,
      role,
    });
  } catch {
    // health is a routing hint; an unwritable health store never fails a stage
  }
}

/**
 * Knowledge isolation at the child boundary: the Knowledge root this process
 * resolved must be the one the Core pinned at run creation — same name, same
 * canonical path. A mismatch refuses the run rather than letting a fallback,
 * a changed default or a repointed registration move it to other Knowledge.
 */
export function assertPinnedKnowledge(resolvedPath: string, resolvedName: string | undefined): void {
  if (!active) return;
  const pinned = active.overlay.knowledge;
  const canon = (p: string): string => {
    let real = p;
    try { real = fs.realpathSync.native(p); } catch { /* compared as written */ }
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  if (canon(resolvedPath) !== canon(pinned.path) || (resolvedName !== undefined && resolvedName !== pinned.name)) {
    throw new CoreRouteOverlayError(
      `Knowledge isolation: run ${active.overlay.run_id} is pinned to Knowledge "${pinned.name}" (${pinned.path}) but this process resolved "${resolvedName ?? "?"}" (${resolvedPath}) — refusing rather than mixing Knowledge contexts`,
    );
  }
}
