import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetsForRole,
  detectWorkspaceKind,
  KnowledgeBindingError,
  launchEnv,
  resolveKnowledgeBinding,
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
    expect(include("policies/documentation.md")).toBe(true);
    expect(include("CLAUDE.md")).toBe(true);

    expect(include(".claude/agents/backend-engineer.md")).toBe(false);
    expect(include(".claude/agents/frontend-engineer.md")).toBe(false);
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
});
