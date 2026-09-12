import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveHandoff, listModules, moduleDocPath, readModuleDoc, parseQaReport, parseTaskVerdicts, parseSecurityReport, resolveModule } from "./moduleDocs.js";
import { AgentStage } from "../types.js";

describe("deriveHandoff (T-V3TOK-091)", () => {
  it("derives BA and SA references from their authoritative documents", () => {
    const ba = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", [
      "# Requirement",
      "## Core Features",
      "- REQ-001 create order",
      "## Constraints & Assumptions",
      "- REQ-002 admin only",
      "## Open Questions",
      "- Who owns refunds?",
    ].join("\n"), undefined, { taskId: "T-1" });
    expect(ba.complete).toBe(true);
    expect(ba.artifact.implements).toEqual(["REQ-001", "REQ-002"]);
    expect(ba.artifact.constraint_refs).toEqual([
      "requirement.md#Core-Features",
      "requirement.md#Constraints-%26-Assumptions",
    ]);
    expect(ba.artifact.open_findings[0].summary).toBe("requirement.md#Open-Questions:1");

    const sa = deriveHandoff(AgentStage.SYSTEM_ANALYST, "sales", [
      "# Design",
      "## Feature Contract — DES-010",
      "Covers REQ-001 and ADR-005 under RULE-031.",
      "## Unresolved Open Questions",
      "—",
    ].join("\n"), undefined, { taskId: "T-1" });
    expect(sa.complete).toBe(true);
    expect(sa.artifact.implements).toEqual(["DES-010"]);
    expect(sa.artifact.contract_refs.produces).toEqual(["design.md#Feature-Contract-%E2%80%94-DES-010"]);
    expect(sa.artifact.decision_refs).toEqual(["ADR-005", "RULE-031"]);
  });

  it("derives PM contract references through the parsed plan and plan graph", () => {
    const plan = [
      "# Plan",
      "## Phase 1: Orders",
      "| Task | Status | Owner | Depends on | Produces | Consumes |",
      "|---|---|---|---|---|---|",
      "| BE-001 (DES-010) — API | pending | backend-engineer | — | orders/create | auth/session |",
      "## Phase 2: UI",
      "| Task | Status | Owner | Depends on | Produces | Consumes |",
      "|---|---|---|---|---|---|",
      "| FE-001 (DES-011) — form | pending | frontend-engineer | BE-001 | — | orders/create |",
    ].join("\n");
    const derived = deriveHandoff(AgentStage.PROJECT_MANAGER, "sales", plan, plan, { taskId: "T-1", phases: [1] });
    expect(derived.complete).toBe(true);
    expect(derived.artifact.phase).toBe(1);
    expect(derived.artifact.implements).toEqual(["DES-010"]);
    expect(derived.artifact.contract_refs).toEqual({ produces: ["orders/create"], consumes: ["auth/session"] });
  });

  it("derives exact addressable SA claim identities instead of heading approximations", () => {
    const hash = "a".repeat(64);
    const revision = "b".repeat(40);
    const evidence = (id: string, claim: string) =>
      `Evidence ${id}: claim=${claim} | state=confirmed | path=src/orders.ts | symbol=orders | line=1 | revision=${revision} | basis=source | tool=rg-read | hash=${hash}`;
    const design = [
      "# Design",
      "Design evidence format: 1",
      "## DES-021 — Order export",
      "Contract:OrderExport.v1 — response boundary.",
      "DEC-021 — keep the route additive.",
      evidence("EVD-021", "DES-021"),
      evidence("EVD-022", "Contract:OrderExport.v1"),
      evidence("EVD-023", "DEC-021"),
      "Compatibility: additive-internal",
      "Data/schema: unchanged",
      "Migration/backfill: none",
      "Security: none",
      "Fallback: disable the additive route.",
      "Material ambiguity: none",
    ].join("\n");
    const derived = deriveHandoff(AgentStage.SYSTEM_ANALYST, "sales", design, undefined, { taskId: "T-1" });
    expect(derived.complete).toBe(true);
    expect(derived.artifact.implements).toEqual(["DES-021"]);
    expect(derived.artifact.contract_refs.produces).toEqual(["Contract:OrderExport.v1"]);
    expect(derived.artifact.decision_refs).toEqual(["DEC-021"]);
  });

  it("derives test-planner and UX/UI references without copied prose", () => {
    const tests = deriveHandoff(AgentStage.TEST_PLANNER, "sales", "# Test Plan\n\n## Coverage\n- TP-009 verifies REQ-001\n", undefined, { taskId: "T-1" });
    expect(tests.artifact.test_refs).toEqual(["TP-009"]);

    const ux = deriveHandoff(AgentStage.UXUI_DESIGNER, "sales", "# UX\n\n## Recommendations\n- UX-003\n- UX-004\n", undefined, { taskId: "T-1" });
    expect(ux.artifact.artifact_refs).toEqual(["uxui/design.md", "UX-003", "UX-004"]);
  });

  it("returns a schema-valid minimal record and note when optional references cannot be derived", () => {
    const result = deriveHandoff(AgentStage.SYSTEM_ANALYST, "auth_login v2 (th)", "# Design only\n", undefined, { taskId: "T-1", phases: [3] });
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toContain("minimal handoff");
    expect(result.artifact).toMatchObject({ task_id: "T-1", module: "auth_login v2 (th)", phase: 3 });
    expect(result.artifact.implements).toEqual([]);
  });
});

describe("T-V8-013 open_findings ids survive rewrite/archive, unlike positional OPEN-### numbering", () => {
  function baWith(openQuestionsBody: string[], prefix: string[] = []): string {
    return [
      "# Requirement",
      ...prefix,
      "## Core Features",
      "- REQ-001 create order",
      "## Open Questions",
      ...openQuestionsBody,
    ].join("\n");
  }

  it("keeps the same finding id when unrelated content changes above the heading", () => {
    const before = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds?"]), undefined, { taskId: "T-1" });
    const after = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds?"], ["## New Section", "unrelated content inserted above"]), undefined, { taskId: "T-1" });
    expect(before.artifact.open_findings[0].id).toBe(after.artifact.open_findings[0].id);
  });

  it("keeps the same finding id when reordered among other findings in the same section", () => {
    const before = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds?", "- What is the SLA?"]), undefined, { taskId: "T-1" });
    const after = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- What is the SLA?", "- Who owns refunds?"]), undefined, { taskId: "T-1" });
    const beforeIds = new Set(before.artifact.open_findings.map((f) => f.id));
    const afterIds = new Set(after.artifact.open_findings.map((f) => f.id));
    expect(afterIds).toEqual(beforeIds);
  });

  it("mints a different id when the finding's own text actually changes", () => {
    const original = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds?"]), undefined, { taskId: "T-1" });
    const reworded = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds after a chargeback?"]), undefined, { taskId: "T-1" });
    expect(original.artifact.open_findings[0].id).not.toBe(reworded.artifact.open_findings[0].id);
  });

  it("no longer numbers findings by position — the same content in a different module still gets a stable, non-sequential id", () => {
    const id = deriveHandoff(AgentStage.BUSINESS_ANALYST, "sales", baWith(["- Who owns refunds?"]), undefined, { taskId: "T-1" }).artifact.open_findings[0].id;
    expect(id).toMatch(/^OPEN-[0-9a-f]{12}$/);
    expect(id).not.toBe("OPEN-001");
  });
});

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
      "## Per-Task Results",
      "- BE-004 — ✅ Verified: routes match DES-011",
      "- AC-007.2 — ✅ Verified: empty order returns zero total",
      "",
      "## Unverified Behaviour — undeployed phases",
    ].join("\n");
    const { artifact, modeInferred } = parseQaReport("T-1", md);
    expect(artifact.status).toBe("PASS");
    expect(artifact.mode).toBe("FULL");
    expect(modeInferred).toBe(false);
    expect(artifact.tests).toEqual({ passed: 42, failed: 0 });
    expect(artifact.hasAutomatedTests).toBe(true);
    // The BE-004 line names DES-011 in its evidence, so that id is verdicted too.
    expect(artifact.requirements).toEqual({ "BE-004": "PASS", "DES-011": "PASS", "AC-007.2": "PASS" });
  });

  // T-V8-014: a status without a per-id verdict is an assertion, not a verdict.
  it("reads a PASS round that maps no id as FAIL rather than manufacturing a verdict", () => {
    const md = [
      "## Round 3 (FULL)",
      "- checked backend routes against design.md ✅",
      "- 42 passed, 0 failed",
      "",
      "## Unverified Behaviour — undeployed phases",
    ].join("\n");
    const { artifact } = parseQaReport("T-1", md);
    expect(artifact.status).toBe("FAIL");
    expect(artifact.requirements).toEqual({});
  });

  it("maps a Partial to FAIL — a Partial is not a pass", () => {
    const md = [
      "## Round 4 (FULL)",
      "**Status:** ⚠️ Partial (FULL)",
      "- 3 passed, 0 failed",
      "",
      "## Per-Task Results",
      "- BE-004 — ✅ Verified",
      "- AC-007.2 — ⚠️ Partial: rule inspected, no executable coverage",
      "",
      "## Unverified Behaviour",
      "- AC-007.2 read only",
    ].join("\n");
    const { artifact } = parseQaReport("BE-004", md);
    expect(artifact.status).toBe("FAIL");
    expect(artifact.requirements).toEqual({ "BE-004": "PASS", "AC-007.2": "FAIL" });
  });
});

describe("parseTaskVerdicts", () => {
  it("reads only its own section, not markers from later sections", () => {
    const md = [
      "## Per-Task Results",
      "- BE-004 — ✅ Verified",
      "",
      "## Issues Found",
      "- AC-007.2 ❌ still broken in the follow-up phase",
    ].join("\n");
    expect(parseTaskVerdicts(md, "BE-004")).toEqual({ "BE-004": "PASS" });
  });

  it("does not file evidence prose like SHA-256 or TS-2322 as an acceptance criterion", () => {
    const md = ["## Per-Task Results", "- BE-004 — ✅ Verified; SHA-256 abc, no TS-2322 remaining"].join("\n");
    expect(parseTaskVerdicts(md, "BE-004")).toEqual({ "BE-004": "PASS" });
  });

  it("fails an id once, permanently — a later ✅ on the same id does not lift it", () => {
    const md = [
      "## Per-Task Results",
      "- AC-007.2 — ❌ Failed: throws on empty order",
      "- AC-007.2 — ✅ Verified: passes for nonempty orders",
    ].join("\n");
    expect(parseTaskVerdicts(md, "BE-004")).toEqual({ "AC-007.2": "FAIL" });
  });

  it("reads durable finding ids so an open finding's recheck is checkable", () => {
    const md = ["## Per-Task Results", "- FIND-0123456789abcdef — ✅ Verified: fix confirmed"].join("\n");
    expect(parseTaskVerdicts(md, "BE-004")).toEqual({ "FIND-0123456789abcdef": "PASS" });
  });

  it("maps nothing from a round that states no marked verdict", () => {
    expect(parseTaskVerdicts("## Per-Task Results\n- BE-004 looks fine to me", "BE-004")).toEqual({});
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
