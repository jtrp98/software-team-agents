import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeZcodeHooks, renderZcodeConfigJson, renderZcodeManagedHooks, ZCODE_CONFIG_PATH } from "../runtime/bindingGenerator.js";
import { RUNTIME_SUPPORT } from "../runtime/runtimeSupport.js";
import { zcodeCoverage, zcodeCoverageWithSyncedPayload } from "./guardSettings.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE = fs.readFileSync(path.join(REPO_ROOT, "templates", ".zcode", "config.json"), "utf8");

describe("zcode guard payload (V12)", () => {
  it("the shipped template is exactly what renderZcodeConfigJson emits — one source, no drift", () => {
    expect(TEMPLATE).toBe(renderZcodeConfigJson());
  });

  it("the managed hooks wire the four PreToolUse guard scripts and the Stop pair, always enabled", () => {
    const managed = renderZcodeManagedHooks();
    expect(managed.enabled).toBe(true);
    const scripts = [...managed.events.PreToolUse, ...managed.events.Stop].flatMap((r) => r.hooks.map((h) => h.args[0]));
    for (const script of ["block-git.js", "block-outside-repo.js", "block-doc-rewrite.js", "block-path-permissions.js", "require-green-before-stop.js", "block-secret-leak.js"]) {
      expect(scripts).toContain(`\${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}`);
    }
  });

  it("merges into a project-owned config without touching foreign keys", () => {
    const project = JSON.stringify({
      mcp: { servers: { fs: {} } },
      hooks: { enabled: false, events: { UserPromptSubmit: [{ hooks: [] }] } },
    });
    const merged = mergeZcodeHooks(project);
    expect(merged.ok).toBe(true);
    expect(merged.changed).toBe(true);
    const parsed = JSON.parse(merged.content!) as {
      mcp: unknown;
      hooks: { enabled: boolean; events: Record<string, unknown[]> };
    };
    expect(parsed.mcp).toEqual({ servers: { fs: {} } });
    expect(parsed.hooks.enabled).toBe(true);
    expect(parsed.hooks.events.UserPromptSubmit).toEqual([{ hooks: [] }]);
    expect(parsed.hooks.events.PreToolUse).toHaveLength(4);
    expect(parsed.hooks.events.Stop).toHaveLength(1);
  });

  it("is idempotent — merging an already-current file reports unchanged", () => {
    const once = mergeZcodeHooks(TEMPLATE);
    expect(once.ok).toBe(true);
    expect(once.changed).toBe(false);
  });

  it("refuses invalid JSON instead of reading it as no-drift", () => {
    const merged = mergeZcodeHooks("{oops");
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain(ZCODE_CONFIG_PATH);
  });

  it("coverage fails closed: a missing or disabled payload is unguarded", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cov-"));
    try {
      expect(zcodeCoverage(root).level).toBe("unguarded");
      fs.mkdirSync(path.join(root, ".zcode"));
      fs.writeFileSync(path.join(root, ZCODE_CONFIG_PATH), JSON.stringify({ hooks: { enabled: false } }));
      const disabled = zcodeCoverage(root);
      expect(disabled.level).toBe("unguarded");
      expect(disabled.detail).toContain("hooks.enabled");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("coverage is partial with PRE_TOOL_GUARD enforced once the payload is synced and enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cov-"));
    try {
      fs.mkdirSync(path.join(root, ".zcode"));
      fs.writeFileSync(path.join(root, ZCODE_CONFIG_PATH), renderZcodeConfigJson());
      const coverage = zcodeCoverage(root);
      expect(coverage.level).toBe("partial");
      expect(coverage.enforced).toContain("pre-tool-guard");
      expect(coverage.detail).toContain("GUARD GAP");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the registry claim quotes the shipped coverage detail", () => {
    expect(RUNTIME_SUPPORT.zcode.claim).toContain(zcodeCoverageWithSyncedPayload().detail);
  });
});
