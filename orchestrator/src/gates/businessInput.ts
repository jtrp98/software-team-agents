import { z } from "zod";

const RequirementIdSchema = z.string().regex(/^REQ-\d{3,}$/, "must be a stable REQ-NNN id");
const AcceptanceCriterionIdSchema = z
  .string()
  .regex(/^AC-\d{3,}(?:\.\d+)?$/, "must be a stable AC-NNN or AC-NNN.N id");
const DecisionIdSchema = z.string().regex(/^DEC-\d{3,}$/, "must be a stable DEC-NNN id");

const EvidenceSourceSchema = z
  .object({
    type: z.enum(["user-confirmed", "approved-artifact"]),
    /** A bounded pointer, not a copied conversation or document body. */
    locator: z.string().trim().min(1),
  })
  .strict();

const BusinessDecisionSchema = z
  .object({
    id: DecisionIdSchema,
    status: z.enum(["resolved", "unresolved"]),
    /** Technical questions belong to SA evidence even when they affect a material outcome. */
    kind: z.enum(["business", "authority", "technical"]),
    material: z.boolean(),
    question: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    /** Exact confirmed answer. Null while the decision is unresolved. */
    answer: z.string().trim().min(1).nullable(),
    /** Provenance for the exact answer. Null while the decision is unresolved. */
    source: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.status === "resolved" && (decision.answer === null || decision.source === null)) {
      ctx.addIssue({
        code: "custom",
        message: `resolved decision ${decision.id} requires both an exact answer and source provenance`,
      });
    }
    if (decision.status === "unresolved" && (decision.answer !== null || decision.source !== null)) {
      ctx.addIssue({
        code: "custom",
        message: `unresolved decision ${decision.id} cannot carry a settled answer or answer source`,
      });
    }
  });

const AssumptionSchema = z
  .object({
    statement: z.string().trim().min(1),
    /** Null means unsourced and must remain explicitly unconfirmed. */
    source: z.string().trim().min(1).nullable(),
  })
  .strict();

function unique(values: readonly string[], label: string, ctx: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", message: `${label} contains a duplicate id` });
  }
}

/**
 * Bounded evidence supplied to a BA run.
 *
 * Nullable/empty confirmation fields are intentional: the same schema carries
 * incomplete intake into the deterministic assessment so it can name the safe
 * interactive fallback. It never fills a missing field on the caller's behalf.
 */
export const BusinessInputEvidenceSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["confirmed", "interactive"]),
    source: EvidenceSourceSchema.nullable(),
    /** The person or authority that confirmed the business meaning. */
    owner: z.string().trim().min(1).nullable(),
    scope: z.array(z.string().trim().min(1)),
    requirement_ids: z.array(RequirementIdSchema),
    acceptance_criteria_ids: z.array(AcceptanceCriterionIdSchema),
    decisions: z.array(BusinessDecisionSchema),
    assumptions: z.array(AssumptionSchema),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    unique(evidence.requirement_ids, "requirement_ids", ctx);
    unique(evidence.acceptance_criteria_ids, "acceptance_criteria_ids", ctx);
    unique(
      evidence.decisions.map((decision) => decision.id),
      "decisions",
      ctx,
    );
  });

export type BusinessInputEvidence = z.infer<typeof BusinessInputEvidenceSchema>;
export type BusinessDecision = BusinessInputEvidence["decisions"][number];

export interface BusinessGateQuestion {
  id: string | null;
  question: string;
  owner: string;
  reason: "material-business-decision" | "missing-business-authority";
}

export interface RoutedBusinessQuestion {
  id: string;
  question: string;
  owner: string;
}

export interface BusinessInputAssessment {
  mode: "confirmed-input" | "interactive-fallback" | "human-gate";
  canNormalizeWithoutInterview: boolean;
  missingConfirmation: Array<
    "source" | "scope" | "requirement_ids" | "acceptance_criteria_ids"
  >;
  humanGates: BusinessGateQuestion[];
  questionsForSa: RoutedBusinessQuestion[];
  carriedQuestions: RoutedBusinessQuestion[];
}

/**
 * Applies the V8 business boundary after facts have been supplied.
 *
 * AI/BA may judge a question's kind and materiality; this function applies the
 * declared facts deterministically. Technical questions go to SA, non-material
 * business questions travel as explicit open items, and only a material
 * business/authority choice or missing authority creates a hard human gate.
 */
export function assessBusinessInput(input: BusinessInputEvidence): BusinessInputAssessment {
  const evidence = BusinessInputEvidenceSchema.parse(input);
  const missingConfirmation: BusinessInputAssessment["missingConfirmation"] = [];
  if (evidence.source === null) missingConfirmation.push("source");
  if (evidence.scope.length === 0) missingConfirmation.push("scope");
  if (evidence.requirement_ids.length === 0) missingConfirmation.push("requirement_ids");
  if (evidence.acceptance_criteria_ids.length === 0) {
    missingConfirmation.push("acceptance_criteria_ids");
  }

  const humanGates: BusinessGateQuestion[] = [];
  if (evidence.owner === null) {
    humanGates.push({
      id: null,
      question: "Who is authorized to confirm this requirement input?",
      // This names who must supply the missing authority; it does not pretend
      // to know who the as-yet-unknown business owner is.
      owner: "requester",
      reason: "missing-business-authority",
    });
  }

  const questionsForSa: RoutedBusinessQuestion[] = [];
  const carriedQuestions: RoutedBusinessQuestion[] = [];
  for (const decision of evidence.decisions) {
    if (decision.status === "resolved") continue;
    if (decision.kind === "technical") {
      questionsForSa.push({
        id: decision.id,
        question: decision.question,
        owner: "system-analyst",
      });
      continue;
    }
    if (decision.material || decision.kind === "authority") {
      humanGates.push({
        id: decision.id,
        question: decision.question,
        owner: decision.owner,
        reason:
          decision.kind === "authority"
            ? "missing-business-authority"
            : "material-business-decision",
      });
      continue;
    }
    carriedQuestions.push({
      id: decision.id,
      question: decision.question,
      owner: decision.owner,
    });
  }

  if (humanGates.length > 0) {
    return {
      mode: "human-gate",
      canNormalizeWithoutInterview: false,
      missingConfirmation,
      humanGates,
      questionsForSa,
      carriedQuestions,
    };
  }

  const confirmed = evidence.mode === "confirmed" && missingConfirmation.length === 0;
  return {
    mode: confirmed ? "confirmed-input" : "interactive-fallback",
    canNormalizeWithoutInterview: confirmed,
    missingConfirmation,
    humanGates,
    questionsForSa,
    carriedQuestions,
  };
}

function sourceText(source: BusinessInputEvidence["source"]): string {
  return source === null ? "(missing)" : `${source.type}:${source.locator}`;
}

/** A deterministic, bounded prompt rendering; never copies a conversation. */
export function renderBusinessInputEvidence(input: BusinessInputEvidence): string {
  const evidence = BusinessInputEvidenceSchema.parse(input);
  const assessment = assessBusinessInput(evidence);
  const heading =
    evidence.mode === "confirmed"
      ? `Confirmed business input (version ${evidence.version})`
      : `Interactive business input (version ${evidence.version})`;
  const lines = [
    heading,
    "Treat this as provenance-bearing intake, not as permission to invent a missing fact or approval.",
    `Assessment: ${assessment.mode}`,
    `Source: ${sourceText(evidence.source)}`,
    `Owner: ${evidence.owner ?? "(missing)"}`,
    `Scope: ${evidence.scope.length > 0 ? evidence.scope.join(" | ") : "(missing)"}`,
    `Requirement IDs: ${evidence.requirement_ids.join(", ") || "(missing)"}`,
    `Acceptance IDs: ${evidence.acceptance_criteria_ids.join(", ") || "(missing)"}`,
  ];

  if (evidence.decisions.length > 0) {
    lines.push("Decisions and open questions (preserve wording and provenance):");
    for (const decision of evidence.decisions) {
      lines.push(
        `- ${decision.id} [${decision.status}; ${decision.kind}; ${decision.material ? "material" : "non-material"}] ` +
          `${decision.question} | owner=${decision.owner} | answer=${decision.answer ?? "(unresolved)"} | source=${decision.source ?? "(unresolved)"}`,
      );
    }
  }
  if (evidence.assumptions.length > 0) {
    lines.push("Assumptions (never promote these to confirmed fact):");
    for (const assumption of evidence.assumptions) {
      lines.push(
        `- ${assumption.statement} ${
          assumption.source === null
            ? "(assumption — unconfirmed)"
            : `(assumption; provenance: ${assumption.source})`
        }`,
      );
    }
  }
  if (assessment.questionsForSa.length > 0) {
    lines.push(
      "Route to SA evidence: " +
        assessment.questionsForSa
          .map((item) => `${item.id} ${item.question} (owner: ${item.owner})`)
          .join(" | "),
    );
  }
  if (assessment.carriedQuestions.length > 0) {
    lines.push(
      "Carry as non-material open questions: " +
        assessment.carriedQuestions
          .map((item) => `${item.id} ${item.question} (owner: ${item.owner})`)
          .join(" | "),
    );
  }
  if (assessment.humanGates.length > 0) {
    lines.push(
      "Human gate(s): " +
        assessment.humanGates
          .map((item) => `${item.id ?? "authority"} \"${item.question}\" (owner: ${item.owner})`)
          .join(" | "),
    );
  }
  return lines.join("\n");
}

/** One stable gate reason carrying every exact unresolved question and owner. */
export function businessGateReason(assessment: BusinessInputAssessment): string {
  if (assessment.humanGates.length > 0) {
    return (
      "MATERIAL_BUSINESS_GATE required — " +
      assessment.humanGates
        .map(
          (gate) =>
            `${gate.id ?? "authority"}: \"${gate.question}\" (owner: ${gate.owner}; reason: ${gate.reason})`,
        )
        .join(" | ")
    );
  }
  const missing = assessment.missingConfirmation.join(", ");
  return (
    "REQUIREMENT_INTERVIEW required — interactive interview required" +
    (missing ? ` because confirmed-input evidence is incomplete (${missing})` : "")
  );
}
