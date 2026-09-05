#!/usr/bin/env node
/**
 * T-V3R-110 — the three V3 property gates the release gate runs as named steps.
 *
 * `scripts/release-gate.mjs` already runs the whole suite, so these do not add
 * coverage: they add *legibility and non-vacuity*. A V3 property that silently
 * stopped being asserted — a renamed criterion, a deleted mode case, a paid-path
 * assertion that quietly matched nothing — would still leave `npm test` green.
 * Each gate here therefore pins the exact assertions it requires by name and
 * fails when one is missing, not only when one fails.
 *
 * Each gate is independently runnable:
 *
 *   node scripts/v3-gate.mjs guardrails
 *   node scripts/v3-gate.mjs modes
 *   node scripts/v3-gate.mjs paid-fallback
 *   node scripts/v3-gate.mjs all          (default)
 *
 * No gate needs a real runner login or a dogfood run: every runtime here is a
 * `MockRuntimeAdapter` or a controlled process fixture.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const orchestrator = path.join(repoRoot, "orchestrator");
const vitest = path.join(orchestrator, "node_modules", "vitest", "vitest.mjs");

/**
 * `required` entries are substrings of a vitest `fullName`. They are the point
 * of this script: a gate passes only when every one of them is present *and*
 * passing, so deleting or renaming an assertion fails the release rather than
 * shrinking it.
 */
const GATES = {
  guardrails: {
    title: "guardrail invariant suite (T-V3R-001, six criteria)",
    files: ["src/runtime/guardInvariants.test.ts", "src/runtime/runtimeConformance.test.ts"],
    filter: "T-V3R-001",
    required: [
      "criterion 1 — no routed Target-write stage reaches a runtime missing its required guard capability",
      "criterion 2 — execution packet and adapter scopes are subsets of the role contract",
      "criterion 3 — every registered adapter passes role and writable-root guard env unmodified",
      "criterion 4 — no concrete adapter source reads a known credential path",
      "criterion 5 — the paid API runtime is never offered; ApiAdapter is unreachable from production construction",
      // T-V5-040 rewrote criterion 6: `model_routing`'s unregistered-runtime
      // fallback is removed, so the criterion now pins the stronger pair — the
      // unregistered target reaches no adapter, and the routed run receives the
      // caller's exact frozen guards object.
      "criterion 6 — an unregistered routing target reaches no adapter, and a routed run gets the exact RuntimeGuards object",
    ],
  },
  modes: {
    // T-V5-040 — execution modes are removed: there is one route. This gate is
    // rewritten to the surviving behaviour rather than deleted. What it pins is
    // now (a) each of the three route sources resolving, (b) exactly one
    // candidate ever being resolved, and (c) every way a route can fail doing so
    // closed, with no handoff to another runner.
    title: "one-route matrix against mock runners (flag / routing.by_role / default, always fail-closed)",
    files: ["src/runtime/executionModes.test.ts"],
    filter: null,
    required: [
      // The three surviving route sources resolve and execute.
      "absent config resolves the default route on claude-code",
      "routing.by_role resolves exactly one candidate, at precedence 2",
      "routing.by_role executes only the runner and model it names",
      "an explicit --runtime flag outranks routing.by_role",
      // Every failure mode stops for a person instead of moving the run.
      "an unavailable route stops with requiresHuman and never reaches another runtime",
      "an unavailable route blocks the orchestrator without advancing or consuming a retry",
      "an unregistered routing.by_role runtime fails closed instead of substituting the default",
      "a UNAVAILABLE result on a Target-write stage stops the task with no second runtime tried",
      "an inert allow_handoff: true still produces zero hops",
      "never falls back on ERROR",
      "never falls back on TIMEOUT",
      "all local runners unavailable stops with no further candidate to try",
      "a budget-inadmissible route fails closed instead of moving to another runtime",
    ],
  },
  "paid-fallback": {
    // T-V5-039 — the paid runtime is retired, not merely opt-in-gated: this
    // gate now pins that it is *never* reachable, from any config or flag,
    // rather than pinning that a now-deleted opt-in defaulted to off.
    title: "paid API runtime unreachability (paid-api is never offered)",
    files: [
      "src/runtime/apiAdapter.test.ts",
      "src/runtime/guardInvariants.test.ts",
      "src/packaging/staConfig.test.ts",
      "src/runtime/executionModes.test.ts",
    ],
    filter: "paid",
    required: [
      "keeps V3 execution defaults additive and paid fallback off when the block is absent",
      "defaults paid fallback off when execution exists without that key",
      "criterion 5 — the paid API runtime is never offered; ApiAdapter is unreachable from production construction",
      "implements RuntimeAdapter without claiming any guard capability",
      "refuses a Target-write stage before the mocked transport is invoked",
      "an unlisted registered runtime is never auto-appended to the fallback chain",
    ],
  },
};

function q(token) {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** Runs one gate. Returns null on success, or a human-readable failure reason. */
function runGate(id) {
  const gate = GATES[id];
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "v3-gate-")), "report.json");
  const argv = [
    q(process.execPath),
    q(vitest),
    "run",
    ...gate.files,
    ...(gate.filter ? ["-t", q(gate.filter)] : []),
    "--reporter=json",
    `--outputFile=${q(outFile)}`,
  ].join(" ");
  console.log(`[v3-gate] ${id} — ${gate.title}\n[v3-gate] $ ${argv}`);
  const res = spawnSync(argv, { cwd: orchestrator, encoding: "utf8", shell: true, timeout: 900_000 });

  let report;
  try {
    report = JSON.parse(fs.readFileSync(outFile, "utf8"));
  } catch {
    const tail = [res.stdout ?? "", res.stderr ?? ""].join("\n").trim().split("\n").slice(-30).join("\n");
    return `no vitest report produced (exit ${res.status ?? "signal"})\n${tail}`;
  } finally {
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }

  const results = report.testResults.flatMap((file) => file.assertionResults);
  const passed = results.filter((a) => a.status === "passed").map((a) => a.fullName);
  const failed = results.filter((a) => a.status === "failed").map((a) => a.fullName);
  const missing = gate.required.filter((needle) => !passed.some((name) => name.includes(needle)));

  if (failed.length > 0) return `failing assertions:\n  - ${failed.join("\n  - ")}`;
  if (missing.length > 0) {
    return `required assertions absent or not passing (renamed, deleted, or filtered out):\n  - ${missing.join("\n  - ")}`;
  }
  if (res.status !== 0) return `vitest exited ${res.status ?? "signal"} with no failing assertion`;
  console.log(`[v3-gate] ok — ${id}: ${gate.required.length}/${gate.required.length} required assertions passed (${passed.length} run)`);
  return null;
}

const requested = process.argv[2] ?? "all";
const ids = requested === "all" ? Object.keys(GATES) : [requested];
for (const id of ids) {
  if (!GATES[id]) {
    console.error(`[v3-gate] unknown gate "${id}" — expected one of: ${Object.keys(GATES).join(", ")}, all`);
    process.exit(2);
  }
}
const problems = [];
for (const id of ids) {
  const problem = runGate(id);
  if (problem) {
    problems.push(id);
    console.error(`[v3-gate] FAIL — ${id}: ${problem}`);
  }
}
if (problems.length > 0) {
  console.error(`[v3-gate] NOT RELEASABLE — ${problems.length} V3 property gate(s) failed: ${problems.join(", ")}`);
  process.exit(1);
}
console.log(`[v3-gate] all requested V3 property gates passed (${ids.join(", ")})`);
