import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACTED_AGENTS, contractsDir, defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Test-only fixture (V13 TASK-005): copies every real, checked-in
 * `contracts/<agent>.yaml` into `<root>/contracts/`.
 *
 * `resolveAuthoritativeContract` now runs as a dispatch preflight before any
 * guard/work-root resolution, so a fixture project root that isolates some
 * other concern (frontmatter resolution, guard wiring, routing) still needs a
 * project a real attempt could dispatch against — otherwise every such test
 * would fail closed on "no contract file", which is a fixture gap, not the
 * behaviour under test. Copies the real bytes verbatim rather than
 * synthesizing one, so a test exercises exactly what production does.
 */
export function seedRealContracts(root: string): void {
  const source = contractsDir(defaultProjectRoot());
  const dest = contractsDir(root);
  fs.mkdirSync(dest, { recursive: true });
  for (const agent of CONTRACTED_AGENTS) {
    fs.copyFileSync(path.join(source, `${agent}.yaml`), path.join(dest, `${agent}.yaml`));
  }
}
