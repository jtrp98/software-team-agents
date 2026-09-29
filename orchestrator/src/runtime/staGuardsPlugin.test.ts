import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

/**
 * The sta-guards OpenCode plugin, exercised through its real exported factory
 * (imported straight from `.opencode/plugin/sta-guards.js`, the same file
 * sync ships). The hook contract mirrors the Claude-side hooks: deny by
 * throwing a human-readable reason, fail open on anything unparseable.
 */

const pluginHref = pathToFileURL(path.resolve(import.meta.dirname, "../../../.opencode/plugin/sta-guards.js")).href;

const roots: string[] = [];
const envKeys = ["STA_ROLE", "STA_WRITABLE_WORK_ROOTS", "STA_TARGET_WORK_ROOTS", "STA_KNOWLEDGE_ROOT", "STA_KNOWLEDGE_ROOT_NAME"] as const;
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
    await expect(guard("write", { filePath: path.join(root, "src", "x.md") })).resolves.toBeUndefined();
    // Relative paths resolve against the workspace root.
    await expect(guard("edit", { file_path: "src/a.ts" })).resolves.toBeUndefined();
    // Bash never touches this guard (declarative permission globs own git).
    await expect(guard("bash", { command: "git push --force" })).resolves.toBeUndefined();
    // V13 TASK-012: the governed artifact tree is refused on the unassigned
    // floor — a session claim grants nothing.
    await expect(guard("write", { filePath: path.join(root, "_docs", "x.md") })).rejects.toThrow(/STA dispatch/);
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

  it("enforces the role's contract write/deny lists when STA_ROLE is set", async () => {
    const root = workspace({
      "backend-engineer": 'schema_version: 1\npermissions:\n  capabilities:\n    - "write code"\n  paths:\n    write: ["src/**", "_docs/module/**/plan.md"]\n    deny: ["_docs/module/**/design.md"]\n',
    });
    process.env.STA_ROLE = "backend-engineer";
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
    process.env.STA_WRITABLE_WORK_ROOTS = JSON.stringify([targetRoot]);
    const guard = await hookFor(root);

    await expect(guard("write", { filePath: path.join(targetRoot, "src", "x.ts") })).resolves.toBeUndefined();
    const denied = await guard("write", { filePath: path.join(targetRoot, ".workflow", "state.db") }).catch((e) => e);
    expectBlocked(denied, /\.workflow/);
    // An ungated sibling of the granted root stays blocked.
    await expect(guard("write", { filePath: path.join(targetRoot, "..", "sibling.txt") })).rejects.toThrow(
      /outside the workspace root|outside this role/,
    );
  });

  it("T-V9-012 names a bound read-only Target and keeps an unbound Target outside the write scope", async () => {
    const root = workspace();
    const writableTarget = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guards-writable-target-"));
    const readOnlyTarget = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guards-readonly-target-"));
    const unboundTarget = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guards-unbound-target-"));
    roots.push(writableTarget, readOnlyTarget, unboundTarget);
    process.env.STA_ROLE = "backend-engineer";
    process.env.STA_WRITABLE_WORK_ROOTS = JSON.stringify([writableTarget]);
    process.env.STA_TARGET_WORK_ROOTS = JSON.stringify([
      { targetId: "api", path: writableTarget, access: "write" },
      { targetId: "web", path: readOnlyTarget, access: "read" },
    ]);
    const guard = await hookFor(root);

    await expect(guard("write", { filePath: path.join(writableTarget, "src", "owned.ts") })).resolves.toBeUndefined();
    await expect(guard("write", { filePath: path.join(readOnlyTarget, "src", "foreign.ts") })).rejects.toThrow(
      /Target "web".*bound read-only.*backend-engineer/,
    );
    await expect(guard("write", { filePath: path.join(unboundTarget, "src", "unbound.ts") })).rejects.toThrow(
      /outside the workspace root/,
    );
  });

  it("fails open on shapes it cannot parse rather than trapping the agent", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", {})).resolves.toBeUndefined();
    await expect(guard("notebookedit", { notebook_path: 42 })).resolves.toBeUndefined();
  });
});

describe("sta-guards plugin — Framework payload is stage-bound (V10 TASK-021)", () => {
  function roleWorkspace(role: "ba" | "dev"): string {
    const root = workspace();
    fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent-team", "config.yaml"),
      `schema_version: 1
target_id: t
registered_at: 2026-08-24T00:00:00Z
overrides: []
role: ${role}
`,
      "utf8",
    );
    return root;
  }

  it("refuses Framework payload to a named stage, whatever the workspace recorded", async () => {
    for (const role of ["ba", "dev"] as const) {
      const root = roleWorkspace(role);
      process.env.STA_ROLE = "backend-engineer";
      const guard = await hookFor(root);
      await expect(guard("write", { filePath: path.join(root, "contracts", "backend-engineer.yaml") })).rejects.toThrow(/Framework payload/);
      await expect(guard("write", { filePath: path.join(root, "workflows", "feature.yml") })).rejects.toThrow(/Framework payload/);
      await expect(guard("write", { filePath: path.join(root, "src", "a.ts") })).resolves.toBeUndefined();
    }
  });

  it("stops keying anything off the recorded role: both roles answer identically", async () => {
    for (const role of ["ba", "dev"] as const) {
      const root = roleWorkspace(role);
      delete process.env.STA_ROLE;
      const guard = await hookFor(root);
      // The recorded role still decides nothing (V13 TASK-012): the governed
      // artifact tree is refused identically for both roles on the unassigned
      // floor, and everything outside it answers identically too.
      await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "plan.md") })).rejects.toThrow(/STA dispatch/);
      await expect(guard("write", { filePath: path.join(root, "_docs", "status.md") })).rejects.toThrow(/STA dispatch/);
      await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "qa.md") })).rejects.toThrow(/STA dispatch/);
      await expect(guard("write", { filePath: path.join(root, "targets.yaml") })).resolves.toBeUndefined();
      await expect(guard("write", { filePath: path.join(root, "src", "a.ts") })).resolves.toBeUndefined();
    }
  });

  it("names no removed `ba`/`dev` command in a denial", async () => {
    const root = roleWorkspace("ba");
    process.env.STA_ROLE = "backend-engineer";
    const guard = await hookFor(root);
    const err = await guard("write", { filePath: path.join(root, "contracts", "backend-engineer.yaml") }).catch((e) => e);
    expectBlocked(err, /Framework payload/);
    expect(String((err as Error).message)).not.toMatch(/software-team-agents (ba|dev)/);
  });

  it("without .agent-team/config.yaml nothing changes (legacy workspaces)", async () => {
    const root = workspace();
    const guard = await hookFor(root);
    await expect(guard("write", { filePath: path.join(root, "contracts", "x.yaml") })).resolves.toBeUndefined();
    // The unassigned floor's governed-artifact refusal needs no config either.
    await expect(guard("write", { filePath: path.join(root, "_docs", "module", "m", "plan.md") })).rejects.toThrow(/STA dispatch/);
  });
});
