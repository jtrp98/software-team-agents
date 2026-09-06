import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHtmlReport, parseStatusMd, runReportVerb, type ReportData } from "./report.js";

const AGENTCLAUDE_INSTALLATION_CONFIG_ORIGINAL = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
beforeEach(() => {
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-report-test-no-installation.yaml");
});
afterEach(() => {
  if (AGENTCLAUDE_INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
  else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = AGENTCLAUDE_INSTALLATION_CONFIG_ORIGINAL;
});

const SAMPLE_STATUS_MD = `# Project Status

## Scaffold
Not scaffolded yet — run the \`setup\` agent before Phase 1.

## Modules

| Module | Stage | Next agent |
|---|---|---|
| test-mod | Phase 1 implementation | backend-engineer |
| auth-mod | Phase 2 verification | qa-engineer |

## test-mod

Docs: requirement ✅ · design ✅ · plan ✅

- Phase 1 — implemented ⚠️ · verified ⬜ · security ⬜ · deployed ⬜
- Phase 2 — implemented ✅ · verified ⬜ · security n/a · deployed ⬜

**Now**: Phase 1 — 2 of 5 unchecked in \`plan.md\`
**Blocked on**: —

## auth-mod

Docs: requirement ✅ · design ✅ · plan ✅

- Phase 1 — implemented ✅ · verified ✅ (FULL) · security ✅ · deployed ✅

**Now**: Phase 2 — verification in progress
**Blocked on**: —
`;

function createFixtureGitRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-report-test-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "init.txt"), "init", "utf8");
  spawnSync("git", ["add", "init.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: dir });

  // Create sample _docs/status.md and module docs
  const statusDir = path.join(dir, "_docs");
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, "status.md"), SAMPLE_STATUS_MD, "utf8");

  const modDir = path.join(statusDir, "module", "test-mod");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "requirement.md"), "# Requirement\n", "utf8");
  fs.writeFileSync(
    path.join(modDir, "plan.md"),
    `# Plan\n\n## Phase 1\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 | verified | backend-engineer | — |\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(modDir, "review.md"),
    `# Review\n\n## Open Issues — all phases\n| Issue | Phase | Routes to | Blocking |\n|---|---|---|---|\n| bug-1 | 1 | backend-engineer | non-blocking |\n`,
    "utf8"
  );

  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("T-V6-018 — sta report verb", () => {
  it("parseStatusMd extracts scaffold, module overview, and per-module phases", () => {
    const data = parseStatusMd(SAMPLE_STATUS_MD);
    expect(data.scaffold).toContain("Not scaffolded yet");
    expect(data.modules).toHaveLength(2);

    const testMod = data.modules.find((m) => m.name === "test-mod");
    expect(testMod).toBeDefined();
    expect(testMod?.stage).toBe("Phase 1 implementation");
    expect(testMod?.nextAgent).toBe("backend-engineer");
    expect(testMod?.docsLine).toContain("Docs: requirement");
    expect(testMod?.nowLine).toContain("**Now**: Phase 1");
    expect(testMod?.blockedOnLine).toBe("**Blocked on**: —");
    expect(testMod?.phases).toHaveLength(2);
    expect(testMod?.phases[0]).toMatchObject({
      phase: 1,
      implemented: "⚠️",
      verified: "⬜",
      security: "⬜",
      deployed: "⬜",
    });
    expect(testMod?.phases[1]).toMatchObject({
      phase: 2,
      implemented: "✅",
      verified: "⬜",
      security: "n/a",
      deployed: "⬜",
    });

    const authMod = data.modules.find((m) => m.name === "auth-mod");
    expect(authMod).toBeDefined();
    expect(authMod?.phases[0].verified).toBe("✅ (FULL)");
  });

  it("generateHtmlReport produces self-contained HTML with four blocks and zero external links", () => {
    const mockReport: ReportData = {
      projectName: "my-mock-project",
      generatedAt: "2026-09-06T12:00:00.000Z",
      overallStatus: "yellow",
      status: {
        absent: false,
        data: parseStatusMd(SAMPLE_STATUS_MD),
      },
      plan: {
        moduleName: "test-mod",
        currentPhase: 1,
        tasks: [
          {
            id: "BE-001",
            phase: 1,
            description: "Set up schema",
            status: "verified",
            owner: "backend-engineer",
            dependsOn: [],
            wave: 1,
            fromCheckbox: false,
            designRefs: [],
          },
          {
            id: "BE-002",
            phase: 1,
            description: "Implement API",
            status: "in_progress",
            owner: "backend-engineer",
            dependsOn: ["BE-001"],
            wave: 2,
            fromCheckbox: false,
            designRefs: [],
          },
        ],
        allPhases: [1, 2],
      },
      review: {
        moduleName: "test-mod",
        absent: false,
        outcome: "⚠️ Partial (FULL)",
        openIssues: [
          {
            raw: "| BE-002 null check | 1 | backend-engineer | blocking |",
            owner: "backend-engineer" as any,
            category: "implementation",
            blocking: true,
            rounds: 1,
            affected: ["BE-002"],
          },
        ],
      },
      changed: {
        projectRoot: "C:\\mock\\root",
        isGit: true,
        changedFiles: ["src/index.ts", "README.md"],
        gate: {
          ok: true,
          status: "passed",
          results: [{ dir: ".", check: "build", status: "passed" }],
        },
        disclaimer: "Deterministic gate notice",
      },
    };

    const html = generateHtmlReport(mockReport);

    // 1. Must have DOCTYPE and HTML structure
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>STA Dashboard — my-mock-project</title>");

    // 2. All 4 blocks present
    expect(html).toContain("1. Modules × Phases Matrix");
    expect(html).toContain("2. Current Phase Plan (Phase 1)");
    expect(html).toContain("3. Open Issues / Reviews");
    expect(html).toContain("4. Working Tree Status");

    // 3. Block contents render
    expect(html).toContain("test-mod");
    expect(html).toContain("BE-001");
    expect(html).toContain("Set up schema");
    expect(html).toContain("BE-002 null check");
    expect(html).toContain("Blocking");
    expect(html).toContain("src/index.ts");
    expect(html).toContain("Gate: PASSED");

    // 4. Must be self-contained — ZERO external network requests
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<script\b[^>]*src=/i);
    expect(html).not.toMatch(/<link\b[^>]*rel=["']?stylesheet["']?/i);
    expect(html).not.toMatch(/@import\s+url/i);
  });

  it("handles missing review.md and plan.md gracefully with stated absences", () => {
    const absentReport: ReportData = {
      projectName: "absent-project",
      generatedAt: "2026-09-06T12:00:00.000Z",
      overallStatus: "yellow",
      status: {
        absent: true,
      },
      plan: {
        moduleName: "nonexistent",
        currentPhase: 1,
        tasks: [],
        allPhases: [],
        absent: true,
      },
      review: {
        moduleName: "nonexistent",
        absent: true,
        openIssues: [],
      },
      changed: {
        projectRoot: "C:\\mock\\root",
        isGit: false,
        changedFiles: [],
        gate: {
          ok: false,
          status: "unverified",
          results: [],
        },
        disclaimer: "Deterministic gate notice",
      },
    };

    const html = generateHtmlReport(absentReport);

    expect(html).toContain("status.md absent");
    expect(html).toContain("plan.md absent");
    expect(html).toContain("No open reviews:");
    expect(html).toContain("<code>_docs/module/nonexistent/review.md</code> absent");
    expect(html).toContain("Working tree clean — 0 changed files.");
  });

  it("runReportVerb writes self-contained HTML to output path", async () => {
    const fixture = createFixtureGitRepo();
    const outputPath = path.join(fixture.dir, ".workflow", "report.html");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = await runReportVerb(
        ["--output", outputPath, "--project-root", fixture.dir, "--module", "test-mod"],
        fixture.dir
      );
      expect(code).toBe(0);
      expect(fs.existsSync(outputPath)).toBe(true);

      const content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("STA Dashboard");
      expect(content).toContain("test-mod");
      expect(content).toContain("BE-001");
      expect(content).toContain("bug-1");
      expect(content).not.toMatch(/https?:\/\//i);
    } finally {
      logSpy.mockRestore();
      fixture.cleanup();
    }
  });
});