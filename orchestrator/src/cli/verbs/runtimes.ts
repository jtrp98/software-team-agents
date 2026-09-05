/**
 * The support table lives in `runtimeSupport.ts` so CLI, README and tests read
 * one record. A person picking a runtime for a machine should not have to
 * trust prose that can drift from what the adapters actually do.
 */
export async function runRuntimesVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  const runtimeRegistry = createProductionRuntimeRegistry(projectRoot);
  const probes = await runtimeRegistry.probeAll();
  console.log("[orchestrator] runtime support (raise a level only when T-V1-05 conformance passes):");
  for (const line of describeRuntimeSupport()) {
    const id = line.slice(0, line.indexOf(":"));
    const probe = probes[id];
    const availability = probe?.available
      ? `available${probe.version ? ` (${probe.version})` : ""}`
      : `unavailable: ${probe?.reason ?? "no unavailability reason was reported"}`;
    console.log(`  ${line}; ${availability}`);
  }
  return 0;
}
import * as path from "node:path";
import { createProductionRuntimeRegistry } from "../../cli.js";
import { describeRuntimeSupport } from "../../runtime/runtimeSupport.js";
import { flagValue } from "../support.js";
