import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallationConfigError, loadInstallationConfig, normalizeKnowledgeRoots } from "./installation.js";

/**
 * Installation schema v2 with a dual-reader loader (DR §2/§8.1): a v1 file
 * keeps validating and is normalized in memory to a synthetic `default` root
 * without being rewritten; a v2 file carries the named-root map plus the
 * `knowledge_root` compatibility alias, and the invariants Ajv cannot express
 * are enforced after it, fail-closed, before any caller sees the config.
 */

let workspace: string | undefined;

function writeInstallation(yaml: string): string {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sta-installation-schema-"));
  const file = path.join(workspace, "installation.yaml");
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

function v2Yaml(defaultRoot: string, knowledgeRoot: string, map: Record<string, string>, identities = ""): string {
  return [
    "schema_version: 2",
    `knowledge_root: ${knowledgeRoot}`,
    `default_root: ${defaultRoot}`,
    "knowledge_roots:",
    ...Object.entries(map).map(([name, value]) => `  ${name}: ${value}`),
    ...(identities ? [identities] : []),
    "",
  ].join("\n");
}

afterEach(() => {
  if (workspace) {
    fs.rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("installation schema v2 — dual-reader loader", () => {
  it("validates a v1 fixture and normalizes it to a synthetic default root without rewriting the file", () => {
    const file = writeInstallation("schema_version: 1\nknowledge_root: /roots/personal\n");
    const before = fs.readFileSync(file);
    const config = loadInstallationConfig(file);
    expect(config.schema_version).toBe(1);
    expect(normalizeKnowledgeRoots(config)).toEqual({
      defaultRoot: "default",
      roots: { default: "/roots/personal" },
      schemaVersion: 1,
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("loads a v2 fixture with two named roots and keeps the declared identities", () => {
    const file = writeInstallation(
      v2Yaml(
        "personal",
        "/roots/personal",
        { personal: "/roots/personal", work: "/roots/work" },
        "identities:\n  figma_email: person@example.com\n  claude_email: person@example.com",
      ),
    );
    const before = fs.readFileSync(file);
    const config = loadInstallationConfig(file);
    expect(config.schema_version).toBe(2);
    if (config.schema_version !== 2) throw new Error("expected a v2 config");
    expect(normalizeKnowledgeRoots(config)).toEqual({
      defaultRoot: "personal",
      roots: { personal: "/roots/personal", work: "/roots/work" },
      schemaVersion: 2,
    });
    expect(config.identities?.figma_email).toBe("person@example.com");
    expect(config.identities?.claude_email).toBe("person@example.com");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe("installation config semantic rejects (DR §8.1)", () => {
  function expectReject(yaml: string, messagePart: string): void {
    const file = writeInstallation(yaml);
    expect(() => loadInstallationConfig(file)).toThrow(InstallationConfigError);
    expect(() => loadInstallationConfig(file)).toThrow(messagePart);
  }

  it("rejects a default_root that is not a key of knowledge_roots", () => {
    expectReject(
      v2Yaml("missing", "/roots/personal", { personal: "/roots/personal" }),
      'default_root "missing" is not a knowledge_roots entry',
    );
  });

  it("rejects a knowledge_root alias that does not match the default root path", () => {
    expectReject(
      v2Yaml("personal", "/roots/other", { personal: "/roots/personal", work: "/roots/work" }),
      "compatibility alias of the default root",
    );
  });

  it("rejects an empty knowledge_roots map", () => {
    expectReject(v2Yaml("personal", "/roots/personal", {}), "knowledge_roots");
  });

  it("rejects a root name outside the lowercase slug contract", () => {
    expectReject(
      v2Yaml("Work", "/roots/work", { Work: "/roots/work" }),
      'knowledge root name "Work"',
    );
  });

  it("rejects names that differ only by case", () => {
    expectReject(
      v2Yaml("personal", "/roots/personal", { personal: "/roots/personal", Personal: "/roots/other" }),
      'knowledge root name "Personal"',
    );
  });

  it("rejects a default_root that only case-differs from a map key", () => {
    expectReject(
      v2Yaml("PERSONAL", "/roots/personal", { personal: "/roots/personal" }),
      'default_root "PERSONAL" is not a knowledge_roots entry',
    );
  });

  it("rejects one canonical path registered under two names", () => {
    expectReject(
      v2Yaml("personal", "/roots/personal", { personal: "/roots/personal", also: "/roots/personal" }),
      '"personal" and "also" point at the same path',
    );
  });

  const itOnWindows = process.platform === "win32" ? it : it.skip;
  itOnWindows("treats case-differing paths as the same canonical root on Windows", () => {
    expectReject(
      v2Yaml("personal", "C:/roots/personal", { personal: "C:/roots/personal", Work: "C:/ROOTS/PERSONAL" })
        .replace("  Work:", "  work:"),
      "point at the same path",
    );
  });

  it("rejects unknown properties", () => {
    expectReject(
      `${v2Yaml("personal", "/roots/personal", { personal: "/roots/personal" })}extra: true\n`,
      "extra",
    );
  });

  it("rejects an unsupported schema version", () => {
    expectReject(
      v2Yaml("personal", "/roots/personal", { personal: "/roots/personal" }).replace(
        "schema_version: 2",
        "schema_version: 3",
      ),
      "schema_version",
    );
  });

  it("rejects a v2 shape missing the knowledge_root compatibility alias", () => {
    expectReject(
      ["schema_version: 2", "default_root: personal", "knowledge_roots:", "  personal: /roots/personal", ""].join("\n"),
      "knowledge_root",
    );
  });
});
