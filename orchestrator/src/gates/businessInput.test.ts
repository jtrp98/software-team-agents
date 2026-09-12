import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ArtifactType } from "../artifacts/schemas.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { makeItem, sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { Orchestrator, type AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { lanesAffectedBy } from "../roles/changePropagation.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { AgentStage, TaskState } from "../types.js";
import { buildPromptParts, compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { FIXTURE_REVISION, runtimeTaskFixture } from "../runtime/packetFixture.testSupport.js";
import {
  BusinessInputEvidenceSchema,
  assessBusinessInput,
  renderBusinessInputEvidence,
  type BusinessInputEvidence,
} from "./businessInput.js";
import { checkGate } from "./gatePolicy.js";

const completeInput = (overrides: Partial<BusinessInputEvidence> = {}): BusinessInputEvidence =>
  BusinessInputEvidenceSchema.parse({
    version: 1,
    mode: "confirmed",
    source: { type: "user-confirmed", locator: "intake://change-42" },
    owner: "Product owner",
    scope: ["Refund eligibility", "Refund expiry"],
    requirement_ids: ["REQ-101"],
    acceptance_criteria_ids: ["AC-101.1"],
    decisions: [
      {
        id: "DEC-101",
        status: "resolved",
        kind: "business",
        material: true,
        question: "How long is a refund eligible?",
        owner: "Product owner",
        answer: "Thirty calendar days",
        source: "intake://change-42#refund-window",
      },
    ],
    assumptions: [
      {
        statement: "The existing clock is UTC",
        source: null,
      },
    ],
    ...overrides,
  });

describe("T-V8-006 confirmed business input", () => {
  it("classifies the committed confirmed, fallback, material, and technical fixtures", () => {
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "v8-business-input.json",
    );
    const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Array<{
      name: string;
      expected_mode: ReturnType<typeof assessBusinessInput>["mode"];
      evidence: unknown;
    }>;

    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      "complete confirmed intake",
      "incomplete intake uses interactive fallback",
      "material business ambiguity gates",
      "technical ambiguity routes to SA",
    ]);
    for (const fixture of fixtures) {
      const evidence = BusinessInputEvidenceSchema.parse(fixture.evidence);
      expect(assessBusinessInput(evidence).mode, fixture.name).toBe(fixture.expected_mode);
    }
  });

  it("accepts source, owner, scope, stable REQ/AC ids, and no unresolved material decision", () => {
    const evidence = completeInput();
    const decision = assessBusinessInput(evidence);

    expect(decision.mode).toBe("confirmed-input");
    expect(decision.canNormalizeWithoutInterview).toBe(true);
    expect(decision.humanGates).toEqual([]);
    expect(decision.questionsForSa).toEqual([]);
  });

  it("falls back to the interactive interview when confirmation evidence is incomplete", () => {
    const evidence = completeInput({ source: null, scope: [], acceptance_criteria_ids: [] });
    const decision = assessBusinessInput(evidence);

    expect(decision.mode).toBe("interactive-fallback");
    expect(decision.canNormalizeWithoutInterview).toBe(false);
    expect(decision.missingConfirmation).toEqual(["source", "scope", "acceptance_criteria_ids"]);
  });

  it("stops on a material business choice with the exact question and owner", () => {
    const evidence = completeInput({
      decisions: [
        {
          id: "DEC-102",
          status: "unresolved",
          kind: "business",
          material: true,
          question: "Do partial refunds consume the full refund window?",
          owner: "Commerce director",
          answer: null,
          source: null,
        },
      ],
    });
    const decision = assessBusinessInput(evidence);

    expect(decision.mode).toBe("human-gate");
    expect(decision.humanGates).toEqual([
      {
        id: "DEC-102",
        question: "Do partial refunds consume the full refund window?",
        owner: "Commerce director",
        reason: "material-business-decision",
      },
    ]);
  });

  it("treats missing business authority as a human gate, not an inferred owner", () => {
    const decision = assessBusinessInput(completeInput({ owner: null }));
    expect(decision.mode).toBe("human-gate");
    expect(decision.humanGates).toEqual([
      {
        id: null,
        question: "Who is authorized to confirm this requirement input?",
        owner: "requester",
        reason: "missing-business-authority",
      },
    ]);
  });

  it("routes code-answerable questions to SA and carries non-material business questions", () => {
    const evidence = completeInput({
      decisions: [
        {
          id: "DEC-103",
          status: "unresolved",
          kind: "technical",
          material: true,
          question: "Does the current refund service use UTC?",
          owner: "system-analyst",
          answer: null,
          source: null,
        },
        {
          id: "DEC-104",
          status: "unresolved",
          kind: "business",
          material: false,
          question: "Should the confirmation email use formal wording?",
          owner: "Product owner",
          answer: null,
          source: null,
        },
      ],
    });
    const decision = assessBusinessInput(evidence);

    expect(decision.mode).toBe("confirmed-input");
    expect(decision.canNormalizeWithoutInterview).toBe(true);
    expect(decision.questionsForSa.map((item) => item.id)).toEqual(["DEC-103"]);
    expect(decision.carriedQuestions.map((item) => item.id)).toEqual(["DEC-104"]);
  });

  it("preserves exact decisions, provenance, and explicit assumptions in the bounded prompt block", () => {
    const rendered = renderBusinessInputEvidence(completeInput());
    expect(rendered).toContain("Thirty calendar days");
    expect(rendered).toContain("intake://change-42#refund-window");
    expect(rendered).toContain("The existing clock is UTC");
    expect(rendered).toContain("assumption — unconfirmed");
  });

  it("rejects malformed or duplicate stable ids instead of normalizing them silently", () => {
    expect(() => completeInput({ requirement_ids: ["requirement-one"] })).toThrow(/REQ/);
    expect(() => completeInput({ acceptance_criteria_ids: ["AC-101.1", "AC-101.1"] })).toThrow(/duplicate/);
  });
});

describe("T-V8-006 requirement gate classification", () => {
  it("lets complete confirmed input leave REQUIREMENT without an interview approval", () => {
    expect(
      checkGate(TaskState.REQUIREMENT, TaskState.DESIGN, { businessInput: completeInput() }),
    ).toEqual({ allowed: true });
  });

  it("keeps incomplete and explicitly interactive input on the interview fallback", () => {
    const incomplete = completeInput({ requirement_ids: [] });
    const blocked = checkGate(TaskState.REQUIREMENT, TaskState.DESIGN, { businessInput: incomplete });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("interactive interview required");

    const interactive = completeInput({ mode: "interactive" });
    expect(checkGate(TaskState.REQUIREMENT, TaskState.DESIGN, { businessInput: interactive }).allowed).toBe(false);
    expect(
      checkGate(TaskState.REQUIREMENT, TaskState.DESIGN, {
        businessInput: interactive,
        requirementApproved: true,
      }).allowed,
    ).toBe(true);
  });

  it("does not let a generic interview approval waive unresolved material input", () => {
    const material = completeInput({
      decisions: [
        {
          id: "DEC-105",
          status: "unresolved",
          kind: "business",
          material: true,
          question: "Who pays the refund fee?",
          owner: "Finance owner",
          answer: null,
          source: null,
        },
      ],
    });
    const blocked = checkGate(TaskState.REQUIREMENT, TaskState.DESIGN, {
      businessInput: material,
      requirementApproved: true,
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('"Who pays the refund fee?"');
    expect(blocked.reason).toContain("owner: Finance owner");
  });
});

describe("T-V8-006 orchestration, prompt, resume, and invalidation", () => {
  const pass: AgentExecutorResult = { outcome: { tokens: 1, cost: 0, result: "PASS" } };

  it("delivers confirmed evidence to BA and proceeds to SA without a redundant interview", async () => {
    const seen: BusinessInputEvidence[] = [];
    const orch = new Orchestrator(
      "T-CONFIRMED",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
      { businessInput: completeInput() },
    );

    const status = await orch.step((request) => {
      if (request.businessInput) seen.push(request.businessInput);
      return pass;
    });

    expect(seen).toEqual([completeInput()]);
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
    expect(orch.approvalLedger).toEqual([]);
  });

  it("parks before BA on a known material choice, then runs BA once after exact confirmed evidence arrives", () => {
    const unresolved = completeInput({
      decisions: [
        {
          id: "DEC-106",
          status: "unresolved",
          kind: "business",
          material: true,
          question: "Who pays the refund fee?",
          owner: "Finance owner",
          answer: null,
          source: null,
        },
      ],
    });
    const orch = new Orchestrator(
      "T-MATERIAL-PREFLIGHT",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
      { businessInput: unresolved },
    );

    expect(orch.status()).toMatchObject({
      kind: "WAITING_FOR_HUMAN",
      reason: expect.stringContaining('"Who pays the refund fee?"'),
    });
    expect(orch.runLog.all()).toHaveLength(0);

    orch.provideBusinessInput(
      completeInput({
        decisions: [
          {
            id: "DEC-106",
            status: "resolved",
            kind: "business",
            material: true,
            question: "Who pays the refund fee?",
            owner: "Finance owner",
            answer: "The merchant",
            source: "decision://finance-owner/refund-fee",
          },
        ],
      }),
      { by: "Finance owner" },
    );

    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BUSINESS_ANALYST });
    expect(orch.approvalLedger.at(-1)).toMatchObject({
      status: "approved",
      decidedBy: "Finance owner",
    });
  });

  it("rejects confirmed input manufactured by an executing agent", async () => {
    const orch = new Orchestrator(
      "T-SELF-CONFIRM",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
    );

    await expect(
      orch.step(() => ({
        ...pass,
        gateEvidence: { businessInput: completeInput() },
      }) as unknown as AgentExecutorResult),
    ).rejects.toThrow(/trusted task-creation evidence/);
  });

  it("persists confirmed evidence across resume without re-running BA", async () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator(
      "T-RESUME-CONFIRMED",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
      { store, businessInput: completeInput() },
    );
    await first.step(() => pass);

    const resumed = Orchestrator.resume("T-RESUME-CONFIRMED", store);
    const stages: AgentStage[] = [];
    await resumed.step((request) => {
      stages.push(request.stage);
      return pass;
    });

    expect(resumed.snapshot().gateContext.businessInput).toEqual(completeInput());
    expect(stages).toEqual([AgentStage.SYSTEM_ANALYST]);
  });

  it("does not rerun BA for an ordinary implementation repair", async () => {
    const orch = new Orchestrator(
      "T-REPAIR",
      classifyTask({
        touchesBusinessRuleOnly: true,
        touchesBackend: true,
        testStrategyTriggers: ["cross-task"],
      }),
      { businessInput: completeInput() },
    );

    await orch.step(() => pass); // BA
    await orch.step(() => pass); // SA -> schema/feasibility gate (unchanged in this round)
    orch.provideHumanApproval("designApproved", true);
    await orch.step(() => pass); // test-planner
    await orch.step(() => pass); // backend
    const retry = await orch.step(() => ({ outcome: { tokens: 1, cost: 0, result: "FAIL" } })); // QA

    expect(retry).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(orch.runLog.all().filter((run) => run.agent === AgentStage.BUSINESS_ANALYST)).toHaveLength(1);
  });

  it("injects the same bounded evidence into legacy and canonical packet prompt paths only for BA", () => {
    const evidence = completeInput();
    const legacy = buildPromptParts({
      stage: AgentStage.BUSINESS_ANALYST,
      taskId: "T-BA-PROMPT",
      context: [],
      businessInput: evidence,
    });
    expect(legacy.text).toContain("Confirmed business input (version 1)");
    expect(legacy.text).toContain("REQ-101");

    const otherRole = buildPromptParts({
      stage: AgentStage.SYSTEM_ANALYST,
      taskId: "T-SA-PROMPT",
      context: [],
      businessInput: evidence,
    });
    expect(otherRole.text).not.toContain("Confirmed business input (version 1)");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ba-input-"));
    try {
      const runtimeTask = runtimeTaskFixture(root, {
        taskId: "T-BA-PACKET",
        stage: AgentStage.BUSINESS_ANALYST,
      });
      const packet = compileExecutionPacket({
        req: {
          stage: AgentStage.BUSINESS_ANALYST,
          taskId: "T-BA-PACKET",
          context: [],
          businessInput: evidence,
        },
        role: "business-analyst",
        runtimeTask,
        contractScope: { allow: ["server/**"], deny: [".git/**"] },
        baseRevision: FIXTURE_REVISION,
      });
      expect(packet.stage_instructions).toContain("Confirmed business input (version 1)");
      expect(packet.stage_instructions).toContain("intake://change-42");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates only graph descendants that reference the changed requirement", () => {
    const unrelatedRequirement = makeItem(
      "requirement",
      "REQ-999",
      {
        acceptance_criteria: ["unrelated"],
        actors: ["admin"],
        priority: "could",
        assumption_unconfirmed: false,
      },
      { owner: AgentStage.BUSINESS_ANALYST },
    );
    const unrelatedDesign = makeItem(
      "architecture",
      "DES-999",
      { feasibility: "feasible", risks: [], component: "other" },
      { relations: [{ type: "refines", to: "REQ-999" }] },
    );
    const affected = lanesAffectedBy(
      new KnowledgeBase([...sampleKnowledge(), unrelatedRequirement, unrelatedDesign]),
      ["REQ-101"],
    );
    expect(affected.size).toBe(0);

    const actual = lanesAffectedBy(
      new KnowledgeBase([...sampleKnowledge(), unrelatedRequirement, unrelatedDesign]),
      ["REQ-003"],
    );
    const ids = [...actual.values()].flat().map((item) => item.id);
    expect(ids).toContain("DES-003");
    expect(ids).not.toContain("REQ-999");
    expect(ids).not.toContain("DES-999");
  });
});
