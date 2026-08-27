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

  it("`_docs/` never makes an app repo ambiguous — this framework puts it there itself", () => {
    // Regression: `_docs` counted as a Knowledge marker, so a target repo with a
    // docs folder came back "ambiguous" and `init` demanded an explicit --role.
    // Since module docs live at `_docs/module/<name>/` INSIDE the target, that
    // eventually described every DEV workspace — the tool's own output made its
    // own detection undecidable.
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
  it("BA carries lane agents + guards + policies, never engineer payload", () => {
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

    expect(include(".claude/agents/backend-engineer.md")).toBe(false);
    expect(include(".claude/agents/frontend-engineer.md")).toBe(false);
    // Derived renderings never ship in the payload, whatever the lane.
    expect(include(".opencode/agent/backend-engineer.md")).toBe(false);
    expect(include("contracts/backend.yaml")).toBe(false);
    expect(include("workflows/bugfix.yml")).toBe(false);
    expect(include("stacks/node/stack.yaml")).toBe(false);
    expect(include("layout.yaml")).toBe(false);
  });

  it("DEV carries the full roster and pipeline payload", () => {
    const include = assetsForRole("dev");
    expect(include(".claude/agents/backend-engineer.md")).toBe(true);
    expect(include("contracts/backend.yaml")).toBe(true);
    expect(include("workflows/bugfix.yml")).toBe(true);
    expect(include("test-pyramid.yaml")).toBe(true);
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

describe("target binding (T-LV1)", () => {
  function targetRepo(): string {
    const t = tmpRoot("app");
    fs.writeFileSync(path.join(t, "package.json"), "{}");
    return t;
  }

  it("returns undefined (silently — no throw) when target.path is not set", () => {
    const knowledge = tmpRoot("kb-no-target");
    const binding = resolveTargetBinding({ knowledgeRoot: knowledge });
    expect(binding).toBeUndefined();
  });

  it("resolves a relative config binding against the knowledge root", () => {
    const knowledge = tmpRoot("kb");
    const t = targetRepo();
    const name = path.basename(t);
    fs.renameSync(t, path.join(path.dirname(knowledge), name));
    const binding = resolveTargetBinding({
      knowledgeRoot: knowledge,
      configTargetPath: path.join("..", name),
    });
    expect(binding?.via).toBe("workspace-config");
    expect(fs.existsSync(binding!.targetRoot)).toBe(true);
  });

  it("fails closed (throws) with recovery advice for a missing path", () => {
    const knowledge = tmpRoot("kb2");
    expect(() =>
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetPath: "../does-not-exist" }),
    ).toThrow(TargetBindingError);
    try {
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetPath: "../does-not-exist" });
    } catch (e) {
      expect((e as Error).message).toMatch(/clone|config\.yaml/);
    }
  });

  it("rejects a directory that is not a Target repo (no app-source markers)", () => {
    const knowledge = tmpRoot("kb3");
    const plain = tmpRoot("plain2");
    expect(() =>
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetPath: plain }),
    ).toThrow(/not a Target repository/);
  });

  it("refuses a binding inside the Knowledge workspace itself (overlap guard)", () => {
    const knowledge = tmpRoot("kb4");
    fs.writeFileSync(path.join(knowledge, "package.json"), "{}");
    expect(() =>
      resolveTargetBinding({ knowledgeRoot: knowledge, configTargetPath: "." }),
    ).toThrow(/separate from the Knowledge workspace/);
  });
});

describe("T-WG5 — the confirm-workspace checkpoint ships to both lanes' synced payload", () => {
  // repo root's own templates/ snapshot, rebuilt by `npm run build:templates`
  // (build:templates is required before this test passes — same as any other
  // check against generated output; see CLAUDE.md's guardrail against
  // patching templates/ directly instead of its sources).
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
    expect(docPolicy).toMatch(/## 0\. Before writing anything — confirm workspace ↔ lane/);
    expect(docPolicy).toContain("stop and ask the user before writing any doc file at all");

    const claudeMd = fs.readFileSync(path.join(templatesRoot, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/Confirm workspace ↔ lane before writing anything/);

    const setupAgent = fs.readFileSync(path.join(templatesRoot, ".claude", "agents", "setup.md"), "utf8");
    expect(setupAgent).toContain("T-WG5");

    const baAgent = fs.readFileSync(path.join(templatesRoot, ".claude", "agents", "business-analyst.md"), "utf8");
    expect(baAgent).toContain("T-WG5");
  });

  it("T-LV3 — qa-engineer's chosen sync mechanism (review.md -> BA-lane sync) is documented, not aspirational", () => {
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
