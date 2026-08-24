import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_IDS, RUNTIME_SUPPORT, SUPPORT_LEVELS, describeRuntimeSupport } from "./runtimeSupport.js";

/** This repo is its own fixture — the README table is the prose half of the claim. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

/** How each runtime id is spelled in the README table's first column. */
const DISPLAY_NAME: Record<(typeof RUNTIME_IDS)[number], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const LEVEL_WORD = {
  supported: "Supported",
  preview: "Preview",
  experimental: "Experimental",
  unsupported: "Unsupported",
} as const;

function readmeRow(id: keyof typeof RUNTIME_SUPPORT): string | undefined {
  return readme
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .find((l) => l.includes(`**${DISPLAY_NAME[id]}**`));
}

describe("runtimeSupport — the single source of truth for support claims (T-V1-04)", () => {
  it("covers exactly the runtimes `--runtime` accepts, so CLI and claims cannot name different sets", () => {
    expect(RUNTIME_IDS).toEqual(["claude-code", "codex", "opencode"]);
    expect(Object.keys(RUNTIME_SUPPORT).sort()).toEqual([...RUNTIME_IDS].sort());
  });

  it("only uses levels from the closed set — including keeping `unsupported` available but unclaimed", () => {
    expect(SUPPORT_LEVELS).toContain("unsupported");
    for (const id of RUNTIME_IDS) {
      expect(SUPPORT_LEVELS, id).toContain(RUNTIME_SUPPORT[id].level);
    }
  });

  /**
   * T-V1-04's "ห้าม claim support เกิน implementation", pinned both ways:
   * a `supported` claim may not carry a caveat about unverified enforcement,
   * and the two known placements cannot quietly rise.
   */
  it("never claims a level stronger than its own caveat allows", () => {
    for (const id of RUNTIME_IDS) {
      const { level, claim } = RUNTIME_SUPPORT[id];
      if (level === "supported") {
        expect(claim.toLowerCase()).not.toMatch(/not verified|unverified|guard gap|never been verified/);
      }
      if (level === "preview" || level === "experimental") {
        expect(claim.length, `${id} at ${level} owes an honest caveat`).toBeGreaterThan(40);
      }
    }
    expect(RUNTIME_SUPPORT["claude-code"].level).toBe("supported");
    expect(RUNTIME_SUPPORT.codex.level).toBe("preview");
    expect(RUNTIME_SUPPORT.opencode.level).toBe("experimental");
  });

  /**
   * README's runtime table must state exactly this record's level per runtime —
   * T-V1-04's "one status everywhere". A row naming its runtime but not its
   * level (or naming a stronger one) fails here rather than misleading a user.
   */
  it("agrees with the shipped README's runtime table, word for word", () => {
    const rank = Object.fromEntries(SUPPORT_LEVELS.map((l, i) => [l, i]));
    for (const id of RUNTIME_IDS) {
      const row = readmeRow(id);
      expect(row, `a README table row naming ${DISPLAY_NAME[id]}`).toBeDefined();
      expect(row!, id).toContain(LEVEL_WORD[RUNTIME_SUPPORT[id].level]);
      // No row may claim any level stronger than its own.
      for (const level of SUPPORT_LEVELS) {
        if (rank[level] <= rank[RUNTIME_SUPPORT[id].level]) continue;
        expect(row!, `${id} must not claim ${level}`).not.toContain(LEVEL_WORD[level]);
      }
    }
  });
});
