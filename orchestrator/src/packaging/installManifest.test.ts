import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CURRENT_STA_SCHEMA_VERSION,
  InstallManifestMissingError,
  installManifestPath,
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

/**
 * T-V5-038 — `isInstalled` and `checkInstallManifest` (ajv schema check)
 * existed only for the now-deleted `sta init`/`installValidation` legacy
 * branch and were removed with it; this module now serves only `sta
 * migrate` (T96), which reads/rewrites an existing manifest's schema_version.
 */
describe("write / read", () => {
  it("round-trips exactly", () => {
    const root = tmpRoot();
    const manifest = sample();
    writeInstallManifest(root, manifest);
    expect(fs.existsSync(installManifestPath(root))).toBe(true);
    expect(readInstallManifest(root)).toEqual(manifest);
  });

  it("throws InstallManifestMissingError when absent", () => {
    const root = tmpRoot();
    expect(() => readInstallManifest(root)).toThrow(InstallManifestMissingError);
  });
});
