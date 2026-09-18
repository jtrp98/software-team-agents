import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPolicySections, policyPointerResolves } from "../docs/policyIndex.js";
import { sha256Of } from "../packaging/templateManifest.js";
import { defaultOpenCodePermissions, renderCodexBinding, renderOpenCodeBinding } from "../runtime/bindingGenerator.js";
import { runTargetSync } from "./syncEngine.js";
import { readTargetManifest } from "./targetMeta.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Snapshot of the V11 Track-A payload: `policies/standards.md` plus the role prompts
 * pointing at it. Roles are derived from the standards index itself so a role added
 * there is snapshot-checked here automatically; the index's own completeness is pinned
 * by `docs/standards.test.ts`.
 */
function roleSections(): (readonly [role: string, section: number])[] {
  const standards = listPolicySections(REPO_ROOT).find((entry) => entry.area === "standards");
  expect(standards, "policies/standards.md exists").toBeDefined();
  return standards!.sections
    .filter((section) => section.number !== null && Number(section.number) >= 1)
    .map((section) => {
      const role = section.heading.slice(section.heading.indexOf(" ") + 1).trim();
      return [role, Number(section.number)] as const;
    });
}

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-standards-${prefix}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Real repo bytes of the Track-A payload, packaged in the manifest shape build:templates emits. */
function buildTemplatesDir(): string {
  const dir = tmpRoot("framework");
  const entries: { path: string; sha256: string; size_bytes: number }[] = [];
  const add = (relPath: string, content: string): void => {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    entries.push({ path: relPath, sha256: sha256Of(content), size_bytes: Buffer.byteLength(content) });
  };
  add("policies/standards.md", fs.readFileSync(path.join(REPO_ROOT, "policies", "standards.md"), "utf8"));
  add("policies/README.md", fs.readFileSync(path.join(REPO_ROOT, "policies", "README.md"), "utf8"));
  for (const [role] of roleSections()) {
    add(`.claude/agents/${role}.md`, fs.readFileSync(path.join(REPO_ROOT, ".claude", "agents", `${role}.md`), "utf8"));
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify({ schema_version: 1, framework_version: "4.0.0", generated_at: "2026-01-01T00:00:00Z", files: entries.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`,
    "utf8",
  );
  const stack = path.join(dir, "stacks", "node", "stack.yaml");
  fs.mkdirSync(path.dirname(stack), { recursive: true });
  fs.writeFileSync(stack, "stack: node\nkind: backend\nlanguage: typescript\nruntime: node\nframeworks: [express]\ndatabase: []\napi: [rest]\npackage_manager: npm\ncommands:\n  install: npm install\n  build: npm run build\n  test: npm test\n  lint: npm run lint\n  typecheck: npm run typecheck\ncapabilities: [testing]\n", "utf8");
  return dir;
}

function gitTarget(): string {
  const target = tmpRoot("target");
  fs.mkdirSync(path.join(target, ".git"));
  fs.writeFileSync(path.join(target, "package.json"), '{"name":"fixture"}\n', "utf8");
  fs.writeFileSync(path.join(target, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  return target;
}

describe("standards payload snapshot at sync (V11 TASK-005)", () => {
  it("ships the standards index pristine and lands every role prompt with both renderings carrying its pointer", () => {
    const target = gitTarget();
    runTargetSync({ targetRoot: target, templatesDir: buildTemplatesDir(), now: "2026-01-01T00:00:00Z" });

    expect(fs.readFileSync(path.join(target, "policies", "standards.md"), "utf8")).toBe(
      fs.readFileSync(path.join(REPO_ROOT, "policies", "standards.md"), "utf8"),
    );
    expect(fs.existsSync(path.join(target, "policies", "README.md"))).toBe(true);

    const claimed = readTargetManifest(target).files.map((file) => file.path);
    expect(claimed).toContain("policies/standards.md");

    for (const [role, n] of roleSections()) {
      const source = fs.readFileSync(path.join(REPO_ROOT, ".claude", "agents", `${role}.md`), "utf8");
      const pointer = `policies/standards.md §${n}`;
      expect(source, role).toContain(pointer);
      expect(policyPointerResolves(REPO_ROOT, "standards", String(n)), role).toBe(true);

      expect(fs.readFileSync(path.join(target, ".claude", "agents", `${role}.md`), "utf8")).toBe(source);

      const opencode = fs.readFileSync(path.join(target, ".opencode", "agent", `${role}.md`), "utf8");
      expect(opencode).toBe(renderOpenCodeBinding(source, defaultOpenCodePermissions()));
      expect(opencode, role).toContain(pointer);

      const codex = fs.readFileSync(path.join(target, ".codex", "agents", `${role}.toml`), "utf8");
      expect(codex).toBe(renderCodexBinding(source));
      expect(codex, role).toContain(pointer);

      expect(claimed, role).toContain(`.opencode/agent/${role}.md`);
      expect(claimed, role).toContain(`.codex/agents/${role}.toml`);
    }
  });
});
