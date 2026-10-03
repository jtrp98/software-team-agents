import { isUnattendedTargetWriteAllowed } from "../runtime/runtimeSupport.js";
import type { RuntimeProbe } from "../runtime/runtimeAdapter.js";
import type { MachineConfig, PoolRuntimeId, RouteRole } from "./machineConfig.js";
import type { RuntimeHealthView } from "./runtimeHealth.js";

/**
 * STA Core's runtime router — deterministic, pure, and the same for every
 * role. "Commander" is a role here exactly like "engineer": nothing names a
 * provider, and every order comes from `machine.yaml`.
 *
 * A candidate is used only if it is, in this order:
 *   1. security-eligible for the role (never relaxed by a fallback),
 *   2. installed/probed available,
 *   3. not cooling down in runtime health,
 *   4. not excluded for this decision (already tried and refused).
 * Every refusal is recorded with its reason, so a fallback chain explains
 * itself. `fallback: false` (exclusive) considers the first entry only.
 */

export interface SecurityEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * What a role needs from a runtime's security boundary, from the declared
 * support record — the same fact the dispatch gate enforces later: the
 * engineer needs an admitted Target-write path. Codex, Antigravity and ZCode use
 * post-run scope verification; other runtimes still require pre-tool
 * certification. Analysis, review and QA roles need no certification (owner
 * decision 2026-10-03 retired the OS approval-isolation requirement along with
 * the Codex sandbox). ZCode stays experimental: the bounded-run freeze still
 * demands `routing.allow_below_supported` before it will auto-route there.
 */
export function securityEligibility(runtimeId: string, role: RouteRole): SecurityEligibility {
  if (role === "engineer" && !isUnattendedTargetWriteAllowed(runtimeId)) {
    return { eligible: false, reason: `SECURITY: runtime "${runtimeId}" is not certified for unattended Target writes; skipped for engineer` };
  }
  return { eligible: true };
}

export interface RouteAttempt {
  runtimeId: string;
  outcome: "selected" | "skipped";
  reason: string;
}

export interface RouteDecision {
  role: RouteRole;
  selected?: PoolRuntimeId;
  attempts: RouteAttempt[];
  /** No candidate is usable now. */
  exhausted: boolean;
  /** Exhausted only by cooldowns/availability (not security): the run should pause and come back, not fail. */
  recoverable: boolean;
  /** Earliest cooldown end among skipped candidates, for auto-resume. */
  recoverAt: number | null;
}

export interface RouteInputs {
  config: MachineConfig;
  health: Readonly<Record<string, RuntimeHealthView>>;
  probes?: Readonly<Record<string, RuntimeProbe | undefined>>;
  /** Extra availability facts the Core knows (e.g. not installed, login required). */
  extraUnavailable?: Readonly<Record<string, string | undefined>>;
  exclude?: ReadonlySet<string>;
  /**
   * The security facts. Production always uses `securityEligibility` (the
   * declared support record); a test may substitute a world where more
   * boundaries are verified, to exercise the provider-neutral walk.
   */
  eligibility?: (runtimeId: string, role: RouteRole) => SecurityEligibility;
}

export function routeFor(config: MachineConfig, role: RouteRole): { order: PoolRuntimeId[]; fallback: boolean } {
  if (role === "commander") return { order: [...config.commander.order], fallback: config.commander.fallback };
  const route = config.roles[role];
  return { order: [...route.order], fallback: route.fallback };
}

export function selectRuntime(role: RouteRole, inputs: RouteInputs): RouteDecision {
  const { order, fallback } = routeFor(inputs.config, role);
  const candidates = fallback ? order : order.slice(0, 1);
  const attempts: RouteAttempt[] = [];
  let securityOnly = true;
  let recoverAt: number | null = null;
  for (const runtimeId of candidates) {
    const security = (inputs.eligibility ?? securityEligibility)(runtimeId, role);
    if (!security.eligible) {
      attempts.push({ runtimeId, outcome: "skipped", reason: security.reason! });
      continue;
    }
    securityOnly = false;
    if (inputs.exclude?.has(runtimeId)) {
      attempts.push({ runtimeId, outcome: "skipped", reason: "already tried for this decision and refused to serve" });
      continue;
    }
    const probe = inputs.probes?.[runtimeId];
    if (probe && !probe.available) {
      attempts.push({ runtimeId, outcome: "skipped", reason: `NOT_AVAILABLE: ${probe.reason ?? "probe reported no reason"}` });
      continue;
    }
    const extra = inputs.extraUnavailable?.[runtimeId];
    if (extra) {
      attempts.push({ runtimeId, outcome: "skipped", reason: extra });
      continue;
    }
    const health = inputs.health[runtimeId];
    if (health && !health.usable) {
      attempts.push({ runtimeId, outcome: "skipped", reason: health.skipReason ?? `${health.status}` });
      if (health.cooldownUntil !== null && (recoverAt === null || health.cooldownUntil < recoverAt)) recoverAt = health.cooldownUntil;
      continue;
    }
    attempts.push({ runtimeId, outcome: "selected", reason: attempts.length === 0 ? `first in ${role} order` : `fallback after ${attempts.length} skipped` });
    return { role, selected: runtimeId, attempts, exhausted: false, recoverable: true, recoverAt: null };
  }
  return { role, attempts, exhausted: true, recoverable: !securityOnly, recoverAt };
}

/**
 * The ordered list handed to a bounded-run child for one role: the configured
 * order (first entry only when exclusive). The child re-applies health and every
 * dispatch gate itself, so this is preference, never authority.
 */
export function overlayOrderFor(config: MachineConfig, role: Exclude<RouteRole, "commander">): PoolRuntimeId[] {
  const { order, fallback } = routeFor(config, role);
  return fallback ? order : order.slice(0, 1);
}
