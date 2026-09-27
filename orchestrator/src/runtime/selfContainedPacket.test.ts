import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { ExecutionPacketSchema } from "../artifacts/schemas.js";
import { renderPacketText } from "../artifacts/executionPacket.js";
import { resolveAuthoritativeContract } from "../agents/agentContract.js";
import { writeExecutionPacket, readExecutionPacket, runtimeArtifactPaths } from "../state/runtimeArtifacts.js";
import { compileExecutionPacket } from "./agentRunAssembly.js";
import { FIXTURE_REVISION, runtimeTaskFixture } from "./packetFixture.testSupport.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { PASSING_VERIFICATION } from "../evidence/stageEvidence.testSupport.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

const tmpRoots: string[] = [];
function mkTmpDir(prefix = "sta-packet-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file lock tolerance */
    }
  }
});

describe("V13 TASK-020 — Fresh role packet and resume self-contained", () => {
  const ROLES: AgentStage[] = [
    AgentStage.BUSINESS_ANALYST,
    AgentStage.SYSTEM_ANALYST,
    AgentStage.PROJECT_MANAGER,
    AgentStage.BACKEND_ENGINEER,
    AgentStage.REVIEWER,
    AgentStage.QA_ENGINEER,
  ];

  it.each(ROLES)("compiles self-contained execution packet for %s with all required context", (stage) => {
    const dir = mkTmpDir(`sta-packet-${stage}-`);
    const task = runtimeTaskFixture(dir, { stage });
    const authoritative = resolveAuthoritativeContract(stage);

    const packet = compileExecutionPacket({
      req: { stage, taskId: task.task_id, context: [] },
      role: stage,
      runtimeTask: task,
      contractScope: { allow: ["server/**", "src/**", "_docs/**"], deny: [".git/**"] },
      attempt: 1,
      baseRevision: FIXTURE_REVISION,
      authoritativeContract: authoritative.contract,
      contractDigest: authoritative.digest,
      rules: authoritative.contract.constraints,
      relevantKnowledge: ["DEC-010: fixture decision", "Architecture: modular monorepo"],
      correlationId: `${task.task_id}:${stage}:1`,
    });

    // 1. Schema validation passes
    const validated = ExecutionPacketSchema.parse(packet);
    expect(validated).toEqual(packet);

    // 2. Self-contained fields exist without prior conversation turns
    expect(packet.role_contract).toBeDefined();
    expect(packet.role_contract?.name).toBe(authoritative.contract.agent.name);
    expect(packet.role_contract?.role).toBe(authoritative.contract.agent.role);
    expect(packet.role_contract?.digest).toBe(authoritative.digest);

    expect(packet.rules).toBeDefined();
    expect(packet.rules?.length).toBeGreaterThan(0);
    expect(packet.rules).toEqual(authoritative.contract.constraints);

    expect(packet.relevant_knowledge).toBeDefined();
    expect(packet.relevant_knowledge).toContain("DEC-010: fixture decision");

    expect(packet.expected_output).toBeDefined();
    expect(packet.expected_output?.artifact_type).toBeTruthy();

    expect(packet.correlation_id).toBe(`${task.task_id}:${stage}:1`);

    // 3. Rendered text contains distinct sections matching the prompt structure
    const rendered = renderPacketText(packet);
    expect(rendered).toContain("## Role contract");
    expect(rendered).toContain(authoritative.contract.agent.name);
    expect(rendered).toContain("## Rules and constraints");
    expect(rendered).toContain("## Relevant knowledge");
    expect(rendered).toContain("## Expected output");
    expect(rendered).toContain("## Correlation ID");
    expect(rendered).toContain(`${task.task_id}:${stage}:1`);

    // 4. Persistence round-trip verifies identical reconstructibility
    const persisted = writeExecutionPacket({ projectRoot: dir, packet });
    const loaded = readExecutionPacket(persisted.path);

    expect(loaded.packet_hash).toBe(packet.packet_hash);
    expect(loaded.role_contract).toEqual(packet.role_contract);
    expect(loaded.rules).toEqual(packet.rules);
    expect(loaded.expected_output).toEqual(packet.expected_output);
    expect(loaded.correlation_id).toEqual(packet.correlation_id);
    expect(loaded.text).toBe(packet.text);
  });

  it("resumes cleanly from SQLite state after process death with identical role packet and no memory leak", async () => {
    const dir = mkTmpDir("sta-resume-test-");
    const dbPath = path.join(dir, "task.db");

    // Process 1: run an orchestrator step up to review stage
    let packetSavedPath = "";
    let packetOriginalHash = "";
    {
      const store1 = new SqliteTaskStore(dbPath);
      const orch1 = new Orchestrator(
        "T-RESUME-001",
        classifyTask({ isClearBugFix: true, touchesBackend: true }),
        {
          humanDecisionVerifier: testHumanVerifier(),
          stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
          store: store1,
        }
      );

      // Simulate implementation step
      await orch1.step(() => ({
        outcome: {
          result: "PASS",
          summary: "Implementation complete",
          tokens: 10,
          cost: 0.001,
          artifacts: [{ path: "src/index.ts", content: "export const x = 1;" }],
        },
        deterministicVerification: PASSING_VERIFICATION,
      }));

      // In Process 1, compile and persist an execution packet for Reviewer
      const task = runtimeTaskFixture(dir, { taskId: "T-RESUME-001", stage: AgentStage.REVIEWER });
      const authoritative = resolveAuthoritativeContract(AgentStage.REVIEWER);
      const packet = compileExecutionPacket({
        req: { stage: AgentStage.REVIEWER, taskId: "T-RESUME-001", context: [] },
        role: AgentStage.REVIEWER,
        runtimeTask: task,
        contractScope: { allow: ["_docs/**"], deny: [".git/**"] },
        attempt: 1,
        baseRevision: FIXTURE_REVISION,
        authoritativeContract: authoritative.contract,
        contractDigest: authoritative.digest,
        rules: authoritative.contract.constraints,
        expectedOutput: {
          artifact_type: "review-report",
          doc_path: "_docs/module/packet-fixture/review.md",
        },
        correlationId: "T-RESUME-001:reviewer:1",
      });

      const writeRes = writeExecutionPacket({ projectRoot: dir, packet });
      packetSavedPath = writeRes.path;
      packetOriginalHash = packet.packet_hash;

      store1.close();
      // Process 1 dies here: store1 and orch1 are released
    }

    // Process 2: freshly loaded process with clean memory
    {
      const store2 = new SqliteTaskStore(dbPath);
      const loadedTask = store2.loadTask("T-RESUME-001");
      expect(loadedTask).not.toBeNull();
      expect(loadedTask?.taskId).toBe("T-RESUME-001");
      expect(loadedTask?.machine.current).toBe(TaskState.REVIEW);

      // Read persisted packet from disk without prior process memory
      const loadedPacket = readExecutionPacket(packetSavedPath);
      expect(loadedPacket.packet_hash).toBe(packetOriginalHash);
      expect(loadedPacket.stage).toBe(AgentStage.REVIEWER);
      expect(loadedPacket.expected_output?.doc_path).toBe("_docs/module/packet-fixture/review.md");
      expect(loadedPacket.correlation_id).toBe("T-RESUME-001:reviewer:1");

      // Verify that reconstructing the packet from inputs yields identical hash
      const task2 = runtimeTaskFixture(dir, { taskId: "T-RESUME-001", stage: AgentStage.REVIEWER });
      const authoritative2 = resolveAuthoritativeContract(AgentStage.REVIEWER);
      const reconstructedPacket = compileExecutionPacket({
        req: { stage: AgentStage.REVIEWER, taskId: "T-RESUME-001", context: [] },
        role: AgentStage.REVIEWER,
        runtimeTask: task2,
        contractScope: { allow: ["_docs/**"], deny: [".git/**"] },
        attempt: 1,
        baseRevision: FIXTURE_REVISION,
        authoritativeContract: authoritative2.contract,
        contractDigest: authoritative2.digest,
        rules: authoritative2.contract.constraints,
        expectedOutput: {
          artifact_type: "review-report",
          doc_path: "_docs/module/packet-fixture/review.md",
        },
        correlationId: "T-RESUME-001:reviewer:1",
      });

      expect(reconstructedPacket.packet_hash).toBe(packetOriginalHash);
      expect(reconstructedPacket.text).toBe(loadedPacket.text);

      store2.close();
    }
  });

  it("detects and rejects artifact drift upon resumption", () => {
    const dir = mkTmpDir("sta-drift-test-");
    const task = runtimeTaskFixture(dir);
    const authoritative = resolveAuthoritativeContract(AgentStage.BACKEND_ENGINEER);

    const input = {
      req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] },
      role: AgentStage.BACKEND_ENGINEER,
      runtimeTask: task,
      contractScope: { allow: ["server/**"], deny: [".git/**"] },
      baseRevision: FIXTURE_REVISION,
      authoritativeContract: authoritative.contract,
      contractDigest: authoritative.digest,
      rules: authoritative.contract.constraints,
    };

    const originalPacket = compileExecutionPacket(input);
    const writeRes = writeExecutionPacket({ projectRoot: dir, packet: originalPacket });

    // Tamper with plan.md or requirement.md on disk
    fs.appendFileSync(task.artifact_hashes[0].source, "\nTampered rule in requirement.md");

    // Subsequent compilation detects drift
    expect(() => compileExecutionPacket(input)).toThrow(/artifact hash drift/i);

    // Tampering with the packet file itself is caught by readExecutionPacket
    fs.writeFileSync(writeRes.path, JSON.stringify({ ...originalPacket, text: "tampered text" }));
    expect(() => readExecutionPacket(writeRes.path)).toThrow(/diverges|hash drift/i);
  });

  it("rejects packet execution when missing required upstream dependency evidence", () => {
    const dir = mkTmpDir("sta-dep-test-");
    const task = runtimeTaskFixture(dir, { overrides: { dependsOn: ["UPSTREAM-SYS-ANALYST"] } });
    const authoritative = resolveAuthoritativeContract(AgentStage.BACKEND_ENGINEER);

    const input = {
      req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] },
      role: AgentStage.BACKEND_ENGINEER,
      runtimeTask: task,
      contractScope: { allow: ["server/**"], deny: [".git/**"] },
      baseRevision: FIXTURE_REVISION,
      authoritativeContract: authoritative.contract,
      contractDigest: authoritative.digest,
    };

    // Missing dependency evidence fails closed
    expect(() => compileExecutionPacket(input)).toThrow(/UPSTREAM-SYS-ANALYST.*completion\/output/i);
  });
});
