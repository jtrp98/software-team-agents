import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

/**
 * T-OC6 — the sta-guards OpenCode plugin, exercised through its real exported
 * factory (imported straight from `.opencode/plugin/sta-guards.js`, the same
 * file sync ships). The hook contract mirrors the Claude-side hooks: deny by
 * throwing a human-readable reason, fail open on anything unparseable.
 */

const pluginHref = pathToFileURL(path.resolve(import.meta.dirname, "../../../.opencode/plugin/sta-guards.js")).href;

const roots: string[] = [];
const envKeys = ["AGENTCLAUDE_ROLE", "AGENTCLAUDE_WRITABLE_WORK_ROOTS", "AGENTCLAUDE_KNOWLEDGE_ROOT"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function workspace(withContracts?: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guards-plugin-"));
  roots.push(root);
  if (withContracts) {
    fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
    for (const [name, content] of Object.entries(withContracts)) {
      fs.writeFileSync(path.join(root, "contracts", `${name}.yaml`), content, "utf8");
    }
  }
  return root;
}

async function hookFor(root: string) {
  const { StaGuards } = (await import(pluginHref)) as {
    StaGuards: (ctx: { project: { worktree: string } }) => Promise<{
      "tool.execute.before": (input: { tool: string }, output: { args: unknown }) => Promise<void>;
    }>;
  };
  const hooks = await StaGuards({ project: { worktree: root } });
  return async (tool: string, args: unknown): Promise<void> => {
    await hooks["tool.execute.before"]({ tool }, { args });
  };
}

function expectBlocked(error: unknown, match: RegExp): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(match);
}

describe("sta-guards plugin (OpenCode)", () => {
  it("allows writes inside the workspace and ignores non-path tools", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "_docs", "x.md") })).resolves.toBeUndefined();
    // Relative paths resolve against the workspace root.
    await expect(guard("edit", { file_path: "src/a.ts" })).resolves.toBeUndefined();
    // Bash never touches this guard (declarative permission globs own git).
    await expect(guard("bash", { command: "git push --force" })).resolves.toBeUndefined();
  });

  it("blocks writes resolving outside the workspace", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(path.dirname(root), "elsewhere.txt") })).rejects.toThrow(
      /outside the workspace root/,
    );
  });

  it("applies the universal deny floor before any contract", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, ".git", "config") })).rejects.toThrow(/no agent may write `.git\/\*\*`/);
    await expect(guard("patch", { path: path.join(root, "knowledge", "_roles", "dev.yaml") })).rejects.toThrow(
      /knowledge\/_roles/,
    );
  });

  it("enforces the role's contract write/deny lists when AGENTCLAUDE_ROLE is set", async () => {
    const root = workspace({
      "backend-engineer": 'schema_version: 1\npermissions:\n  capabilities:\n    - "write code"\n  paths:\n    write: ["src/**", "_docs/module/**/plan.md"]\n    deny: ["_docs/module/**/design.md"]\n',
    });
    process.env.AGENTCLAUDE_ROLE = "backend-engineer";
    const guard = await hookFor(root);

    await expect(guard("write", { filePath: path.join(root, "src", "x.ts") })).resolves.toBeUndefined();
    const denied = await guard("write", { filePath: path.join(root, "_docs", "module", "m", "design.md") }).catch((e) => e);
    expectBlocked(denied, /contract explicitly denies `_docs\/module\/\*\*\/design\.md`/);

    const outsideScope = await guard("write", { filePath: path.join(root, "docs", "other.md") }).catch((e) => e);
    expectBlocked(outsideScope, /may write: `src\/\*\*`/);
  });

  it("without a role only the universal floor holds — interactive runs stay usable", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "anything", "goes.txt") })).resolves.toBeUndefined();
  });

  it("honours canonical writable work roots and evaluates the floor relative to them", async () => {
    const root = workspace();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guards-target-"));
    roots.push(targetRoot);
    process.env.AGENTCLAUDE_WRITABLE_WORK_ROOTS = JSON.stringify([targetRoot]);
    const guard = await hookFor(root);

    await expect(guard("write", { filePath: path.join(targetRoot, "src", "x.ts") })).resolves.toBeUndefined();
    const denied = await guard("write", { filePath: path.join(targetRoot, ".workflow", "state.db") }).catch((e) => e);
    expectBlocked(denied, /\.workflow/);
    // An ungated sibling of the granted root stays blocked.
    await expect(guard("write", { filePath: path.join(targetRoot, "..", "sibling.txt") })).rejects.toThrow(
      /outside the workspace root|outside this role/,
    );
  });

  it("fails open on shapes it cannot parse rather than trapping the agent", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", {})).resolves.toBeUndefined();
    await expect(guard("notebookedit", { notebook_path: 42 })).resolves.toBeUndefined();
  });
});

describe("sta-guards plugin — workspace-role tripwire (T-WG3)", () => {
  function roleWorkspace(role: "ba" | "dev"): string {
    const root = workspace();
    fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent-team", "config.yaml"),
      `schema_version: 1\ntarget_id: t\nregistered_at: 2026-08-24T00:00:00Z\noverrides: []\nrole: ${role}\n`,
      "utf8",
    );
    return root;
  }

  it("dev workspace blocks analysis artifacts and registry files, interactively included", async () => {
    const root = roleWorkspace("dev");
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "plan.md") })).rejects.toThrow(/Knowledge repository/);
    await expect(guard("write", { filePath: path.join(root, "_docs", "status.md") })).rejects.toThrow(/Knowledge repository/);
    await expect(guard("write", { filePath: path.join(root, "decisions", "DR-001.yaml") })).rejects.toThrow(/Knowledge repository/);
    await expect(guard("write", { filePath: path.join(root, "targets.yaml") })).rejects.toThrow(/Knowledge repository/);
    // Engineer-owned docs and app code remain writable in a dev workspace.
    await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "review.md") })).resolves.toBeUndefined();
    await expect(guard("write", { filePath: path.join(root, "src", "a.ts") })).resolves.toBeUndefined();
  });

  it("deny text names the resolved Knowledge root when the launch provides it (T-WG7 env)", async () => {
    const root = roleWorkspace("dev");
    process.env.AGENTCLAUDE_KNOWLEDGE_ROOT = path.join(path.dirname(root), "kb-fixture");
    const guard = await hookFor(root);
    const err = await guard("write", { filePath: path.join(root, "_docs", "module", "m", "requirement.md") }).catch((e) => e);
    expectBlocked(err, /kb-fixture/);
  });

  it("ba workspace mirrors the rule for engineer/pipeline payload", async () => {
    const root = roleWorkspace("ba");
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "contracts", "backend-engineer.yaml") })).rejects.toThrow(/Target checkout/);
    await expect(guard("write", { filePath: path.join(root, "workflows", "feature.yml") })).rejects.toThrow(/Target checkout/);
    await expect(guard("edit", { file_path: "_docs/module/m/design.md" })).resolves.toBeUndefined();
  });

  it("without .agent-team/config.yaml nothing changes (legacy workspaces)", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "contracts", "x.yaml") })).resolves.toBeUndefined();
    await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "plan.md") })).resolves.toBeUndefined();
  });
});
