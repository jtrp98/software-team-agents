/**
 * The one declaration of how well each runtime is actually supported.
 *
 * README's runtime table used to carry the status in prose (✅ / ⚠️ / 🧪), which
 * meant two sources of truth that could drift: the table could claim a level
 * the adapters no longer justify, and nothing failed when it did. This module
 * is now the machine-readable half; `runtimeSupport.test.ts` reads the shipped
 * README back and fails when the two disagree, and `sta runtimes` renders this
 * record so the CLI answers with the same words.
 *
 * THE LEVELS ARE A CLOSED SET, AND MOVING UP IS EARNED
 *
 *   supported     — headless pipeline + guards verified on a real installation
 *   preview       — launch paths work; known gaps are named and covered
 *   experimental  — spike-proven only; expect guard gaps, expect change
 *   unsupported   — not offered
 *
 * The rule for raising a level is the conformance suite: mandatory cases
 * passing deterministically is what upgrades a claim, not enthusiasm. A level
 * here that outruns the evidence is exactly the "claim support beyond
 * implementation" failure this module exists to prevent.
 */

import { antigravityCoverageWithHooks, codexCoverageWithHooks, opencodeCoverageWithPlugin, zcodeCoverageWithSyncedPayload } from "../targetcli/guardSettings.js";

export type RuntimeSupportLevel = "supported" | "preview" | "experimental" | "unsupported";

export const SUPPORT_LEVELS: readonly RuntimeSupportLevel[] = [
  "supported",
  "preview",
  "experimental",
  "unsupported",
];

/** The ids `--runtime` accepts — kept as data so CLI validation and this table cannot name different sets. */
export const RUNTIME_IDS = ["claude-code", "codex", "opencode", "antigravity", "zcode"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export interface RuntimeSupport {
  level: RuntimeSupportLevel;
  /** Independently certified headless write path; deliberately not inferred from the broader support label. */
  unattendedTargetWrites: boolean;
  /** What the level means for a user of this runtime, in one line. */
  claim: string;
}

// V10 (TASK-004) collapses the workspace lanes, so sessions launch from the Knowledge root and
// Target-path guard coverage becomes the enforcement question for every runtime. Each
// non-certified claim pins "V10 does not change this status" — runtimeSupport.test.ts fails if
// that declaration is dropped, so a lane change cannot quietly read as a certification change.
export const RUNTIME_SUPPORT: Record<RuntimeId, RuntimeSupport> = {
  "claude-code": {
    level: "supported",
    unattendedTargetWrites: true,
    claim:
      "headless pipeline, hooks/guards and exit checks verified end to end; the default runtime for `sta run` and interactive launches, and certified for unattended Target writes — V10's workspace-lane collapse does not move this boundary, because certification follows verified enforcement rather than which workspace a session launches from",
  },
  codex: {
    level: "supported",
    unattendedTargetWrites: true,
    claim:
      `interactive sessions and the headless adapter are verified on real Codex 0.154.0/0.155.1 installs, including sandbox/approval parsing, JSONL, output-schema and cached-token normalisation. ` +
      `Interactive guard coverage (once synced): ${codexCoverageWithHooks().detail}. ` +
      `Headless enforcement is the per-run native permission profile — broad reads, writes only at packet-authorized paths, network disabled, packet-generated execpolicy plus OS deny rules for resolved Git executables — live-verified end to end on a real install (round three, 2026-09-23: outside-workspace write denied, in-workspace write allowed, read-only refused everything, network unreachable at DNS level), and exit checks run fail-closed after process exit through the provider-neutral ExitCheckRunner, which caught a real red typecheck with file and line. ` +
      `This headless path is certified for unattended Target writes and is what \`supported\` scopes; interactive Codex receives no per-run profile, stays unguarded, needs \`--allow-unguarded-runtime\` and is limited to analysis/proposal, and the \`.codex/hooks.json\` payload remains compatibility wiring for that surface that is never claimed as headless enforcement. ` +
      `V10 does not change this status`,
  },
  opencode: {
    level: "experimental",
    unattendedTargetWrites: false,
    claim:
      `spike-proven on 1.18.21 (probe, headless run, guards report); native exit hooks are absent, so the provider-neutral fail-closed ExitCheckRunner verifies requested exit checks after a successful process exit; other versions' tool arg-shapes are unverified. ` +
      `Guard coverage (once synced): ${opencodeCoverageWithPlugin().detail}. Analysis/proposal only; partial guards do not certify unattended Target writes. ` +
      `V10 does not change this status: a session launched from the Knowledge workspace inherits the same partial coverage on Target paths`,
  },
  antigravity: {
    level: "supported",
    unattendedTargetWrites: true,
    claim:
      `interactive sessions and the headless adapter are verified on real agy installs with the machine-global bridge hook (~/.gemini/config/hooks.json). ` +
      `Guard coverage (once synced): ${antigravityCoverageWithHooks().detail}. ` +
      `Headless guarded writes enforce PreToolUse path permissions and the universal floor in-band via the bridge hook. ` +
      `This headless path is certified for unattended Target writes; pipeline and guard integration are verified end to end. Provider-neutral exit checks run after successful headless execution. V10 does not change this status`,
  },
  zcode: {
    level: "experimental",
    unattendedTargetWrites: false,
    claim:
      `There is no CLI and no headless pipeline, so \`sta run --runtime zcode\` refuses as unregistered-for-execution and there is no launch path. ` +
      `Guard wiring ships via \`.zcode/config.json\` and was live-verified end to end on a real ZCode Desktop session (2026-09-23, \`planning/v12/evidence/zcode-uat/\`); unattended Target-write stages stay refused. ` +
      `Per-role Target/Knowledge write bounds apply to a role-play session only when it declares its role through \`software-team-agents session-role\` (\`.workflow/session-role.json\`); ` +
      `an undeclared session keeps the universal floor alone, and read permissions stay instruction-level. ` +
      `Guard coverage (once synced): ${zcodeCoverageWithSyncedPayload().detail}. ` +
      `V10 does not change this status: a desktop-only runtime has no headless surface for the lane collapse to change`,
  },
};

/**
 * A support-level opt-in may enable an analysis/proposal route, but it must
 * never promote Target writes by itself. Certification is an independent,
 * explicit field because a runtime can have a verified headless boundary while
 * its interactive surface remains preview (Codex), or vice versa.
 */
export function isUnattendedTargetWriteCertified(runtimeId: string): boolean {
  return runtimeId in RUNTIME_SUPPORT && RUNTIME_SUPPORT[runtimeId as RuntimeId].unattendedTargetWrites;
}

/** One line per runtime, registry order preserved — the shape both `sta runtimes` and the README table render. */
export function describeRuntimeSupport(): string[] {
  return RUNTIME_IDS.map((id) => `${id}: ${RUNTIME_SUPPORT[id].level} — ${RUNTIME_SUPPORT[id].claim}`);
}
