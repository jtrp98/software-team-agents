import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { TargetStackConfig } from "../targetcli/targetMeta.js";
import { renderStackDigest, STACK_DIGEST_BUDGET_BYTES } from "./stackDigest.js";

function stack(profile: string, packageManager: string, commands: TargetStackConfig["commands"]): TargetStackConfig {
  return {
    profile,
    package_manager: packageManager,
    commands,
    schema_paths: profile === "dotnet" ? ["src/App/Migrations"] : [],
    source_roots: ["src"],
    detected_at: "2026-08-27T00:00:00.000Z",
    fingerprint: "sha256:fixture",
  };
}

const node = stack("node", "npm", {
  install: "npm install",
  build: "npm run build",
  test: "npm run test",
  lint: "npm run lint",
  typecheck: "npm run typecheck",
});
const dotnet = stack("dotnet", "dotnet", {
  install: "dotnet restore",
  build: "dotnet build",
  test: "dotnet test",
  lint: "dotnet format --verify-no-changes",
  typecheck: "dotnet build --no-restore",
});
const python = stack("python", "pip", {
  install: "python -m pip install -r requirements.txt",
  build: "python -m build",
  test: "python -m pytest",
  lint: "python -m ruff check .",
  typecheck: "python -m mypy .",
});

describe("renderStackDigest", () => {
  it.each([
    ["node", node, "npm run build"],
    ["dotnet", dotnet, "dotnet test"],
    ["python", python, "python -m pytest"],
  ])("renders the %s resolved profile within budget", (_name, profile, expected) => {
    const rendered = renderStackDigest(profile);
    expect(rendered).toContain(expected);
    expect(rendered).toContain(".agent-team/config.yaml stack");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(STACK_DIGEST_BUDGET_BYTES);
  });

  it("renders a dotnet golden with no npm command", () => {
    const rendered = renderStackDigest(dotnet);
    expect(rendered).not.toMatch(/\bnpm\b/i);
    expect(rendered).toMatchInlineSnapshot(`
      "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->
      # Target-resolved stack

      - Profile: \`dotnet\`
      - Package manager/tool: \`dotnet\`
      - Source roots: \`src\`
      - Schema paths: \`src/App/Migrations\`

      ## Commands

      - install: \`dotnet restore\`
      - build: \`dotnet build\`
      - test: \`dotnet test\`
      - lint: \`dotnet format --verify-no-changes\`
      - typecheck: \`dotnet build --no-restore\`

      Use this repository's existing libraries and conventions. Implement the resolved stack; do not choose a replacement. A stack change is a human decision.
      "
    `);
  });

  it("renders stable node and python goldens", () => {
    expect(renderStackDigest(node)).toMatchInlineSnapshot(`
      "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->
      # Target-resolved stack

      - Profile: \`node\`
      - Package manager/tool: \`npm\`
      - Source roots: \`src\`
      - Schema paths: none detected

      ## Commands

      - install: \`npm install\`
      - build: \`npm run build\`
      - test: \`npm run test\`
      - lint: \`npm run lint\`
      - typecheck: \`npm run typecheck\`

      Use this repository's existing libraries and conventions. Implement the resolved stack; do not choose a replacement. A stack change is a human decision.
      "
    `);
    expect(renderStackDigest(python)).toMatchInlineSnapshot(`
      "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->
      # Target-resolved stack

      - Profile: \`python\`
      - Package manager/tool: \`pip\`
      - Source roots: \`src\`
      - Schema paths: none detected

      ## Commands

      - install: \`python -m pip install -r requirements.txt\`
      - build: \`python -m build\`
      - test: \`python -m pytest\`
      - lint: \`python -m ruff check .\`
      - typecheck: \`python -m mypy .\`

      Use this repository's existing libraries and conventions. Implement the resolved stack; do not choose a replacement. A stack change is a human decision.
      "
    `);
  });

  it("renders the unresolved golden without a Node default", () => {
    const rendered = renderStackDigest();
    expect(rendered).not.toMatch(/node|npm/i);
    expect(rendered).toContain("software-team-agents sync");
    expect(rendered).toMatchInlineSnapshot(`
      "<!-- GENERATED from .agent-team/config.yaml stack; do not edit by hand. -->
      # Target-resolved stack

      Stack not yet detected. Run \`software-team-agents sync\` to resolve and record this Target's profile; do not assume a default stack.
      "
    `);
  });

  it("keeps engineer prompts stack-agnostic while retaining non-stack invariants", () => {
    for (const role of ["backend-engineer", "frontend-engineer"]) {
      const prompt = fs.readFileSync(path.join(defaultProjectRoot(), ".claude", "agents", `${role}.md`), "utf8");
      expect(prompt).toContain(".agent-team/config.yaml");
      expect(prompt).toContain("Implement that stack; do not choose or introduce a replacement.");
      expect(prompt).toContain("Work only on");
      expect(prompt).toContain("Do not decide an unclear rule or ask the user.");
      expect(prompt).toContain("Never set task Status, run git, expose secrets, or invoke another role.");
      expect(prompt).not.toMatch(/\b(?:npm|Prisma|Express|Next\.js|Tailwind|Zustand|Zod)\b/);
    }
  });
});
