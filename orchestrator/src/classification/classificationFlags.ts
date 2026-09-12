import type { ClassificationInput } from "./taskClassifier.js";

/**
 * The CLI's boolean classification flags, shared between `cli.ts`'s own
 * flag-based `run`/`--register-only` form and `cli/verbs/boundedRun.ts`.
 *
 * Split out on purpose: `boundedRun.ts` needs this map, and `cli.ts` needs
 * `boundedRun.ts` (to dispatch the verb) — a module either side imported
 * from `cli.ts` at its own top level would resolve to `undefined` mid-cycle,
 * which is exactly the failure a shared, cycle-free home avoids.
 */
export type BooleanClassificationKey = Exclude<keyof ClassificationInput, "testStrategyTriggers">;

export const FLAG_TO_CLASSIFICATION: Record<string, BooleanClassificationKey> = {
  "--typo": "isTypoOrCopyOnly",
  "--bug-fix": "isClearBugFix",
  "--schema": "touchesSchema",
  "--business-rule": "touchesBusinessRuleOnly",
  "--incremental": "isIncrementalFeature",
  "--new-feature": "isNewFeatureModuleOrProject",
  "--deploy": "isProductionDeployOrMigration",
  "--sensitive": "touchesSensitiveArea",
  "--backend": "touchesBackend",
  "--frontend": "touchesFrontend",
};
