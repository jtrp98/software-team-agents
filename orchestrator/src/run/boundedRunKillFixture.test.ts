import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { driveFixture, fakeAgents, seedEngineRun } from "./boundedRunEngine.testSupport.js";

/**
 * T-V8-022, retargeted by V13 TASK-007 — the child half of the real
 * process-kill boundary test.
 *
 * boundedRunFaultMatrix.test.ts models a crash with a ledger proxy. This file
 * is the same engine, the same ledger-attempt boundary, the same SQLite state
 * and the same Git repository in a process the parent actually SIGKILLs while
 * the second task's engineer holds the one-writer slot, so the durable state
 * the parent then reads was produced by an operating-system kill.
 *
 * Skipped unless the parent (boundedRunFaultMatrix.test.ts) spawns it.
 */

const enabled = process.env.STA_BOUNDED_KILL_FIXTURE === "1";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe.skipIf(!enabled)("real process-kill bounded-run fixture", () => {
  it("completes the first task, then hangs inside the second task's engineer until the parent kills it", async () => {
    const stateRoot = process.env.STA_BOUNDED_KILL_STATE_ROOT!;
    const targetRoot = process.env.STA_BOUNDED_KILL_TARGET_ROOT!;
    const marker = process.env.STA_BOUNDED_KILL_MARKER!;
    const runId = process.env.STA_BOUNDED_KILL_RUN_ID!;

    const f = seedEngineRun(git, [], {
      target: targetRoot,
      stateRoot,
      runId,
      tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }],
    });
    const agents = fakeAgents(f, {
      onEngineer: async (req) => {
        if (req.taskId !== "BE-2") return;
        fs.writeFileSync(path.join(targetRoot, "src", "partial-BE-2.txt"), "interrupted work\n");
        fs.writeFileSync(marker, "ready\n");
        await new Promise<never>(() => undefined);
      },
    });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("never reached — the parent kills this process first");
  }, 60_000);
});
