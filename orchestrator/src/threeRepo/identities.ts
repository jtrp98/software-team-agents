import type { InstallationConfig } from "./installation.js";

/**
 * The identity gate (T-UX3) — the "เมลเดียวกันเท่านั้น" rule the owner set for
 * design-source access, made checkable instead of remembered.
 *
 * WHAT IS VERIFIED MECHANICALLY, AND WHAT IS NOT
 *
 *  - **Figma** can be verified end to end: a read-only `get_me` call returns
 *    the email of the account the token actually authenticates, so
 *    {@link verifyFigmaIdentity} compares that against the declared value and
 *    fails closed on mismatch or unavailability. Nothing here performs the
 *    network call itself — the runtime adapter does — this module only owns
 *    the verdict, so tests can prove every branch without a credential.
 *  - **Claude (Anthropic auth)** has no trusted runtime API this framework can
 *    query, so its email is declared-only: Anthropic's own authentication is
 *    what binds the session to an account. Comparing the two declared emails
 *    here is defense-in-depth, not proof.
 *
 * FAIL CLOSED
 *
 * Every branch that cannot establish the required fact is a refusal with a
 * reason naming the fix (`sta configure identity …`). A missing config and a
 * failed verification are equally blocking — the one thing they never do is
 * let a run proceed on the assumption the accounts probably match.
 *
 * SECRETS STAY OUT
 *
 * Only email addresses pass through here, and nothing returns a token: the
 * PAT lives in the environment (`FIGMA_PAT`) or the runtime's keychain, and
 * {@link figmaPatConfigured} deliberately answers presence as a boolean so a
 * caller cannot accidentally log what it read.
 */

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One normalization, used by every comparison: trim, then casefold. Local-part case is insignificant for this policy's purpose (identity equality), and pretending otherwise would block people whose accounts differ only in case. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isWellFormedEmail(raw: string): boolean {
  return EMAIL_PATTERN.test(raw.trim());
}

export interface DeclaredIdentitiesCheck {
  ok: boolean;
  /** Actionable problems; empty when ok. Never quotes more of the config than the offending field name. */
  problems: string[];
}

/**
 * The declared-level half of the gate: identities exist, are well-formed, and
 * agree with each other. Runs before any runtime starts; the Figma-side check
 * against `get_me` happens at MCP connection time on top of this.
 */
export function checkDeclaredIdentities(config: Pick<InstallationConfig, "identities">): DeclaredIdentitiesCheck {
  const identities = config.identities;
  if (!identities) {
    return {
      ok: false,
      problems: [
        "no identities are configured for this installation — declare them once with " +
          "`sta configure identity --figma-email <email> --claude-email <email>`; " +
          "the UX/UI stage refuses to run until the Figma and Claude accounts are declared to be the same person",
      ],
    };
  }

  const problems: string[] = [];
  if (!isWellFormedEmail(identities.figma_email)) {
    problems.push("identities.figma_email is not a usable email address — re-run `sta configure identity --figma-email <email>`");
  }
  if (!isWellFormedEmail(identities.claude_email)) {
    problems.push("identities.claude_email is not a usable email address — re-run `sta configure identity --claude-email <email>`");
  }
  if (problems.length === 0 && normalizeEmail(identities.figma_email) !== normalizeEmail(identities.claude_email)) {
    problems.push(
      "the declared figma_email and claude_email are different addresses — this integration requires both accounts " +
        "to belong to the same person; re-run `sta configure identity --figma-email <email> --claude-email <email>` " +
        "with the one address both accounts share",
    );
  }
  return { ok: problems.length === 0, problems };
}

export interface IdentityVerification {
  allowed: boolean;
  /** Why, in one line — shown to whoever launched the run. */
  reason: string;
}

/**
 * The runtime half: does the account the token authenticated as match the
 * declaration? Fail closed when the comparison cannot be made at all.
 *
 * `getMeEmail` is null exactly when the call did not return a usable email —
 * wrong scopes, network failure, server error — and that is distinguished from
 * a mismatch in the reason because the fixes differ (token/scopes vs account).
 */
export function verifyFigmaIdentity(declaredEmail: string | undefined, getMeEmail: string | null): IdentityVerification {
  if (declaredEmail === undefined || !isWellFormedEmail(declaredEmail)) {
    return {
      allowed: false,
      reason:
        "cannot verify the Figma identity: no usable figma_email is declared — " +
        "run `sta configure identity --figma-email <email>` before starting this stage",
    };
  }
  if (getMeEmail === null || getMeEmail.trim() === "") {
    return {
      allowed: false,
      reason:
        "cannot verify the Figma identity: get_me returned no email — check FIGMA_PAT is set and its token has read " +
        "(file_metadata:read / profile) scope; refusing to continue without a verified match",
    };
  }
  if (normalizeEmail(getMeEmail) !== normalizeEmail(declaredEmail)) {
    return {
      allowed: false,
      reason:
        "the authenticated Figma account does not match the declared figma_email — this stage runs only under the " +
        "declared identity; sign in with the declared account or re-declare it via `sta configure identity`",
    };
  }
  return { allowed: true, reason: "Figma identity verified against the declared figma_email" };
}

/** Whether a Figma token is present in the environment. Answers presence only — the value never passes through here. */
export function figmaPatConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const pat = env.FIGMA_PAT;
  return typeof pat === "string" && pat.trim().length > 0;
}
