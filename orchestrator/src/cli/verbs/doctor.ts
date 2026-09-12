import { createProductionRuntimeRegistry } from "../composition/runtimeRegistry.js";
import { DEFAULT_RUNTIME_ID } from "../../runtime/runtimeRegistry.js";
import { detectRuntimeCapabilities } from "../../runtime/runtimeCapabilityDetection.js";
import { exitCodeFor, runDoctor } from "../../threeRepo/doctor.js";
import { flagValue } from "../support.js";

/** `doctor` — aggregate read-only diagnostics; never mutates, exits non-zero only on FAIL. */
export async function runDoctorVerb(rest: string[]): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root");
  try {
    // The composition root is the one place that may name a concrete adapter
    // (see runtimeAdapter.ts): doctor itself stays provider-blind and receives
    // the same probe a real run would use — and, through that adapter, the
    // claims-vs-install capability sweep.
    const resolvedProjectRoot = projectRoot ?? process.cwd();
    const runtimeRegistry = createProductionRuntimeRegistry(resolvedProjectRoot);
    const claude = runtimeRegistry.get(DEFAULT_RUNTIME_ID);
    const report = await runDoctor({
      projectRoot: projectRoot ?? undefined,
      probe: () => runtimeRegistry.probe(DEFAULT_RUNTIME_ID),
      capabilities: async () => {
        const probe = await runtimeRegistry.probe(DEFAULT_RUNTIME_ID);
        const r = await detectRuntimeCapabilities(claude, { probe });
        return {
          runtimeId: r.runtimeId,
          verified: r.checks.filter((c) => c.verified).map((c) => c.capability),
          unverified: r.checks.filter((c) => !c.verified).map((c) => c.capability),
          missingRequired: r.missingRequired,
          fallbacks: r.fallbacks,
        };
      },
    });
    for (const c of report.checks) {
      const mark = c.status === "PASS" ? "✓" : c.status === "WARNING" ? "!" : "✗";
      console.log(`${mark} ${c.status.padEnd(7)} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      if (c.fix && c.status !== "PASS") console.log(`    Fix: ${c.fix}`);
    }
    const failed = report.checks.filter((c) => c.status === "FAIL").length;
    const warned = report.checks.filter((c) => c.status === "WARNING").length;
    console.log(`[orchestrator] doctor: ${report.ok ? "usable" : "BLOCKED"} (${failed} fail, ${warned} warning)`);
    return exitCodeFor(report);
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
