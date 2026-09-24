import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { canWritePath, pathRulesFor, targetPathRules } from "../agents/pathPermissions.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { seedRealContracts } from "../testing/contractFixtures.js";
import {
  SelfReviewError,
  WrongVerdictProducerError,
  assertIndependentVerdict,
  checkReviewSeparation,
  checkReviewerContractSeparation,
} from "./reviewSeparation.js";

/**
 * V13 TASK-006 — the review artifact belongs to the reviewer, and only to it.
 * Every assertion here reads the real `contracts/*.yaml` through the same
 * `pathRulesFor`/`targetPathRules` the dispatch guards use.
 */

const REVIEW_MD = "_docs/module/orders/review.md";
const REVIEW_ARCHIVE = "_docs/module/orders/review/phase-1.md";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("review.md ownership from the loaded contracts (V13 TASK-006)", () => {
  const others = [
    AgentStage.BACKEND_ENGINEER,
    AgentStage.FRONTEND_ENGINEER,
    AgentStage.QA_ENGINEER,
    AgentStage.SECURITY,
    AgentStage.DEVOPS,
    AgentStage.SETUP,
    AgentStage.BUSINESS_ANALYST,
    AgentStage.SYSTEM_ANALYST,
    AgentStage.PROJECT_MANAGER,
    AgentStage.TEST_PLANNER,
    AgentStage.UXUI_DESIGNER,
  ];

  it.each(others)("denies %s writing review.md or its archive, in the workspace and in a bound Target", (stage) => {
    for (const rules of [pathRulesFor(stage), targetPathRules(stage)]) {
      for (const target of [REVIEW_MD, REVIEW_ARCHIVE]) {
        const decision = canWritePath(rules, target);
        expect(decision.allowed, `${stage} -> ${target}`).toBe(false);
      }
    }
  });

  it("lets the reviewer write review.md and its archive, and nothing it reviews or verifies", () => {
    const rules = pathRulesFor(AgentStage.REVIEWER);
    expect(canWritePath(rules, REVIEW_MD).allowed).toBe(true);
    expect(canWritePath(rules, REVIEW_ARCHIVE).allowed).toBe(true);
    for (const target of [
      "server/orders.ts",
      "src/orders.ts",
      "app/page.tsx",
      "components/Button.tsx",
      "prisma/schema.prisma",
      "package.json",
      "_docs/module/orders/qa.md",
      "_docs/module/orders/qa/phase-1.md",
      "_docs/module/orders/security.md",
      "_docs/module/orders/design.md",
      "_docs/module/orders/plan.md",
      "_docs/status.md",
    ]) {
      expect(canWritePath(rules, target).allowed, target).toBe(false);
    }
  });

  it("finds no overlap between the reviewer and the stages it reviews in the shipped contracts", () => {
    expect(checkReviewerContractSeparation(defaultProjectRoot())).toEqual([]);
    expect(checkReviewSeparation(defaultProjectRoot()).problems).toEqual([]);
  });

  it("reports a reviewed stage whose contract could rewrite review.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-ownership-"));
    roots.push(root);
    seedRealContracts(root);
    const file = path.join(root, "contracts", "backend-engineer.yaml");
    // Grant review.md and drop every deny that would have caught it.
    const doctored = fs
      .readFileSync(file, "utf8")
      .replace("\n  write: [", '\n  write: ["_docs/module/*/review.md", ')
      .replace('"_docs/module/*/review.md", "_docs/module/*/review/**", "_docs/module/**", ', "");
    fs.writeFileSync(file, doctored, "utf8");
    const problems = checkReviewerContractSeparation(root);
    expect(problems.some((p) => p.startsWith("backend-engineer may write _docs/module/sample/review.md"))).toBe(true);
    expect(checkReviewSeparation(root).ok).toBe(false);
  });

  it("reports a reviewer contract that could write code a reviewed stage writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-ownership-"));
    roots.push(root);
    seedRealContracts(root);
    const file = path.join(root, "contracts", "reviewer.yaml");
    const doctored = fs
      .readFileSync(file, "utf8")
      .replace(/\n  write: \[/, '\n  write: ["README.md", ')
      .replace(/\n  read: \[/, '\n  read: ["README.md", ');
    fs.writeFileSync(file, doctored, "utf8");
    const problems = checkReviewerContractSeparation(root);
    expect(problems.some((p) => /reviewer may write README\.md, which backend-engineer writes/.test(p))).toBe(true);
  });
});

describe("only the reviewer issues a review report (V13 TASK-006)", () => {
  it("refuses a review report from a producing stage as self-review", () => {
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.SETUP]) {
      expect(() => assertIndependentVerdict(stage, ArtifactType.REVIEW_REPORT)).toThrow(SelfReviewError);
    }
  });

  it("refuses a review report from QA or security — being a verifier is not being the reviewer", () => {
    for (const stage of [AgentStage.QA_ENGINEER, AgentStage.SECURITY]) {
      expect(() => assertIndependentVerdict(stage, ArtifactType.REVIEW_REPORT)).toThrow(WrongVerdictProducerError);
    }
  });

  it("refuses the reviewer issuing QA's or security's verdict", () => {
    expect(() => assertIndependentVerdict(AgentStage.REVIEWER, ArtifactType.QA_REPORT)).toThrow(WrongVerdictProducerError);
    expect(() => assertIndependentVerdict(AgentStage.REVIEWER, ArtifactType.SECURITY_REPORT)).toThrow(WrongVerdictProducerError);
    expect(() => assertIndependentVerdict(AgentStage.REVIEWER, ArtifactType.REVIEW_REPORT)).not.toThrow();
  });
});
