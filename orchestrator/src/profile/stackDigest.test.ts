import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderStackDigest } from "./stackDigest.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-stack-digest-"));
  roots.push(root);
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "backend-engineer.md"), "# B\n\n## Fixed project stack\n\n- Express\n\n## Other\nignore\n");
  fs.writeFileSync(path.join(dir, "frontend-engineer.md"), "# F\n\n## Fixed project stack\n\n- Next.js\n");
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
describe("renderStackDigest", () => {
  it("derives the digest from both authoritative prompt sections", () => {
    const root = fixture();
    expect(renderStackDigest(root)).toContain("- Express");
    expect(renderStackDigest(root)).toContain("- Next.js");
    fs.writeFileSync(path.join(root, ".claude", "agents", "backend-engineer.md"), "## Fixed project stack\n\n- Fastify\n");
    expect(renderStackDigest(root)).toContain("- Fastify");
  });
});
