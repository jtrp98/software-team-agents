import type { RuntimeAgentResult } from "./runtimeAdapter.js";

/**
 * The normalized runtime failure taxonomy (STA Core).
 *
 * `RuntimeRunStatus` answers "did the runtime run?" in four words; this answers
 * "why not, and what should STA do about it?" in a closed vocabulary every
 * caller above the adapters shares. Each adapter translates its own
 * vendor-specific envelope into one of these classes (`failureClass` on its
 * result); routing, health and the Core read only the class — none of them
 * parses a provider message again.
 *
 * Two families, kept apart on purpose:
 *
 *   runtime/provider failures — the runtime could not do the work at all.
 *   Switching to another runtime is the right answer (subject to policy):
 *     QUOTA_EXHAUSTED · RATE_LIMITED · PROVIDER_UNAVAILABLE ·
 *     TEMPORARY_AUTH_FAILURE · TIMEOUT (bounded retry first)
 *
 *   work failures — the runtime ran and the work is what failed. Switching
 *   provider would only launder the verdict, so these never move a stage:
 *     EXECUTION_ERROR · TASK_FAILURE · SECURITY_FAILURE · HARD_HUMAN_GATE
 *
 * An adapter only ever *refines* an `UNAVAILABLE` result into one of the
 * provider classes. It never promotes an `ERROR` to a provider class from
 * prose: an invented pattern would hand a real task failure a free retry on
 * another provider, which is exactly the misclassification each adapter's
 * closed refusal set exists to prevent.
 */
export const RUNTIME_FAILURE_CLASSES = [
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TEMPORARY_AUTH_FAILURE",
  "TIMEOUT",
  "EXECUTION_ERROR",
  "TASK_FAILURE",
  "SECURITY_FAILURE",
  "HARD_HUMAN_GATE",
] as const;
export type RuntimeFailureClass = (typeof RUNTIME_FAILURE_CLASSES)[number];

/** Classes where another runtime may take the work over immediately. */
const FALLBACK_CLASSES: ReadonlySet<RuntimeFailureClass> = new Set([
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TEMPORARY_AUTH_FAILURE",
]);

/** True when a failure of this class moves work to the next runtime rather than failing it. */
export function isFallbackClass(failureClass: RuntimeFailureClass): boolean {
  return FALLBACK_CLASSES.has(failureClass);
}

/** True for the provider family (including TIMEOUT, which retries first and falls back after). */
export function isRuntimeHealthClass(failureClass: RuntimeFailureClass): boolean {
  return FALLBACK_CLASSES.has(failureClass) || failureClass === "TIMEOUT";
}

export function isRuntimeFailureClass(value: unknown): value is RuntimeFailureClass {
  return typeof value === "string" && (RUNTIME_FAILURE_CLASSES as readonly string[]).includes(value);
}

/**
 * The one place a result becomes a class. An adapter-supplied class wins; an
 * unrefined result maps by status only. `OK` is not a failure (null).
 */
export function classifyRuntimeResult(result: Pick<RuntimeAgentResult, "status" | "failureClass">): RuntimeFailureClass | null {
  if (result.status === "OK") return null;
  if (result.failureClass) return result.failureClass;
  switch (result.status) {
    case "UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "TIMEOUT":
      return "TIMEOUT";
    default:
      return "EXECUTION_ERROR";
  }
}

/**
 * Shared refinement for an HTTP status a provider refused with. Only ever
 * applied to a result the adapter already classified `UNAVAILABLE` from its
 * own structured envelope fields.
 *
 * 429 is split by the provider's own words: a usage/quota/credit/billing
 * message is a quota that will not clear in seconds; anything else is a rate
 * limit that will.
 */
export function classifyProviderRefusal(httpStatus: number | undefined, message: string): RuntimeFailureClass {
  if (QUOTA_MESSAGE.test(message)) return "QUOTA_EXHAUSTED";
  if (httpStatus === 429) return "RATE_LIMITED";
  if (httpStatus === 401 || httpStatus === 403) return "TEMPORARY_AUTH_FAILURE";
  if (AUTH_MESSAGE.test(message)) return "TEMPORARY_AUTH_FAILURE";
  if (RATE_MESSAGE.test(message)) return "RATE_LIMITED";
  return "PROVIDER_UNAVAILABLE";
}

/** Provider wording for an exhausted plan/credit allowance. */
export const QUOTA_MESSAGE = /usage limit|quota|insufficient[_ ]quota|credit balance|billing|out of credits|limit reached|plan limit/i;
const RATE_MESSAGE = /rate.?limit|too many requests|\b429\b/i;
const AUTH_MESSAGE = /unauthori[sz]ed|not logged in|log ?in required|authentication|invalid api key|incorrect api key|expired token|\b40[13]\b/i;
