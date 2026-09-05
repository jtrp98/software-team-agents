import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetsForRole,
  detectWorkspaceKind,
  KnowledgeBindingError,
  launchEnv,
  resolveKnowledgeBinding,
  resolveTargetBinding,
  TargetBindingError,
} from "./roleWorkspace.js";
import { loadTargetConfig, removedTargetPath, removedTargetPathProblem } from "./targetMeta.js";

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-role-${prefix}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace kind detection (T-ROLE-16)", () => {
  it("classifies by markers: knowledge / target / ambiguous / unrecognized", () => {
    const k = tmpRoot("k");
    fs.mkdirSync(path.join(k, "knowledge"));
    expect(detectWorkspaceKind(k)).toBe("knowledge");

    const t = tmpRoot("t");
    fs.writeFileSync(path.join(t, "package.json"), "{}");
    expect(detectWorkspaceKind(t)).toBe("target");

    const both = tmpRoot("both");
    fs.mkdirSync(path.join(both, "knowledge"));
    fs.writeFileSync(path.join(both, "pyproject.toml"), "");
    expect(detectWorkspaceKind(both)).toBe("ambiguous");

    const none = tmpRoot("none");
    expect(detectWorkspaceKind(none)).toBe("unrecognized");

    // .NET projects count as application source too.
    const dotnet = tmpRoot("dotnet");
    fs.writeFileSync(path.join(dotnet, "Acme.sln"), "");
    expect(detectWorkspaceKind(dotnet)).toBe("target");

    const nestedDotnet = tmpRoot("nested-dotnet");
    fs.mkdirSync(path.join(nestedDotnet, "ClassOnlineWeb"));
    fs.writeFileSync(path.join(nestedDotnet, "ClassOnlineWeb", "ClassOnlineWeb.csproj"), "");
    expect(detectWorkspaceKind(nestedDotnet)).toBe("target");
  });

  /**
   * `knowledge-policy.yaml` is not a marker. Detection decides which
   * repository a session may write to, so all five outcomes are pinned here
   * rather than left to the composite case above.
   */
  describe("detection after the third marker was retired", () => {
    function writeRole(root: string, role: string): void {
      fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
      fs.writeFileSync(path.join(root, ".agent-team", "config.yaml"), `schema_version: 1\ntarget_id: x\nrole: ${role}\n`, "utf8");
    }

    it("1/5 pre-init Knowledge: a fresh clone is recognised from its committed markers alone", () => {
      // Neither .agent-team/ nor knowledge-policy.yaml — exactly a `git clone`
      // of a Knowledge repo before anyone has run `init` on this machine.
      const clone = tmpRoot("pre-init-knowledge");
      fs.mkdirSync(path.join(clone, "knowledge"));
      fs.writeFileSync(path.join(clone, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
      expect(detectWorkspaceKind(clone)).toBe("knowledge");

      // Either committed marker is sufficient on its own.
      const onlyTargets = tmpRoot("pre-init-targets-only");
      fs.writeFileSync(path.join(onlyTargets, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
      expect(detectWorkspaceKind(onlyTargets)).toBe("knowledge");
    });

    it("2/5 post-init Knowledge: the recorded role decides, markers or not", () => {
      const initialised = tmpRoot("post-init-knowledge");
      writeRole(initialised, "ba");
      expect(detectWorkspaceKind(initialised)).toBe("knowledge");
    });

    it("3/5 Target: app source, and a recorded dev role outranks Knowledge-shaped files", () => {
      const target = tmpRoot("target");
      fs.writeFileSync(path.join(target, "package.json"), "{}", "utf8");
      expect(detectWorkspaceKind(target)).toBe("target");

      // A DEV workspace that also carries a knowledge/ folder is NOT ambiguous:
      // a person already answered that question at init. Getting this wrong
      // routes writes to the wrong repository.
      const devWithKnowledgeDir = tmpRoot("dev-with-knowledge");
      fs.writeFileSync(path.join(devWithKnowledgeDir, "package.json"), "{}", "utf8");
      fs.mkdirSync(path.join(devWithKnowledgeDir, "knowledge"));
      writeRole(devWithKnowledgeDir, "dev");
      expect(detectWorkspaceKind(devWithKnowledgeDir)).toBe("target");
    });

    it("4/5 ambiguous: both marker families, nothing recorded — init still demands --role", () => {
      const both = tmpRoot("ambiguous");
      fs.mkdirSync(path.join(both, "knowledge"));
      fs.writeFileSync(path.join(both, "package.json"), "{}", "utf8");
      expect(detectWorkspaceKind(both)).toBe("ambiguous");
    });

    it("5/5 unrecognised: an empty directory, and a lone knowledge-policy.yaml is no longer a marker", () => {
      expect(detectWorkspaceKind(tmpRoot("unrecognised"))).toBe("unrecognized");

      const policyOnly = tmpRoot("policy-only");
      fs.writeFileSync(path.join(policyOnly, "knowledge-policy.yaml"), "version: 1\n", "utf8");
      expect(detectWorkspaceKind(policyOnly)).toBe("unrecognized");
    });

    it("a config this CLI cannot fully parse still yields its role rather than losing detection", () => {
      const future = tmpRoot("future-schema");
      fs.mkdirSync(path.join(future, ".agent-team"), { recursive: true });
      fs.writeFileSync(
        path.join(future, ".agent-team", "config.yaml"),
        "schema_version: 99\nrole: ba\nunknown_future_key:\n  nested: true\n",
        "utf8",
      );
      expect(detectWorkspaceKind(future)).toBe("knowledge");
    });
  });

  it("`_docs/` never makes an app repo ambiguous — this framework puts it there itself", () => {
    // Regression: `_docs` must not count as a Knowledge marker. Module docs
    // live at `_docs/module/<name>/` INSIDE the target, so counting it would
    // make every DEV workspace "ambiguous" once its first module doc lands.
    const target = tmpRoot("docs-target");
    fs.writeFileSync(path.join(target, "package.json"), "{}");
    fs.mkdirSync(path.join(target, "_docs", "module", "sales-crm"), { recursive: true });
    expect(detectWorkspaceKind(target)).toBe("target");

    // A docs folder alone still identifies nothing — Knowledge needs a real marker.
    const docsOnly = tmpRoot("docs-only");
    fs.mkdirSync(path.join(docsOnly, "_docs"));
    expect(detectWorkspaceKind(docsOnly)).toBe("unrecognized");

    // And a genuine Knowledge repo is unaffected.
    const knowledge = tmpRoot("kb");
    fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets: []\n");
    fs.mkdirSync(path.join(knowledge, "_docs"));
    expect(detectWorkspaceKind(knowledge)).toBe("knowledge");
  });
});

describe("role asset profiles (T-ROLE-09/10/11)", () => {
  it("BA carries BA-workspace agents + guards + policies, never engineer payload", () => {
    const include = assetsForRole("ba");
    expect(include(".claude/agents/business-analyst.md")).toBe(true);
    expect(include(".claude/agents/system-analyst.md")).toBe(true);
    expect(include(".claude/agents/project-manager.md")).toBe(true);
    expect(include(".claude/agents/test-planner.md")).toBe(true);
    expect(include(".claude/hooks/block-git.js")).toBe(true);
    expect(include(".claude/settings.json")).toBe(true);
    expect(include(".claude/scripts/check-doc-structure.js")).toBe(true);
    expect(include(".opencode/plugin/sta-guards.js")).toBe(true);
    expect(include("policies/documentation.md")).toBe(true);
    expect(include("CLAUDE.md")).toBe(true);
    // The document/plan checkers are CI and are BA-workspace payload only.
    expect(include(".github/workflows/knowledge-ci.yml")).toBe(true);

    expect(include(".claude/agents/backend-engineer.md")).toBe(false);
    expect(include(".claude/agents/frontend-engineer.md")).toBe(false);
    // Derived renderings never ship in the payload, whatever the workspace role.
    expect(include(".opencode/agent/backend-engineer.md")).toBe(false);
    expect(include("contracts/backend.yaml")).toBe(false);
    expect(include("workflows/bugfix.yml")).toBe(false);
    expect(include("stacks/node/stack.yaml")).toBe(false);
    expect(include("layout.yaml")).toBe(false);
  });

  it("DEV carries the full roster and pipeline payload, but not the Knowledge document CI", () => {
    const include = assetsForRole("dev");
    expect(include(".claude/agents/backend-engineer.md")).toBe(true);
    expect(include("contracts/backend.yaml")).toBe(true);
    expect(include("workflows/bugfix.yml")).toBe(true);
    expect(include("test-pyramid.yaml")).toBe(true);
    // A Target has no `_docs/**` of its own for these checks to run against.
    expect(include(".github/workflows/knowledge-ci.yml")).toBe(false);
  });
});

describe("knowledge binding (T-ROLE-06/T-ROLE-08)", () => {
  function knowledgeRepo(): string {
    const k = tmpRoot("kb");
    fs.mkdirSync(path.join(k, ".git"));
    fs.mkdirSync(path.join(k, "knowledge"));
    fs.writeFileSync(path.join(k, "targets.yaml"), "schema_version: 1\ntargets: []\n");
    return k;
  }

  it("resolves a relative config binding against the target root", () => {
    const workspace = tmpRoot("ws");
    const k = knowledgeRepo();
    const name = path.basename(k);
    fs.renameSync(k, path.join(path.dirname(workspace), name));
    const binding = resolveKnowledgeBinding({
      targetRoot: workspace,
      configKnowledgePath: path.join("..", name),
      installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
    });
    expect(binding?.via).toBe("workspace-config");
    expect(fs.existsSync(binding!.knowledgeRoot)).toBe(true);
  });

  it("fails closed with recovery advice for a missing path", () => {
    const workspace = tmpRoot("ws2");
    expect(() =>
      resolveKnowledgeBinding({
        targetRoot: workspace,
        configKnowledgePath: "../does-not-exist",
        installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
      }),
    ).toThrow(KnowledgeBindingError);
    try {
      resolveKnowledgeBinding({
        targetRoot: workspace,
        configKnowledgePath: "../does-not-exist",
        installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
      });
    } catch (e) {
      expect((e as Error).message).toMatch(/clone|config\.yaml/);
    }
  });

  it("rejects a directory that is not a Knowledge repo", () => {
    const workspace = tmpRoot("ws3");
    const plain = tmpRoot("plain");
    expect(() =>
      resolveKnowledgeBinding({
        targetRoot: workspace,
        configKnowledgePath: plain,
        installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
      }),
    ).toThrow(/not a Knowledge repository/);
  });

  it("refuses a binding inside the workspace itself", () => {
    const workspace = tmpRoot("ws4");
    fs.mkdirSync(path.join(workspace, "knowledge"));
    fs.writeFileSync(path.join(workspace, "knowledge-policy.yaml"), "version: 1\n");
    expect(() =>
      resolveKnowledgeBinding({
        targetRoot: workspace,
        configKnowledgePath: ".",
        installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
      }),
    ).toThrow(/separate from the Target/);
  });

  it("returns undefined (not a throw) when no binding exists anywhere", () => {
    const workspace = tmpRoot("ws5");
    const binding = resolveKnowledgeBinding({
      targetRoot: workspace,
      installationConfigPath: path.join(workspace, "no-such-installation.yaml"),
    });
    expect(binding).toBeUndefined();
  });
});

describe("write-policy launch wiring (T-ROLE-12/13)", () => {
  it("grants zero cross-root writable roots regardless of inherited shell env", () => {
    for (const role of ["ba", "dev"] as const) {
      const env = launchEnv(role, { AGENTCLAUDE_WRITABLE_WORK_ROOTS: '["D:\\somewhere-else"]', PATH: "keep" });
      expect(env.AGENTCLAUDE_WRITABLE_WORK_ROOTS).toBe("[]");
      expect(env.PATH).toBe("keep");
    }
  });

  it("T-WG7 — a DEV launch carries AGENTCLAUDE_KNOWLEDGE_ROOT; a BA launch without one does not", () => {
    const dev = launchEnv("dev", {}, "C:\\kb");
    expect(dev.AGENTCLAUDE_KNOWLEDGE_ROOT).toBe("C:\\kb");
    expect(launchEnv("ba", {}).AGENTCLAUDE_KNOWLEDGE_ROOT).toBeUndefined();
  });

  it("T-LV1 — a launch carries AGENTCLAUDE_TARGET_ROOT only when a Target binding resolved", () => {
    const withTarget = launchEnv("ba", {}, undefined, "C:\\app");
    expect(withTarget.AGENTCLAUDE_TARGET_ROOT).toBe("C:\\app");
    expect(launchEnv("ba", {}).AGENTCLAUDE_TARGET_ROOT).toBeUndefined();
  });

  it("T-V3TOK-042 — BA and DEV launches carry the resolved context command without changing other env", () => {
    for (const role of ["ba", "dev"] as const) {
      const env = launchEnv(role, { PATH: "keep" }, undefined, undefined, '"C:\\Program Files\\node.exe" C:\\sta\\cli.js context');
      expect(env.AGENTCLAUDE_CONTEXT_CMD).toContain("cli.js context");
      expect(env.PATH).toBe("keep");
    }
  });
});

/**
 * Asserts the contract for the removed `target.path` field: it is ignored,
 * reported, and never fatal. Validation for the surviving `target_id` path
 * (missing mapping, not-a-Target-repo, overlap guard) lives in the "target
 * binding by id" block below.
 */
describe("target binding without the removed target.path", () => {
  function writeConfig(root: string, body: string): void {
    fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-team", "config.yaml"), body, "utf8");
  }

  it("returns undefined (silently — no throw) when no target binding is set", () => {
    const knowledge = tmpRoot("kb-no-target");
    const binding = resolveTargetBinding({ knowledgeRoot: knowledge });
    expect(binding).toBeUndefined();
  });

  it("a config still carrying target.path loads — it is stripped, never a validation failure", () => {
    const knowledge = tmpRoot("kb-legacy-path");
    writeConfig(
      knowledge,
      "schema_version: 1\ntarget_id: kb\nregistered_at: 2026-08-24T06:13:07.517Z\noverrides: []\nrole: ba\ntarget:\n  path: C:\\src\\somewhere\\app\n",
    );
    const config = loadTargetConfig(knowledge);
    expect(config?.role).toBe("ba");
    expect(config?.target?.target_id).toBeUndefined();
    expect((config?.target as Record<string, unknown> | undefined)?.path).toBeUndefined();
  });

  it("the removed field is still readable so status can name it, with the fix in the message", () => {
    const knowledge = tmpRoot("kb-legacy-report");
    writeConfig(
      knowledge,
      "schema_version: 1\ntarget_id: kb\nregistered_at: 2026-08-24T06:13:07.517Z\noverrides: []\nrole: ba\ntarget:\n  path: C:\\src\\somewhere\\app\n",
    );
    const legacy = removedTargetPath(knowledge);
    expect(legacy).toBe("C:\\src\\somewhere\\app");
    const problem = removedTargetPathProblem(legacy!);
    expect(problem).toContain("target.path");
    expect(problem).toContain("target_id");
    expect(problem).toContain("targets.local.yaml");
    // ...and it resolves to no binding rather than to the stale path.
    expect(resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: loadTargetConfig(knowledge)?.target?.target_id })).toBeUndefined();
  });

  it("reports nothing for a migrated config and nothing for a workspace with no config at all", () => {
    const migrated = tmpRoot("kb-migrated");
    writeConfig(migrated, "schema_version: 1\ntarget_id: kb\nregistered_at: 2026-08-24T06:13:07.517Z\noverrides: []\nrole: ba\ntarget:\n  target_id: app\n");
    expect(removedTargetPath(migrated)).toBeUndefined();
    expect(removedTargetPath(tmpRoot("kb-bare"))).toBeUndefined();
  });
});

describe("target binding by id (T-V5-017 — one Target-location mechanism)", () => {
  function standaloneAppRepo(prefix: string): string {
    const app = tmpRoot(prefix);
    fs.mkdirSync(path.join(app, ".git"));
    fs.writeFileSync(path.join(app, "package.json"), "{}");
    return app;
  }
  function knowledgeWithRegistry(appId: string, appPath?: string): string {
    const knowledge = tmpRoot("kb-id");
    fs.mkdirSync(path.join(knowledge, ".git"));
    fs.mkdirSync(path.join(knowledge, "knowledge"));
    fs.writeFileSync(
      path.join(knowledge, "targets.yaml"),
      `schema_version: 1\ntargets:\n  - target_id: ${appId}\n    name: App\n    remote_url: https://github.com/acme/app.git\n    status: active\n`,
    );
    if (appPath) {
      fs.mkdirSync(path.join(knowledge, ".workflow"), { recursive: true });
      fs.writeFileSync(
        path.join(knowledge, ".workflow", "targets.local.yaml"),
        `schema_version: 1\ntargets:\n  ${appId}:\n    path: ${JSON.stringify(appPath)}\n`,
      );
    }
    return knowledge;
  }

  it("resolves target_id through .workflow/targets.local.yaml with no committed path and no warning", () => {
    const app = standaloneAppRepo("app");
    const knowledge = knowledgeWithRegistry("app", app);
    const binding = resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: "app" });
    expect(binding?.via).toBe("local-mapping");
    expect(binding?.targetId).toBe("app");
    expect(fs.realpathSync.native(binding!.targetRoot)).toBe(fs.realpathSync.native(app));
  });

  it("resolves on a second machine with no edit to a committed file — the mapping is machine-local", () => {
    // "Second machine" = a different checkout location; only .workflow/targets.local.yaml differs.
    const app = standaloneAppRepo("app2");
    const secondKnowledge = knowledgeWithRegistry("app", app);
    const binding = resolveTargetBinding({ knowledgeRoot: secondKnowledge, configTargetId: "app" });
    expect(binding?.via).toBe("local-mapping");
    expect(fs.existsSync(binding!.targetRoot)).toBe(true);
  });

  it("an unknown target_id fails with the registry named as the fix", () => {
    const app = standaloneAppRepo("app3");
    const knowledge = knowledgeWithRegistry("app", app);
    try {
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: "other" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TargetBindingError);
      expect((e as Error).message).toContain("unknown Target \"other\"");
      expect((e as Error).message).toContain("targets.yaml");
    }
  });

  it("a configured id with no local mapping fails naming .workflow/targets.local.yaml", () => {
    const knowledge = knowledgeWithRegistry("app");
    try {
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: "app" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TargetBindingError);
      expect((e as Error).message).toContain("targets.local.yaml");
    }
  });

  it("a mapping path without application markers is rejected — looksLikeTargetRoot still applies", () => {
    const plain = tmpRoot("not-an-app");
    fs.mkdirSync(path.join(plain, ".git"));
    const knowledge = knowledgeWithRegistry("app", plain);
    expect(() => resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: "app" })).toThrow(/not a Target repository/);
  });

  it("a mapping path overlapping the Knowledge root is rejected by the shared loader", () => {
    const app = standaloneAppRepo("app4");
    const knowledge = knowledgeWithRegistry("app", app);
    // Point the mapping at the Knowledge root itself — the loader's overlap rule must fire.
    fs.writeFileSync(
      path.join(knowledge, ".workflow", "targets.local.yaml"),
      `schema_version: 1\ntargets:\n  app:\n    path: ${JSON.stringify(knowledge)}\n`,
    );
    expect(() => resolveTargetBinding({ knowledgeRoot: knowledge, configTargetId: "app" })).toThrow(/overlap/i);
  });
});

describe("T-WG5 — the confirm-workspace checkpoint ships to both workspace roles' synced payload", () => {
  // repo root's own templates/ snapshot; run `npm run build:templates` first
  // if it's stale — see CLAUDE.md's guardrail against patching templates/
  // directly instead of its sources.
  const templatesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates");

  it("policies/documentation.md's §0 checkpoint is included in both the BA and DEV asset profiles", () => {
    for (const role of ["ba", "dev"] as const) {
      const include = assetsForRole(role);
      expect(include("policies/documentation.md")).toBe(true);
      expect(include("CLAUDE.md")).toBe(true);
    }
  });

  it("the checkpoint text is actually present in the synced source files (not just referenced)", () => {
    const docPolicy = fs.readFileSync(path.join(templatesRoot, "policies", "documentation.md"), "utf8");
    expect(docPolicy).toMatch(/## 0\. Before writing anything — confirm workspace ↔ workspace role/);
    expect(docPolicy).toContain("stop and ask the user before writing any doc file at all");

    const claudeMd = fs.readFileSync(path.join(templatesRoot, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/Confirm workspace ↔ workspace role before writing anything/);

    const setupAgent = fs.readFileSync(path.join(templatesRoot, ".claude", "agents", "setup.md"), "utf8");
    expect(setupAgent).toContain("T-WG5");

    const baAgent = fs.readFileSync(path.join(templatesRoot, ".claude", "agents", "business-analyst.md"), "utf8");
    expect(baAgent).toContain("T-WG5");
  });

  it("T-LV3 — qa-engineer's chosen sync mechanism (review.md -> BA-workspace sync) is documented, not aspirational", () => {
    const qaAgent = fs.readFileSync(path.join(templatesRoot, ".claude", "agents", "qa-engineer.md"), "utf8");
    expect(qaAgent).toContain("Knowledge / Target / three-repo mode");
    expect(qaAgent).toContain("Knowledge sync");
    expect(qaAgent).toMatch(/role: dev/);

    const contract = fs.readFileSync(path.join(templatesRoot, "..", "contracts", "qa-engineer.yaml"), "utf8");
    expect(contract).toMatch(/T-LV3/);

    const claudeMd = fs.readFileSync(path.join(templatesRoot, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/T-LV3/);
  });

  it("TEAM_SETUP_V1.md exists and every reference to it resolves (no broken canonical link)", () => {
    const repoRoot = path.resolve(templatesRoot, "..");
    expect(fs.existsSync(path.join(repoRoot, "TEAM_SETUP_V1.md"))).toBe(true);
    for (const referencing of ["AGENTS.md", "CLAUDE.md"]) {
      const content = fs.readFileSync(path.join(repoRoot, referencing), "utf8");
      if (content.includes("TEAM_SETUP_V1.md")) {
        expect(fs.existsSync(path.join(repoRoot, "TEAM_SETUP_V1.md"))).toBe(true);
      }
    }
  });
});
