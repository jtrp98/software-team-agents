import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(cursor, "package.json")) || !fs.existsSync(path.join(cursor, "prompt-setup.md"))) cursor = path.dirname(cursor);
  return cursor;
}

describe("T-V9-023 / T-V9-024 prompt packaging and layout separation", () => {
  const root = repoRoot();
  it("does not ship a legacy document-layout converter", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).not.toContain("prompt-reconcile-knowledge-layout.md");
    expect(fs.existsSync(path.join(root, "prompt-reconcile-knowledge-layout.md"))).toBe(false);
  });

  it("ships prompt-update-knowledge.md as a canonical knowledge refresh playbook, not a legacy converter pointer", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("prompt-update-knowledge.md");
    expect(fs.existsSync(path.join(root, "prompt-update-knowledge.md"))).toBe(true);
    const content = fs.readFileSync(path.join(root, "prompt-update-knowledge.md"), "utf8");
    expect(content).not.toContain("# Compatibility pointer");
    expect(content).toContain("# prompt-update-knowledge.md — AI-Assisted Knowledge Refresh Playbook");
  });
});
