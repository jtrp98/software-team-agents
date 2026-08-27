import * as fs from "node:fs";
import { AgentStage } from "../dist/types.js";
import { buildContextCommand, renderContextCommand } from "../dist/context/contextCommand.js";
import { sliceModuleDocsWithSavings } from "../dist/runtime/agentRunAssembly.js";
import { createTraceableTokenBenchmarkFixture } from "../dist/observability/tokenBenchmark.js";

const roles = [
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.PROJECT_MANAGER,
  AgentStage.TEST_PLANNER,
  AgentStage.UXUI_DESIGNER,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
  AgentStage.SECURITY,
];

const fixture = createTraceableTokenBenchmarkFixture();
try {
  const rows = [];
  for (const role of roles) {
    const command = await buildContextCommand({
      role,
      moduleHint: fixture.moduleName,
      phases: [1],
      projectRoot: fixture.root,
      env: {},
    });
    const run = sliceModuleDocsWithSavings(role, {
      projectRoot: fixture.root,
      moduleName: fixture.moduleName,
      phases: [1],
    });
    const rendered = renderContextCommand(command);
    const skippedNamed = command.context.selected.every((doc) =>
      doc.skipped.every((heading) => rendered.includes(heading)),
    );
    rows.push({
      role,
      doc_chars_before: command.context.savings.bytesBefore,
      doc_chars_after: command.context.savings.bytesAfter,
      savings_pct: command.context.savings.savedPct,
      direct_file_reads: command.context.directFileReads,
      fallback_to_full: command.context.selected.filter((doc) => doc.fullDocument && /passed through whole|traceability is incomplete|no REQ-NNN|no phase given|parser confidence/i.test(doc.reason)).length,
      owner_or_policy_full: command.context.selected.filter((doc) => doc.fullDocument && !/passed through whole|traceability is incomplete|no REQ-NNN|no phase given|parser confidence/i.test(doc.reason)).length,
      unknown_kept: command.context.selected.reduce((sum, doc) => sum + doc.unknownSections.length, 0),
      dropped_named: skippedNamed,
      sta_context_equals_sta_run: JSON.stringify(command.context.docs) === JSON.stringify(run.docs),
      documents: Object.fromEntries(command.context.selected.map((doc) => [doc.doc, {
        chars_before: doc.bytesBefore,
        chars_after: doc.bytesAfter,
        savings_pct: doc.bytesBefore === 0 ? 0 : Math.round(((doc.bytesBefore - doc.bytesAfter) / doc.bytesBefore) * 100),
        full_document: doc.fullDocument,
        reason: doc.reason,
      }])),
    });
  }
  const totals = rows.reduce(
    (sum, row) => ({
      doc_chars_before: sum.doc_chars_before + row.doc_chars_before,
      doc_chars_after: sum.doc_chars_after + row.doc_chars_after,
      direct_file_reads: sum.direct_file_reads + row.direct_file_reads,
      fallback_to_full: sum.fallback_to_full + row.fallback_to_full,
      owner_or_policy_full: sum.owner_or_policy_full + row.owner_or_policy_full,
      unknown_kept: sum.unknown_kept + row.unknown_kept,
    }),
    { doc_chars_before: 0, doc_chars_after: 0, direct_file_reads: 0, fallback_to_full: 0, owner_or_policy_full: 0, unknown_kept: 0 },
  );
  console.log(JSON.stringify({
    fixture: {
      module: fixture.moduleName,
      design_chars: 67_000,
      requirement_chars: 12_000,
      phase: 1,
      note: "deterministic traceable P0-size fixture; no model was launched",
    },
    rows,
    totals: {
      ...totals,
      savings_pct: totals.doc_chars_before === 0 ? 0 : Math.round(((totals.doc_chars_before - totals.doc_chars_after) / totals.doc_chars_before) * 100),
      route_back_missing_context: null,
      full_document_reopens: null,
    },
  }, null, 2));
} finally {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}
