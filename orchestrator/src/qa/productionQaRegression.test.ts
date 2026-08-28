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
import { createPostDevVerificationHook } from "./verificationHook.js";

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
    const verification = createPostDevVerificationHook({
      inner: async (req) => {
        if (req.stage === AgentStage.QA_ENGINEER) qaModelCalls++;
        return { outcome: { tokens: 99, cost: 1, result: "PASS" } };
      },
      deterministicRunner: () => createProjectRunner({ root, workspace: new LocalWorkspace({ root }) }),
      requiredVerification: () => ({
        status: "full-order",
        levels: ["lint", "typecheck", "unit", "integration", "build"],
        reason: "fixture",
        enforcement: "warn",
      }),
    });
    const execute = withQaOptimization({
      inner: verification.executor,
      changedFiles: () => ["broken.ts"],
      deterministicVerification: verification.verificationFor,
    });

    await orchestrator.step(execute); // implementation model pass, then deterministic typecheck fail
    expect(qaModelCalls).toBe(0);
    expect(orchestrator.machine.current).toBe("IMPLEMENTATION");
    const devRun = orchestrator.runLog.runsForTask("T-REAL-TSC").find((run) => run.agent === AgentStage.BACKEND_ENGINEER)!;
    expect(devRun.result).toBe("FAIL");
    expect(devRun.failure_reason).toContain("TS2322");
    expect(devRun.deterministic_gate).toBe("enabled");
  });

  it("an all-skipped Target still invokes QA instead of manufacturing a green result", async () => {
    const verification = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 7, cost: 0, result: "PASS" } }),
      deterministicRunner: () => createProjectRunner({
        root: "/target",
        workspace: {
          readFile: async () => JSON.stringify({ scripts: {} }), writeFile: async () => undefined, exists: async () => false,
          runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
        },
      }),
      requiredVerification: () => ({
        status: "full-order",
        levels: ["lint", "typecheck", "unit", "integration", "build"],
        reason: "fixture",
        enforcement: "warn",
      }),
    });
    const devRequest = { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-SKIP", context: [] };
    const devResult = await verification.executor(devRequest);
    expect(devResult.outcome.result).toBe("PASS");
    expect(verification.verificationFor(devRequest)?.status).toBe("skipped");

    const execute = withQaOptimization({
      inner: verification.executor,
      changedFiles: () => ["src/unknown.ts"],
      deterministicVerification: verification.verificationFor,
    });
    const result = await execute({ stage: AgentStage.QA_ENGINEER, taskId: "T-SKIP", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.tokens).toBe(7);
  });
});
