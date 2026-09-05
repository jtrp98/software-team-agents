/** `tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>]`. */
/**
 * `sta policy` reads one section, not one file.
 *
 * A miss is exit 0 with the available sections printed: an agent that gets an
 * error here falls back to reading the whole file, which is exactly the cost
 * this verb removes.
 */
export async function runPolicyVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  if (rest.includes("--help")) {
    console.log("usage: sta policy [<area>] [<section>] [--json] [--project-root <path>]");
    console.log("  no args        every policy area and the sections inside it");
    console.log("  <area>         one area's sections (documentation, coding, security, ...)");
    console.log("  <area> <sec>   that section's text; accepts §10, 10, 5c, or part of the heading");
    return 0;
  }
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const json = rest.includes("--json");
  const [area, section] = positionalArgs(rest);

  try {
    if (area === undefined) {
      const index = listPolicySections(projectRoot);
      if (json) {
        console.log(JSON.stringify(index, null, 2));
        return 0;
      }
      for (const entry of index) {
        console.log(`${entry.relPath} (${entry.bytes} B, ${entry.sections.length} section(s))`);
        for (const s of entry.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      }
      return 0;
    }

    if (section === undefined) {
      const entry = listPolicySections(projectRoot).find((e) => e.area === area.replace(/^policies\//, "").replace(/\.md$/, ""));
      if (!entry) throw new PolicyIndexError(`no policy area "${area}" — available: ${listPolicySections(projectRoot).map((e) => e.area).join(", ")}`);
      if (json) {
        console.log(JSON.stringify(entry, null, 2));
        return 0;
      }
      console.log(`${entry.relPath} (${entry.bytes} B)`);
      for (const s of entry.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      return 0;
    }

    const result = getPolicySection(projectRoot, area, section);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!result.found) {
      console.log(`[orchestrator] ${result.relPath} has no section matching "${section}". It has:`);
      for (const s of result.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      return 0;
    }
    console.log(`# ${result.relPath} — ${result.heading}  (${result.bytes} B of ${result.areaBytes} B)`);
    console.log("");
    console.log(result.text);
    return 0;
  } catch (error) {
    if (error instanceof PolicyIndexError) throw new CliUsageError(error.message);
    throw error;
  }
}
import { CliUsageError } from "../../cli.js";
import { getPolicySection, listPolicySections, PolicyIndexError } from "../../docs/policyIndex.js";
import { flagValue, positionalArgs } from "../support.js";
