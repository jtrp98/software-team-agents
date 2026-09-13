import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(cursor, "package.json")) || !fs.existsSync(path.join(cursor, "prompt-setup.md"))) cursor = path.dirname(cursor);
  return cursor;
}

describe("T-V9-023 obsolete layout-conversion prompt removal", () => {
  const root = repoRoot();
  it("does not ship a legacy document-layout converter or its compatibility pointer", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).not.toContain("prompt-reconcile-knowledge-layout.md");
    expect(pkg.files).not.toContain("prompt-update-knowledge.md");
    expect(fs.existsSync(path.join(root, "prompt-reconcile-knowledge-layout.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "prompt-update-knowledge.md"))).toBe(false);
  });
});
