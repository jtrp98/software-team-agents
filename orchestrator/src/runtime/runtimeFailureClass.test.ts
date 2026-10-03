import { describe, expect, it } from "vitest";
import { classifyProviderRefusal, classifyRuntimeResult, isFallbackClass, isRuntimeHealthClass, RUNTIME_FAILURE_CLASSES } from "./runtimeFailureClass.js";
import { classifyClaudeRefusal } from "./claudeCodeAdapter.js";
import { classifyCodexRefusal } from "./codexAdapter.js";

describe("STA Core runtime failure taxonomy", () => {
  it("keeps the provider and work families semantically distinct", () => {
    for (const cls of ["QUOTA_EXHAUSTED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TEMPORARY_AUTH_FAILURE"] as const) expect(isFallbackClass(cls)).toBe(true);
    // TIMEOUT retries first (bounded) — it is health, not an immediate hop.
    expect(isFallbackClass("TIMEOUT")).toBe(false);
    expect(isRuntimeHealthClass("TIMEOUT")).toBe(true);
    // Work failures never move work to another provider.
    for (const cls of ["EXECUTION_ERROR", "TASK_FAILURE", "SECURITY_FAILURE", "HARD_HUMAN_GATE"] as const) {
      expect(isFallbackClass(cls)).toBe(false);
      expect(isRuntimeHealthClass(cls)).toBe(false);
    }
    expect(RUNTIME_FAILURE_CLASSES).toHaveLength(9);
  });

  it("maps an unrefined result by status, and an adapter's class wins", () => {
    expect(classifyRuntimeResult({ status: "OK" })).toBeNull();
    expect(classifyRuntimeResult({ status: "UNAVAILABLE" })).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyRuntimeResult({ status: "TIMEOUT" })).toBe("TIMEOUT");
    expect(classifyRuntimeResult({ status: "ERROR" })).toBe("EXECUTION_ERROR");
    expect(classifyRuntimeResult({ status: "UNAVAILABLE", failureClass: "QUOTA_EXHAUSTED" })).toBe("QUOTA_EXHAUSTED");
  });

  it("splits a provider refusal into quota, rate limit and auth by the provider's own words", () => {
    expect(classifyProviderRefusal(429, "Too Many Requests")).toBe("RATE_LIMITED");
    expect(classifyProviderRefusal(429, "You exceeded your current quota")).toBe("QUOTA_EXHAUSTED");
    expect(classifyProviderRefusal(401, "Unauthorized")).toBe("TEMPORARY_AUTH_FAILURE");
    expect(classifyProviderRefusal(undefined, "provider not configured")).toBe("PROVIDER_UNAVAILABLE");
  });

  it("Claude Code: an HTTP 429 is a rate limit, the subscription usage window is a quota with its reset time", () => {
    expect(classifyClaudeRefusal({ api_error_status: 429, result: "rate_limit_error" })).toEqual({ failureClass: "RATE_LIMITED" });
    expect(classifyClaudeRefusal({ api_error_status: 401, result: "invalid x-api-key" })).toEqual({ failureClass: "TEMPORARY_AUTH_FAILURE" });
    const quota = classifyClaudeRefusal({ result: "Claude AI usage limit reached|1790000000" });
    expect(quota.failureClass).toBe("QUOTA_EXHAUSTED");
    expect(quota.retryAt).toBe(1_790_000_000_000);
    expect(classifyClaudeRefusal({ result: "Not logged in · Please run /login" })).toEqual({ failureClass: "TEMPORARY_AUTH_FAILURE" });
  });

  it("Codex: its own refusal lines normalize without the routing layer reading vendor text", () => {
    expect(classifyCodexRefusal("ERROR: exceeded retry limit, last status: 429 Too Many Requests")).toBe("RATE_LIMITED");
    expect(classifyCodexRefusal("ERROR: unexpected status 401 Unauthorized: Incorrect API key provided.")).toBe("TEMPORARY_AUTH_FAILURE");
    expect(classifyCodexRefusal("ERROR: You've hit your usage limit. Try again later.")).toBe("QUOTA_EXHAUSTED");
  });
});
