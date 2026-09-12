import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "tsconfig.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("orchestrator package root not found");
    cursor = parent;
  }
}

describe("clean compiled distribution", () => {
  it("cleans dist before TypeScript emits the release payload", () => {
    const root = findPackageRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.build).toBe("node scripts/clean-dist.mjs && tsc -p tsconfig.json");

    const cleaner = fs.readFileSync(path.join(root, "scripts", "clean-dist.mjs"), "utf8");
    expect(cleaner).toContain('path.basename(distRoot) !== "dist"');
    expect(cleaner).toContain("fs.rmSync(distRoot");
  });
});
