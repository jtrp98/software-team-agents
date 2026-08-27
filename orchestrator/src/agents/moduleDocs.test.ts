import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listModules, moduleDocPath, readModuleDoc, parseQaReport, parseSecurityReport, resolveModule } from "./moduleDocs.js";

describe("moduleDocPath / readModuleDoc", () => {
  it("resolves under _docs/module/<name>/", () => {
    expect(moduleDocPath("/root", "sales-crm", "review.md")).toBe(
      path.join("/root", "_docs", "module", "sales-crm", "review.md"),
    );
  });

  it("returns null when the file doesn't exist, instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moduledocs-"));
    expect(readModuleDoc(dir, "nope", "review.md")).toBeNull();
  });

  it("reads real content back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moduledocs-"));
    const modDir = path.join(dir, "_docs", "module", "sales-crm");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, "review.md"), "hello");
    expect(readModuleDoc(dir, "sales-crm", "review.md")).toBe("hello");
  });

  /**
   * A module name reaches this join from a CLI flag and from BA-written
   * knowledge items — both untrusted. `../..` must not walk the reader out of
   * `_docs/module/`; it fails closed instead of sanitizing into some other
   * module's folder.
   */
  it("refuses a module name that would escape _docs/module/", () => {
    for (const hostile of ["../..", "..", ".", "a/../b", "a/b", "a\\b", "C:\\tmp", "C:tmp"]) {
      expect(() => moduleDocPath("/root", hostile, "review.md"), hostile).toThrow(/unsafe module name/);
    }
  });

  it("still accepts the names real modules use", () => {
    expect(() => moduleDocPath("/root", "sales-crm", "review.md")).not.toThrow();
    expect(() => moduleDocPath("/root", "auth_login v2 (th)", "plan.md")).not.toThrow();
  });
});

describe("listModules / resolveModule (T-V3TOK-040)", () => {
  function fixture(modules: Record<string, string[]>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-resolver-"));
    for (const [name, files] of Object.entries(modules)) {
      const dir = path.join(root, "_docs", "module", name);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of files) fs.writeFileSync(path.join(dir, file), `# ${name}\n`, "utf8");
    }
    return root;
  }

  it("returns one module, ignoring empty folders and non-establishing documents", () => {
    const root = fixture({ empty: [], stale: ["review.md"], sales: ["requirement.md"] });
    expect(listModules(root)).toEqual(["sales"]);
    expect(resolveModule(root)).toEqual({ status: "one", module: "sales", candidates: ["sales"] });
  });

  it("returns many candidates in deterministic order and honors an exact hint", () => {
    const root = fixture({ zebra: ["design.md"], alpha: ["requirement.md"] });
    expect(resolveModule(root)).toEqual({ status: "many", candidates: ["alpha", "zebra"] });
    expect(resolveModule(root, "zebra")).toEqual({ status: "one", module: "zebra", candidates: ["alpha", "zebra"] });
  });

  it("returns none for an absent module tree or an unmatched exact hint", () => {
    const root = fixture({ sales: ["design.md"] });
    expect(resolveModule(path.join(root, "missing"))).toEqual({ status: "none", candidates: [] });
    expect(resolveModule(root, "billing")).toEqual({ status: "none", candidates: ["sales"] });
  });

  it("validates hints with the same traversal guard used by document reads", () => {
    const root = fixture({ sales: ["design.md"] });
    for (const hostile of ["../sales", "a/b", "a\\b", "C:\\tmp"]) {
      expect(() => resolveModule(root, hostile), hostile).toThrow(/unsafe module name/);
    }
  });
});

describe("parseQaReport", () => {
  it("reads a clean FULL pass round as PASS", () => {
    const md = [
      "## Round 3 (FULL)",
      "- checked backend routes against design.md ✅",
      "- 42 passed, 0 failed",
      "- typecheck ✅ lint ✅ build ✅",
      "",
      "## Unverified Behaviour — undeployed phases",
    ].join("\n");
    const { artifact, modeInferred } = parseQaReport("T-1", md);
    expect(artifact.status).toBe("PASS");
    expect(artifact.mode).toBe("FULL");
    expect(modeInferred).toBe(false);
    expect(artifact.tests).toEqual({ passed: 42, failed: 0 });
    expect(artifact.hasAutomatedTests).toBe(true);
  });

  it("reads a round with any ⚠️/❌ marker as FAIL even if some checks passed", () => {
    const md = ["## Round 1 (FULL)", "- schema drift ❌", "- typecheck ✅"].join("\n");
    const { artifact } = parseQaReport("T-1", md);
    expect(artifact.status).toBe("FAIL");
  });

  it("defaults mode to TARGETED (fails closed) when no (FULL)/(TARGETED) marker is found", () => {
    const md = "## Round 1\n- looks fine ✅";
    const { artifact, modeInferred } = parseQaReport("T-1", md);
    expect(artifact.mode).toBe("TARGETED");
    expect(modeInferred).toBe(true);
  });

  it("synthesizes an Unverified Behaviour placeholder when no automated tests and no section found", () => {
    const md = "## Round 1 (FULL)\n- read-only review, all good ✅";
    const { artifact } = parseQaReport("T-1", md);
    expect(artifact.hasAutomatedTests).toBe(false);
    expect(artifact.unverifiedBehaviour.length).toBeGreaterThan(0);
  });

  it("never produces an empty evidence array (schema requires min 1)", () => {
    const { artifact } = parseQaReport("T-1", "## Round 1 (FULL)\nno bullets here, just prose ✅");
    expect(artifact.evidence.length).toBeGreaterThan(0);
  });
});

describe("parseSecurityReport", () => {
  it("PASSes when every finding is FIXED or ACCEPTED", () => {
    const md = [
      "## Open Findings — all rounds",
      "- SEC-1 🔴 CRITICAL — SQL injection in search — ✅ Fixed (re-audited)",
      "- SEC-2 🟡 Minor — verbose error message — ⚪ Accepted",
    ].join("\n");
    const artifact = parseSecurityReport("T-1", md);
    expect(artifact.overallStatus).toBe("PASS");
    expect(artifact.findings).toHaveLength(2);
    expect(artifact.findings[0]).toMatchObject({ severity: "CRITICAL", status: "FIXED" });
  });

  it("FAILs on an open or fix-claimed Critical/Important finding", () => {
    const md = ["## Open Findings — all rounds", "- SEC-1 🟠 Important — missing authz check — 🔵 Open"].join("\n");
    expect(parseSecurityReport("T-1", md).overallStatus).toBe("FAIL");

    const claimed = ["## Open Findings — all rounds", "- SEC-1 🔴 Critical — token leak — 🟣 Fix claimed"].join("\n");
    expect(parseSecurityReport("T-1", claimed).overallStatus).toBe("FAIL");
  });

  it("a Minor finding never blocks overallStatus even if still Open", () => {
    const md = ["## Open Findings — all rounds", "- SEC-1 🟡 Minor — cosmetic — 🔵 Open"].join("\n");
    expect(parseSecurityReport("T-1", md).overallStatus).toBe("PASS");
  });

  it("ignores lines with only a severity or only a status emoji", () => {
    const md = ["## Open Findings — all rounds", "- 🔴 severity mentioned but no status yet", "- 🔵 status mentioned, no severity"].join("\n");
    expect(parseSecurityReport("T-1", md).findings).toHaveLength(0);
  });
});
