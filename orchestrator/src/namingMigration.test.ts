import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const excludedDirectories = new Set([".git", ".workflow", "node_modules", "dist", "planning", "release"]);
const excludedFiles = new Set([
  // Machine-local Codex hook wiring contains the checkout's physical path.
  // The parent directory is not a Framework identifier and cannot be renamed
  // without moving the user's checkout.
  ".codex/hooks.json",
  ".claude/settings.local.json",
]);

function textFiles(root: string, relative = ""): string[] {
  const current = path.join(root, relative);
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const normalized = child.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...textFiles(root, child));
      continue;
    }
    if (entry.isFile() && !excludedFiles.has(normalized)) files.push(normalized);
  }
  return files;
}

describe("vendor-neutral naming contract", () => {
  it("contains no legacy Framework identifier outside historical planning and the physical checkout path", () => {
    const offenders: string[] = [];
    const legacyIdentifier = ["agent", "claude"].join("");
    for (const relative of textFiles(projectRoot)) {
      const bytes = fs.readFileSync(path.join(projectRoot, relative));
      if (bytes.includes(0)) continue;
      if (bytes.toString("utf8").toLowerCase().includes(legacyIdentifier)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("publishes the vendor-neutral private package, binary and schema namespace", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "orchestrator", "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };
    expect(pkg.name).toBe("@software-team-agents/orchestrator");
    expect(pkg.bin).toEqual({ "sta-orchestrate": "dist/cli.js" });

    let schemaIds = 0;
    for (const file of fs.readdirSync(path.join(projectRoot, "orchestrator", "schemas"))) {
      if (!file.endsWith(".schema.json")) continue;
      const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, "orchestrator", "schemas", file), "utf8")) as { $id?: string };
      if (schema.$id === undefined) continue;
      schemaIds++;
      expect(schema.$id, file).toMatch(/^https:\/\/software-team-agents\.local\/schemas\//);
    }
    expect(schemaIds).toBeGreaterThan(0);
  });
});
