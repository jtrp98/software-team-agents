import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  checkTemplateManifest,
  readFrameworkVersion,
  sha256Of,
  type TemplateManifest,
} from "./templateManifest.js";

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-template-manifest-"));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  return root;
}

const NOW = "2026-08-20T09:00:00Z";

describe("readFrameworkVersion", () => {
  it("reads package.json's version field", () => {
    const root = fixtureRepo({ "package.json": JSON.stringify({ version: "1.2.3" }) });
    expect(readFrameworkVersion(root)).toBe("1.2.3");
  });

  it("prefers the repo-root distributable over the orchestrator dev package — one source names both the .tgz and the manifest", () => {
    const root = fixtureRepo({
      "package.json": JSON.stringify({ name: "software-team-agents", version: "2.0.0" }),
      "orchestrator/package.json": JSON.stringify({ version: "0.9.0" }),
    });
    expect(readFrameworkVersion(root)).toBe("2.0.0");
  });

  it("throws when no candidate package.json has a version", () => {
    const root = fixtureRepo({ "package.json": JSON.stringify({ name: "x" }) });
    expect(() => readFrameworkVersion(root)).toThrow(/version/);
  });
});

describe("buildManifest", () => {
  it("hashes every listed file and records its size", () => {
    const root = fixtureRepo({ "CLAUDE.md": "# rules\n", "layout.yaml": "version: 1\n" });
    const manifest = buildManifest(root, ["CLAUDE.md", "layout.yaml"], "1.0.0", NOW);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.framework_version).toBe("1.0.0");
    expect(manifest.generated_at).toBe(NOW);
    expect(manifest.files).toHaveLength(2);
    const claude = manifest.files.find((f) => f.path === "CLAUDE.md")!;
    expect(claude.sha256).toBe(sha256Of("# rules\n"));
    expect(claude.size_bytes).toBe(Buffer.byteLength("# rules\n"));
  });

  it("is deterministic — same content, same hash, regardless of when it runs", () => {
    const root = fixtureRepo({ "CLAUDE.md": "# rules\n" });
    const a = buildManifest(root, ["CLAUDE.md"], "1.0.0", "2026-01-01T00:00:00Z");
    const b = buildManifest(root, ["CLAUDE.md"], "1.0.0", "2026-06-01T00:00:00Z");
    expect(a.files[0].sha256).toBe(b.files[0].sha256);
  });
});

describe("checkTemplateManifest", () => {
  function validManifest(): TemplateManifest {
    return {
      schema_version: 1,
      framework_version: "1.0.0",
      generated_at: NOW,
      files: [{ path: "CLAUDE.md", sha256: sha256Of("# rules\n"), size_bytes: 8 }],
    };
  }

  it("accepts a well-formed manifest", () => {
    expect(checkTemplateManifest(validManifest())).toEqual([]);
  });

  it("rejects a duplicate path", () => {
    const manifest = validManifest();
    manifest.files.push({ ...manifest.files[0] });
    const problems = checkTemplateManifest(manifest);
    expect(problems.some((p) => p.includes("listed more than once"))).toBe(true);
  });

  it("rejects a malformed sha256", () => {
    const manifest = validManifest();
    manifest.files[0].sha256 = "not-a-hash";
    expect(checkTemplateManifest(manifest).length).toBeGreaterThan(0);
  });

  it("rejects an unknown top-level field", () => {
    const problems = checkTemplateManifest({ ...validManifest(), extra: true });
    expect(problems.length).toBeGreaterThan(0);
  });
});
