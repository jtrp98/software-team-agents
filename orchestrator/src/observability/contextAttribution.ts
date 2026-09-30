import * as path from "node:path";
import { estimateInputTokens } from "../context/contextBudget.js";
import type { RunRecord } from "./runLog.js";

function n(value: number | null | undefined): string {
  return value === null || value === undefined ? "not reported" : value.toLocaleString("en-US");
}

function est(chars: number | null | undefined): string {
  return chars === null || chars === undefined ? "" : ` (~${estimateInputTokens(chars).toLocaleString("en-US")} tokens est.)`;
}

/**
 * "What consumed those tokens" for one recorded stage run: initial context
 * split into packet and always-on instructions, what the agent retrieved
 * through tools (from the Large File Context Policy guard's ledger), the turn
 * count against its ceiling, and the runtime's own usage counters.
 *
 * Only measured values are printed; anything the runtime did not report says
 * so. Character-derived token figures are labelled estimates (chars/4) —
 * provider token counts appear only in the usage line.
 */
export function renderRunContextAttribution(run: RunRecord): string[] {
  const t = run.context_telemetry ?? null;
  const lines = [`Agent: ${run.agent}${run.runtime ? ` (${run.runtime}${run.model ? `/${run.model}` : ""})` : ""} — ${run.result}`];
  if (t === null) {
    lines.push(`  Initial context: packet ${n(run.context_chars)} chars${est(run.context_chars)}; always-on instructions not measured for this run`);
  } else {
    lines.push(
      "  Initial context:",
      `    Execution packet:          ${n(t.packet_chars)} chars${est(t.packet_chars)}`,
      `    Always-on instructions:    ${n(t.always_on_chars)} chars${est(t.always_on_chars)}`,
      `    Effective initial context: ${n(t.effective_initial_chars)} chars (~${n(t.effective_initial_estimated_tokens)} tokens est.; hard ceiling ${t.hard_ceiling_estimated_tokens === null ? "disabled" : `${n(t.hard_ceiling_estimated_tokens)} tokens est.`})`,
    );
    const reads = t.tool_reads;
    if (reads === null) {
      lines.push("  Retrieval: no read ledger for this run (runtime without the large-read guard, or no file reads)");
    } else {
      lines.push(
        `  Retrieval: ${n(reads.reads)} file read(s), ${n(reads.readChars)} chars${est(reads.readChars)} — duplicates ${n(reads.duplicateReads)}, blocked large reads ${n(reads.blockedReads)}`,
        ...reads.largest.map((read) =>
          `    ${path.basename(read.path)}${read.startLine !== null ? ` lines ${read.startLine}-${read.endLine}` : ""}: ${n(read.chars)} chars${est(read.chars)}`,
        ),
      );
    }
    lines.push(`  Model turns: ${n(t.turns)}${t.max_turns === null ? " (no limit)" : ` / limit ${n(t.max_turns)}`}${t.max_turns_reached ? " — STOPPED AT LIMIT" : ""}`);
  }
  lines.push(`  Usage (runtime-reported): input ${n(run.input_tokens)}, output ${n(run.output_tokens)}, cache-read ${n(run.cache_read_tokens)}, cache-created ${n(run.cache_creation_tokens ?? null)}`);
  return lines;
}
