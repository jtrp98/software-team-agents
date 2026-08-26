import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { checkTemplateManifest, sha256Of } from "./templateManifest.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

function fixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-template-builder-"));
  roots.push(root);
  const files: Record<string, string> = {
    "CLAUDE.md": "# rules\n",
    ".claude/agents/business-analyst.md": "---\nname: business-analyst\n---\n",
    ".claude/commands/critic.md": "---\ndescription: critique\n---\n@_shared/guardrails.md\n",
    ".claude/commands/_shared/guardrails.md": "# shared guardrails include\n",
    ".claude/tests/run.js": "// self-test, never templated\n",
    "contracts/business-analyst.yaml": "write: []\n",
    "layout.yaml": "version: 1\n",
    "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version: "0.1.0" }),
    "orchestrator/src/cli.ts": "// framework source, never templated\n",
    "_docs/module/sales/requirement.md": "# req, never templated\n",
    "README.md": "# repo readme, never templated\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("buildTemplates", () => {
  it("copies every template file into outDir, preserving relative paths", () => {
    const root = fixtureRepo();
    const outDir = path.join(root, "out");
    const { manifest } = buildTemplates(root, outDir, NOW);

    expect(fs.readFileSync(path.join(outDir, "CLAUDE.md"), "utf8")).toBe("# rules\n");
    expect(fs.readFileSync(path.join(outDir, ".claude/agents/business-analyst.md"), "utf8")).toContain(
      "business-analyst",
    );
    expect(fs.readFileSync(path.join(outDir, ".claude/commands/_shared/guardrails.md"), "utf8")).toContain(
      "guardrails",
    );
    expect(manifest.framework_version).toBe("0.1.0");
    expect(checkTemplateManifest(manifest)).toEqual([]);
  });

  it("never copies framework source, self-tests, project docs, or this repo's own working docs", () => {
    const root = fixtureRepo();
    const outDir = path.join(root, "out");
    buildTemplates(root, outDir, NOW);

    for (const forbidden of [
      "orchestrator/src/cli.ts",
      ".claude/tests/run.js",
      "_docs/module/sales/requirement.md",
      "README.md",
    ]) {
      expect(fs.existsSync(path.join(outDir, forbidden))).toBe(false);
    }
  });

  it("writes manifest.json into outDir with correct hashes", () => {
    const root = fixtureRepo();
    const outDir = path.join(root, "out");
    buildTemplates(root, outDir, NOW);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    const claude = manifest.files.find((f: { path: string }) => f.path === "CLAUDE.md");
    expect(claude.sha256).toBe(sha256Of("# rules\n"));
  });

  it("is deterministic — re-running produces byte-identical copies and the same hashes", () => {
    const root = fixtureRepo();
    const outDir = path.join(root, "out");
    const first = buildTemplates(root, outDir, "2026-01-01T00:00:00Z");
    const second = buildTemplates(root, outDir, "2026-06-01T00:00:00Z");
    expect(second.manifest.files).toEqual(first.manifest.files);
  });

  it("throws a clear error when orchestrator/package.json has no version", () => {
    const root = fixtureRepo();
    fs.writeFileSync(path.join(root, "orchestrator/package.json"), JSON.stringify({ name: "x" }), "utf8");
    expect(() => buildTemplates(root, path.join(root, "out"), NOW)).toThrow(/version/);
  });
});

describe("buildTemplates against the real repo", () => {
  it("produces a valid manifest that includes the real framework files and excludes the real forbidden ones", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-template-builder-real-"));
    roots.push(outDir);

    const { manifest } = buildTemplates(repoRoot, outDir, NOW);
    expect(checkTemplateManifest(manifest)).toEqual([]);

    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("layout.yaml");
    expect(paths.some((p) => p.startsWith(".claude/agents/"))).toBe(true);
    expect(paths.some((p) => p.startsWith(".claude/commands/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("contracts/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("orchestrator/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".claude/tests/"))).toBe(false);
  });
});
