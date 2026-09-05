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

import { codexCoverage, opencodeCoverageWithPlugin } from "../targetcli/guardSettings.js";

export type RuntimeSupportLevel = "supported" | "preview" | "experimental" | "unsupported";

export const SUPPORT_LEVELS: readonly RuntimeSupportLevel[] = [
  "supported",
  "preview",
  "experimental",
  "unsupported",
];

/** The ids `--runtime` accepts — kept as data so CLI validation and this table cannot name different sets. */
export const RUNTIME_IDS = ["claude-code", "codex", "opencode"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export interface RuntimeSupport {
  level: RuntimeSupportLevel;
  /** What the level means for a user of this runtime, in one line. */
  claim: string;
}

export const RUNTIME_SUPPORT: Record<RuntimeId, RuntimeSupport> = {
  "claude-code": {
    level: "supported",
    claim:
      "headless pipeline, hooks/guards and exit checks verified end to end; the default runtime for `sta run` and interactive launches",
  },
  codex: {
    level: "preview",
    claim:
      `interactive sessions via \`--runtime codex\` work and bindings generate completely; the headless adapter has never been verified against a real install — UAT covers Claude Code only. ` +
      `Guard coverage: ${codexCoverage().detail} — a launch requires --allow-unguarded-runtime (T-V5-008)`,
  },
  opencode: {
    level: "experimental",
    claim:
      `spike-proven on 1.18.21 (probe, headless run, guards report); exit checks have no in-band enforcement (\`GUARD GAP\` + QA round cover it) and other versions' tool arg-shapes are unverified. ` +
      `Guard coverage (once synced): ${opencodeCoverageWithPlugin().detail}`,
  },
};

/** One line per runtime, registry order preserved — the shape both `sta runtimes` and the README table render. */
export function describeRuntimeSupport(): string[] {
  return RUNTIME_IDS.map((id) => `${id}: ${RUNTIME_SUPPORT[id].level} — ${RUNTIME_SUPPORT[id].claim}`);
}
