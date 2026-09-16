import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { UNIVERSAL_DENY } from "../agents/pathPermissions.js";
import { FORBIDDEN_COMMANDS, GuardResolutionError, contractGuardResolver, contractGuards } from "./runtimeGuards.js";

/** This repo is its own target project — `contracts/*.yaml` at the root are the real thing, not fixtures. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

describe("contractGuards — one declaration of what a role may write (T108)", () => {
  it("takes the write scope from the role's own contract, not from a second list", () => {
    const guards = contractGuards("backend-engineer", REPO_ROOT);
    expect(guards.writeAllow.length).toBeGreaterThan(0);
  });

  /**
   * The contract carries the role boundary, the stack profile the layout. The
   * adapter-level guard set has to carry both, or an orchestrated stage is
   * handed a write scope that excludes the code it was asked to write.
   */
  it("carries the resolved stack layout, not just the contract's role-shaped globs", () => {
    const guards = contractGuards("backend-engineer", REPO_ROOT);
    expect(guards.writeAllow).toContain("server/**");
    expect(guards.writeAllow).toContain("prisma/**");
    expect(guards.writeAllow).toContain("_docs/status.md");
    expect(guards.writeDeny).toContain("components/**");
  });

  it("layers the universal floor over whatever the contract says, rather than replacing it", () => {
    const guards = contractGuards("backend-engineer", REPO_ROOT);
    for (const denied of UNIVERSAL_DENY) {
      expect(guards.writeDeny).toContain(denied);
    }
  });

  /**
   * These are policy that holds for every role (`policies/git.md`,
   * `policies/coding.md` §5c, `policies/security.md` §5c-1), so they are
   * constants rather than contract fields — a per-role setting here would invite
   * a contract that switches one off.
   */
  it("applies the same command and exit-check rules to every role", () => {
    const engineer = contractGuards("backend-engineer", REPO_ROOT);
    const analyst = contractGuards("system-analyst", REPO_ROOT);

    expect(engineer.forbidCommands).toEqual(FORBIDDEN_COMMANDS);
    expect(analyst.forbidCommands).toEqual(FORBIDDEN_COMMANDS);
    expect(engineer.exitChecks).toEqual(analyst.exitChecks);
    expect(engineer.exitChecks).toContain("code-green");
    expect(engineer.exitChecks).toContain("no-hardcoded-secret");
  });

  it("gives different roles different write scopes — the ownership model this exists to carry", () => {
    const engineer = contractGuards("backend-engineer", REPO_ROOT);
    const analyst = contractGuards("system-analyst", REPO_ROOT);
    expect(engineer.writeAllow).not.toEqual(analyst.writeAllow);
  });

  /**
   * An unresolvable contract could be read as "write nothing" or as "no
   * restriction" — opposite behaviours. A guard that guesses between them is
   * worse than one that stops, so this throws and `createRuntimeExecutor`
   * refuses to start the run.
   */
  it("throws rather than guessing when a role has no contract", () => {
    expect(() => contractGuards("no-such-role", REPO_ROOT)).toThrow(GuardResolutionError);
    expect(() => contractGuards("no-such-role", REPO_ROOT)).toThrow(/must not proceed with an unknown write scope/);
  });

  /**
   * V10 TASK-010 — the Target side of the split. The role contract still answers
   * the Knowledge-side question; inside a bound Target the Target is the scope.
   */
  it("scopes a target-side stage to the whole Target, keeping the floor and the Knowledge deny", () => {
    const guards = contractGuards("backend-engineer", REPO_ROOT, REPO_ROOT, { targetSide: true });
    expect(guards.writeAllow).toEqual(["**"]);
    expect(guards.writeAllow.length).toBeGreaterThan(0);
    for (const denied of UNIVERSAL_DENY) expect(guards.writeDeny).toContain(denied);
    expect(guards.writeDeny).toContain("knowledge/**");
    expect(guards.writeDeny).toContain("_docs/module/*/design.md");
    expect(guards.writeDeny).toContain("contracts/**");
    // The stack layout half is what this collapses; it must not come back.
    expect(guards.writeDeny).not.toContain("components/**");
  });

  it("leaves the knowledge-side guard set untouched when no Target is written", () => {
    const knowledge = contractGuards("backend-engineer", REPO_ROOT, REPO_ROOT);
    expect(knowledge.writeAllow).not.toContain("**");
    expect(knowledge.writeAllow).toContain("server/**");
  });

  it("the resolver form curries the project root for the executor", () => {
    const resolve = contractGuardResolver(REPO_ROOT);
    expect(resolve("qa-engineer").writeAllow).toEqual(contractGuards("qa-engineer", REPO_ROOT).writeAllow);
  });
});
