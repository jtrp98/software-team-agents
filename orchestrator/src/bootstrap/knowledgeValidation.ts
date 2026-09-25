import { defaultProjectRoot } from "../agents/agentContract.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { readBootstrapState, BootstrapStateError } from "./bootstrapStore.js";
import { BootstrapNotSettledError, BootstrapNotStartedError, UntrustedHumanValidationError } from "./bootstrapRunner.js";
import type { BootstrapState } from "./bootstrapModel.js";

export interface ValidationSummary {
  approved: string[];
  alreadyApproved: string[];
  skipped: Array<{ id: string; reason: string }>;
  bootstrapState: BootstrapState;
}

/** A role or Controller cannot manufacture a human review from an actor name. */
export function advanceToApproved(item: KnowledgeItem, now: string, projectRoot: string): KnowledgeItem {
  void item;
  void now;
  void projectRoot;
  throw new UntrustedHumanValidationError();
}

/** No trusted TASK-001 channel is configured; refuse before any Knowledge write. */
export function validateDiscoveredKnowledge(
  validatedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): ValidationSummary {
  void validatedBy;
  void now;
  const { state, problems } = readBootstrapState(projectRoot);
  if (problems.length > 0) throw new BootstrapStateError(problems);
  if (!state) throw new BootstrapNotStartedError();
  if (!state.stages.every((s) => s.status === "done" || s.status === "skipped")) throw new BootstrapNotSettledError();
  throw new UntrustedHumanValidationError();
}
