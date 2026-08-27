import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_BUDGET_BYTES,
  BOOTSTRAP_CLOSE,
  BOOTSTRAP_OPEN,
  inspectBootstrapBlock,
  MalformedBootstrapBlockError,
  renderBootstrapBlock,
  renderDevClaude,
  renderKnowledgeInclude,
  renderWorkspaceClaude,
  stripBootstrapBlock,
  stripDevClaudeBanner,
} from "./knowledgeRender.js";

const BASE = "\uFEFF# Project rules\r\n\r\nKeep these bytes.\r\n";
const KNOWLEDGE_ROOT = "C:\\src\\schoolbright-knowledge";
const TARGET_ROOT = "C:\\src\\schoolbright-app";

describe("renderKnowledgeInclude", () => {
  it("names the resolved root as a machine-readable assignment", () => {
    const content = renderKnowledgeInclude(KNOWLEDGE_ROOT);
    expect(content).toContain(`KNOWLEDGE_ROOT=${KNOWLEDGE_ROOT}`);
    expect(content).toContain("generated");
    expect(content).toContain("_docs/module/<name>/");
  });
});

describe("T-V3-06 bootstrap rendering", () => {
  it("round-trips exactly, preserves every surrounding byte, and is idempotent over three renders", () => {
    const options = { role: "dev" as const, workspaceRoot: TARGET_ROOT, boundRoot: KNOWLEDGE_ROOT };
    const once = renderWorkspaceClaude(BASE, options);
    const twice = renderWorkspaceClaude(once, options);
    const thrice = renderWorkspaceClaude(twice, options);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(stripBootstrapBlock(once)).toBe(BASE);
    expect(inspectBootstrapBlock(once)).toMatchObject({ state: "valid", outside: BASE });
    expect((once.match(/<!-- sta:bootstrap -->/g) ?? [])).toHaveLength(1);
    expect((once.match(/<!-- \/sta:bootstrap -->/g) ?? [])).toHaveLength(1);
  });

  it("refuses unterminated, duplicated, close-only, and reversed markers without guessing", () => {
    for (const malformed of [
      `${BOOTSTRAP_OPEN}\nbody`,
      `${BOOTSTRAP_OPEN}\na\n${BOOTSTRAP_OPEN}\nb\n${BOOTSTRAP_CLOSE}\n`,
      `${BOOTSTRAP_CLOSE}\nproject`,
      `${BOOTSTRAP_CLOSE}\n${BOOTSTRAP_OPEN}\n`,
    ]) {
      expect(inspectBootstrapBlock(malformed).state).toBe("malformed");
      expect(() => stripBootstrapBlock(malformed)).toThrow(MalformedBootstrapBlockError);
    }
  });

  it("keeps the block under 4 KB and structurally limited to identity, roots, gates, boundaries and pointers", () => {
    const block = renderBootstrapBlock({ role: "dev", workspaceRoot: TARGET_ROOT, boundRoot: KNOWLEDGE_ROOT });
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(BOOTSTRAP_BUDGET_BYTES);
    expect(block).toContain("AGENTCLAUDE_CONTEXT_CMD");
    expect(block).toContain("sta policy <area> <section>");
    expect(block).toContain("requirements interview");
    expect(block).not.toMatch(/\|\s*Agent\s*\|/i);
    expect(block).not.toMatch(/## Roles|pipeline narrative|## Rules nothing enforces/i);
    expect((block.match(/sta policy/g) ?? [])).toHaveLength(1);
  });

  it("renders stable DEV and BA golden blocks with the correct bound root", () => {
    const dev = renderBootstrapBlock({ role: "dev", workspaceRoot: TARGET_ROOT, boundRoot: KNOWLEDGE_ROOT });
    const ba = renderBootstrapBlock({ role: "ba", workspaceRoot: KNOWLEDGE_ROOT, boundRoot: TARGET_ROOT });
    expect(dev).toMatchInlineSnapshot(`
      "<!-- sta:bootstrap -->
      # software-team-agents bootstrap
      - Workspace role: **DEV** (\`dev\`) — writes Target application code and DEV-role artifacts only.
      - Workspace root (writable): \`C:\\src\\schoolbright-app\`
      - Knowledge root (read-only): \`C:\\src\\schoolbright-knowledge\`
      - Human gates: requirements interview; schema confirmation; third QA failure or Critical; Critical/Important security finding; real deploy or migration.
      - Hard boundary: no state-changing git.
      - Hard boundary: write only inside resolved writable workspace roots.
      - Hard boundary: write only paths allowed by the active role contract.
      - Hard boundary: Confirm workspace ↔ workspace role before writing anything.
      - Hard boundary: amend existing module docs section-by-section; never regenerate them.
      - Hard boundary: approvals/sign-offs are human acts; agents never forge them.
      - Hard boundary: dates and unclear business rules come from a person; never improvise them.
      - Context: run the command named by \`AGENTCLAUDE_CONTEXT_CMD\` with \`<your-role> --module <name> --phase <n>\`.
      - Everything else: read only the needed section with \`sta policy <area> <section>\`.
      <!-- /sta:bootstrap -->
      "
    `);
    expect(ba).toMatchInlineSnapshot(`
      "<!-- sta:bootstrap -->
      # software-team-agents bootstrap
      - Workspace role: **BA** (\`ba\`) — writes Knowledge requirements/design/planning artifacts only.
      - Workspace root (writable): \`C:\\src\\schoolbright-knowledge\`
      - Target root (optional, read-only): \`C:\\src\\schoolbright-app\`
      - Human gates: requirements interview; schema confirmation; third QA failure or Critical; Critical/Important security finding; real deploy or migration.
      - Hard boundary: no state-changing git.
      - Hard boundary: write only inside resolved writable workspace roots.
      - Hard boundary: write only paths allowed by the active role contract.
      - Hard boundary: Confirm workspace ↔ workspace role before writing anything.
      - Hard boundary: amend existing module docs section-by-section; never regenerate them.
      - Hard boundary: approvals/sign-offs are human acts; agents never forge them.
      - Hard boundary: dates and unclear business rules come from a person; never improvise them.
      - Context: run the command named by \`AGENTCLAUDE_CONTEXT_CMD\` with \`<your-role> --module <name> --phase <n>\`.
      - Everything else: read only the needed section with \`sta policy <area> <section>\`.
      <!-- /sta:bootstrap -->
      "
    `);
  });

  it("migrates the legacy DEV banner and retains the backward-compatible API names", () => {
    const legacy = "<!-- sta:three-repo-dev -->\nlegacy\n<!-- /sta:three-repo-dev -->\n" + BASE;
    const rendered = renderDevClaude(legacy, KNOWLEDGE_ROOT, TARGET_ROOT);
    expect(rendered.startsWith(BOOTSTRAP_OPEN)).toBe(true);
    expect(rendered).not.toContain("sta:three-repo-dev");
    expect(stripDevClaudeBanner(rendered)).toBe(BASE);
  });
});
