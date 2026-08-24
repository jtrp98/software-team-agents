import { describe, expect, it } from "vitest";
import { renderDevClaude, renderKnowledgeInclude, stripDevClaudeBanner } from "./knowledgeRender.js";

const BASE = "# Rules\n\nRead `_docs/status.md` first, then `_docs/module/<name>/plan.md`.\n";
const ROOT = "C:\\src\\schoolbright-knowledge";

describe("renderKnowledgeInclude", () => {
  it("names the resolved root as a machine-readable assignment", () => {
    const content = renderKnowledgeInclude(ROOT);
    expect(content).toContain(`KNOWLEDGE_ROOT=${ROOT}`);
    expect(content).toContain("generated");
    expect(content).toContain("_docs/module/<name>/");
  });
});

describe("renderDevClaude", () => {
  it("prepends an authoritative banner naming the Knowledge root and preserves the body", () => {
    const rendered = renderDevClaude(BASE, ROOT);
    expect(rendered.startsWith("<!-- sta:three-repo-dev -->")).toBe(true);
    expect(rendered).toContain(`**Knowledge root:** \`${ROOT}\``);
    expect(rendered).toContain("READ-ONLY");
    expect(rendered.endsWith(BASE)).toBe(true);
    // The stale-local warning is explicit: a found local _docs/ is legacy.
    expect(rendered).toContain("stale legacy");
  });

  it("is idempotent — rendering over rendered content does not stack banners", () => {
    const once = renderDevClaude(BASE, ROOT);
    const twice = renderDevClaude(once, ROOT);
    expect(twice).toBe(once);
  });

  it("re-renders against a moved root without leaving banner fragments", () => {
    const moved = renderDevClaude(renderDevClaude(BASE, ROOT), "D:\\other-knowledge");
    expect(moved).toContain("D:\\other-knowledge");
    expect(moved).not.toContain(ROOT);
    expect((moved.match(/sta:three-repo-dev/g) ?? []).length).toBe(2); // open + close only
  });

  it("stripDevClaudeBanner removes a whole banner including its markers", () => {
    expect(stripDevClaudeBanner(renderDevClaude(BASE, ROOT))).toBe(BASE);
    expect(stripDevClaudeBanner(BASE)).toBe(BASE);
  });
});
