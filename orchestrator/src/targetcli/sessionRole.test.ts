import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_ROLE_PATH } from "../agents/pathPermissions.js";
import { parseTargetArgs, type TargetCliArgs } from "./cli.js";
import { knownRoleNames, readSessionRoleDeclaration, runSessionRoleCommand } from "./sessionRole.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A bare workspace; `withStacks` adds the real node profile the way a synced one would carry. */
function makeWorkspace(withStacks = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-session-role-"));
  if (withStacks) fs.cpSync(path.join(REPO_ROOT, "stacks", "node"), path.join(root, "stacks", "node"), { recursive: true });
  return root;
}

function readFile(root: string): string {
  return fs.readFileSync(path.join(root, ...SESSION_ROLE_PATH.split("/")), "utf8");
}

describe("session-role — the one writer of the declared-session-role file (V12)", () => {
  it("set writes the declaration for a non-stack role with no stack half", () => {
    const root = makeWorkspace();
    try {
      const result = runSessionRoleCommand({ targetRoot: root, action: "set", role: "business-analyst", now: "2026-09-22T00:00:00.000Z" });
      expect(result.message).toContain("business-analyst");
      const written = JSON.parse(readFile(root)) as { role: string; stack?: unknown; declared_at: string };
      expect(written.role).toBe("business-analyst");
      expect(written.declared_at).toBe("2026-09-22T00:00:00.000Z");
      expect(written.stack).toBeUndefined();
      expect(readSessionRoleDeclaration(root)?.role).toBe("business-analyst");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("set resolves the stack half through the same call the orchestrator uses", () => {
    const root = makeWorkspace(true);
    try {
      const result = runSessionRoleCommand({ targetRoot: root, action: "set", role: "backend-engineer" });
      expect(result.declaration?.stack).toBeDefined();
      // The node profile's backend globs, resolved — not a hand-written guess.
      expect(result.declaration?.stack?.write).toContain("server/**");
      expect(readSessionRoleDeclaration(root)?.stack?.write).toContain("server/**");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("set with no resolvable stack writes the role alone — stricter, never looser", () => {
    const root = makeWorkspace(false);
    try {
      const result = runSessionRoleCommand({ targetRoot: root, action: "set", role: "backend-engineer" });
      expect(result.declaration?.role).toBe("backend-engineer");
      expect(result.declaration?.stack).toBeUndefined();
      expect(readFile(root)).not.toContain("server/**");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("set refuses a role the registry does not carry, and a missing role", () => {
    const root = makeWorkspace();
    try {
      expect(() => runSessionRoleCommand({ targetRoot: root, action: "set", role: "chief-hacker" })).toThrow(/unknown agent role "chief-hacker"/);
      expect(() => runSessionRoleCommand({ targetRoot: root, action: "set" })).toThrow(/a role is required/);
      expect(fs.existsSync(path.join(root, SESSION_ROLE_PATH))).toBe(false);
      // The valid list is the registry's, so the error names the real roles.
      expect(() => runSessionRoleCommand({ targetRoot: root, action: "set", role: "chief-hacker" })).toThrow(new RegExp(knownRoleNames()[0].replace(/[-]/g, "\\$&")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clear removes the declaration and answers calmly when there is none", () => {
    const root = makeWorkspace();
    try {
      runSessionRoleCommand({ targetRoot: root, action: "set", role: "business-analyst" });
      const cleared = runSessionRoleCommand({ targetRoot: root, action: "clear" });
      expect(fs.existsSync(path.join(root, SESSION_ROLE_PATH))).toBe(false);
      expect(cleared.message).toContain("cleared");
      const again = runSessionRoleCommand({ targetRoot: root, action: "clear" });
      expect(again.message).toContain("nothing to clear");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("show reports the declaration, and anonymity when it is absent or unreadable", () => {
    const root = makeWorkspace();
    try {
      const none = runSessionRoleCommand({ targetRoot: root, action: "show" });
      expect(none.declaration).toBeNull();
      expect(none.message).toContain("no session role declared");

      runSessionRoleCommand({ targetRoot: root, action: "set", role: "backend-engineer" });
      const shown = runSessionRoleCommand({ targetRoot: root, action: "show" });
      expect(shown.declaration?.role).toBe("backend-engineer");

      fs.writeFileSync(path.join(root, SESSION_ROLE_PATH), "{oops", "utf8");
      const corrupt = runSessionRoleCommand({ targetRoot: root, action: "show" });
      expect(corrupt.declaration).toBeNull();
      expect(corrupt.message).toContain("unreadable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session-role argument parsing", () => {
  function parse(argv: string[]): TargetCliArgs {
    return parseTargetArgs(argv);
  }

  it("parses set/clear/show with the role positional", () => {
    const set = parse(["session-role", "set", "backend-engineer"]);
    expect(set.command).toBe("session-role");
    expect(set.sessionRoleAction).toBe("set");
    expect(set.sessionRoleName).toBe("backend-engineer");
    expect(parse(["session-role", "clear"]).sessionRoleAction).toBe("clear");
    expect(parse(["session-role", "show"]).sessionRoleAction).toBe("show");
  });

  it("rejects two actions and keeps the verb distinct from other commands", () => {
    expect(() => parse(["session-role", "set", "clear"])).toThrow(/only one action/);
    expect(() => parse(["set"])).toThrow(/unrecognized argument: set/);
    expect(() => parse(["session-role", "set", "backend-engineer", "--target-root", "x", "extra"])).toThrow(/unrecognized argument: extra/);
  });

  it("still accepts a --role flag value as the retired, ignored flag", () => {
    const args = parse(["session-role", "show", "--role", "dev"]);
    expect(args.retiredRole).toBe("dev");
    expect(args.sessionRoleAction).toBe("show");
  });
});
