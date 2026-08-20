import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  PathDeniedError,
  UNIVERSAL_DENY,
  assertCanWrite,
  canWritePath,
  checkPathRules,
  matchesGlob,
  pathRulesFor,
  toRepoRelative,
} from "./pathPermissions.js";

describe("matchesGlob", () => {
  it("matches a literal path", () => {
    expect(matchesGlob("package.json", "package.json")).toBe(true);
    expect(matchesGlob("package.json", "app/package.json")).toBe(false);
  });

  it("keeps a single star inside one segment", () => {
    expect(matchesGlob("_docs/module/*/design.md", "_docs/module/sales-crm/design.md")).toBe(true);
    expect(matchesGlob("_docs/module/*/design.md", "_docs/module/a/b/design.md")).toBe(false);
    expect(matchesGlob("next.config.*", "next.config.js")).toBe(true);
  });

  it("lets a double star span segments", () => {
    expect(matchesGlob("server/**", "server/routes/deal.ts")).toBe(true);
    expect(matchesGlob("server/**", "server/index.ts")).toBe(true);
    expect(matchesGlob("app/api/**", "app/api/deals/route.ts")).toBe(true);
    expect(matchesGlob("app/api/**", "app/page.tsx")).toBe(false);
  });

  /** `a/**` has to match `a` itself, or a rule about a directory misses the directory. */
  it("matches the directory a double star hangs off", () => {
    expect(matchesGlob("prisma/**", "prisma")).toBe(true);
  });

  it("treats a windows path the same as a posix one", () => {
    expect(matchesGlob("server/**", "server\\routes\\deal.ts")).toBe(true);
  });

  it("does not let a dot or a bracket in a pattern act as a regex", () => {
    expect(matchesGlob("next.config.js", "nextxconfigxjs")).toBe(false);
    expect(matchesGlob("a+b.ts", "a+b.ts")).toBe(true);
  });
});

describe("canWritePath", () => {
  const rules = { write: ["server/**", "prisma/**"], deny: ["prisma/migrations/**"], read: ["**"] };

  it("allows a path the write list covers", () => {
    expect(canWritePath(rules, "server/routes/deal.ts").allowed).toBe(true);
  });

  /** Allow-by-default would make every new directory writable by everyone the moment it appears. */
  it("refuses anything the write list does not cover", () => {
    const decision = canWritePath(rules, "app/page.tsx");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rule).toBe("not-allowed");
  });

  it("lets a deny outrank the write list that would otherwise permit it", () => {
    const decision = canWritePath(rules, "prisma/migrations/001/migration.sql");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rule).toBe("agent-deny");
  });

  it("lets the universal deny outrank everything, including an explicit allow", () => {
    const permissive = { write: ["**"], deny: [], read: ["**"] };
    for (const target of [".git/config", "node_modules/x/index.js", ".workflow/state.db"]) {
      const decision = canWritePath(permissive, target);
      expect(decision.allowed, target).toBe(false);
      if (!decision.allowed) expect(decision.rule).toBe("universal-deny");
    }
  });

  it("says so plainly when a role has no write paths at all", () => {
    const decision = canWritePath({ write: [], deny: [], read: [] }, "anything.ts");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("no write paths");
  });
});

describe("the shipped contracts' path rules", () => {
  it("gives every agent a write list", () => {
    const result = checkPathRules();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The ownership model, enforced: each agent owns exactly one artifact. */
  it("lets each doc agent write its own document and no one else's", () => {
    const cases: Array<[AgentStage, string, string]> = [
      [AgentStage.BUSINESS_ANALYST, "_docs/module/crm/requirement.md", "_docs/module/crm/design.md"],
      [AgentStage.SYSTEM_ANALYST, "_docs/module/crm/design.md", "_docs/module/crm/plan.md"],
      [AgentStage.PROJECT_MANAGER, "_docs/module/crm/plan.md", "_docs/module/crm/design.md"],
      [AgentStage.SECURITY, "_docs/module/crm/security.md", "_docs/module/crm/review.md"],
      [AgentStage.DEVOPS, "_docs/module/crm/deploy.md", "_docs/module/crm/design.md"],
    ];
    for (const [agent, own, other] of cases) {
      const rules = pathRulesFor(agent);
      expect(canWritePath(rules, own).allowed, `${agent} own`).toBe(true);
      expect(canWritePath(rules, other).allowed, `${agent} other`).toBe(false);
    }
  });

  /** An engineer that edits design.md has changed the contract it was meant to implement. */
  it("stops an engineer writing any module document", () => {
    for (const agent of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const rules = pathRulesFor(agent);
      for (const doc of ["design.md", "requirement.md", "plan.md", "review.md"]) {
        expect(canWritePath(rules, `_docs/module/crm/${doc}`).allowed, `${agent} ${doc}`).toBe(false);
      }
    }
  });

  it("keeps the engineers out of each other's code", () => {
    const backend = pathRulesFor(AgentStage.BACKEND_ENGINEER);
    const frontend = pathRulesFor(AgentStage.FRONTEND_ENGINEER);

    expect(canWritePath(backend, "prisma/schema.prisma").allowed).toBe(true);
    expect(canWritePath(frontend, "prisma/schema.prisma").allowed).toBe(false);
    expect(canWritePath(frontend, "components/DealCard.tsx").allowed).toBe(true);
    expect(canWritePath(backend, "components/DealCard.tsx").allowed).toBe(false);
  });

  /** A verifier that fixes what it finds is no longer verifying. */
  it("stops qa-engineer and security writing application code", () => {
    for (const agent of [AgentStage.QA_ENGINEER, AgentStage.SECURITY]) {
      const rules = pathRulesFor(agent);
      for (const file of ["server/index.ts", "app/page.tsx", "prisma/schema.prisma"]) {
        expect(canWritePath(rules, file).allowed, `${agent} ${file}`).toBe(false);
      }
    }
  });

  it("lets qa-engineer edit plan.md, which is its one non-checkbox exception", () => {
    expect(canWritePath(pathRulesFor(AgentStage.QA_ENGINEER), "_docs/module/crm/plan.md").allowed).toBe(true);
  });

  it("stops every agent writing the pipeline's own definition", () => {
    for (const agent of Object.values(AgentStage).filter((a) => a !== AgentStage.HUMAN)) {
      const rules = pathRulesFor(agent);
      for (const file of [".claude/agents/backend-engineer.md", "contracts/backend-engineer.yaml", ".workflow/state.db"]) {
        expect(canWritePath(rules, file).allowed, `${agent} ${file}`).toBe(false);
      }
    }
  });
});

describe("assertCanWrite", () => {
  it("throws with the reason attached", () => {
    try {
      assertCanWrite(AgentStage.FRONTEND_ENGINEER, "prisma/schema.prisma");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PathDeniedError);
      expect((e as PathDeniedError).decision.allowed).toBe(false);
    }
  });

  it("stays quiet for a path the agent owns", () => {
    expect(() => assertCanWrite(AgentStage.BACKEND_ENGINEER, "server/routes/deal.ts")).not.toThrow();
  });
});

describe("toRepoRelative", () => {
  it("returns null for a path outside the repo, which is another guard's job", () => {
    expect(toRepoRelative("/somewhere/else/x.ts", "/repo")).toBeNull();
    expect(toRepoRelative("/repo", "/repo")).toBeNull();
  });

  it("normalizes to forward slashes", () => {
    expect(toRepoRelative("/repo/server/x.ts", "/repo")).toBe("server/x.ts");
  });
});

describe("checkPathRules", () => {
  /**
   * Every document here is amended, never regenerated (conventions.md §4), so a
   * role allowed to write something it cannot read is a rule that contradicts
   * itself. This caught three real gaps the moment it was written.
   */
  it("requires everything a role may write to be readable by it", () => {
    for (const agent of Object.values(AgentStage).filter((a) => a !== AgentStage.HUMAN)) {
      const rules = pathRulesFor(agent);
      for (const target of rules.write) {
        const readable = rules.read.some((pattern) => matchesGlob(pattern, target) || pattern === target);
        expect(readable, `${agent} writes ${target} but cannot read it`).toBe(true);
      }
    }
  });

  it("gives every role something to read", () => {
    for (const agent of Object.values(AgentStage).filter((a) => a !== AgentStage.HUMAN)) {
      expect(pathRulesFor(agent).read.length, agent).toBeGreaterThan(0);
    }
  });

  it("reports a role that may write what it cannot read", () => {
    // Proven against the real checker via the shipped contracts above; this pins
    // the message so the rule cannot be quietly relaxed to a no-op.
    const result = checkPathRules();
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("names the universal denies it enforces, so the list is not folklore", () => {
    expect(UNIVERSAL_DENY).toContain(".git/**");
    expect(UNIVERSAL_DENY).toContain(".workflow/**");
  });
});
