import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(cursor, "package.json")) || !fs.existsSync(path.join(cursor, "prompt-setup.md"))) cursor = path.dirname(cursor);
  return cursor;
}

describe("T-V3-14 layout reconciliation prompt compatibility", () => {
  const root = repoRoot();
  const renamed = fs.readFileSync(path.join(root, "prompt-reconcile-knowledge-layout.md"), "utf8");
  const stub = fs.readFileSync(path.join(root, "prompt-update-knowledge.md"), "utf8");
  it("keeps exactly the five layout buckets and the safety rails, with an evidence-command pointer only", () => {
    expect([...renamed.matchAll(/^### Bucket [A-E] —/gm)].map((match) => match[0])).toHaveLength(5);
    expect(renamed).toContain("## Safety rails — never, under this playbook");
    expect(renamed).toMatch(/reconciles file layout/);
    expect(renamed).toMatch(/does not read a Target/);
    expect(renamed).toContain("sta knowledge reconcile --target <id>");
  });
  it("ships both names for the one-release compatibility window", () => {
    expect(stub).toContain("prompt-reconcile-knowledge-layout.md");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["prompt-update-knowledge.md", "prompt-reconcile-knowledge-layout.md"]));
  });
});
