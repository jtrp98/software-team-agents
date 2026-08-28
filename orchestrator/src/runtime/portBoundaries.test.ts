import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * OFF04 — the boundary rule, enforced rather than remembered.
 *
 * `runtimeAdapter.ts`'s whole reason to exist is that the orchestrator core
 * talks to a port while only the composition root knows which provider backs
 * it. Nothing checks that rule today, which means the next convenience import
 * reintroduces provider coupling with no failing test and no reviewer signal.
 * This file is the check: a concrete adapter module may be imported by the CLI
 * composition root and by tests — nowhere else — and no adapter may import a
 * sibling adapter (that is how the Codex adapter ended up reaching into the
 * Claude module for its own spawn type).
 *
 * If this test fails on something legitimate, extend ALLOWED_IMPORTERS with a
 * comment saying why that file must name a provider — the point is that doing
 * so stays a documented decision, never an accident.
 */

const ADAPTER_MODULES = ["claudeCodeAdapter.js", "codexAdapter.js", "mockAdapter.js"];

/** Files allowed to name a concrete adapter. The composition root is the only production entry. */
const ALLOWED_IMPORTERS = new Set(["cli.ts"]);

const SRC_ROOT = path.resolve(__dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Dist is compiled output; tests live beside sources but are scanned too.
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("runtime port boundary", () => {
  it("only the composition root imports a concrete adapter", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const base = path.basename(file);
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
      const content = fs.readFileSync(file, "utf8");
      for (const mod of ADAPTER_MODULES) {
        const importsIt = new RegExp(`from\\s+"[^"]*${mod}"`).test(content);
        const isSelf = base === mod.replace(".js", ".ts");
        if (!importsIt || isSelf) continue;
        if (base.endsWith(".test.ts")) continue; // tests may construct anything
        if (ALLOWED_IMPORTERS.has(base)) continue;
        violations.push(`${rel} imports ${mod}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no adapter imports a sibling adapter", () => {
    const pairs: Array<[string, string]> = [
      ["claudeCodeAdapter.ts", "codexAdapter"],
      ["codexAdapter.ts", "claudeCodeAdapter"],
      ["mockAdapter.ts", "claudeCodeAdapter"],
      ["mockAdapter.ts", "codexAdapter"],
    ];
    const violations: string[] = [];
    for (const [file, sibling] of pairs) {
      const content = fs.readFileSync(path.join(SRC_ROOT, "runtime", file), "utf8");
      if (new RegExp('from\\s+"[^"]*' + sibling + '.js"').test(content)) {
        violations.push(`${file} imports ${sibling}.js`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the Task Compiler imports no runtime adapter or concrete adapter", () => {
    const content = fs.readFileSync(path.join(SRC_ROOT, "runtime", "agentRunAssembly.ts"), "utf8");
    expect(content).not.toMatch(/from\s+"[^"]*(?:runtimeAdapter|claudeCodeAdapter|codexAdapter|mockAdapter|openCodeAdapter)\.js"/);
  });
});
