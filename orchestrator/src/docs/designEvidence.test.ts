import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../artifacts/executionPacket.js";
import {
  designEvidenceForClaims,
  parseDesignEvidence,
  verifyDesignEvidence,
} from "./designEvidence.js";

const REVISION = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-evidence-"));
  roots.push(root);
  const rel = "src/orders.ts";
  const text = "export function orderSummary() { return { total: 0 }; }\n";
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
  return { root, rel, hash: contentHash(text) };
}

function design(overrides: Partial<Record<"compatibility" | "schema" | "migration" | "security" | "ambiguity", string>> = {}) {
  const source = sourceFixture();
  const evidence = (id: string, claim: string, basis = "source", state = "confirmed") =>
    `Evidence ${id}: claim=${claim} | state=${state} | path=${source.rel} | symbol=orderSummary | line=1 | revision=${REVISION} | basis=${basis} | tool=rg-read | hash=${source.hash}`;
  const markdown = [
    "# Design", "", "Design evidence format: 1", "",
    "## Feasibility Summary", "Feasible.", "",
    "## Feature-by-Feature Feasibility", "DES-011 is the selected design.", "",
    "## Data Model", "No change.", "",
    "## DES-011 — Order summary contract",
    "Contract:OrderSummary.v2 — stable response contract.",
    "DEC-011 — keep the empty total explicit.",
    evidence("EVD-011", "DES-011"),
    evidence("EVD-012", "Contract:OrderSummary.v2"),
    evidence("EVD-013", "DEC-011"),
    `Compatibility: ${overrides.compatibility ?? "additive-internal"}`,
    `Data/schema: ${overrides.schema ?? "unchanged"}`,
    `Migration/backfill: ${overrides.migration ?? "none"}`,
    `Security: ${overrides.security ?? "none"}`,
    "Fallback: retain Contract:OrderSummary.v1.",
    `Material ambiguity: ${overrides.ambiguity ?? "none"}`, "",
    "## Modules", "orders", "", "## Risks & Dependencies", "none", "",
    "## Unresolved Open Questions", "none", "", "## Change Log", "undated fixture",
  ].join("\n");
  return { ...source, markdown, evidence };
}

describe("T-V8-007 addressable design evidence", () => {
  it("parses stable DES/contract/decision claims and selects their exact evidence", () => {
    const fixture = design();
    const parsed = parseDesignEvidence(fixture.markdown);
    expect(parsed.problems).toEqual([]);
    expect(parsed.mode).toBe("addressable");
    expect(parsed.claims).toEqual(["DES-011", "Contract:OrderSummary.v2", "DEC-011"]);
    expect(parsed.gate).toMatchObject({ triggers: [], canProceedWithoutConfirmation: true, migrationRequired: false });
    expect(designEvidenceForClaims(parsed, ["DES-011", "Contract:OrderSummary.v2", "DEC-011"]).map(ref => ref.id)).toEqual([
      "EVD-011", "EVD-012", "EVD-013",
    ]);
  });

  it("keeps graph/LSP relationships inferred until direct source confirmation", () => {
    const fixture = design();
    const graph = fixture.evidence("EVD-011", "DES-011", "graph", "confirmed");
    const result = parseDesignEvidence(fixture.markdown.replace(fixture.evidence("EVD-011", "DES-011"), graph));
    expect(result.problems.join("\n")).toContain("graph/LSP evidence must remain inferred");

    const inferred = fixture.evidence("EVD-011", "DES-011", "lsp", "inferred");
    expect(parseDesignEvidence(fixture.markdown.replace(fixture.evidence("EVD-011", "DES-011"), inferred)).problems).toEqual([]);
  });

  it("reports stale revisions, source drift, missing symbols and invalid lines instead of changing design", () => {
    const fixture = design();
    const parsed = parseDesignEvidence(fixture.markdown);
    expect(verifyDesignEvidence(parsed.evidence, { targetRoot: fixture.root, currentRevision: REVISION })).toEqual([]);
    expect(verifyDesignEvidence(parsed.evidence, { targetRoot: fixture.root, currentRevision: "b".repeat(40) }).join("\n")).toContain("stale revision");
    expect(verifyDesignEvidence(parsed.evidence, { targetRoot: fixture.root, currentRevision: "b".repeat(40), allowContentStableRevision: true })).toEqual([]);
    fs.writeFileSync(path.join(fixture.root, fixture.rel), "export const drifted = true;\n");
    const drift = verifyDesignEvidence(parsed.evidence, { targetRoot: fixture.root, currentRevision: REVISION }).join("\n");
    expect(drift).toContain("content hash drift");
    expect(drift).toContain("symbol orderSummary");
  });

  it.each([
    [{ schema: "additive" }, "schema"],
    [{ migration: "required" }, "migration"],
    [{ compatibility: "breaking" }, "breaking-contract"],
    [{ security: "critical" }, "critical-security"],
    [{ ambiguity: "unresolved" }, "material-ambiguity"],
  ] as const)("classifies %o as the %s hard gate", (overrides, trigger) => {
    const parsed = parseDesignEvidence(design(overrides).markdown);
    expect(parsed.problems).toEqual([]);
    expect(parsed.gate.triggers).toContain(trigger);
    expect(parsed.gate.canProceedWithoutConfirmation).toBe(false);
  });

  it("keeps a legacy design readable only as a migration-required fallback", () => {
    const parsed = parseDesignEvidence("# Design\n\n## DES-011 — Existing section\nLegacy prose.\n");
    expect(parsed.mode).toBe("legacy");
    expect(parsed.problems).toEqual([]);
    expect(parsed.gate.migrationRequired).toBe(true);
    expect(() => designEvidenceForClaims(parsed, ["DES-011"])).toThrow(/migrate.*before unattended execution/i);
  });
});
