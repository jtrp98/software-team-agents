import * as fs from "node:fs";
import * as path from "node:path";
import { sectionMap } from "../../context/sections.js";
import { parsePlanTasks, type PlanTaskRow } from "../../docs/planGraph.js";
import { parseOpenIssues, type OpenIssueRow } from "../../orchestrator/failureClassifier.js";
import { readModuleDoc, resolveModule, listModules } from "../../agents/moduleDocs.js";
import { resolveContextDocsRoot } from "../../targetcli/roots.js";
import { listOrphanRunBranches, observeRuns, renderMergeAdvisory, type OrphanRunBranch, type RunObservation } from "../../run/observability.js";
import { getChangedSummary, type ChangedSummary } from "./changed.js";
import { flagValue } from "../support.js";

export interface StatusPhaseRow {
  phase: number;
  implemented: string;
  verified: string;
  security: string;
  deployed: string;
  raw: string;
}

export interface StatusModuleBlock {
  name: string;
  docsLine?: string;
  nowLine?: string;
  blockedOnLine?: string;
  stage?: string;
  nextAgent?: string;
  phases: StatusPhaseRow[];
}

export interface StatusReportData {
  scaffold?: string;
  modules: StatusModuleBlock[];
}

export interface PlanReportData {
  moduleName: string;
  currentPhase: number;
  tasks: PlanTaskRow[];
  allPhases: number[];
  absent?: boolean;
}

export interface ReviewReportData {
  moduleName: string;
  absent: boolean;
  outcome?: string;
  openIssues: OpenIssueRow[];
}

export interface ReportData {
  projectName: string;
  generatedAt: string;
  overallStatus: "green" | "yellow" | "red";
  status: {
    absent: boolean;
    data?: StatusReportData;
    error?: string;
  };
  plan: PlanReportData;
  review: ReviewReportData;
  changed: ChangedSummary;
  runs?: RunObservation[];
  orphanRunBranches?: OrphanRunBranch[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parsePhaseDetail(detail: string): { implemented: string; verified: string; security: string; deployed: string } {
  const parts = detail.split(/\s*·\s*/);
  let implemented = "⬜";
  let verified = "⬜";
  let security = "⬜";
  let deployed = "⬜";
  for (const p of parts) {
    const trimmed = p.trim();
    const m = trimmed.match(/^(implemented|verified|security|deployed)\s+(.*)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const val = m[2].trim();
      if (kind === "implemented") implemented = val;
      else if (kind === "verified") verified = val;
      else if (kind === "security") security = val;
      else if (kind === "deployed") deployed = val;
    }
  }
  return { implemented, verified, security, deployed };
}

/** Parses _docs/status.md using sectionMap and regex extraction. */
export function parseStatusMd(statusText: string): StatusReportData {
  const sections = sectionMap(statusText);
  const lines = statusText.split(/\r?\n/);

  let scaffold: string | undefined;
  const scaffoldSection = sections.find((s) => /^scaffold\b/i.test(s.heading));
  if (scaffoldSection) {
    const sLines = lines.slice(scaffoldSection.start + 1, scaffoldSection.end).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("<!--"));
    if (sLines.length > 0) scaffold = sLines[0];
  }

  // Parse ## Modules overview table if present
  const moduleOverview = new Map<string, { stage: string; nextAgent: string }>();
  const modulesSection = sections.find((s) => /^modules\b/i.test(s.heading));
  if (modulesSection) {
    const mLines = lines.slice(modulesSection.start + 1, modulesSection.end);
    let sawHeader = false;
    for (const line of mLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) continue;
      if (/^\|?\s*:?-{2,}/.test(trimmed)) continue;
      const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
      if (!sawHeader) {
        sawHeader = true;
        continue;
      }
      if (cells.length >= 3) {
        moduleOverview.set(cells[0], { stage: cells[1], nextAgent: cells[2] });
      }
    }
  }

  const modules: StatusModuleBlock[] = [];
  for (const s of sections) {
    if (/^(scaffold|modules)\b/i.test(s.heading)) continue;
    const sLines = lines.slice(s.start + 1, s.end);
    let docsLine: string | undefined;
    let nowLine: string | undefined;
    let blockedOnLine: string | undefined;
    const phases: StatusPhaseRow[] = [];

    for (const l of sLines) {
      const trimmed = l.trim();
      if (/^docs:/i.test(trimmed)) docsLine = trimmed;
      if (/^\*\*now\*\*/i.test(trimmed)) nowLine = trimmed;
      if (/^\*\*blocked on\*\*/i.test(trimmed)) blockedOnLine = trimmed;
      const pm = trimmed.match(/^-\s*Phase\s*(\d+)\s*[-—–]+\s*(.*)$/i);
      if (pm) {
        const num = Number(pm[1]);
        const details = parsePhaseDetail(pm[2]);
        phases.push({
          phase: num,
          implemented: details.implemented,
          verified: details.verified,
          security: details.security,
          deployed: details.deployed,
          raw: trimmed,
        });
      }
    }

    const overview = moduleOverview.get(s.heading);
    modules.push({
      name: s.heading,
      docsLine,
      nowLine,
      blockedOnLine,
      stage: overview?.stage,
      nextAgent: overview?.nextAgent,
      phases,
    });
  }

  return { scaffold, modules };
}

function statusBadgeClass(symbol: string): string {
  if (symbol.includes("✅") || symbol.toLowerCase() === "passed" || symbol.toLowerCase() === "pass") return "badge-green";
  if (symbol.includes("⚠️") || symbol.toLowerCase() === "partial" || symbol.toLowerCase() === "in_progress") return "badge-yellow";
  if (symbol.includes("❌") || symbol.toLowerCase() === "failed" || symbol.toLowerCase() === "fail" || symbol.toLowerCase() === "blocked") return "badge-red";
  if (symbol.toLowerCase() === "n/a") return "badge-muted";
  return "badge-gray";
}

/** Generates completely self-contained offline HTML string. */
export function generateHtmlReport(report: ReportData): string {
  const overallBadgeClass =
    report.overallStatus === "green" ? "badge-green" : report.overallStatus === "yellow" ? "badge-yellow" : "badge-red";
  const overallLabel = report.overallStatus.toUpperCase();

  // Type breakdown for changed files
  const extCounts: Record<string, number> = {};
  for (const f of report.changed.changedFiles) {
    const ext = path.extname(f) || "(none)";
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const extSummary = Object.entries(extCounts)
    .map(([ext, count]) => `<span class="tag"><code>${escapeHtml(ext)}</code>: ${count}</span>`)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>STA Dashboard — ${escapeHtml(report.projectName)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --border-dark: #cbd5e1;
      --green-bg: #dcfce7;
      --green-text: #166534;
      --green-border: #86efac;
      --yellow-bg: #fef9c3;
      --yellow-text: #854d0e;
      --yellow-border: #fde047;
      --red-bg: #fee2e2;
      --red-text: #991b1b;
      --red-border: #fca5a5;
      --gray-bg: #f1f5f9;
      --gray-text: #334155;
      --gray-border: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    header h1 {
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .meta-line {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .block {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    .block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .block-header h2 {
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge-lg {
      padding: 6px 16px;
      font-size: 14px;
      border-radius: 16px;
    }
    .badge-green { background: var(--green-bg); color: var(--green-text); border-color: var(--green-border); }
    .badge-yellow { background: var(--yellow-bg); color: var(--yellow-text); border-color: var(--yellow-border); }
    .badge-red { background: var(--red-bg); color: var(--red-text); border-color: var(--red-border); }
    .badge-gray { background: var(--gray-bg); color: var(--gray-text); border-color: var(--gray-border); }
    .badge-muted { background: #f8fafc; color: #94a3b8; border-color: #e2e8f0; }
    .tag {
      display: inline-block;
      background: var(--gray-bg);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 6px;
      margin-bottom: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      margin-top: 8px;
    }
    th, td {
      text-align: left;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: #f8fafc;
      font-weight: 600;
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fdfdfd; }
    .card-notice {
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      background: #f8fafc;
    }
    .card-warning {
      background: #fffbeb;
      border-color: #fde68a;
      color: #92400e;
    }
    .card-success {
      background: #f0fdf4;
      border-color: #bbf7d0;
      color: #166534;
    }
    .file-list {
      max-height: 200px;
      overflow-y: auto;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 12px;
      margin-top: 10px;
    }
    .file-item {
      padding: 2px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .file-item:last-child { border-bottom: none; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 2px 4px;
      border-radius: 3px;
    }
    footer {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 32px;
      padding-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>STA Dashboard — ${escapeHtml(report.projectName)}</h1>
        <div class="meta-line">
          Generated: <strong>${escapeHtml(report.generatedAt)}</strong> &bull; Module: <strong>${escapeHtml(report.plan.moduleName)}</strong>
        </div>
      </div>
      <div>
        <span class="badge badge-lg ${overallBadgeClass}">Overall: ${overallLabel}</span>
      </div>
    </header>

    <!-- BLOCK 1: Modules × Phases Matrix -->
    <section class="block">
      <div class="block-header">
        <h2>1. Modules × Phases Matrix</h2>
        ${report.status.absent ? '<span class="badge badge-yellow">status.md absent</span>' : '<span class="badge badge-green">status.md synced</span>'}
      </div>
      ${
        report.status.absent
          ? `<div class="card-notice card-warning">
              <strong>_docs/status.md absent:</strong> No status file found at target knowledge root.
            </div>`
          : ""
      }
      ${
        !report.status.absent && report.status.data && report.status.data.modules.length > 0
          ? `<table>
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Phase</th>
                  <th>Implemented</th>
                  <th>Verified</th>
                  <th>Security</th>
                  <th>Deployed</th>
                  <th>Status / Blockers</th>
                </tr>
              </thead>
              <tbody>
                ${report.status.data.modules
                  .flatMap((mod) => {
                    if (mod.phases.length === 0) {
                      return `<tr>
                        <td><strong>${escapeHtml(mod.name)}</strong></td>
                        <td colspan="5"><em>No phases listed</em></td>
                        <td>${mod.nowLine ? escapeHtml(mod.nowLine) : "—"}</td>
                      </tr>`;
                    }
                    return mod.phases.map((ph, idx) => `<tr>
                      ${idx === 0 ? `<td rowspan="${mod.phases.length}"><strong>${escapeHtml(mod.name)}</strong><br><small class="meta-line">${escapeHtml(mod.stage || "")}</small></td>` : ""}
                      <td>Phase ${ph.phase}</td>
                      <td><span class="badge ${statusBadgeClass(ph.implemented)}">${escapeHtml(ph.implemented)}</span></td>
                      <td><span class="badge ${statusBadgeClass(ph.verified)}">${escapeHtml(ph.verified)}</span></td>
                      <td><span class="badge ${statusBadgeClass(ph.security)}">${escapeHtml(ph.security)}</span></td>
                      <td><span class="badge ${statusBadgeClass(ph.deployed)}">${escapeHtml(ph.deployed)}</span></td>
                      <td>${idx === 0 ? escapeHtml(mod.nowLine || mod.blockedOnLine || "—") : ""}</td>
                    </tr>`);
                  })
                  .join("")}
              </tbody>
            </table>`
          : !report.status.absent
          ? '<div class="card-notice">No module blocks found in <code>_docs/status.md</code>.</div>'
          : ""
      }
    </section>

    <!-- BLOCK 2: Current Phase Plan -->
    <section class="block">
      <div class="block-header">
        <h2>2. Current Phase Plan (Phase ${report.plan.currentPhase})</h2>
        <span class="badge badge-gray">${escapeHtml(report.plan.moduleName)}</span>
      </div>
      ${
        report.plan.absent
          ? `<div class="card-notice card-warning">
              <strong>plan.md absent:</strong> No <code>plan.md</code> found for module <code>${escapeHtml(report.plan.moduleName)}</code>.
            </div>`
          : report.plan.tasks.length === 0
          ? `<div class="card-notice">
              No tasks found for Phase ${report.plan.currentPhase} in <code>plan.md</code>.
            </div>`
          : `<table>
              <thead>
                <tr>
                  <th style="width: 50px;">Check</th>
                  <th style="width: 140px;">Task ID</th>
                  <th>Description</th>
                  <th style="width: 100px;">Status</th>
                  <th style="width: 140px;">Owner</th>
                  <th style="width: 120px;">Depends on</th>
                  <th style="width: 60px;">Tier</th>
                </tr>
              </thead>
              <tbody>
                ${report.plan.tasks
                  .map(
                    (t) => `<tr>
                  <td>${t.status === "verified" ? "✅" : "⬜"}</td>
                  <td><code>${escapeHtml(t.id)}</code></td>
                  <td>${escapeHtml(t.description)}</td>
                  <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
                  <td>${escapeHtml(t.owner)}</td>
                  <td>${t.dependsOn.length > 0 ? t.dependsOn.map(escapeHtml).join(", ") : "—"}</td>
                  <td>${t.tier ? `<span class="badge badge-gray">${escapeHtml(t.tier)}</span>` : "—"}</td>
                </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </section>

    <!-- BLOCK 3: Open Issues / Reviews -->
    <section class="block">
      <div class="block-header">
        <h2>3. Open Issues / Reviews</h2>
        ${
          report.review.absent
            ? '<span class="badge badge-gray">review.md absent</span>'
            : report.review.openIssues.length > 0
            ? '<span class="badge badge-yellow">' + report.review.openIssues.length + ' open</span>'
            : '<span class="badge badge-green">clean</span>'
        }
      </div>
      ${
        report.review.absent
          ? `<div class="card-notice">
              <strong>No open reviews:</strong> <code>_docs/module/${escapeHtml(report.review.moduleName)}/review.md</code> absent.
            </div>`
          : report.review.openIssues.length === 0
          ? `<div class="card-notice card-success">
              ✅ <strong>No open reviews:</strong> 0 open issues recorded in <code>review.md</code>.
              ${report.review.outcome ? `<br><small>Latest Outcome: <code>${escapeHtml(report.review.outcome)}</code></small>` : ""}
            </div>`
          : `<table>
              <thead>
                <tr>
                  <th>Issue / Raw</th>
                  <th>Owner / Routes to</th>
                  <th>Category</th>
                  <th>Rounds</th>
                  <th>Blocking</th>
                </tr>
              </thead>
              <tbody>
                ${report.review.openIssues
                  .map(
                    (iss) => `<tr>
                  <td><code>${escapeHtml(iss.raw)}</code></td>
                  <td>${iss.owner ? escapeHtml(iss.owner) : "—"}</td>
                  <td>${iss.category ? `<span class="tag">${escapeHtml(iss.category)}</span>` : "—"}</td>
                  <td>${iss.rounds || 1}</td>
                  <td>${iss.blocking ? '<span class="badge badge-red">Blocking</span>' : '<span class="badge badge-gray">Non-blocking</span>'}</td>
                </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </section>

    <!-- BLOCK 4: Working Tree Status -->
    <section class="block">
      <div class="block-header">
        <h2>4. Working Tree Status</h2>
        <span class="badge ${statusBadgeClass(report.changed.gate.status)}">Gate: ${escapeHtml(report.changed.gate.status.toUpperCase())}</span>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
        Changed files: <strong>${report.changed.changedFiles.length}</strong> &bull; Stack profile: <code>${escapeHtml(report.changed.gate.profile || "none detected")}</code>
      </p>
      ${extSummary ? `<div style="margin-bottom: 12px;">${extSummary}</div>` : ""}

      ${
        report.changed.changedFiles.length > 0
          ? `<details>
              <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text);">View Changed Files (${report.changed.changedFiles.length})</summary>
              <div class="file-list">
                ${report.changed.changedFiles.map((f) => `<div class="file-item">${escapeHtml(f)}</div>`).join("")}
              </div>
            </details>`
          : '<div class="card-notice card-success">Working tree clean — 0 changed files.</div>'
      }

      <div style="margin-top: 16px;">
        <h3 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Deterministic Checks</h3>
        ${
          report.changed.gate.results.length === 0
            ? `<div class="card-notice">${escapeHtml(report.changed.gate.message || "No checks executed.")}</div>`
            : `<table>
                <thead>
                  <tr>
                    <th>Directory</th>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Reason / Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${report.changed.gate.results
                    .map(
                      (r) => `<tr>
                    <td><code>${escapeHtml(r.dir || ".")}</code></td>
                    <td><strong>${escapeHtml(r.check)}</strong></td>
                    <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
                    <td>${escapeHtml(r.reason || r.command || "—")}</td>
                  </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>`
        }
      </div>

      <div class="card-notice" style="margin-top: 16px;">
        <small class="meta-line">Notice: ${escapeHtml(report.changed.disclaimer)}</small>
      </div>
    </section>

    ${report.runs === undefined ? "" : `<section class="block">
      <div class="block-header">
        <h2>5. Bounded Runs</h2>
        <span class="badge badge-gray">${report.runs.length} RUN(S)</span>
      </div>
      ${report.runs.length === 0
        ? '<div class="card-notice">No bounded-run artifacts found.</div>'
        : report.runs.map((run) => `<div class="card" style="margin-bottom: 16px;">
            <h3><code>${escapeHtml(run.run_id)}</code> — ${escapeHtml(run.state)}</h3>
            <p class="meta-line">module=${escapeHtml(run.module)} · wave=${run.wave} · runtime=${escapeHtml(run.runtime_id)} · tier=${escapeHtml(run.tier)} · model=${escapeHtml(run.model)}</p>
            <p class="meta-line">base=${escapeHtml(run.base_branch)}@${escapeHtml(run.base_sha)} · run branch=${escapeHtml(run.run_branch)}</p>
            <p class="meta-line">task order: ${run.task_order.map(escapeHtml).join(" → ")}</p>
            <table>
              <thead><tr><th>Task</th><th>Status</th><th>Duration</th><th>Changed files</th><th>Checkpoint</th><th>Gate</th><th>Failure</th></tr></thead>
              <tbody>${run.tasks.map((task) => `<tr>
                <td><code>${escapeHtml(task.task_id)}</code></td>
                <td>${escapeHtml(task.status)}</td>
                <td>${task.duration_ms === undefined ? "—" : `${task.duration_ms} ms`}</td>
                <td>${task.changed_files.length === 0 ? "—" : task.changed_files.map(escapeHtml).join("<br>")}</td>
                <td>${task.checkpoint_sha ? `<code>${escapeHtml(task.checkpoint_sha)}</code><br>${escapeHtml(task.checkpoint_subject ?? "")}` : "—"}</td>
                <td>${task.gate ? `${escapeHtml(task.gate)}${task.gate_summary ? `<br>${escapeHtml(task.gate_summary)}` : ""}` : "—"}</td>
                <td>${task.failure_reason ? `${escapeHtml(task.failure_class ?? "unknown")}: ${escapeHtml(task.failure_reason)}` : "—"}</td>
              </tr>`).join("")}</tbody>
            </table>
            ${run.failure_reason ? `<div class="card-notice card-error">Run failure: ${escapeHtml(run.failure_class ?? "unknown")} — ${escapeHtml(run.failure_reason)}</div>` : ""}
            <div class="card-notice"><strong>Next required human action:</strong> ${escapeHtml(run.next_required_human_action)}</div>
            ${renderMergeAdvisory(run, run.merge_advisory).map((line) => `<div class="card-notice">${escapeHtml(line.replace(/^\[orchestrator\]\s*/, ""))}</div>`).join("")}
            <div class="card-notice"><small class="meta-line">${escapeHtml(run.disclaimer)}</small></div>
          </div>`).join("")}
      ${(report.orphanRunBranches ?? []).length === 0
        ? ""
        : `<div class="card-notice"><strong>Orphan run branches — listed only, never removed:</strong><br>${(report.orphanRunBranches ?? []).map((entry) => `<code>${escapeHtml(entry.branch)}</code> (${escapeHtml(entry.target_root)})`).join("<br>")}</div>`}
    </section>`}

    <footer>
      Generated by <code>sta report</code> &bull; Self-contained offline dashboard &bull; Zero external requests
    </footer>
  </div>
</body>
</html>`;
}

/** `report [--output <path>] [--project-root <path>] [--module <name>]` verb. */
export async function runReportVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  const moduleHint = flagValue(rest, "--module");
  const outputArg = flagValue(rest, "--output");
  const outputPath = outputArg ? path.resolve(projectRoot, outputArg) : path.join(projectRoot, ".workflow", "report.html");

  const docsRoot = resolveContextDocsRoot(projectRoot);

  // 1. Read status.md
  const statusPath = path.join(docsRoot, "_docs", "status.md");
  let statusAbsent = true;
  let statusData: StatusReportData | undefined;
  let statusError: string | undefined;

  try {
    if (fs.existsSync(statusPath)) {
      const statusText = fs.readFileSync(statusPath, "utf8");
      statusData = parseStatusMd(statusText);
      statusAbsent = false;
    }
  } catch (err) {
    statusError = err instanceof Error ? err.message : String(err);
  }

  // Resolve target module for Block 2 & 3
  let resolvedModuleName = moduleHint;
  if (!resolvedModuleName) {
    const candidate = resolveModule(docsRoot, undefined);
    if (candidate.status === "one") {
      resolvedModuleName = candidate.module;
    } else {
      const allMods = listModules(docsRoot);
      if (allMods.length > 0) resolvedModuleName = allMods[0];
      else if (statusData && statusData.modules.length > 0) resolvedModuleName = statusData.modules[0].name;
      else resolvedModuleName = "default";
    }
  }

  // 2. Read plan.md
  let planAbsent = true;
  let planTasks: PlanTaskRow[] = [];
  let planPhases: number[] = [];
  let currentPhase = 1;

  // Determine current phase from status.md if possible
  if (statusData) {
    const modBlock = statusData.modules.find((m) => m.name === resolvedModuleName);
    if (modBlock?.nowLine) {
      const phMatch = modBlock.nowLine.match(/Phase\s*(\d+)/i);
      if (phMatch) currentPhase = Number(phMatch[1]);
    }
  }

  const planText = readModuleDoc(docsRoot, resolvedModuleName, "plan.md");
  if (planText) {
    planAbsent = false;
    const parsed = parsePlanTasks(planText);
    planPhases = [...new Set(parsed.tasks.map((t) => t.phase))].sort((a, b) => a - b);
    if (planPhases.length > 0 && !planPhases.includes(currentPhase)) {
      currentPhase = planPhases[0];
    }
    planTasks = parsed.tasks.filter((t) => t.phase === currentPhase);
    if (planTasks.length === 0 && parsed.tasks.length > 0) {
      // Fall back to first non-empty phase
      currentPhase = parsed.tasks[0].phase;
      planTasks = parsed.tasks.filter((t) => t.phase === currentPhase);
    }
  }

  // 3. Read review.md
  let reviewAbsent = true;
  let openIssues: OpenIssueRow[] = [];
  let reviewOutcome: string | undefined;

  const reviewText = readModuleDoc(docsRoot, resolvedModuleName, "review.md");
  if (reviewText) {
    reviewAbsent = false;
    openIssues = parseOpenIssues(reviewText);
    const outcomeMatch = reviewText.match(/\*\*Status:\*\*\s*(.+)/i);
    if (outcomeMatch) reviewOutcome = outcomeMatch[1].trim();
  }

  // 4. Working tree changes & gate status
  const changed = await getChangedSummary(projectRoot);
  const runs = await observeRuns(projectRoot);
  const orphanRunBranches = await listOrphanRunBranches(projectRoot, runs);

  // Overall status derivation
  let overallStatus: "green" | "yellow" | "red" = "green";
  if (changed.gate.status === "failed" || openIssues.some((i) => i.blocking)) {
    overallStatus = "red";
  } else if (changed.gate.status === "unverified" || openIssues.length > 0 || changed.changedFiles.length > 0) {
    overallStatus = "yellow";
  }

  const report: ReportData = {
    projectName: path.basename(projectRoot),
    generatedAt: new Date().toISOString(),
    overallStatus,
    status: {
      absent: statusAbsent,
      data: statusData,
      error: statusError,
    },
    plan: {
      moduleName: resolvedModuleName,
      currentPhase,
      tasks: planTasks,
      allPhases: planPhases,
      absent: planAbsent,
    },
    review: {
      moduleName: resolvedModuleName,
      absent: reviewAbsent,
      outcome: reviewOutcome,
      openIssues,
    },
    changed,
    runs,
    orphanRunBranches,
  };

  const html = generateHtmlReport(report);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");

  console.log(`[orchestrator] report written to ${outputPath}`);
  return 0;
}
