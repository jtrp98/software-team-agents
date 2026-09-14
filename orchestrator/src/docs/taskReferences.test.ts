import { describe, expect, it } from "vitest";
import { selectTaskReference } from "./taskReferences.js";

describe("selected task reference boundaries", () => {
  it("keeps a selected heading's paragraphs, bullets and child headings without another reference or section", () => {
    const doc = "## DES-001 — Orders\nDetails.\n- Return zero.\n### Response\nKeep all fields.\n## DES-002 — Unrelated\nSECRET\n";
    expect(selectTaskReference(doc, "DES-001", "design.md").text).toBe("## DES-001 — Orders\nDetails.\n- Return zero.\n### Response\nKeep all fields.");
    expect(selectTaskReference("## REQ-001 — Orders\n- AC-001.1: distinct selected acceptance\n", "REQ-001", "requirement.md").text).toBe("## REQ-001 — Orders");
  });
  it("keeps nested list evidence but stops at sibling bullets and selects exactly one table row", () => {
    expect(selectTaskReference("- AC-001.1: Empty order\n  - Total is zero.\n- Unrelated assertion\nSECRET", "AC-001.1", "requirement.md").text).toBe("- AC-001.1: Empty order\n  - Total is zero.");
    expect(selectTaskReference("| REQ-001 | Orders work |\n| REQ-002 | SECRET |", "REQ-001", "requirement.md").text).toBe("| REQ-001 | Orders work |");
  });
  it("refuses fuzzy mentions, duplicate declarations and empty definitions", () => {
    for (const doc of ["See REQ-001 for details.", "- REQ-001: first\n## REQ-001: second", "## REQ-001\n"]) expect(() => selectTaskReference(doc, "REQ-001", "requirement.md")).toThrow(/exactly one|no semantic text/);
  });
  it("treats a summary-table row citing an already-headed ID as a reference, not a second declaration", () => {
    const doc = "## REQ-012 — Orders\nDetails.\n\n## Scope Overview\n| REQ-012 | done |\n| REQ-013 | todo |\n";
    expect(selectTaskReference(doc, "REQ-012", "requirement.md").text).toBe("## REQ-012 — Orders\nDetails.");
  });
  it("finds a numbered-list acceptance criterion whose ID is wrapped in parens", () => {
    const doc = "1. (AC-012.1) First criterion holds.\n2. (AC-012.2) Second criterion holds.\n";
    expect(selectTaskReference(doc, "AC-012.1", "requirement.md").text).toBe("1. (AC-012.1) First criterion holds.");
    expect(selectTaskReference(doc, "AC-012.2", "requirement.md").text).toBe("2. (AC-012.2) Second criterion holds.");
  });
});
