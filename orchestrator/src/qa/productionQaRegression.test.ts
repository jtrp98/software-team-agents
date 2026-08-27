import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { LocalWorkspace } from "../runtime/localWorkspace.js";
import { withQaOptimization } from "./optimized.js";
import { createProjectRunner } from "./projectRunner.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("production deterministic QA regression", () => {
  it("T-V3TOK-014 guard 7: a real tsc error prevents the QA model call and routes back to implementation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-qa-red-"));
    roots.push(root);
    // Resolve from this package rather than the caller's cwd: the Target
    // fixture deliberately has no dependencies of its own.
    const tsc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/typescript/bin/tsc");
    fs.writeFileSync(path.join(root, "broken.ts"), "const answer: number = 'not a number';\n");
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, files: ["broken.ts"] }));
    fs.writeFileSync(path.join(root, "run-typecheck.cjs"), `const { spawnSync } = require('node:child_process'); process.exit(spawnSync(process.execPath, [${JSON.stringify(tsc)}, '-p', 'tsconfig.json'], { stdio: 'inherit' }).status ?? 1);`);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node run-typecheck.cjs" } }));

    const orchestrator = new Orchestrator("T-REAL-TSC", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    let qaModelCalls = 0;
    const execute = withQaOptimization({
      inner: async (req) => {
        if (req.stage === AgentStage.QA_ENGINEER) qaModelCalls++;
        return { outcome: { tokens: 99, cost: 1, result: "PASS" } };
      },
      changedFiles: () => ["broken.ts"],
      deterministicRunner: createProjectRunner({ root, workspace: new LocalWorkspace({ root }) }),
    });

    await orchestrator.step(execute); // implementation pass
    await orchestrator.step(execute); // deterministic typecheck fail
    expect(qaModelCalls).toBe(0);
    expect(orchestrator.machine.current).toBe("IMPLEMENTATION");
    const qaRun = orchestrator.runLog.runsForTask("T-REAL-TSC").find((run) => run.agent === AgentStage.QA_ENGINEER)!;
    expect(qaRun.result).toBe("FAIL");
    expect(qaRun.failure_reason).toContain("TS2322");
    expect(qaRun.input_tokens).toBeNull();
  });

  it("an all-skipped Target still invokes QA instead of manufacturing a green result", async () => {
    const execute = withQaOptimization({
      inner: async () => ({ outcome: { tokens: 7, cost: 0, result: "PASS" } }),
      changedFiles: () => ["src/unknown.ts"],
      deterministicRunner: createProjectRunner({
        root: "/target",
        workspace: {
          readFile: async () => JSON.stringify({ scripts: {} }), writeFile: async () => undefined, exists: async () => false,
          runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
        },
      }),
    });
    const result = await execute({ stage: AgentStage.QA_ENGINEER, taskId: "T-SKIP", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.tokens).toBe(7);
  });
});
