import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CURRENT_STA_SCHEMA_VERSION,
  InstallManifestMissingError,
  checkInstallManifest,
  installManifestPath,
  isInstalled,
  readInstallManifest,
  writeInstallManifest,
  type InstallManifest,
} from "./installManifest.js";

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-install-manifest-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function sample(): InstallManifest {
  return {
    schema_version: CURRENT_STA_SCHEMA_VERSION,
    framework_version: "0.1.0",
    installed_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    files: [{ path: "CLAUDE.md", sha256: "a".repeat(64), size_bytes: 10 }],
  };
}

describe("isInstalled / write / read", () => {
  it("is false before init, true after", () => {
    const root = tmpRoot();
    expect(isInstalled(root)).toBe(false);
    writeInstallManifest(root, sample());
    expect(isInstalled(root)).toBe(true);
    expect(fs.existsSync(installManifestPath(root))).toBe(true);
  });

  it("round-trips exactly", () => {
    const root = tmpRoot();
    const manifest = sample();
    writeInstallManifest(root, manifest);
    expect(readInstallManifest(root)).toEqual(manifest);
  });

  it("throws InstallManifestMissingError when absent", () => {
    const root = tmpRoot();
    expect(() => readInstallManifest(root)).toThrow(InstallManifestMissingError);
  });
});

describe("checkInstallManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(checkInstallManifest(sample())).toEqual([]);
  });

  it("rejects a duplicate path", () => {
    const manifest = sample();
    manifest.files.push({ ...manifest.files[0] });
    expect(checkInstallManifest(manifest).some((p) => p.includes("more than once"))).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { installed_at, ...rest } = sample();
    expect(checkInstallManifest(rest).length).toBeGreaterThan(0);
  });
});
