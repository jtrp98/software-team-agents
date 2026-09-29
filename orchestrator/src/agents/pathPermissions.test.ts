import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMarkerBlock } from "../targetcli/knowledgeRender.js";
import { AgentStage } from "../types.js";
import { signAttemptGrant, type AttemptGrantToken } from "../governance/attemptGrant.js";
import {
  ATTEMPT_GRANT_KEY_PATH,
  ATTEMPT_GRANT_TOKEN_PATH,
  GUARD_RULES_CLOSE,
  GUARD_RULES_OPEN,
  GUARD_RULE_HOSTS,
  GUARD_STACK_RULES_ENV,
  GUARD_TARGET_WORK_ROOTS_ENV,
  PathDeniedError,
  UNASSIGNED_SESSION_DENY,
  UNIVERSAL_DENY,
  WORKSPACE_BA_ARTIFACTS,
  FRAMEWORK_PAYLOAD_ARTIFACTS,
  assertCanWrite,
  canWritePath,
  checkPathRules,
  contractPathRules,
  frameworkPayloadDenyWhy,
  matchesGlob,
  pathRulesFor,
  renderGuardRuleBlock,
  serializeGuardTargetWorkRoots,
  targetPathRules,
  toRepoRelative,
  unassignedSessionDenyWhy,
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
      [AgentStage.TEST_PLANNER, "_docs/module/crm/test-plan.md", "_docs/module/crm/plan.md"],
      [AgentStage.SECURITY, "_docs/module/crm/security.md", "_docs/module/crm/qa.md"],
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
      for (const doc of ["design.md", "requirement.md", "plan.md", "test-plan.md", "qa.md"]) {
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

  it("lets qa-engineer edit plan.md, which is its one exception beyond qa.md", () => {
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
   * Every document here is amended, never regenerated (`policies/documentation.md` §4), so a
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

describe("V10 TASK-021 — the Framework payload is denied per stage, not per workspace role", () => {
  const permissive = { write: ["**"], deny: [], read: ["**"] };

  it("refuses Framework payload whatever the workspace records, and names no `ba`/`dev` command", () => {
    for (const rel of ["contracts/backend-engineer.yaml", "workflows/bugfix.yml", "stacks/node/stack.yaml", "layout.yaml", "test-pyramid.yaml", "escalation-policy.yaml"]) {
      const decision = canWritePath(permissive, rel);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.rule).toBe("framework-deny");
        expect(decision.reason).toContain("Framework payload");
        expect(decision.reason).not.toMatch(/software-team-agents (ba|dev)/);
      }
    }
  });

  it("leaves Knowledge documents to the contract that owns them — the old `role: dev` blanket ban is gone", () => {
    // The ban that replaced it is stage-bound and lives in `contractGuards`
    // (V10 TASK-012); this layer no longer knows which repository it is in.
    expect(canWritePath(permissive, "_docs/module/crm/requirement.md").allowed).toBe(true);
    expect(canWritePath(permissive, "knowledge/sales/requirement/REQ-1.yaml").allowed).toBe(true);
    expect(canWritePath(permissive, "src/index.ts").allowed).toBe(true);
    expect(canWritePath(permissive, "_docs/module/crm/qa.md").allowed).toBe(true);
  });

  it("TypeScript artifact lists match .claude/hooks/block-path-permissions.js and .opencode/plugin/sta-guards.js exactly", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const claudeHook = fs.readFileSync(path.join(root, ".claude", "hooks", "block-path-permissions.js"), "utf8");
    const opencodePlugin = fs.readFileSync(path.join(root, ".opencode", "plugin", "sta-guards.js"), "utf8");

    for (const pattern of [...WORKSPACE_BA_ARTIFACTS, ...FRAMEWORK_PAYLOAD_ARTIFACTS]) {
      expect(claudeHook).toContain(pattern);
      expect(opencodePlugin).toContain(pattern);
    }
  });

  it("no guard host still names the removed `ba`/`dev` commands in a denial", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    for (const rel of [".claude/hooks/block-path-permissions.js", ".codex/hooks/block-path-permissions.js", ".opencode/plugin/sta-guards.js", ".agents/hooks/sta-guard.js"]) {
      const text = fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
      expect(text).not.toMatch(/software-team-agents (ba|dev)/);
    }
  });
});

describe("T-V5-020 — one authored declaration, generated guard copies", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const GUARD_MIRROR = ".codex/hooks/block-path-permissions.js";
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
  const allHostPaths = () => [...GUARD_RULE_HOSTS.map((host) => host.path), GUARD_MIRROR];

  interface GeneratedGuardRules {
    ATTEMPT_GRANT_REL_PATH: string;
    ATTEMPT_GRANT_KEY_REL_PATH: string;
    UNIVERSAL_DENY: string[];
    WORKSPACE_BA_ARTIFACTS: string[];
    FRAMEWORK_PAYLOAD_ARTIFACTS: string[];
    UNASSIGNED_SESSION_DENY: string[];
    matchesGlob(pattern: string, target: string): boolean;
    frameworkPayloadDenial(relative: string, role: string | null): string | null;
    frameworkPayloadDenyWhy(pattern: string): string;
    unassignedSessionDenial(relative: string): string | null;
    unassignedSessionDenyWhy(pattern: string): string;
    canonicalGrantJson(value: unknown): string;
    grantSignatureValid(token: unknown, createHmac: typeof import("node:crypto").createHmac, keyHex: string): boolean;
    attemptGrantFromText(text: unknown, createHmac: typeof import("node:crypto").createHmac, keyHex: string, nowMs: number): { grantId: string; role: string; stack: { write: string[]; deny: string[] } } | null;
    stackPathRules(grant?: { stack: { write: string[]; deny: string[] } } | null): { write: string[]; deny: string[] };
    boundReadOnlyTarget(nodePath: typeof path, target: string): string | null;
    boundReadOnlyWhy(targetId: string, role: string | null): string;
    knowledgeArtifactDenial(nodePath: typeof path, target: string, role: string | null): { rel: string; why: string } | null;
    knowledgeSelectionIncompleteWhy(rootName: string): string;
  }

  /** Executes the rendered block the way a hook host does, and hands back what it declared. */
  function evaluateBlock(): GeneratedGuardRules {
    const body = renderGuardRuleBlock()
      .split("\n")
      .filter((line) => line !== GUARD_RULES_OPEN && line !== GUARD_RULES_CLOSE)
      .join("\n");
    return new Function(
      `${body}\nreturn { ATTEMPT_GRANT_REL_PATH, ATTEMPT_GRANT_KEY_REL_PATH, UNIVERSAL_DENY, WORKSPACE_BA_ARTIFACTS, FRAMEWORK_PAYLOAD_ARTIFACTS, UNASSIGNED_SESSION_DENY, matchesGlob, frameworkPayloadDenial, frameworkPayloadDenyWhy, unassignedSessionDenial, unassignedSessionDenyWhy, canonicalGrantJson, grantSignatureValid, attemptGrantFromText, stackPathRules, boundReadOnlyTarget, boundReadOnlyWhy, knowledgeArtifactDenial, knowledgeSelectionIncompleteWhy };`,
    )() as GeneratedGuardRules;
  }

  it("renders the rule lists from the constants rather than from a second copy", () => {
    const generated = evaluateBlock();
    expect(generated.UNIVERSAL_DENY).toEqual([...UNIVERSAL_DENY]);
    expect(generated.WORKSPACE_BA_ARTIFACTS).toEqual([...WORKSPACE_BA_ARTIFACTS]);
    expect(generated.FRAMEWORK_PAYLOAD_ARTIFACTS).toEqual([...FRAMEWORK_PAYLOAD_ARTIFACTS]);
    expect(generated.UNASSIGNED_SESSION_DENY).toEqual([...UNASSIGNED_SESSION_DENY]);
  });

  /**
   * `matchesGlob` is the one duplication a generator cannot remove — TypeScript
   * here, JavaScript text in the block — so it is the one duplication held by an
   * executing test instead of by a comment saying "Mirrors".
   */
  it("the generated matcher agrees with the TypeScript matcher on every rule the guards apply", () => {
    const generated = evaluateBlock();
    const patterns = [
      ...UNIVERSAL_DENY,
      ...WORKSPACE_BA_ARTIFACTS,
      ...FRAMEWORK_PAYLOAD_ARTIFACTS,
      "server/**",
      "next.config.*",
      "a/**",
      "**/*.ts",
      "prisma/**",
      "package.json",
    ];
    const targets = [
      "node_modules/pkg/index.js",
      ".workflow/state.json",
      "dist/cli.js",
      "knowledge/_roles/ba/seen.yaml",
      "knowledge/sales/requirement/REQ-1.yaml",
      "_docs/module/crm/requirement.md",
      "_docs/module/crm/uxui/design.md",
      "_docs/module/crm/qa.md",
      "_docs/status.md",
      "decisions/DR-001.yaml",
      "targets.yaml",
      "knowledge-policy.yaml",
      "contracts/backend-engineer.yaml",
      "workflows/feature.yml",
      "stacks/dotnet/profile.yaml",
      "layout.yaml",
      "test-pyramid.yaml",
      "escalation-policy.yaml",
      "server",
      "server/routes/deal.ts",
      "src/index.ts",
      "next.config.js",
      "a",
      "a/b/c.ts",
      "prisma",
      "prisma/schema.prisma",
      "./src/index.ts",
      "/src/index.ts",
      "src\\index.ts",
      "package.json",
      "",
    ];
    for (const pattern of patterns) {
      for (const target of targets) {
        expect(generated.matchesGlob(pattern, target), `${pattern} vs ${target}`).toBe(matchesGlob(pattern, target));
      }
    }
  });

  it("the generated Framework-payload denial agrees with the TypeScript one, and fires only for a named stage", () => {
    const generated = evaluateBlock();
    // No stage named: the per-stage layer cannot fire, exactly as the
    // per-agent contract layer cannot.
    expect(generated.frameworkPayloadDenial("contracts/backend-engineer.yaml", null)).toBeNull();

    for (const pattern of FRAMEWORK_PAYLOAD_ARTIFACTS) {
      const sample = pattern.replace("/**", "/sample.yaml");
      expect(generated.frameworkPayloadDenial(sample, "backend-engineer"), sample).toBe(frameworkPayloadDenyWhy(pattern));
    }
    expect(generated.frameworkPayloadDenial("src/index.ts", "backend-engineer")).toBeNull();
    expect(generated.frameworkPayloadDenial("_docs/module/m/design.md", "backend-engineer")).toBeNull();

    // The workspace-role deny this replaced pointed at `software-team-agents
    // ba|dev`, commands V10 removes.
    expect(generated.frameworkPayloadDenyWhy("contracts/**")).toBe(frameworkPayloadDenyWhy("contracts/**"));
    expect(generated.frameworkPayloadDenyWhy("contracts/**")).not.toMatch(/software-team-agents (ba|dev)/);
  });

  /** The layout half of an engineer's rules reaches a hook through the environment. */
  it("the generated stack-rule reader takes the channel the orchestrator writes, and trusts nothing else", () => {
    const body = renderGuardRuleBlock()
      .split("\n")
      .filter((line) => line !== GUARD_RULES_OPEN && line !== GUARD_RULES_CLOSE)
      .join("\n");
    const read = new Function(`${body}\nreturn stackPathRules;`)() as () => { write: string[]; deny: string[] };

    const saved = process.env[GUARD_STACK_RULES_ENV];
    try {
      delete process.env[GUARD_STACK_RULES_ENV];
      expect(read()).toEqual({ write: [], deny: [] });

      process.env[GUARD_STACK_RULES_ENV] = JSON.stringify({ write: ["ClassOnlineWeb/**"], deny: ["ClassOnlineWeb/bin/**"] });
      expect(read()).toEqual({ write: ["ClassOnlineWeb/**"], deny: ["ClassOnlineWeb/bin/**"] });

      // Anything malformed grants nothing rather than being guessed at: both
      // halves drop out together, so the path lands on deny-by-default.
      for (const bad of ["{not json", "null", "[]", '{"write":"ClassOnlineWeb/**"}', '{"write":[1,"",null]}']) {
        process.env[GUARD_STACK_RULES_ENV] = bad;
        expect(read().write, bad).toEqual([]);
      }
    } finally {
      if (saved === undefined) delete process.env[GUARD_STACK_RULES_ENV];
      else process.env[GUARD_STACK_RULES_ENV] = saved;
    }
  });

  it("T-V9-012 renders one Target-access reader for every guard host without widening write roots", () => {
    const generated = evaluateBlock();
    const writable = path.resolve("fixture", "api");
    const readOnly = path.resolve("fixture", "web");
    const savedRole = process.env.STA_ROLE;
    const savedRoots = process.env[GUARD_TARGET_WORK_ROOTS_ENV];
    try {
      process.env.STA_ROLE = "backend-engineer";
      process.env[GUARD_TARGET_WORK_ROOTS_ENV] = serializeGuardTargetWorkRoots([
        { targetId: "api", path: writable, access: "write" },
        { targetId: "web", path: readOnly, access: "read" },
      ]);
      expect(generated.boundReadOnlyTarget(path, path.join(writable, "src", "owned.ts"))).toBeNull();
      expect(generated.boundReadOnlyTarget(path, path.join(readOnly, "src", "foreign.ts"))).toBe("web");
      expect(generated.boundReadOnlyWhy("web", "backend-engineer")).toMatch(/Target "web".*bound read-only.*backend-engineer/);
      expect(JSON.parse(process.env[GUARD_TARGET_WORK_ROOTS_ENV]!)).toEqual([
        { targetId: "api", path: writable, access: "write" },
        { targetId: "web", path: readOnly, access: "read" },
      ]);
    } finally {
      if (savedRole === undefined) delete process.env.STA_ROLE;
      else process.env.STA_ROLE = savedRole;
      if (savedRoots === undefined) delete process.env[GUARD_TARGET_WORK_ROOTS_ENV];
      else process.env[GUARD_TARGET_WORK_ROOTS_ENV] = savedRoots;
    }
  });

  it("stays dependency-free, so a CommonJS hook and an ESM plugin can both carry it", () => {
    const block = renderGuardRuleBlock();
    expect(block).not.toMatch(/\brequire\s*\(/);
    expect(block).not.toMatch(/^\s*import\b/m);
    expect(block).not.toMatch(/\bimport\s*\(/);
    expect(block).not.toMatch(/\bmodule\.exports\b/);
    expect(block).not.toMatch(/^\s*export\b/m);
  });

  it("every host carries the rendered block byte-for-byte, the Codex mirror included", () => {
    const expected = renderGuardRuleBlock();
    const hosts = allHostPaths();
    expect(hosts).toContain(".claude/hooks/block-path-permissions.js");
    expect(hosts).toContain(".opencode/plugin/sta-guards.js");
    for (const rel of hosts) {
      const inspected = inspectMarkerBlock(read(rel), GUARD_RULES_OPEN, GUARD_RULES_CLOSE, "guard-rules");
      expect(inspected.state, rel).toBe("valid");
      if (inspected.state === "valid") expect(inspected.block, rel).toBe(expected);
    }
  });

  it("leaves no hand-maintained copy of the rule data outside a generated block", () => {
    for (const rel of allHostPaths()) {
      const inspected = inspectMarkerBlock(read(rel), GUARD_RULES_OPEN, GUARD_RULES_CLOSE, "guard-rules");
      expect(inspected.state, rel).toBe("valid");
      if (inspected.state !== "valid") continue;
      expect(inspected.outside, rel).not.toMatch(/const\s+UNIVERSAL_DENY\s*=/);
      expect(inspected.outside, rel).not.toMatch(/const\s+WORKSPACE_BA_ARTIFACTS\s*=/);
      expect(inspected.outside, rel).not.toMatch(/const\s+FRAMEWORK_PAYLOAD_ARTIFACTS\s*=/);
      expect(inspected.outside, rel).not.toMatch(/function\s+matchesGlob\s*\(/);
      expect(inspected.outside, rel).not.toMatch(/function\s+frameworkPayloadDenial\s*\(/);
      expect(inspected.outside, rel).not.toMatch(/function\s+frameworkPayloadDenyWhy\s*\(/);
      expect(inspected.outside, rel).not.toMatch(/function\s+boundReadOnly(?:Target|Why)\s*\(/);
    }
  });

  it("keeps every rule renderable as a single-quoted JavaScript literal", () => {
    // A quote, backslash or newline in a rule would generate a broken guard.
    // The renderer throws on one; this keeps the current lists honest too.
    for (const rule of [...UNIVERSAL_DENY, ...WORKSPACE_BA_ARTIFACTS, ...FRAMEWORK_PAYLOAD_ARTIFACTS]) {
      expect(rule, rule).not.toMatch(/['\\\r\n]/);
    }
    expect(() => renderGuardRuleBlock()).not.toThrow();
  });
});

describe("V11 TASK-020 — the managed-session selection marker in the knowledge denial (DR §6, §8.4)", () => {
  const kbFixture = path.resolve("fixture", "knowledge-root");
  const saved: Record<string, string | undefined> = {};
  const GUARDED_ENV = ["STA_ROLE", "STA_KNOWLEDGE_ROOT", "STA_KNOWLEDGE_ROOT_NAME"] as const;

  /** Executes the rendered block the way a hook host does (same recipe as the T-V5-020 suite above). */
  function evaluateBlock(): {
    knowledgeArtifactDenial(nodePath: typeof path, target: string, role: string | null): { rel: string; why: string } | null;
    knowledgeSelectionIncompleteWhy(rootName: string): string;
  } {
    const body = renderGuardRuleBlock()
      .split("\n")
      .filter((line) => line !== GUARD_RULES_OPEN && line !== GUARD_RULES_CLOSE)
      .join("\n");
    return new Function(`${body}\nreturn { knowledgeArtifactDenial, knowledgeSelectionIncompleteWhy };`)();
  }

  function withGuardEnv(env: Partial<Record<(typeof GUARDED_ENV)[number], string | undefined>>, run: (generated: ReturnType<typeof evaluateBlock>) => void): void {
    for (const key of GUARDED_ENV) saved[key] = process.env[key];
    try {
      for (const key of GUARDED_ENV) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      run(evaluateBlock());
    } finally {
      for (const key of GUARDED_ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it("a managed invocation with the selection env complete denies Knowledge artifacts off the selected canonical path", () => {
    withGuardEnv({ STA_ROLE: "backend-engineer", STA_KNOWLEDGE_ROOT: kbFixture, STA_KNOWLEDGE_ROOT_NAME: "work" }, (generated) => {
      const denial = generated.knowledgeArtifactDenial(path, path.join(kbFixture, "_docs", "module", "crm", "design.md"), "backend-engineer");
      expect(denial).not.toBeNull();
      expect(denial!.rel).toBe("_docs/module/crm/design.md");
      expect(denial!.why).toContain(kbFixture);
      // A Target source outside the selected root still reaches the permission decision.
      expect(generated.knowledgeArtifactDenial(path, path.resolve("fixture", "target", "src", "app.ts"), "backend-engineer")).toBeNull();
    });
  });

  it("a managed invocation whose selection env is half-set denies before any permission decision", () => {
    // The launcher sets name + path as one unit; a name without a path means the
    // launch contract broke, and no write can be attributed to a Knowledge root.
    withGuardEnv({ STA_ROLE: "backend-engineer", STA_KNOWLEDGE_ROOT_NAME: "work" }, (generated) => {
      for (const target of [path.resolve("fixture", "target", "src", "app.ts"), path.join(kbFixture, "knowledge", "x.yaml"), path.join(kbFixture, "_docs", "status.md")]) {
        const denial = generated.knowledgeArtifactDenial(path, target, "backend-engineer");
        expect(denial, target).not.toBeNull();
        expect(denial!.why).toContain("work");
        expect(denial!.why).toContain("STA_KNOWLEDGE_ROOT");
      }
      expect(generated.knowledgeSelectionIncompleteWhy("work")).toMatch(/one session = one root/);
    });
  });

  it("an empty-string path counts as missing for a managed invocation", () => {
    withGuardEnv({ STA_ROLE: "backend-engineer", STA_KNOWLEDGE_ROOT: "", STA_KNOWLEDGE_ROOT_NAME: "work" }, (generated) => {
      expect(generated.knowledgeArtifactDenial(path, path.resolve("src", "app.ts"), "backend-engineer")).not.toBeNull();
    });
  });

  it("an unbound invocation (no marker) keeps the legacy rules — the fail-open and the path-only denial", () => {
    withGuardEnv({ STA_ROLE: "backend-engineer" }, (generated) => {
      // No name, no path: the V10 fail-open single-repo mode run.js pins.
      expect(generated.knowledgeArtifactDenial(path, path.join(kbFixture, "_docs", "module", "m", "design.md"), "backend-engineer")).toBeNull();
      // Path without a name is the legacy contract: the old rule, unchanged.
      process.env.STA_KNOWLEDGE_ROOT = kbFixture;
      const denial = generated.knowledgeArtifactDenial(path, path.join(kbFixture, "_docs", "module", "m", "design.md"), "backend-engineer");
      expect(denial).not.toBeNull();
      expect(denial!.rel).toBe("_docs/module/m/design.md");
      expect(generated.knowledgeArtifactDenial(path, path.resolve("fixture", "target", "src", "app.ts"), "backend-engineer")).toBeNull();
    });
  });

  it("a role outside the knowledge-denied set is never touched by this rule", () => {
    withGuardEnv({ STA_ROLE: "system-analyst", STA_KNOWLEDGE_ROOT_NAME: "work" }, (generated) => {
      expect(generated.knowledgeArtifactDenial(path, path.resolve("src", "app.ts"), "system-analyst")).toBeNull();
    });
  });

  it("the hook resolves no default and reads no installation config (TOCTOU)", () => {
    const block = renderGuardRuleBlock();
    expect(block).not.toContain("STA_INSTALLATION_CONFIG");
    expect(block).not.toContain("knowledge_roots");
    expect(block).not.toContain("installation.yaml");
  });
});

describe("STA-issued attempt grant — the direct-mode identity channel (V13 TASK-012)", () => {
  const KEY = "a".repeat(64);

  /** Same recipe as the T-V5-020 suite: executes the rendered block the way a hook host does. */
  function evaluateBlock(): {
    ATTEMPT_GRANT_REL_PATH: string;
    ATTEMPT_GRANT_KEY_REL_PATH: string;
    attemptGrantFromText(text: unknown, createHmac: typeof import("node:crypto").createHmac, keyHex: string, nowMs: number): { grantId: string; role: string; stack: { write: string[]; deny: string[] } } | null;
    stackPathRules(grant?: { stack: { write: string[]; deny: string[] } } | null): { write: string[]; deny: string[] };
    frameworkPayloadDenial(relative: string, role: string | null): string | null;
    frameworkPayloadDenyWhy(pattern: string): string;
  } {
    const body = renderGuardRuleBlock()
      .split("\n")
      .filter((line) => line !== GUARD_RULES_OPEN && line !== GUARD_RULES_CLOSE)
      .join("\n");
    return new Function(
      `${body}\nreturn { ATTEMPT_GRANT_REL_PATH, ATTEMPT_GRANT_KEY_REL_PATH, attemptGrantFromText, stackPathRules, frameworkPayloadDenial, frameworkPayloadDenyWhy };`,
    )();
  }

  /** Signs a token exactly the way STA's own issuer does, so the block is tested against real grant bytes. */
  function signedToken(over: Partial<AttemptGrantToken> = {}, keyHex = KEY): AttemptGrantToken {
    const unsigned = {
      attempt_grant: 1,
      grant_id: `agr_${"b".repeat(32)}`,
      role: "qa-engineer",
      stage: "qa-engineer",
      task_id: "T-GRANT",
      contract_digest: "c".repeat(64),
      scope: { write: ["_docs/status.md"], deny: [], stack: { write: ["server/**"], deny: [] } },
      work_roots: [],
      knowledge_root: null,
      issued_at: "2026-09-25T00:00:00.000Z",
      expires_at: "2026-09-26T00:00:00.000Z",
      nonce: "d".repeat(32),
      ...over,
    };
    return signAttemptGrant(unsigned as Omit<AttemptGrantToken, "signature">, keyHex);
  }

  const NOW = Date.parse("2026-09-25T12:00:00.000Z");

  it("renders the token and key paths from the one TypeScript constants", () => {
    const generated = evaluateBlock();
    expect(generated.ATTEMPT_GRANT_REL_PATH).toBe(ATTEMPT_GRANT_TOKEN_PATH);
    expect(generated.ATTEMPT_GRANT_KEY_REL_PATH).toBe(ATTEMPT_GRANT_KEY_PATH);
  });

  it("accepts exactly a validly-signed, unexpired token and hands back the granted identity", () => {
    const generated = evaluateBlock();
    const grant = generated.attemptGrantFromText(JSON.stringify(signedToken()), createHmac, KEY, NOW);
    expect(grant).toMatchObject({ grantId: `agr_${"b".repeat(32)}`, role: "qa-engineer", stack: { write: ["server/**"], deny: [] } });
  });

  it("a self-written role file is worthless: unsigned, tampered or forged tokens grant nothing", () => {
    const generated = evaluateBlock();
    // The retired self-declaration shape, hand-written exactly as the old
    // channel accepted it: no signature, no authority.
    expect(generated.attemptGrantFromText(JSON.stringify({ role: "backend-engineer", declared_at: "2026-09-25T00:00:00Z" }), createHmac, KEY, NOW)).toBeNull();
    // A real token with one field edited after signing.
    const tampered = signedToken();
    tampered.role = "backend-engineer";
    expect(generated.attemptGrantFromText(JSON.stringify(tampered), createHmac, KEY, NOW)).toBeNull();
    // A token signed under a different key (the session guessed one).
    expect(generated.attemptGrantFromText(JSON.stringify(signedToken({}, "f".repeat(64))), createHmac, KEY, NOW)).toBeNull();
    // Off-shape anything is "no grant", never an error.
    const wrongVersion = JSON.parse(JSON.stringify(signedToken()));
    wrongVersion.attempt_grant = 2;
    for (const bad of [null, undefined, "", "not json", "[]", JSON.stringify({}), JSON.stringify(wrongVersion), JSON.stringify(signedToken({ role: "Not A Role" }))]) {
      expect(generated.attemptGrantFromText(bad, createHmac, KEY, NOW), String(bad)).toBeNull();
    }
  });

  it("an expired grant grants nothing, checked against the clock the hook is given", () => {
    const generated = evaluateBlock();
    const token = JSON.stringify(signedToken({ expires_at: "2026-09-25T00:00:00.000Z" }));
    expect(generated.attemptGrantFromText(token, createHmac, KEY, NOW)).toBeNull();
    // And the exact boundary: one millisecond before expiry still holds.
    const boundary = JSON.stringify(signedToken({ expires_at: "2026-09-25T12:00:00.001Z" }));
    expect(generated.attemptGrantFromText(boundary, createHmac, KEY, NOW)).not.toBeNull();
  });

  it("the grant's stack half merges beside the env channel, malformed dropping out empty", () => {
    const generated = evaluateBlock();
    const grant = { stack: { write: ["server/**"], deny: ["dist/**"] } };
    const saved = process.env[GUARD_STACK_RULES_ENV];
    try {
      delete process.env[GUARD_STACK_RULES_ENV];
      expect(generated.stackPathRules(grant)).toEqual({ write: ["server/**"], deny: ["dist/**"] });
      expect(generated.stackPathRules(null)).toEqual({ write: [], deny: [] });

      process.env[GUARD_STACK_RULES_ENV] = JSON.stringify({ write: ["src/**"], deny: [] });
      expect(generated.stackPathRules(grant)).toEqual({ write: ["src/**", "server/**"], deny: ["dist/**"] });
    } finally {
      if (saved === undefined) delete process.env[GUARD_STACK_RULES_ENV];
      else process.env[GUARD_STACK_RULES_ENV] = saved;
    }
  });

  it("a granted role turns the per-stage layer on with no env at all, exactly as STA_ROLE would", () => {
    const generated = evaluateBlock();
    const grant = generated.attemptGrantFromText(JSON.stringify(signedToken()), createHmac, KEY, NOW);
    expect(grant && generated.frameworkPayloadDenial("contracts/backend-engineer.yaml", grant.role)).toBe(
      generated.frameworkPayloadDenyWhy("contracts/**"),
    );
    // Without a grant (or with an unverified one) the layer stays off.
    expect(generated.frameworkPayloadDenial("contracts/backend-engineer.yaml", null)).toBeNull();
  });
});

describe("T-V5-023 — stack-shaped path permissions live in the stack profile", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  let workspace: string;

  /** A workspace shaped like a synced one: the real `contracts/` and `stacks/` payload, plus whatever config the case needs. */
  function makeWorkspace(config?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-stack-perms-"));
    fs.cpSync(path.join(repoRoot, "contracts"), path.join(root, "contracts"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
    if (config !== undefined) {
      fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
      fs.writeFileSync(path.join(root, ".agent-team", "config.yaml"), config, "utf8");
    }
    return root;
  }

  const dotnetConfig = (sourceRoots: string[], extra = "") =>
    [
      "schema_version: 1",
      "target_id: sb-web-student",
      "registered_at: 2026-08-23T16:09:42.269Z",
      "role: dev",
      "stack:",
      "  profile: dotnet",
      "  package_manager: nuget",
      "  commands:",
      "    install: dotnet restore",
      "    build: dotnet build",
      "    test: dotnet test",
      "    lint: dotnet format --verify-no-changes",
      "    typecheck: dotnet build",
      "  schema_paths: []",
      "  source_roots:",
      ...sourceRoots.map((root) => `    - ${root}`),
      "  detected_at: 2026-08-28T08:55:31.504Z",
      "  fingerprint: sha256:deadbeef",
      extra,
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n";

  afterEach(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("no engineer contract declares a stack-specific path glob any more", () => {
    // The role boundary is expressible in this pipeline's own vocabulary; a
    // repository layout is not. Asserted against the shipped contracts.
    for (const role of ["backend-engineer", "frontend-engineer"]) {
      const rules = contractPathRules(role, repoRoot);
      for (const glob of [...rules.read, ...rules.write, ...rules.deny]) {
        expect(glob, `${role}: ${glob}`).toMatch(/^(?:_docs\/|\.claude\/|policies\/|contracts\/|workflows\/|stacks\/|knowledge\/|decisions\/|(?:CLAUDE|README)\.md$)/);
      }
    }
  });

  it("a dotnet Target resolves its real source root as the engineer write set, with no override", () => {
    workspace = makeWorkspace(dotnetConfig(["ClassOnlineWeb"]));

    const backend = pathRulesFor("backend-engineer", workspace);
    // Packet registration and execution may load contracts from Framework while
    // the effective layout belongs to a separate Target.
    expect(pathRulesFor("backend-engineer", repoRoot, workspace)).toEqual(backend);
    expect(backend.write).toContain("ClassOnlineWeb/**");
    expect(backend.write.length).toBeGreaterThan(0);
    expect(canWritePath(backend, "ClassOnlineWeb/Controllers/StudentController.cs").allowed).toBe(true);
    expect(canWritePath(backend, "ClassOnlineWeb/Web.config").allowed).toBe(true);
    // Views and client assets stay frontend-engineer's, exactly as components/** does on Node.
    expect(canWritePath(backend, "ClassOnlineWeb/Views/Student/Index.cshtml").allowed).toBe(false);
    expect(canWritePath(backend, "ClassOnlineWeb/Scripts/app.js").allowed).toBe(false);
    // Build output and restored packages belong to nobody.
    expect(canWritePath(backend, "ClassOnlineWeb/bin/ClassOnlineWeb.dll").allowed).toBe(false);
    expect(canWritePath(backend, "ClassOnlineWeb/packages/Newtonsoft.Json/lib.dll").allowed).toBe(false);
    // The role boundary the contract still owns.
    expect(canWritePath(backend, "contracts/backend-engineer.yaml").allowed).toBe(false);
    expect(canWritePath(backend, "_docs/module/crm/design.md").allowed).toBe(false);

    const frontend = pathRulesFor("frontend-engineer", workspace);
    expect(canWritePath(frontend, "ClassOnlineWeb/Views/Student/Index.cshtml").allowed).toBe(true);
    expect(canWritePath(frontend, "ClassOnlineWeb/Content/site.css").allowed).toBe(true);
    expect(canWritePath(frontend, "ClassOnlineWeb/Controllers/StudentController.cs").allowed).toBe(false);
    expect(canWritePath(frontend, "ClassOnlineWeb/VMModels/StudentVM.cs").allowed).toBe(false);
  });

  it("a source root of `.` grants the Target itself rather than emitting `./**`", () => {
    workspace = makeWorkspace(dotnetConfig(["."]));
    const backend = pathRulesFor("backend-engineer", workspace);
    expect(backend.write).toContain("**");
    expect(backend.write.some((glob) => glob.startsWith("./"))).toBe(false);
    expect(canWritePath(backend, "Controllers/StudentController.cs").allowed).toBe(true);
    // The floor and the contract boundary still apply on top of a whole-root grant.
    expect(canWritePath(backend, "bin/x.dll").allowed).toBe(false);
    expect(canWritePath(backend, ".git/config").allowed).toBe(false);
    expect(canWritePath(backend, "contracts/backend-engineer.yaml").allowed).toBe(false);
  });

  it("every recorded source root is expanded, not just the first", () => {
    workspace = makeWorkspace(dotnetConfig(["ApiWeb", "AdminWeb"]));
    const backend = pathRulesFor("backend-engineer", workspace);
    expect(backend.write).toContain("ApiWeb/**");
    expect(backend.write).toContain("AdminWeb/**");
  });

  /** The compatibility requirement: an installation that never recorded a stack must not lose write access. */
  it("a workspace with no recorded stack keeps the legacy Node/Prisma globs", () => {
    workspace = makeWorkspace();
    const backend = pathRulesFor("backend-engineer", workspace);
    expect([...backend.write].sort()).toEqual(
      ["README.md", "_docs/status-archive.md", "_docs/status.md", "app/api/**", "package.json", "prisma/**", "server/**", "src/lib/**", "src/server/**"].sort(),
    );
    expect([...backend.deny].sort()).toEqual(
      ["_docs/module/*/review.md", "_docs/module/*/review/**", "_docs/module/**", ".claude/**", "components/**", "contracts/**"].sort(),
    );

    const frontend = pathRulesFor("frontend-engineer", workspace);
    expect([...frontend.write].sort()).toEqual(
      ["_docs/status-archive.md", "_docs/status.md", "app/**", "components/**", "public/**", "src/app/**", "src/components/**", "styles/**"].sort(),
    );
    expect([...frontend.deny].sort()).toEqual(
      ["_docs/module/*/review.md", "_docs/module/*/review/**", "_docs/module/**", ".claude/**", "app/api/**", "contracts/**", "prisma/**", "server/**"].sort(),
    );
  });

  /** A Target that has not synced yet carries a `stacks/` payload with no permissions block. */
  it("falls back to the legacy globs rather than stripping write access on a pre-V5 stacks payload", () => {
    workspace = makeWorkspace(dotnetConfig(["ClassOnlineWeb"]));
    const stale = fs
      .readFileSync(path.join(workspace, "stacks", "dotnet", "stack.yaml"), "utf8")
      .replace(/\npermissions:[\s\S]*$/, "\n");
    expect(stale).not.toContain("permissions:");
    fs.writeFileSync(path.join(workspace, "stacks", "dotnet", "stack.yaml"), stale, "utf8");

    const backend = pathRulesFor("backend-engineer", workspace);
    expect(backend.write).toContain("server/**");
    expect(backend.write).toContain("prisma/**");
    expect(backend.write).not.toContain("ClassOnlineWeb/**");
  });

  it("a Target whose existing prompt overrides claim both engineer prompts still resolves a full write set", () => {
    // `sb-web-student` claimed .claude/agents/{backend,frontend}-engineer.md to work
    // around the Node-only globs. This task must not require un-claiming them.
    workspace = makeWorkspace(
      dotnetConfig(["ClassOnlineWeb"], "overrides:\n  - .claude/agents/frontend-engineer.md\n  - .claude/agents/backend-engineer.md"),
    );
    expect(pathRulesFor("backend-engineer", workspace).write).toContain("ClassOnlineWeb/**");
    expect(pathRulesFor("frontend-engineer", workspace).write).toContain("ClassOnlineWeb/Views/**");
  });

  it("checkPathRules fails when a stack-shaped glob drifts back into a contract", () => {
    workspace = makeWorkspace();
    expect(checkPathRules(workspace)).toEqual({ ok: true, problems: [] });

    const contract = path.join(workspace, "contracts", "backend-engineer.yaml");
    const text = fs.readFileSync(contract, "utf8");
    fs.writeFileSync(contract, text.replace('write: ["README.md"', 'write: ["server/**", "README.md"'), "utf8");

    const result = checkPathRules(workspace);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/backend-engineer: permissions\.write declares "server\/\*\*"/);
    expect(result.problems.join("\n")).toMatch(/stacks\/<profile>\/stack\.yaml permissions\.backend-engineer/);
  });

  it("leaves a non-engineer contract's own paths alone — only the two engineer roles are stack-scoped", () => {
    workspace = makeWorkspace();
    // devops/qa/security still name app paths in their read sets; that is a separate
    // question from the engineer write boundary and this check must not fail them.
    expect(contractPathRules("qa-engineer", workspace).read).toContain("app/**");
    expect(checkPathRules(workspace).ok).toBe(true);
  });
});

describe("V10 TASK-010 — target-side write rules", () => {
  const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("scopes Target writes to the role×stack allowlist — a root binding alone grants no path (V13 TASK-011)", () => {
    const rules = targetPathRules(AgentStage.BACKEND_ENGINEER, FRAMEWORK_ROOT);
    expect(rules.write).toEqual(pathRulesFor(AgentStage.BACKEND_ENGINEER, FRAMEWORK_ROOT).write);
    expect(rules.write).not.toContain("**");
    // What the contract+stack grant holds on the Knowledge side holds on the
    // Target side; everything else is refused by default.
    expect(canWritePath(rules, "server/routes/deal.ts").allowed).toBe(true);
    expect(canWritePath(rules, "infra/main.tf").allowed).toBe(false);
    expect(canWritePath(rules, "ClassOnlineWeb/Views/Home/Index.cshtml").allowed).toBe(false);
  });

  it("still refuses Knowledge artifacts and framework payload", () => {
    const rules = targetPathRules(AgentStage.BACKEND_ENGINEER, FRAMEWORK_ROOT);
    for (const relPath of ["knowledge/anything.md", "decisions/ADR-999.md", "_docs/module/m/design.md", "targets.yaml"]) {
      const decision = canWritePath(rules, relPath);
      expect(decision.allowed, relPath).toBe(false);
      expect(decision.allowed === false && decision.rule, relPath).toBe("agent-deny");
    }
    expect(canWritePath(rules, "contracts/backend-engineer.yaml").allowed).toBe(false);
    expect(canWritePath(rules, ".claude/hooks/block-path-permissions.js").allowed).toBe(false);
  });

  it("still refuses the universal floor", () => {
    const rules = targetPathRules(AgentStage.FRONTEND_ENGINEER, FRAMEWORK_ROOT);
    for (const relPath of UNIVERSAL_DENY.map((glob) => glob.replace("/**", "/probe.txt"))) {
      const decision = canWritePath(rules, relPath);
      expect(decision.allowed, relPath).toBe(false);
      expect(decision.allowed === false && decision.rule, relPath).toBe("universal-deny");
    }
  });

  it("does not add an allow list to the rendered hook guard block", () => {
    expect(renderGuardRuleBlock()).not.toContain("TARGET_WIDE_WRITE");
  });
});
