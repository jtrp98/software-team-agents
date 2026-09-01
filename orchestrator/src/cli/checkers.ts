/**
 * T-V4-CLI-002 — the 18 `--check-*` flags as one declarative table.
 *
 * Every entry here was, until this task, a near-identical `if (args.checkX)`
 * block inside `runCli` (`cli.ts:2308-2541`). The blocks differed only in: the
 * flag, the function called, the success sentence, the failure heading, and how
 * `result.notes` were surfaced. That is table data, not control flow.
 *
 * This file holds ONLY the table and the one loop body that prints an entry.
 * No interface hierarchy, no registry class, no plugin mechanism — the consumer
 * (`runCli`) is a plain `for` loop over `CHECKERS`. Adding the 19th checker is
 * one new row here plus its `--check-*` branch in `parseArgs`; the
 * `cli.test.ts` descriptor-count test fails if those two ever disagree.
 */
import { checkAllContracts } from "../agents/agentContract.js";
import { checkPathRules } from "../agents/pathPermissions.js";
import { checkLayout } from "../layout/repoLayout.js";
import { checkPromptBudget } from "../layout/promptBudget.js";
import { checkAllWorkflows } from "../workflow/workflowDefinition.js";
import { checkBindings } from "../runtime/bindingGenerator.js";
import { checkProfile } from "../profile/projectProfile.js";
import { checkDecisions } from "../decisions/decisionLog.js";
import { checkTestPyramid } from "../testing/testPyramid.js";
import { checkReviewSeparation } from "../review/reviewSeparation.js";
import { checkEscalationPolicy } from "../escalation/escalationPolicy.js";
import { checkWorkspace } from "../workspace/workspace.js";
import { checkRepoMap } from "../repos/repoMap.js";
import { checkEnvironmentConfig } from "../environment/environment.js";
import { checkDocStructure } from "../docs/docStructure.js";
import { checkPlanGraphs } from "../docs/planGraph.js";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { validateInstallation } from "../packaging/installValidation.js";
import { checkRoleWorkspaces } from "../roles/roleWorkspace.js";

/**
 * The one shape every checker's result is reduced to for printing. A plain
 * record type, not an `interface` — there is no checker abstraction to model,
 * only three columns the loop reads.
 */
export type CheckOutcome = {
  ok: boolean;
  problems: string[];
  notes: string[];
};

/**
 * The `CliArgs` boolean field that selects a checker. Also this table's
 * source-order key — evaluation order in `runCli` must stay the order below,
 * because the flags are mutually exclusive in practice only, and the old code
 * short-circuited on the first match in a fixed order.
 */
export type CheckerFlag =
  | "checkContracts"
  | "checkLayout"
  | "checkPromptBudget"
  | "checkWorkflows"
  | "checkBindings"
  | "checkProfile"
  | "checkDecisions"
  | "checkTestPyramid"
  | "checkReviewSeparation"
  | "checkEscalationPolicy"
  | "checkWorkspace"
  | "checkRepos"
  | "checkEnvironments"
  | "checkDocStructure"
  | "checkPlan"
  | "checkKnowledge"
  | "checkInstallation"
  | "checkRoles";

/**
 * How a checker surfaces `result.notes` — byte-for-byte with the pre-table blocks:
 *  - `"leading"`             — `[orchestrator] note: <n>` on BOTH paths, before the ok/fail branch
 *  - `"trailing-on-success"` — `  - <n>` after the ok message, success path ONLY (`--check-prompt-budget`)
 *  - `"none"`                — notes are never printed
 */
export type NotesMode = "leading" | "trailing-on-success" | "none";

/** One row of the {@link CHECKERS} table — data columns, not an abstraction. */
export type CheckerDescriptor = {
  /** Selecting `CliArgs` field. */
  flag: CheckerFlag;
  /** The `--check-*` string it maps to — used by the descriptor-count test and nothing else. */
  cliFlag: string;
  /** Runs the check. `moduleName` is consumed only by `--check-plan`. */
  run: (projectRoot: string, moduleName: string | undefined) => CheckOutcome;
  /** stdout line printed before `return 0` on success. */
  okMessage: string;
  /** stderr heading printed above the problem list before `return 1` on failure. */
  failHeading: string;
  notes: NotesMode;
};

const toOutcome = (r: { ok: boolean; problems: string[]; notes?: string[] }): CheckOutcome => ({
  ok: r.ok,
  problems: r.problems,
  notes: r.notes ?? [],
});

export const CHECKERS: readonly CheckerDescriptor[] = [
  {
    flag: "checkContracts",
    cliFlag: "--check-contracts",
    run: (root) => {
      // Path rules live in the same files, so they are checked in the same pass —
      // a write glob that can never match is a role that silently cannot do its job.
      const contracts = checkAllContracts(root);
      const paths = checkPathRules(root);
      const problems = [...contracts.problems, ...paths.problems];
      return { ok: problems.length === 0, problems, notes: [] };
    },
    okMessage: "[orchestrator] contracts/*.yaml agree with the agent registry, and their path rules are sane.",
    failHeading: "[orchestrator] contracts/*.yaml have problems:",
    notes: "none",
  },
  {
    flag: "checkLayout",
    cliFlag: "--check-layout",
    run: (root) => toOutcome(checkLayout(root)),
    okMessage: "[orchestrator] layout.yaml agrees with the repo.",
    failHeading: "[orchestrator] layout.yaml and the repo disagree:",
    notes: "none",
  },
  {
    flag: "checkPromptBudget",
    cliFlag: "--check-prompt-budget",
    run: (root) => toOutcome(checkPromptBudget(root)),
    okMessage: "[orchestrator] static prompt budget holds.",
    failHeading: "[orchestrator] static prompt budget exceeded:",
    notes: "trailing-on-success",
  },
  {
    flag: "checkWorkflows",
    cliFlag: "--check-workflows",
    run: (root) => toOutcome(checkAllWorkflows(root)),
    okMessage: "[orchestrator] workflows/*.yml agree with the classifier.",
    failHeading: "[orchestrator] workflows/*.yml and the classifier disagree:",
    notes: "none",
  },
  {
    flag: "checkBindings",
    cliFlag: "--check-bindings",
    run: (root) => toOutcome(checkBindings(root)),
    okMessage: "[orchestrator] .codex/agents bindings match the .claude/agents sources.",
    failHeading: "[orchestrator] codex role bindings have drifted from their sources:",
    notes: "none",
  },
  {
    flag: "checkProfile",
    cliFlag: "--check-profile",
    run: (root) => toOutcome(checkProfile(root)),
    okMessage: "[orchestrator] project.yaml and stacks/ agree with the agent roster.",
    failHeading: "[orchestrator] project.yaml and the agent roster disagree:",
    // A tracked migration is worth seeing on a green run; burying it until
    // something breaks is how it stops being tracked.
    notes: "leading",
  },
  {
    flag: "checkDecisions",
    cliFlag: "--check-decisions",
    run: (root) => toOutcome(checkDecisions(root)),
    okMessage: "[orchestrator] decisions/*.md agree with the schema and cross-link cleanly.",
    failHeading: "[orchestrator] decisions/*.md have problems:",
    notes: "none",
  },
  {
    flag: "checkTestPyramid",
    cliFlag: "--check-test-pyramid",
    run: (root) => toOutcome(checkTestPyramid(root)),
    okMessage: "[orchestrator] test-pyramid.yaml agrees with its schema.",
    failHeading: "[orchestrator] test-pyramid.yaml has problems:",
    notes: "none",
  },
  {
    flag: "checkReviewSeparation",
    cliFlag: "--check-review-separation",
    run: (root) => toOutcome(checkReviewSeparation(root)),
    okMessage: "[orchestrator] no agent can review its own work.",
    failHeading: "[orchestrator] creator/reviewer separation is broken:",
    // An unreviewed pipeline is a right-sizing decision the user owns
    // (workflows/typo.yml says so outright), so it is shown and not failed.
    notes: "leading",
  },
  {
    flag: "checkEscalationPolicy",
    cliFlag: "--check-escalation-policy",
    run: (root) => toOutcome(checkEscalationPolicy(root)),
    okMessage: "[orchestrator] escalation-policy.yaml agrees with the runtime policy.",
    failHeading: "[orchestrator] escalation-policy.yaml has problems:",
    // A severity that can never retry changes how the whole pipeline behaves.
    notes: "leading",
  },
  {
    flag: "checkWorkspace",
    cliFlag: "--check-workspace",
    run: (root) => toOutcome(checkWorkspace(root)),
    okMessage: "[orchestrator] workspace.yaml is fine.",
    failHeading: "[orchestrator] workspace.yaml has problems:",
    // "no workspace.yaml" is the normal state for a standalone project; burying
    // that note makes silence indistinguishable from an unvalidated workspace.
    notes: "leading",
  },
  {
    flag: "checkRepos",
    cliFlag: "--check-repos",
    run: (root) => toOutcome(checkRepoMap(root)),
    okMessage: "[orchestrator] repos.yaml is fine.",
    failHeading: "[orchestrator] repos.yaml has problems:",
    notes: "leading",
  },
  {
    flag: "checkEnvironments",
    cliFlag: "--check-environments",
    run: (root) => toOutcome(checkEnvironmentConfig(root)),
    okMessage: "[orchestrator] environments.yaml is fine.",
    failHeading: "[orchestrator] environments.yaml has problems:",
    notes: "leading",
  },
  {
    flag: "checkDocStructure",
    cliFlag: "--check-doc-structure",
    run: (root) => toOutcome(checkDocStructure(root)),
    okMessage: "[orchestrator] every module document present has the sections its schema requires.",
    failHeading: "[orchestrator] module documents have structural problems:",
    notes: "leading",
  },
  {
    flag: "checkPlan",
    cliFlag: "--check-plan",
    run: (root, moduleName) => toOutcome(checkPlanGraphs(root, moduleName)),
    okMessage: "[orchestrator] every plan.md checked is a valid task graph.",
    failHeading: "[orchestrator] plan task graphs have problems:",
    notes: "leading",
  },
  {
    flag: "checkKnowledge",
    cliFlag: "--check-knowledge",
    run: (root) => toOutcome(checkKnowledge(root)),
    okMessage: "[orchestrator] knowledge/ is consistent.",
    failHeading: "[orchestrator] knowledge/ has problems:",
    notes: "leading",
  },
  {
    flag: "checkInstallation",
    cliFlag: "--check-installation",
    run: (root) => toOutcome(validateInstallation(root)),
    okMessage: "[orchestrator] installation metadata (.agent-team/, or legacy .sta/) agrees with the project's real files.",
    failHeading: "[orchestrator] installation metadata has problems:",
    notes: "leading",
  },
  {
    flag: "checkRoles",
    cliFlag: "--check-roles",
    run: (root) => toOutcome(checkRoleWorkspaces(root)),
    okMessage: "[orchestrator] every role workspace agrees with knowledge/.",
    failHeading: "[orchestrator] role workspaces have problems:",
    // "BA is behind on sales-crm" is the check working — what a lane needs to be
    // told, not a repo inconsistency to fail on.
    notes: "leading",
  },
];

/**
 * Executes one descriptor and returns its process exit code, printing exactly
 * what the pre-table `if (args.checkX)` block printed — same streams, same order.
 */
export function runChecker(
  d: CheckerDescriptor,
  projectRoot: string,
  moduleName: string | undefined,
): number {
  const result = d.run(projectRoot, moduleName);
  if (d.notes === "leading") {
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
  }
  if (result.ok) {
    console.log(d.okMessage);
    if (d.notes === "trailing-on-success") {
      for (const note of result.notes) console.log(`  - ${note}`);
    }
    return 0;
  }
  console.error(d.failHeading);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  return 1;
}
