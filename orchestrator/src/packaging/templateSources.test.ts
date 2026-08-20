import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NEVER_TEMPLATED, TEMPLATE_SOURCES, listTemplateFiles } from "./templateSources.js";

/** A minimal repo shaped like this one — just enough of each home to prove the boundary. */
function fixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-template-sources-"));
  const files: Record<string, string> = {
    "CLAUDE.md": "# rules\n",
    ".claude/agents/business-analyst.md": "---\nname: business-analyst\n---\n",
    ".claude/hooks/block-git.js": "// hook\n",
    ".claude/scripts/generate-status.js": "// script\n",
    ".claude/shared/multi-module-schema-scoping.md": "# procedure\n",
    ".claude/settings.json": "{}\n",
    ".claude/tests/run.js": "// self-test, never templated\n",
    "contracts/business-analyst.yaml": "write: []\n",
    "workflows/feature.yml": "roles: []\n",
    "policies/coding.md": "# coding\n",
    "stacks/nextjs-express/stack.yaml": "language: typescript\n",
    "layout.yaml": "version: 1\n",
    "escalation-policy.yaml": "severities: []\n",
    "knowledge-policy.yaml": "roles: []\n",
    "test-pyramid.yaml": "levels: []\n",
    "orchestrator/src/cli.ts": "// framework source, never templated\n",
    "_docs/module/sales/requirement.md": "# req\n",
    "decisions/ADR-001.md": "# adr\n",
    "knowledge/sales/requirement/REQ-001.yaml": "id: REQ-001\n",
    ".workflow/state.yaml": "tasks: []\n",
    "project.yaml": "stack: nextjs-express\n",
    "README.md": "# repo readme, never templated\n",
    "MERGE_GUIDE.md": "# merge guide, never templated\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  return root;
}

describe("listTemplateFiles", () => {
  it("includes every file under a TEMPLATE_SOURCES home", () => {
    const root = fixtureRepo();
    const files = listTemplateFiles(root);
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain(".claude/agents/business-analyst.md");
    expect(files).toContain(".claude/hooks/block-git.js");
    expect(files).toContain(".claude/scripts/generate-status.js");
    expect(files).toContain(".claude/shared/multi-module-schema-scoping.md");
    expect(files).toContain(".claude/settings.json");
    expect(files).toContain("contracts/business-analyst.yaml");
    expect(files).toContain("workflows/feature.yml");
    expect(files).toContain("policies/coding.md");
    expect(files).toContain("stacks/nextjs-express/stack.yaml");
    expect(files).toContain("layout.yaml");
    expect(files).toContain("escalation-policy.yaml");
    expect(files).toContain("knowledge-policy.yaml");
    expect(files).toContain("test-pyramid.yaml");
  });

  it("never includes framework source or project-owned state", () => {
    const root = fixtureRepo();
    const files = listTemplateFiles(root);
    for (const forbidden of [
      "orchestrator/src/cli.ts",
      ".claude/tests/run.js",
      "_docs/module/sales/requirement.md",
      "decisions/ADR-001.md",
      "knowledge/sales/requirement/REQ-001.yaml",
      ".workflow/state.yaml",
      "project.yaml",
      "README.md",
      "MERGE_GUIDE.md",
    ]) {
      expect(files).not.toContain(forbidden);
    }
  });

  it("tolerates a home that does not exist yet, rather than throwing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-template-sources-empty-"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# rules\n", "utf8");
    expect(() => listTemplateFiles(root)).not.toThrow();
    expect(listTemplateFiles(root)).toEqual(["CLAUDE.md"]);
  });

  it("is deterministic and sorted", () => {
    const root = fixtureRepo();
    const first = listTemplateFiles(root);
    const second = listTemplateFiles(root);
    expect(second).toEqual(first);
    expect(first).toEqual([...first].sort());
  });
});

describe("NEVER_TEMPLATED", () => {
  it("names nothing that also appears as a TEMPLATE_SOURCES home", () => {
    const homes = new Set(TEMPLATE_SOURCES.map((s) => s.relPath));
    for (const forbidden of NEVER_TEMPLATED) {
      expect(homes.has(forbidden)).toBe(false);
    }
  });
});
