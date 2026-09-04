import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "../packaging/templateBuilder.js";
import { installedFrameworkVersion, parseVersion } from "./version.js";

const NOW = "2026-09-04T09:00:00Z";
const roots: string[] = [];

function fixtureRepo(pkgVersion: string, marker: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-version-"));
  roots.push(root);
  const files: Record<string, string> = {
    "CLAUDE.md": `# rules ${marker}\n`,
    "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version: "0.1.0" }),
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "software-team-agents", version: pkgVersion }));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  buildTemplates(root, path.join(root, "templates"), NOW);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("installedFrameworkVersion (T-V5-030)", () => {
  it("distinguishes two same-version Framework checkouts with different payloads", () => {
    const a = fixtureRepo("1.0.0-rc.3", "checkout-a");
    const b = fixtureRepo("1.0.0-rc.3", "checkout-b");

    const versionA = installedFrameworkVersion(a);
    const versionB = installedFrameworkVersion(b);

    expect(versionA).not.toBe(versionB);
    expect(parseVersion(versionA)).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion(versionB)).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it("reports the same string for two builds of identical payload at the same version", () => {
    const a = fixtureRepo("1.0.0-rc.3", "same-payload");
    const b = fixtureRepo("1.0.0-rc.3", "same-payload");

    expect(installedFrameworkVersion(a)).toBe(installedFrameworkVersion(b));
  });
});
