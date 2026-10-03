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
      "headless pipeline and hooks were verified. Owner decision 2026-10-03: headless runs launch `claude` directly, the way a person runs it — the user's own login, no Codex-sandbox wrapper — and the workspace's `.claude/settings.json` hooks enforce the universal floor, git refusal and contract path permissions before every tool call; writes outside the grant are also refused after the run by the provider-neutral write-scope check, and exit checks run fail-closed through the provider-neutral ExitCheckRunner. " +
      "This hook-guarded headless path is certified for unattended Target writes through its pre-tool hooks. The TASK-031 Codex-sandbox wrapper remains available only to a caller that explicitly asks for it (`osIsolation: true`). V10 does not change this status",
  },
  codex: {
    level: "supported",
    unattendedTargetWrites: false,
    claim:
      `interactive sessions and the headless adapter are verified on real Codex 0.154.0/0.155.1/0.160.0 installs, including JSONL, output-schema and cached-token normalisation. ` +
      `Interactive guard coverage (once synced): ${codexCoverageWithHooks().detail}. ` +
      `Owner decision 2026-10-03: headless \`codex exec\` runs without the Windows elevated sandbox or any per-run OS permission profile (\`--dangerously-bypass-approvals-and-sandbox\`), so it reads and writes files normally; git stays refused by the isolated execpolicy, writes outside the grant are refused after the run by the provider-neutral write-scope check, and exit checks run through the provider-neutral ExitCheckRunner. ` +
      `With no pre-tool write guard, unattended Target writes are not certified: Codex serves analysis, review and QA stages and routing skips it for Target-writing stages. ` +
      `V10 does not change this status`,
  },
  opencode: {
    level: "experimental",
    unattendedTargetWrites: false,
    claim:
      `spike-proven on 1.18.21 (probe, headless run, guards report); native exit hooks are absent, so the provider-neutral fail-closed ExitCheckRunner verifies requested exit checks after a successful process exit; other versions' tool arg-shapes are unverified. ` +
      `Guard coverage (once synced): ${opencodeCoverageWithPlugin().detail}. The headless adapter implements the V13 executor lifecycle (fresh-session resume, honest cancel accounting, evidence with changed files and the native session reference). Unattended Target writes are not certified, so Target-write stages stay refused; automatic routing also needs \`routing.allow_below_supported\` for this experimental runtime. ` +
      `V10 does not change this status: a session launched from the Knowledge workspace inherits the same partial coverage on Target paths`,
  },
  antigravity: {
    level: "supported",
    unattendedTargetWrites: false,
    claim:
      `interactive sessions and the headless adapter are verified on real agy installs with the machine-global bridge hook (~/.gemini/config/hooks.json). ` +
      `Guard coverage (once synced and installed): ${antigravityCoverageWithHooks().detail}. ` +
      `Headless guarded writes enforce PreToolUse path permissions and the universal floor in-band via the bridge hook. ` +
      `Owner decision 2026-10-03 retired the TASK-027 a1 OS approval-isolation preflight, so production role dispatch of analysis, review and QA stages is allowed; unattended Target writes are not certified. Provider-neutral exit checks cover completed runs. V10 does not change this status`,
  },
  zcode: {
    level: "experimental",
    unattendedTargetWrites: false,
    claim:
      `The ZCode install bundles its agent CLI (\`resources/glm/zcode.cjs\`, headless \`-p --json\`), which the governed ZcodeAdapter drives through the V13 executor lifecycle (V13 TASK-015): fresh-session resume, honest cancel accounting, evidence with the native session id and run-changed files, and a post-run write check that turns any write outside the grant into ERROR. ` +
      `A guarded run is refused before spawn unless the synced \`.zcode/config.json\` hooks are all persistently trusted (the headless engine skips untrusted project hooks; a person inspects with \`zcode hooks trust review\` and grants with \`zcode hooks trust grant\` — review alone changes nothing); an explicit model or effort is refused (no per-run flag), and a packet too long for the Windows command line is refused, never truncated. ` +
      `Guard wiring ships via \`.zcode/config.json\` and was live-verified end to end on a real ZCode Desktop session (2026-09-23, \`planning/v12/evidence/zcode-uat/\`). Unattended Target-write stages stay refused; automatic routing also needs \`routing.allow_below_supported\` for this experimental runtime. ` +
      `Per-role Target/Knowledge write bounds apply to a direct-mode session only through a STA-issued scoped attempt grant (\`sta grant issue\` writing \`.workflow/attempt-grant.json\` — V13 TASK-012); ` +
      `an ungranted session keeps the universal floor plus the governed-artifact denial, and read permissions stay instruction-level. ` +
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
