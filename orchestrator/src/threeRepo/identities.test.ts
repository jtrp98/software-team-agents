import { describe, expect, it } from "vitest";
import {
  checkDeclaredIdentities,
  figmaPatConfigured,
  isWellFormedEmail,
  normalizeEmail,
  verifyFigmaIdentity,
} from "./identities.js";

describe("normalizeEmail", () => {
  it("trims and casefolds — the one normalization every comparison uses", () => {
    expect(normalizeEmail("  A.B@Example.COM ")).toBe("a.b@example.com");
  });
});

describe("isWellFormedEmail", () => {
  it("accepts an ordinary address and rejects junk", () => {
    expect(isWellFormedEmail("person@example.co.th")).toBe(true);
    expect(isWellFormedEmail("no-at-sign")).toBe(false);
    expect(isWellFormedEmail("@missing-local.com")).toBe(false);
    expect(isWellFormedEmail("spaces in@x.com")).toBe(false);
  });
});

describe("checkDeclaredIdentities", () => {
  it("blocks with the fix named when nothing is declared", () => {
    const result = checkDeclaredIdentities({});
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/sta configure identity --figma-email/);
  });

  it("passes when both emails are declared and equal", () => {
    const result = checkDeclaredIdentities({
      identities: { figma_email: "same@person.dev", claude_email: "same@person.dev" },
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("passes across case and surrounding whitespace — normalization runs before comparing", () => {
    const result = checkDeclaredIdentities({
      identities: { figma_email: "Same@Person.dev ", claude_email: " same@person.dev" },
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed on a mismatch between the two declared accounts", () => {
    const result = checkDeclaredIdentities({
      identities: { figma_email: "one@person.dev", claude_email: "other@person.dev" },
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/different addresses|same person/);
  });

  it("rejects a malformed declaration instead of failing open later", () => {
    const result = checkDeclaredIdentities({
      identities: { figma_email: "not-an-email", claude_email: "not-an-email" },
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("figma_email"))).toBe(true);
    expect(result.problems.some((p) => p.includes("claude_email"))).toBe(true);
  });
});

describe("verifyFigmaIdentity (fail closed)", () => {
  it("allows a verified match", () => {
    const verdict = verifyFigmaIdentity("me@person.dev", "Me@Person.Dev");
    expect(verdict.allowed).toBe(true);
  });

  it("blocks a mismatch and says which side to change", () => {
    const verdict = verifyFigmaIdentity("declared@person.dev", "someone@else.dev");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/does not match/);
  });

  it("blocks when get_me returns no email — a token problem reads differently from a mismatch", () => {
    const verdict = verifyFigmaIdentity("declared@person.dev", null);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/FIGMA_PAT/);
  });

  it("blocks when nothing usable is declared", () => {
    const verdict = verifyFigmaIdentity(undefined, "whoever@person.dev");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/configure identity/);
  });
});

describe("figmaPatConfigured", () => {
  it("answers presence as a boolean — the value never passes through", () => {
    expect(figmaPatConfigured({})).toBe(false);
    expect(figmaPatConfigured({ FIGMA_PAT: "   " })).toBe(false);
    expect(figmaPatConfigured({ FIGMA_PAT: "secret" })).toBe(true);
  });
});
