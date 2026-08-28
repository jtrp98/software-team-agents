import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { formatResolvedCommand, resolveBundledStaCli } from "./npmCliResolver.js";

describe("bundled sta resolver (T-V3TOK-042)", () => {
  it("resolves the JS entry directly through Node, bypassing Windows npm shims", () => {
    const root = "C:\\Program Files\\software-team-agents";
    const entry = path.join(root, "orchestrator", "dist", "cli.js");
    const resolved = resolveBundledStaCli(root, { exists: (candidate) => candidate === entry, execPath: "C:\\Program Files\\nodejs\\node.exe" });
    expect(resolved).toEqual({ file: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: [entry] });
    expect(formatResolvedCommand(resolved!)).toBe(`"C:\\Program Files\\nodejs\\node.exe" "${entry}"`);
  });

  it("returns null when an installation has no sta entry", () => {
    expect(resolveBundledStaCli("C:\\missing", { exists: () => false })).toBeNull();
  });
});
