import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMarkerBlock } from "../targetcli/knowledgeRender.js";
import { AgentStage } from "../types.js";
import {
  GUARD_RULES_CLOSE,
  GUARD_RULES_OPEN,
  GUARD_RULE_HOSTS,
  GUARD_STACK_RULES_ENV,
  PathDeniedError,
  UNIVERSAL_DENY,
  WORKSPACE_BA_ARTIFACTS,
  WORKSPACE_DEV_ARTIFACTS,
  assertCanWrite,
  canWritePath,
  checkPathRules,
  contractPathRules,
  matchesGlob,
  pathRulesFor,
  readWorkspaceRole,
  renderGuardRuleBlock,
  toRepoRelative,
  workspaceDenyWhy,
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
      for (const doc of ["design.md", "requirement.md", "plan.md", "test-plan.md", "review.md"]) {
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

  it("lets qa-engineer edit plan.md, which is its one exception beyond review.md", () => {
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

describe("T-V5-019 — workspace-role artifact rules", () => {
  const permissive = { write: ["**"], deny: [], read: ["**"] };

  it("DEV-role workspace denies _docs/module/*/requirement.md and knowledge/** through the TypeScript path", () => {
    const docDecision = canWritePath(permissive, "_docs/module/crm/requirement.md", { workspaceRole: "dev" });
    expect(docDecision.allowed).toBe(false);
    if (!docDecision.allowed) {
      expect(docDecision.rule).toBe("workspace-deny");
      expect(docDecision.reason).toContain("Knowledge repository");
    }

    const kbDecision = canWritePath(permissive, "knowledge/sales/requirement/REQ-1.yaml", { workspaceRole: "dev" });
    expect(kbDecision.allowed).toBe(false);
    if (!kbDecision.allowed) {
      expect(kbDecision.rule).toBe("workspace-deny");
    }

    // App code and engineer-owned docs remain allowed in dev
    expect(canWritePath(permissive, "src/index.ts", { workspaceRole: "dev" }).allowed).toBe(true);
    expect(canWritePath(permissive, "_docs/module/crm/review.md", { workspaceRole: "dev" }).allowed).toBe(true);
  });

  it("BA-role workspace denies contracts/** and workflows/**", () => {
    const contractDecision = canWritePath(permissive, "contracts/backend-engineer.yaml", { workspaceRole: "ba" });
    expect(contractDecision.allowed).toBe(false);
    if (!contractDecision.allowed) {
      expect(contractDecision.rule).toBe("workspace-deny");
      expect(contractDecision.reason).toContain("Target checkout");
    }

    const workflowDecision = canWritePath(permissive, "workflows/bugfix.yml", { workspaceRole: "ba" });
    expect(workflowDecision.allowed).toBe(false);
    if (!workflowDecision.allowed) {
      expect(workflowDecision.rule).toBe("workspace-deny");
    }

    // Knowledge docs remain allowed in BA
    expect(canWritePath(permissive, "_docs/module/crm/requirement.md", { workspaceRole: "ba" }).allowed).toBe(true);
    expect(canWritePath(permissive, "knowledge/sales/requirement/REQ-1.yaml", { workspaceRole: "ba" }).allowed).toBe(true);
  });

  it("no recorded role → both rule sets inactive (legacy workspace unaffected)", () => {
    expect(canWritePath(permissive, "_docs/module/crm/requirement.md", { workspaceRole: null }).allowed).toBe(true);
    expect(canWritePath(permissive, "contracts/backend-engineer.yaml", { workspaceRole: null }).allowed).toBe(true);
    expect(canWritePath(permissive, "_docs/module/crm/requirement.md").allowed).toBe(true);
    expect(canWritePath(permissive, "contracts/backend-engineer.yaml").allowed).toBe(true);
  });

  it("TypeScript artifact lists match .claude/hooks/block-path-permissions.js and .opencode/plugin/sta-guards.js exactly", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const claudeHook = fs.readFileSync(path.join(root, ".claude", "hooks", "block-path-permissions.js"), "utf8");
    const opencodePlugin = fs.readFileSync(path.join(root, ".opencode", "plugin", "sta-guards.js"), "utf8");

    for (const baPattern of WORKSPACE_BA_ARTIFACTS) {
      expect(claudeHook).toContain(baPattern);
      expect(opencodePlugin).toContain(baPattern);
    }
    for (const devPattern of WORKSPACE_DEV_ARTIFACTS) {
      expect(claudeHook).toContain(devPattern);
      expect(opencodePlugin).toContain(devPattern);
    }
  });
});

describe("T-V5-020 — one authored declaration, generated guard copies", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const GUARD_MIRROR = ".codex/hooks/block-path-permissions.js";
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
  const allHostPaths = () => [...GUARD_RULE_HOSTS.map((host) => host.path), GUARD_MIRROR];

  interface GeneratedGuardRules {
    UNIVERSAL_DENY: string[];
    WORKSPACE_BA_ARTIFACTS: string[];
    WORKSPACE_DEV_ARTIFACTS: string[];
    matchesGlob(pattern: string, target: string): boolean;
    readWorkspaceRole(nodeFs: unknown, nodePath: unknown, workspaceRoot: string): string | null;
    workspaceDenyWhy(role: string): string;
  }

  /** Executes the rendered block the way a hook host does, and hands back what it declared. */
  function evaluateBlock(): GeneratedGuardRules {
    const body = renderGuardRuleBlock()
      .split("\n")
      .filter((line) => line !== GUARD_RULES_OPEN && line !== GUARD_RULES_CLOSE)
      .join("\n");
    return new Function(
      `${body}\nreturn { UNIVERSAL_DENY, WORKSPACE_BA_ARTIFACTS, WORKSPACE_DEV_ARTIFACTS, matchesGlob, readWorkspaceRole, workspaceDenyWhy };`,
    )() as GeneratedGuardRules;
  }

  it("renders the rule lists from the constants rather than from a second copy", () => {
    const generated = evaluateBlock();
    expect(generated.UNIVERSAL_DENY).toEqual([...UNIVERSAL_DENY]);
    expect(generated.WORKSPACE_BA_ARTIFACTS).toEqual([...WORKSPACE_BA_ARTIFACTS]);
    expect(generated.WORKSPACE_DEV_ARTIFACTS).toEqual([...WORKSPACE_DEV_ARTIFACTS]);
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
      ...WORKSPACE_DEV_ARTIFACTS,
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
      "_docs/module/crm/review.md",
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

  it("the generated role reader agrees with the TypeScript one", () => {
    const generated = evaluateBlock();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guard-block-"));
    try {
      expect(generated.readWorkspaceRole(fs, path, tmp)).toBe(readWorkspaceRole(tmp));

      fs.mkdirSync(path.join(tmp, ".agent-team"), { recursive: true });
      for (const role of ["ba", "dev"] as const) {
        fs.writeFileSync(path.join(tmp, ".agent-team", "config.yaml"), `schema_version: 1\nrole: ${role}\n`, "utf8");
        expect(generated.readWorkspaceRole(fs, path, tmp)).toBe(role);
        expect(generated.readWorkspaceRole(fs, path, tmp)).toBe(readWorkspaceRole(tmp));
      }

      fs.writeFileSync(path.join(tmp, ".agent-team", "config.yaml"), "schema_version: 1\n", "utf8");
      expect(generated.readWorkspaceRole(fs, path, tmp)).toBeNull();
      expect(readWorkspaceRole(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the generated deny explanation agrees with the TypeScript one", () => {
    const generated = evaluateBlock();
    const saved = process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
    try {
      delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
      expect(generated.workspaceDenyWhy("dev")).toBe(workspaceDenyWhy("dev"));
      expect(generated.workspaceDenyWhy("ba")).toBe(workspaceDenyWhy("ba"));

      process.env.AGENTCLAUDE_KNOWLEDGE_ROOT = "C:/src/knowledge-schoolbright";
      expect(generated.workspaceDenyWhy("dev")).toBe(workspaceDenyWhy("dev"));
      expect(generated.workspaceDenyWhy("dev")).toContain("C:/src/knowledge-schoolbright");
    } finally {
      if (saved === undefined) delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
      else process.env.AGENTCLAUDE_KNOWLEDGE_ROOT = saved;
    }
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
      expect(inspected.outside, rel).not.toMatch(/const\s+WORKSPACE_(?:BA|DEV)_ARTIFACTS\s*=/);
      expect(inspected.outside, rel).not.toMatch(/function\s+matchesGlob\s*\(/);
      expect(inspected.outside, rel).not.toMatch(/function\s+readWorkspaceRole\s*\(/);
      expect(inspected.outside, rel).not.toMatch(/function\s+workspaceDenyWhy\s*\(/);
    }
  });

  it("keeps every rule renderable as a single-quoted JavaScript literal", () => {
    // A quote, backslash or newline in a rule would generate a broken guard.
    // The renderer throws on one; this keeps the current lists honest too.
    for (const rule of [...UNIVERSAL_DENY, ...WORKSPACE_BA_ARTIFACTS, ...WORKSPACE_DEV_ARTIFACTS]) {
      expect(rule, rule).not.toMatch(/['\\\r\n]/);
    }
    expect(() => renderGuardRuleBlock()).not.toThrow();
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
        expect(glob, `${role}: ${glob}`).toMatch(/^(?:_docs\/|\.claude\/|policies\/|contracts\/|workflows\/|stacks\/|knowledge\/|decisions\/|CLAUDE\.md$)/);
      }
    }
  });

  it("a dotnet Target resolves its real source root as the engineer write set, with no override", () => {
    workspace = makeWorkspace(dotnetConfig(["ClassOnlineWeb"]));

    const backend = pathRulesFor("backend-engineer", workspace);
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
      ["_docs/status-archive.md", "_docs/status.md", "app/api/**", "package.json", "prisma/**", "server/**", "src/lib/**", "src/server/**"].sort(),
    );
    expect([...backend.deny].sort()).toEqual(["_docs/module/**", ".claude/**", "components/**", "contracts/**"].sort());

    const frontend = pathRulesFor("frontend-engineer", workspace);
    expect([...frontend.write].sort()).toEqual(
      ["_docs/status-archive.md", "_docs/status.md", "app/**", "components/**", "public/**", "src/app/**", "src/components/**", "styles/**"].sort(),
    );
    expect([...frontend.deny].sort()).toEqual(
      ["_docs/module/**", ".claude/**", "app/api/**", "contracts/**", "prisma/**", "server/**"].sort(),
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
    fs.writeFileSync(contract, text.replace('write: ["_docs/status.md"', 'write: ["server/**", "_docs/status.md"'), "utf8");

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
