import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutionPacketSchema } from "../artifacts/schemas.js";
import { RuntimeTaskSchema } from "./runtimeTask.js";
import { type InstallMode } from "../threeRepo/ownership.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

const ALL_SOURCES = sourceFiles().map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

// Exclude test files, testSupport files, and the one-time legacy cutover archive tool
const PRODUCTION_SOURCES = ALL_SOURCES.filter(
  ({ file }) =>
    !/[.]test[.]ts$|[.]testSupport[.]ts$/.test(file) &&
    file !== "state/legacyCutoverArchive.ts",
);

function offendersFor(pattern: RegExp): string[] {
  return PRODUCTION_SOURCES
    .filter(({ text }) =>
      text.split(/\r?\n/).some((line) => pattern.test(line) && !/^\s*([*]|\/\/|\/[*])/.test(line)),
    )
    .map(({ file }) => file);
}

describe("TASK-023: No legacy references in production source code", () => {
  const legacySymbols = [
    "LegacyExecutionPacketSchema",
    "LegacyExecutionPacket",
    "readExecutionPacketForAudit",
    "LegacyRuntimeTaskSchema",
    "LegacyRuntimeTask",
    "projectWaveRun",
    "resolveExecutionAuthority",
    "resolveSelectedKnowledgeRootOrLegacy",
  ];

  it.each(legacySymbols)("production source contains no references to %s", (symbol) => {
    const regex = new RegExp(`\\b${symbol}\\b`);
    expect(offendersFor(regex)).toEqual([]);
  });

  it("production source contains no references to buildPrompt call or definition", () => {
    expect(offendersFor(/\bbuildPrompt\s*\(/)).toEqual([]);
  });

  it("InstallMode only permits three-repo (single-repo and legacy-project deleted)", () => {
    const mode: InstallMode = "three-repo";
    expect(mode).toBe("three-repo");
    const ownershipSource = ALL_SOURCES.find(({ file }) => file === "threeRepo/ownership.ts")?.text ?? "";
    expect(ownershipSource).toContain('export type InstallMode = "three-repo";');
  });

  it("cli usage help contains no references to legacy-project mode", () => {
    const cliSource = ALL_SOURCES.find(({ file }) => file === "cli.ts")?.text ?? "";
    expect(cliSource).not.toMatch(/--mode\s+legacy-project/);
    expect(cliSource).toMatch(/--mode\s+three-repo/);
  });
});

describe("TASK-023: Canonical schema enforcement (no legacy fallback path)", () => {
  it("ExecutionPacketSchema strictly requires version 2", () => {
    const parsed = ExecutionPacketSchema.safeParse({ version: 1 });
    expect(parsed.success).toBe(false);
  });

  it("RuntimeTaskSchema strictly requires version 2", () => {
    const parsed = RuntimeTaskSchema.safeParse({ version: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("TASK-024: No governance bypass switches, obsolete interfaces or unused apiAdapter", () => {
  const bypassSymbols = [
    "ApiAdapter",
    "PAID_API_RUNTIME_ID",
    "noDeterministicGate",
    "noDocumentGate",
    "noQaOptimization",
    "allowQaSkip",
  ];

  it.each(bypassSymbols)("production source contains no references to %s", (symbol) => {
    const regex = new RegExp(`\\b${symbol}\\b`);
    expect(offendersFor(regex)).toEqual([]);
  });

  it("apiAdapter.ts and sessionRole.ts do not exist on disk", () => {
    expect(fs.existsSync(path.join(SRC, "runtime", "apiAdapter.ts"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "targetcli", "sessionRole.ts"))).toBe(false);
  });

  it("cli usage help contains no references to bypass flags", () => {
    const cliSource = ALL_SOURCES.find(({ file }) => file === "cli.ts")?.text ?? "";
    expect(cliSource).not.toMatch(/--no-deterministic-gate/);
    expect(cliSource).not.toMatch(/--no-document-gate/);
    expect(cliSource).not.toMatch(/--no-qa-optimization/);
  });
});

describe("TASK-028: no file-backed lane authority remains", () => {
  const fileAuthoritySymbols = [
    "loadRoleWorkspace",
    "writeRoleWorkspace",
    "readRoleWorkspaceFile",
    "listRoleWorkspaceFiles",
    "checkRoleWorkspaces",
    "roleWorkspacePath",
    "recordSignoff",
    "APPROVAL_TYPE_OF_LANE",
    "workspacesUnder",
    "checkRoles",
  ];

  it.each(fileAuthoritySymbols)("production source contains no references to %s", (symbol) => {
    expect(offendersFor(new RegExp(`\b${symbol}\b`))).toEqual([]);
  });

  it("the role-workspace file schema is gone", () => {
    expect(fs.existsSync(path.resolve(SRC, "..", "schemas", "role-workspace.schema.json"))).toBe(false);
  });

  it("no production path reads knowledge/_roles/ (only the guard floor names it)", () => {
    const readers = PRODUCTION_SOURCES.filter(({ file, text }) =>
      file !== "agents/pathPermissions.ts" &&
      file !== "threeRepo/ownership.ts" &&
      text.split(/\r?\n/).some((line) => /ROLES_DIRNAME|["'`]_roles["'`/]/.test(line) && !/^\s*([*]|\/\/|\/[*])/.test(line)),
    ).map(({ file }) => file);
    expect(readers).toEqual(["knowledge/knowledgeStore.ts"]); // RESERVED_DIRS: the item walk skips it
  });
});
