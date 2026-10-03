import type SqliteDatabase from "../store/sqliteDatabase.js";
import { isRuntimeHealthClass, type RuntimeFailureClass } from "../runtime/runtimeFailureClass.js";
import type { MachineConfig } from "./machineConfig.js";

/**
 * Runtime health — the reason one quota hit does not cost every later stage
 * the same failed attempt.
 *
 * A provider-family failure (quota, rate limit, outage, auth, repeated
 * timeout) puts the runtime in a cooldown. Until it lapses, routing treats the
 * runtime as unavailable *before* dispatch, so the next stage starts on the
 * next runtime instead of re-discovering the quota (Engineer → quota → Review →
 * quota → QA → quota). A work failure (tests, lint, a bug) is never health:
 * it says nothing about the provider, and recording it would push work away
 * from a perfectly healthy runtime.
 *
 * Cooldowns, not permanent marks: a quota window ends, and a paused run
 * resumes when it does. TIMEOUT is bounded — the first `timeout_retry_limit - 1`
 * consecutive timeouts leave the runtime usable (the engine's own retry runs
 * it again); reaching the limit cools it down so the retry lands elsewhere.
 * No path here retries anything by itself, so nothing can loop forever.
 */

export type RuntimeHealthStatus = "healthy" | "quota_exhausted" | "rate_limited" | "unavailable" | "auth_required" | "timeout" | "degraded";

export interface RuntimeHealthRecord {
  runtimeId: string;
  status: RuntimeHealthStatus;
  failureClass: RuntimeFailureClass | null;
  reason: string | null;
  cooldownUntil: number | null;
  consecutiveTimeouts: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  updatedAt: number;
}

export interface RuntimeHealthView extends RuntimeHealthRecord {
  /** False while a cooldown is running. */
  usable: boolean;
  /** Present when usable is false: the reason routing reports for skipping it. */
  skipReason?: string;
}

export interface RecordFailureInput {
  runtimeId: string;
  failureClass: RuntimeFailureClass;
  reason: string;
  now?: number;
  /** Provider-reported reset time (epoch ms); wins over the configured cooldown when later than now. */
  retryAt?: number;
  runId?: string;
  role?: string;
}

const STATUS_BY_CLASS: Partial<Record<RuntimeFailureClass, RuntimeHealthStatus>> = {
  QUOTA_EXHAUSTED: "quota_exhausted",
  RATE_LIMITED: "rate_limited",
  PROVIDER_UNAVAILABLE: "unavailable",
  TEMPORARY_AUTH_FAILURE: "auth_required",
  TIMEOUT: "timeout",
};

export type HealthPolicy = MachineConfig["health"];

const MINUTE = 60_000;

function cooldownMinutes(policy: HealthPolicy, failureClass: RuntimeFailureClass): number {
  switch (failureClass) {
    case "QUOTA_EXHAUSTED": return policy.quota_cooldown_minutes;
    case "RATE_LIMITED": return policy.rate_limit_cooldown_minutes;
    case "TEMPORARY_AUTH_FAILURE": return policy.auth_cooldown_minutes;
    case "TIMEOUT": return policy.timeout_cooldown_minutes;
    default: return policy.unavailable_cooldown_minutes;
  }
}

interface Row {
  runtime_id: string;
  status: string;
  failure_class: string | null;
  reason: string | null;
  cooldown_until: number | null;
  consecutive_timeouts: number;
  last_error: string | null;
  last_success_at: number | null;
  updated_at: number;
}

function fromRow(row: Row): RuntimeHealthRecord {
  return {
    runtimeId: row.runtime_id,
    status: row.status as RuntimeHealthStatus,
    failureClass: (row.failure_class as RuntimeFailureClass | null) ?? null,
    reason: row.reason,
    cooldownUntil: row.cooldown_until,
    consecutiveTimeouts: row.consecutive_timeouts,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at,
  };
}

export class RuntimeHealthStore {
  constructor(private readonly db: SqliteDatabase, private readonly policy: HealthPolicy, private readonly clock: () => number = Date.now) {}

  get(runtimeId: string): RuntimeHealthRecord | null {
    const row = this.db.prepare("SELECT * FROM runtime_health WHERE runtime_id = ?").get(runtimeId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  view(runtimeId: string, now = this.clock()): RuntimeHealthView {
    const record = this.get(runtimeId) ?? {
      runtimeId, status: "healthy" as const, failureClass: null, reason: null, cooldownUntil: null,
      consecutiveTimeouts: 0, lastError: null, lastSuccessAt: null, updatedAt: 0,
    };
    const cooling = record.cooldownUntil !== null && record.cooldownUntil > now;
    return cooling
      ? { ...record, usable: false, skipReason: `${record.failureClass ?? record.status}: cooling down until ${new Date(record.cooldownUntil!).toISOString()} (${record.reason ?? "no reason recorded"})` }
      : { ...record, usable: true };
  }

  snapshot(runtimeIds: readonly string[], now = this.clock()): Record<string, RuntimeHealthView> {
    return Object.fromEntries(runtimeIds.map((id) => [id, this.view(id, now)]));
  }

  isUsable(runtimeId: string, now = this.clock()): boolean {
    return this.view(runtimeId, now).usable;
  }

  /** Records one runtime-attributed failure. Work-family classes are logged as events only and never change health. */
  recordFailure(input: RecordFailureInput): RuntimeHealthView {
    const now = input.now ?? this.clock();
    this.event(input.runtimeId, "failure", now, { runId: input.runId, role: input.role, failureClass: input.failureClass, detail: input.reason });
    if (!isRuntimeHealthClass(input.failureClass)) return this.view(input.runtimeId, now);
    const current = this.get(input.runtimeId);
    let consecutiveTimeouts = input.failureClass === "TIMEOUT" ? (current?.consecutiveTimeouts ?? 0) + 1 : 0;
    let status = STATUS_BY_CLASS[input.failureClass] ?? "unavailable";
    let cooldownUntil: number | null = now + cooldownMinutes(this.policy, input.failureClass) * MINUTE;
    if (input.retryAt !== undefined && input.retryAt > now) cooldownUntil = input.retryAt;
    if (input.failureClass === "TIMEOUT" && consecutiveTimeouts < this.policy.timeout_retry_limit) {
      // Bounded retry: still usable, the engine's own retry may run it again.
      status = "degraded";
      cooldownUntil = null;
    }
    if (input.failureClass === "TIMEOUT" && consecutiveTimeouts >= this.policy.timeout_retry_limit) {
      // The limit is spent: cool down, and start the count afresh after it.
      consecutiveTimeouts = 0;
    }
    this.db.prepare(`
      INSERT INTO runtime_health (runtime_id, status, failure_class, reason, cooldown_until, consecutive_timeouts, last_error, last_success_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET status = excluded.status, failure_class = excluded.failure_class, reason = excluded.reason,
        cooldown_until = excluded.cooldown_until, consecutive_timeouts = excluded.consecutive_timeouts, last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(input.runtimeId, status, input.failureClass, input.reason.slice(0, 2000), cooldownUntil, consecutiveTimeouts, input.reason.slice(0, 2000), current?.lastSuccessAt ?? null, now);
    return this.view(input.runtimeId, now);
  }

  recordSuccess(runtimeId: string, context: { runId?: string; role?: string; now?: number } = {}): void {
    const now = context.now ?? this.clock();
    this.event(runtimeId, "success", now, { runId: context.runId, role: context.role });
    const current = this.get(runtimeId);
    this.db.prepare(`
      INSERT INTO runtime_health (runtime_id, status, failure_class, reason, cooldown_until, consecutive_timeouts, last_error, last_success_at, updated_at)
      VALUES (?, 'healthy', NULL, NULL, NULL, 0, ?, ?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET status = 'healthy', failure_class = NULL, reason = NULL, cooldown_until = NULL,
        consecutive_timeouts = 0, last_success_at = excluded.last_success_at, updated_at = excluded.updated_at
    `).run(runtimeId, current?.lastError ?? null, now, now);
  }

  /** A person's explicit "it is fixed" (Connect/Test succeeded): ends any cooldown. */
  clear(runtimeId: string, now = this.clock()): void {
    this.event(runtimeId, "cleared", now, {});
    this.db.prepare("UPDATE runtime_health SET status = 'healthy', cooldown_until = NULL, consecutive_timeouts = 0, updated_at = ? WHERE runtime_id = ?").run(now, runtimeId);
  }

  /** The earliest moment any of these runtimes leaves its cooldown, or null when none is cooling. */
  earliestRecovery(runtimeIds: readonly string[], now = this.clock()): number | null {
    let earliest: number | null = null;
    for (const id of runtimeIds) {
      const view = this.view(id, now);
      if (!view.usable && view.cooldownUntil !== null && (earliest === null || view.cooldownUntil < earliest)) earliest = view.cooldownUntil;
    }
    return earliest;
  }

  event(runtimeId: string, kind: string, at: number, data: { runId?: string; role?: string; failureClass?: string; detail?: string }): void {
    this.db.prepare("INSERT INTO runtime_events (at, runtime_id, run_id, role, kind, failure_class, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(at, runtimeId, data.runId ?? null, data.role ?? null, kind, data.failureClass ?? null, data.detail?.slice(0, 2000) ?? null);
  }

  eventsForRun(runId: string): Array<{ at: number; runtimeId: string; role: string | null; kind: string; failureClass: string | null; detail: string | null }> {
    const rows = this.db.prepare("SELECT at, runtime_id, role, kind, failure_class, detail FROM runtime_events WHERE run_id = ? ORDER BY id").all(runId) as Array<{
      at: number; runtime_id: string; role: string | null; kind: string; failure_class: string | null; detail: string | null;
    }>;
    return rows.map((row) => ({ at: row.at, runtimeId: row.runtime_id, role: row.role, kind: row.kind, failureClass: row.failure_class, detail: row.detail }));
  }
}
