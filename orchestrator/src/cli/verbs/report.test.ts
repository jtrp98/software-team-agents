import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePlanTasks } from "../../docs/planGraph.js";
import { renderCanonicalTasks, type PlanTask } from "../../docs/planTask.js";
import { generateHtmlReport, parseStatusMd, runReportVerb, summarizeChangedByTarget, summarizeCodeIntel, type ReportData } from "./report.js";

const STA_INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
beforeEach(() => {
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-report-test-no-installation.yaml");
});
afterEach(() => {
  if (STA_INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = STA_INSTALLATION_CONFIG_ORIGINAL;
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

function reportTask(id: string, title: string, status: PlanTask["status"], dependsOn: string[] = []): PlanTask {
  return {
    version: 1,
    id,
    phase: 1,
    title,
    objective: `${title} under the current contract.`,
    why: "The current plan requires this work.",
    owner: "backend-engineer",
    dependsOn,
    traceability: ["REQ-001", "AC-001.1", "DES-001"],
    produces: [],
    consumes: [],
    risk: ["low"],
    humanGate: [],
    status,
    scopeAndConstraints: "Keep the change within this module.",
    retrievalHints: "Hypothesis: current source owns the behavior.\nQuery: locate the contract.\nProvenance: DES-001",
    doNotModify: "Unrelated modules.",
    acceptanceCriteria: "AC-001.1: the report renders the task.",
    validationAndEvidence: "Verify AC-001.1 by rendering the report and asserting the task title.",
    compatibility: "Current callers remain unchanged.",
  };
}

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
    renderCanonicalTasks([reportTask("BE-001", "Set up schema", "verified")]),
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

  it("generateHtmlReport produces a self-contained report including bounded-run evidence", () => {
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
          reportTask("BE-001", "Set up schema", "verified"),
          reportTask("BE-002", "Implement API", "in_progress", ["BE-001"]),
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
      runs: [{
        run_id: "01J00000000000000000000063",
        target_root: "C:\\mock\\root",
        module: "test-mod",
        wave: 1,
        state: "HUMAN_REVIEW",
        base_branch: "main",
        base_sha: "a".repeat(40),
        run_branch: "sta/run/test-mod/01J00000000000000000000063",
        task_order: ["BE-001"],
        runtime_id: "claude-code",
        tier: "T2",
        model: "opus",
        tasks: [{
          task_id: "BE-001",
          status: "CHECKPOINTED",
          duration_ms: 2000,
          changed_files: ["src/index.ts"],
          checkpoint_sha: "b".repeat(40),
          checkpoint_subject: "sta(BE-001): checkpoint",
          gate: "passed",
          gate_summary: "typecheck",
        }],
        next_required_human_action: "Review checkpoints with qa-engineer; only a human may declare MERGE_READY.",
        merge_advisory: {
          kind: "diverged",
          command: "git switch main && git merge --ff-only sta/run/test-mod/01J00000000000000000000063",
          advanced_by: 1,
          overlapping_paths: ["src/index.ts"],
        },
        disclaimer: "Deterministic gate only — CHECKPOINTED is a durability fact, not a QA verdict.",
      }],
      orphanRunBranches: [{ target_root: "C:\\mock\\root", branch: "sta/run/orphan/old" }],
    };

    const html = generateHtmlReport(mockReport);

    // 1. Must have DOCTYPE and HTML structure
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>STA Dashboard — my-mock-project</title>");

    // 2. Existing blocks and the additive run section are present
    expect(html).toContain("1. Modules × Phases Matrix");
    expect(html).toContain("2. Current Phase Plan (Phase 1)");
    expect(html).toContain("3. Open Issues / Reviews");
    expect(html).toContain("4. Working Tree Status");
    expect(html).toContain("5. Bounded Runs");

    // 3. Block contents render
    expect(html).toContain("test-mod");
    expect(html).toContain("BE-001");
    expect(html).toContain("Set up schema");
    expect(html).toContain("BE-002 null check");
    expect(html).toContain("Blocking");
    expect(html).toContain("src/index.ts");
    expect(html).toContain("Gate: PASSED");
    expect(html).toContain("CHECKPOINTED");
    expect(html).toContain("Next required human action:");
    expect(html).toContain("base branch advanced by 1 commit");
    expect(html).toContain("overlapping paths: src/index.ts");
    expect(html).toContain("Orphan run branches — listed only, never removed:");
    expect(html).toContain("CHECKPOINTED is a durability fact, not a QA verdict");
    expect(html).not.toMatch(/\b(?:BE-001|1 tasks?)\s+(?:complete|done|passed)\b/i);

    // 4. Must be self-contained — ZERO external network requests
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<script\b[^>]*src=/i);
    expect(html).not.toMatch(/<link\b[^>]*rel=["']?stylesheet["']?/i);
    expect(html).not.toMatch(/@import\s+url/i);
  });

  it("V10 TASK-013 groups a report's bounded-run diffs by target root", () => {
    const runs: ReportData["runs"] = [
      {
        run_id: "01J00000000000000000000063",
        target_root: "C:\\mock\\target-api",
        module: "test-mod",
        wave: 1,
        state: "WAVE_COMPLETE",
        base_branch: "main",
        base_sha: "a".repeat(40),
        run_branch: "sta/run/test-mod/01J00000000000000000000063",
        task_order: ["BE-001", "BE-002"],
        runtime_id: "claude-code",
        tier: "T2",
        model: "opus",
        tasks: [
          { task_id: "BE-001", status: "CHECKPOINTED", changed_files: ["server/a.ts", "server/b.ts"] },
          { task_id: "BE-002", status: "CHECKPOINTED", changed_files: ["server/b.ts"] },
        ],
        next_required_human_action: "Review checkpoints with qa-engineer; only a human may declare MERGE_READY.",
        merge_advisory: { kind: "none", reason: "not-reviewable" },
        disclaimer: "Deterministic gate only — CHECKPOINTED is a durability fact, not a QA verdict.",
      },
      {
        run_id: "01J00000000000000000000064",
        target_root: "C:\\mock\\target-web",
        module: "test-mod",
        wave: 1,
        state: "WAVE_COMPLETE",
        base_branch: "main",
        base_sha: "a".repeat(40),
        run_branch: "sta/run/test-mod/01J00000000000000000000064",
        task_order: ["FE-001"],
        runtime_id: "claude-code",
        tier: "T2",
        model: "opus",
        tasks: [{ task_id: "FE-001", status: "CHECKPOINTED", changed_files: ["web/app.tsx"] }],
        next_required_human_action: "Review checkpoints with qa-engineer; only a human may declare MERGE_READY.",
        merge_advisory: { kind: "none", reason: "not-reviewable" },
        disclaimer: "Deterministic gate only — CHECKPOINTED is a durability fact, not a QA verdict.",
      },
    ];

    const summary = summarizeChangedByTarget(runs);
    expect(summary).toEqual([
      { target_root: "C:\\mock\\target-api", changed_file_count: 2, changed_files: ["server/a.ts", "server/b.ts"] },
      { target_root: "C:\\mock\\target-web", changed_file_count: 1, changed_files: ["web/app.tsx"] },
    ]);

    const mockReport: ReportData = {
      projectName: "my-mock-project",
      generatedAt: "2026-09-06T12:00:00.000Z",
      overallStatus: "green",
      status: { absent: true },
      plan: { moduleName: "test-mod", currentPhase: 1, tasks: [], allPhases: [], absent: true },
      review: { moduleName: "test-mod", absent: true, openIssues: [] },
      changed: {
        projectRoot: "C:\\mock\\root",
        isGit: true,
        changedFiles: [],
        gate: { ok: true, status: "passed", results: [] },
        disclaimer: "Deterministic gate notice",
      },
      runs,
    };

    const html = generateHtmlReport(mockReport);
    expect(html).toContain("Diff summary by target");
    expect(html).toContain("C:\\mock\\target-api");
    expect(html).toContain("C:\\mock\\target-web");
    expect(html).toContain("2 file(s)");
    expect(html).toContain("1 file(s)");
    expect(html).toContain("server/a.ts");
    expect(html).toContain("web/app.tsx");
  });

  it("V10 TASK-018 summarizes code-intel activity per run from the audit trail and run records", () => {
    const mockReportBase: ReportData = {
      projectName: "my-mock-project",
      generatedAt: "2026-09-06T12:00:00.000Z",
      overallStatus: "green",
      status: { absent: true },
      plan: { moduleName: "test-mod", currentPhase: 1, tasks: [], allPhases: [], absent: true },
      review: { moduleName: "test-mod", absent: true, openIssues: [] },
      changed: {
        projectRoot: "C:\\mock\\root",
        isGit: true,
        changedFiles: [],
        gate: { ok: true, status: "passed", results: [] },
        disclaimer: "Deterministic gate notice",
      },
    };
    const store = {
      listTasks: () => [{ taskId: "BE-001" }, { taskId: "BE-002" }, { taskId: "BE-003" }],
      eventsForTask: (taskId: string) =>
        taskId === "BE-001"
          ? [
              { taskId, at: 1, type: "CODE_INTELLIGENCE_QUERY", payload: {}, actor: null, reason: null, input: null, output: null, decision: null },
              { taskId, at: 2, type: "CODE_INTELLIGENCE_HIT", payload: { count: 4 }, actor: null, reason: null, input: null, output: null, decision: null },
              { taskId, at: 3, type: "CODE_INTELLIGENCE_STALE", payload: {}, actor: null, reason: null, input: null, output: null, decision: null },
              { taskId, at: 4, type: "CODE_INTELLIGENCE_FALLBACK", payload: { reason: "stale" }, actor: null, reason: null, input: null, output: null, decision: null },
            ]
          : taskId === "BE-002"
            ? [{ taskId, at: 5, type: "CODE_INTELLIGENCE_FALLBACK", payload: { reason: "missing-index" }, actor: null, reason: null, input: null, output: null, decision: null }]
            : [],
      runsForTask: (taskId: string) =>
        taskId === "BE-001"
          ? [
              { code_intel_chars: 4210 },
              { code_intel_chars: 8123 },
            ]
          : taskId === "BE-002"
            ? [{ code_intel_chars: 0 }]
            : [],
    };
    // A minimal store stub — summarizeCodeIntel reads only these three members.
    const summaries = summarizeCodeIntel(store as unknown as Parameters<typeof summarizeCodeIntel>[0]);
    expect(summaries).toEqual([
      expect.objectContaining({
        task_id: "BE-001",
        events: { CODE_INTELLIGENCE_QUERY: 1, CODE_INTELLIGENCE_HIT: 1, CODE_INTELLIGENCE_STALE: 1, CODE_INTELLIGENCE_FALLBACK: 1 },
        last_fallback_reason: "stale",
        attempts_with_evidence: 2,
        total_attempts: 2,
        last_code_intel_chars: 8123,
      }),
      expect.objectContaining({
        task_id: "BE-002",
        last_fallback_reason: "missing-index",
        attempts_with_evidence: 0,
        total_attempts: 1,
        last_code_intel_chars: 0,
      }),
    ]);
    // A task with zero code-intel activity stays out of the summary — it would be noise, not evidence.
    expect(summaries.map((summary) => summary.task_id)).not.toContain("BE-003");

    const html = generateHtmlReport({ ...mockReportBase, codeIntel: summaries });
    expect(html).toContain("Code Intelligence (audit-trail summary)");
    expect(html).toContain("BE-001");
    expect(html).toContain("2/2 attempt(s)");
    expect(html).toContain("Last fallback reason");
    expect(html).toContain("<code>stale</code>");
    expect(html).toContain("never a QA pass condition");
    // No section at all when no state database existed.
    expect(generateHtmlReport({ ...mockReportBase, codeIntel: undefined })).not.toContain("Code Intelligence");
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
      const fixturePlan = fs.readFileSync(path.join(fixture.dir, "_docs", "module", "test-mod", "plan.md"), "utf8");
      expect(parsePlanTasks(fixturePlan)).toMatchObject({ problems: [], tasks: [expect.objectContaining({ id: "BE-001" })] });
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
