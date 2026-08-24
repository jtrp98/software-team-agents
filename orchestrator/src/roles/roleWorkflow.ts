import { AgentStage } from "../types.js";
import type { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type {
  ApiPayload,
  ArchitecturePayload,
  KnowledgeItem,
  KnowledgeKind,
  RequirementPayload,
  TaskPayload,
} from "../knowledge/knowledgeModel.js";
import { ALLOWED_OWNERS } from "../knowledge/ownership.js";
import { LANE_LABEL, type RoleLane, laneOf, rolesInLane } from "./roleLane.js";
import { type RoleWorkspace, loadRoleWorkspace } from "./roleWorkspace.js";
import { type SignoffVerdict, describeSignoff, signoffVerdict } from "./roleApproval.js";

/**
 * What happens *inside* one lane, between raw input arriving and the next lane
 * being able to start (T100 for BA; T101/T102 add the other two rows).
 *
 * NOT THE SAME THING AS `workflows/*.yml`
 *
 * Those say which of the eleven agents run, in what order, for a kind of change —
 * the cross-lane pipeline. This says what a single lane's work passes through
 * on its way to being something the next lane may rely on. A project has one
 * `workflows/feature.yml`; it has three of these, running at their own pace.
 *
 * THE STAGE IS DERIVED FROM T65, NOT STORED
 *
 * `ownership.ts` already fixes the only path a piece of knowledge can take:
 * `draft` -> `reviewed` (by somebody who is not its owner) -> `approved` (by a
 * person, never an agent). So a lane's stage is not a new state machine, it is
 * a reading of where its own items currently sit on that one. Storing it would
 * create a second answer free to disagree with the items themselves — the same
 * reason `roleWorkspace.ts` stores only the watermark.
 *
 * THE HANDOFF IS NOT A NEW MECHANISM EITHER
 *
 * "BA hands off to SA" means: BA's requirements are `approved`, and the SA lane
 * has acknowledged them (T99's watermark). Both halves already exist, so this
 * file reports the handoff rather than performing one. Nothing here writes.
 *
 * BLOCKERS VS CARRIES
 *
 * A blocker means the next lane must not start. A carry means it may start and
 * has something to resolve first. The distinction is load-bearing for exactly
 * one case, and getting it wrong would be worse than not having it: CLAUDE.md
 * requires an unsourced fact to be written down as `assumption_unconfirmed`, and
 * requires `system-analyst` to resolve it with the user rather than designing
 * around it. If that flag blocked the handoff, the rule would punish the
 * business-analyst for obeying it, and the way to make progress would be to stop
 * flagging assumptions. So it travels, loudly, instead of stopping anything.
 */

export type RoleWorkflowStage =
  /** The lane's primary kind does not exist for this module yet. Nothing has started. */
  | "intake"
  /** At least one owned item is `draft` — somebody other than its owner has to review it. */
  | "drafting"
  /** Everything owned is `reviewed` or better, and at least one is waiting on a person (item level, T65). */
  | "awaiting-approval"
  /** Every item is approved, but nobody has signed the lane itself off yet — or what they signed has changed since (T103). */
  | "awaiting-signoff"
  /** The person in this lane said no. An answer, not an absence — it blocks until they are asked again. */
  | "rejected"
  /** Everything owned is `approved`, the lane is signed off, and nothing blocks the handoff. */
  | "ready"
  /** Everything owned is `approved`, but something must be fixed before the next lane starts. */
  | "blocked";

export interface NextAction {
  /** Who has to move. `human` is never a suggestion here — it is a point the pipeline cannot pass on its own. */
  actor: "agent" | "human";
  /** The agent that does or assists with it, when there is one. */
  agent: AgentStage | null;
  what: string;
}

export interface Handoff {
  to: RoleLane | null;
  /** Approved items the next lane may rely on. */
  items: string[];
  /** Why the next lane must not start. Empty means it may. */
  blockers: string[];
  /** Flagged material the next lane must resolve before designing around it — travels with the work, never holds it. */
  carries: string[];
  /** Whether the receiving lane has acknowledged these versions (T99). False is normal, not an error. */
  acknowledgedByTarget: boolean;
}

export interface RoleWorkflowState {
  lane: RoleLane;
  module: string | null;
  stage: RoleWorkflowStage;
  nextAction: NextAction;
  /** Ids owned by this lane in this module, by where they sit on T65's path. */
  draft: string[];
  reviewed: string[];
  approved: string[];
  /** Where this lane's own gate stands (T103). */
  signoff: SignoffVerdict;
  handoff: Handoff;
}

export interface LaneSpec {
  lane: RoleLane;
  /** The agent that leads this lane — the one a person runs to get the lane's primary artefact produced. */
  leadAgent: AgentStage;
  /** The kind whose absence means this lane has not started. */
  primaryKind: KnowledgeKind;
  /** Where approved work goes next. `null` for the last lane in the chain. */
  handoffTo: RoleLane | null;
  /** CLAUDE.md's always-human point for this lane, in the words the person will read. */
  humanGate: string;
  /** Reasons this lane's approved work must not move on. Generic ones are in the engine. */
  blockers(approved: KnowledgeItem[], kb: KnowledgeBase): string[];
  /** Flagged material that travels with the handoff instead of holding it. */
  carries(approved: KnowledgeItem[], kb: KnowledgeBase): string[];
}

/**
 * The BA lane (T100): raw requirement in, `requirement`/`business-rule`
 * knowledge out, handed to SA.
 *
 * Its two lane-specific checks are the two things `system-analyst` cannot work
 * around by itself:
 *
 *   - **An approved requirement with no acceptance criteria.** `test-planner`
 *     and `qa-engineer` verify against those; with none, "done" has no
 *     definition and the phase can only be accepted by opinion.
 *   - **An unconfirmed assumption**, which travels rather than blocks — see the
 *     module note above.
 */
export const BA_WORKFLOW: LaneSpec = {
  lane: "ba",
  leadAgent: AgentStage.BUSINESS_ANALYST,
  primaryKind: "requirement",
  handoffTo: "sa",
  humanGate:
    "a requirement is never inferred — the person in the BA lane sits the interview and approves what it produced " +
    "(CLAUDE.md's first always-human point)",
  blockers(approved) {
    return approved
      .filter((item) => item.kind === "requirement" && (item.payload as RequirementPayload).acceptance_criteria.length === 0)
      .map(
        (item) =>
          `${item.id} is approved with no acceptance criteria — test-planner and qa-engineer verify against those, ` +
          "so there would be nothing to verify against",
      );
  },
  carries(approved) {
    return approved
      .filter((item) => item.kind === "requirement" && (item.payload as RequirementPayload).assumption_unconfirmed)
      .map(
        (item) =>
          `${item.id} rests on an unconfirmed assumption — system-analyst resolves it with the user before designing ` +
          "around it, rather than promoting it to fact by using it",
      );
  },
};

/**
 * The SA lane (T101): approved requirements in, `architecture`/`api`/`db-schema`
 * knowledge out, handed to DEV.
 *
 * Its blockers are the three ways a design can be `approved` and still leave an
 * engineer with a decision that is not theirs to make — which CLAUDE.md's
 * "engineers never decide a rule, they implement or they stop" rule says must
 * never happen. A design that says `not-feasible` is a verdict, not a plan; one
 * that says `unknown` is a gap wearing a design's clothes; and an API with no
 * contract name is the specific thing `taskGraph.ts` derives §6a's
 * backend-before-frontend ordering from, so without it the frontend has to guess
 * the response shape — the exact failure §6a exists to prevent, and one this
 * project has already paid for once.
 */
export const SA_WORKFLOW: LaneSpec = {
  lane: "sa",
  leadAgent: AgentStage.SYSTEM_ANALYST,
  primaryKind: "architecture",
  handoffTo: "dev",
  humanGate:
    "the data model is confirmed with a person before any code is written against it " +
    "(CLAUDE.md's second always-human point)",
  blockers(approved) {
    const problems: string[] = [];
    for (const item of approved) {
      if (item.kind === "architecture") {
        const { feasibility } = item.payload as ArchitecturePayload;
        if (feasibility === "not-feasible") {
          problems.push(`${item.id} is approved but its feasibility is "not-feasible" — that is a verdict, not something to build`);
        }
        if (feasibility === "unknown") {
          problems.push(
            `${item.id} is approved with feasibility "unknown" — an engineer would have to decide whether it can be done, ` +
              "which is not an engineer's call to make",
          );
        }
      }
      if (item.kind === "api" && (item.payload as ApiPayload).contract_name === null) {
        problems.push(
          `${item.id} has no contract_name — the backend-before-frontend ordering (agent-boundaries §6a) is derived from ` +
            "that name, so without it the frontend has to guess the response shape",
        );
      }
    }
    return problems;
  },
  carries(approved) {
    return approved
      .filter((item) => item.kind === "architecture")
      .flatMap((item) => {
        const { feasibility, risks } = item.payload as ArchitecturePayload;
        const carried: string[] = [];
        if (feasibility === "feasible-with-risk") {
          carried.push(`${item.id} is feasible with risk — DEV builds it knowing that, not discovering it`);
        }
        if (risks.length > 0) {
          carried.push(`${item.id} carries ${risks.length} recorded risk(s): ${risks.join("; ")}`);
        }
        return carried;
      });
  },
};

/**
 * The DEV lane (T102): approved design in, `task` knowledge and real code out.
 * The last lane — it hands off to nobody.
 *
 * Its first blocker is CLAUDE.md's §6a rule made checkable rather than
 * remembered: a frontend task that consumes a contract whose producing backend
 * task is not approved was written against a design document rather than
 * against what the backend actually built. That is the mismatch §6a names, and
 * it is stated in the data — `TaskPayload.produces` / `consumes` — so it can be
 * caught instead of reviewed for.
 *
 * The join to T01–T60 is `orchestrator_task_id`. It carries rather than blocks:
 * a task can be perfectly well described here and simply not have been run
 * through the state machine yet, which is a normal state and not a defect.
 */
export const DEV_WORKFLOW: LaneSpec = {
  lane: "dev",
  leadAgent: AgentStage.BACKEND_ENGINEER,
  primaryKind: "task",
  handoffTo: null,
  humanGate:
    "a person approves the deploy or migration itself, and any ⚠️/❌ QA round or 🔴/🟠 security finding on the way " +
    "(CLAUDE.md's third, fourth and fifth always-human points)",
  blockers(approved, kb) {
    const problems: string[] = [];
    const producerOf = new Map<string, KnowledgeItem>();
    for (const item of kb.query({ kinds: ["task"] })) {
      for (const contract of (item.payload as TaskPayload).produces) producerOf.set(contract, item);
    }

    for (const item of approved) {
      if (item.kind !== "task") continue;
      const payload = item.payload as TaskPayload;

      if (payload.plan_status === "blocked") {
        problems.push(`${item.id} is approved but its plan Status is "blocked" — an approved blocked task is two answers`);
      }
      if (payload.tag !== "frontend") continue;

      for (const contract of payload.consumes) {
        const producer = producerOf.get(contract);
        if (!producer) {
          problems.push(
            `${item.id} consumes contract "${contract}" that no task produces — the frontend has nothing real to read it off`,
          );
          continue;
        }
        if (producer.status !== "approved") {
          problems.push(
            `${item.id} is approved but ${producer.id}, which produces the contract "${contract}" it consumes, is ` +
              `${producer.status} — agent-boundaries §6a: the frontend reads its types off what the backend actually built`,
          );
        }
      }
    }
    return problems;
  },
  carries(approved) {
    return approved
      .filter((item) => item.kind === "task")
      .flatMap((item) => {
        const payload = item.payload as TaskPayload;
        const carried: string[] = [];
        if (payload.orchestrator_task_id === null) {
          carried.push(`${item.id} has no orchestrator_task_id — this graph and the running state machine are not joined for it`);
        }
        if (payload.plan_status !== "verified") {
          carried.push(
            `${item.id} is approved as knowledge but its plan Status is "${payload.plan_status}" — only qa-engineer sets verified`,
          );
        }
        return carried;
      });
  },
};

/**
 * The UX/UI lane: the one lane whose primary artefact is a *recommendation*.
 * `uxui-designer` drafts the UX items (`UX-*`) from the design source; every one
 * of them still walks T65's path — reviewed by somebody else, approved by a
 * person — and the lane's own gate stays a person recording uxui-signoff. The
 * agent proposes; the human authority is untouched.
 */
export const UXUI_WORKFLOW: LaneSpec = {
  lane: "uxui",
  leadAgent: AgentStage.UXUI_DESIGNER,
  primaryKind: "ux-design",
  handoffTo: "dev",
  humanGate: "a human records uxui-signoff for the current UX artifact",
  blockers() { return []; },
  carries() { return []; },
};

/**
 * One entry per lane.
 *
 * Still typed `Partial` even now that all three are filled: the type is what
 * forces a caller to handle a missing lane, and the CLI's "(no lane workflow
 * defined yet)" line was the thing that kept the gap visible while there was
 * one. Narrowing it to a total record buys nothing and removes that.
 */
export const LANE_WORKFLOWS: Partial<Record<RoleLane, LaneSpec>> = {
  ba: BA_WORKFLOW,
  sa: SA_WORKFLOW,
  uxui: UXUI_WORKFLOW,
  dev: DEV_WORKFLOW,
};

export function workflowFor(lane: RoleLane): LaneSpec | undefined {
  return LANE_WORKFLOWS[lane];
}

/** Kinds a lane's roles are allowed to own. Derived from T65's table — used for messages, never as a filter (an item's actual `owner` decides which lane it belongs to). */
export function ownedKindsOf(lane: RoleLane): KnowledgeKind[] {
  const roles = new Set(rolesInLane(lane));
  return (Object.keys(ALLOWED_OWNERS) as KnowledgeKind[]).filter((kind) =>
    ALLOWED_OWNERS[kind].some((role) => roles.has(role)),
  );
}

function itemsOwnedBy(lane: RoleLane, module: string | null, kb: KnowledgeBase): KnowledgeItem[] {
  return kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
}

function ids(items: KnowledgeItem[]): string[] {
  return items.map((i) => i.id).sort();
}

/** How this state reaches the *receiving* lane's watermark. Passed in rather than read from disk here, so the function stays pure and a test can supply an in-memory lane. */
export type WorkspaceLookup = (lane: RoleLane) => RoleWorkspace;

/**
 * Where the lane stands right now, worked out from `knowledge/` and the
 * receiving lane's watermark. Pure: it reads, it never writes, and calling it
 * does not advance anything — in particular it must never advance a watermark,
 * which is the one thing `roleWorkspace.ts` reserves for a person.
 */
export function roleWorkflowState(
  spec: LaneSpec,
  module: string | null,
  kb: KnowledgeBase,
  workspaces: WorkspaceLookup,
): RoleWorkflowState {
  const owned = itemsOwnedBy(spec.lane, module, kb);
  const draft = owned.filter((i) => i.status === "draft");
  const reviewed = owned.filter((i) => i.status === "reviewed");
  const approved = owned.filter((i) => i.status === "approved");
  const hasPrimary = owned.some((i) => i.kind === spec.primaryKind);

  const blockers = [
    ...ids([...draft, ...reviewed]).map(
      (id) => `${id} is not approved — the next lane must not build on knowledge nobody accepted as binding`,
    ),
    ...spec.blockers(approved, kb),
  ];
  const carries = spec.carries(approved, kb);

  const target = spec.handoffTo;
  // The target lane is caught up on these ids exactly when its own watermark
  // holds the current version of each one. Read from its watermark directly
  // rather than from `laneView`: the view only reports ids the target already
  // declares a relation to, and at handoff time it usually declares none yet.
  const acknowledgedByTarget =
    target !== null &&
    approved.length > 0 &&
    (() => {
      const seen = new Map(workspaces(target).seen.map((ref) => [ref.id, ref.version]));
      return approved.every((item) => seen.get(item.id) === item.version);
    })();

  const handoff: Handoff = {
    to: target,
    items: ids(approved),
    blockers,
    carries,
    acknowledgedByTarget,
  };

  // T103's gate sits after every item is approved and before `ready`: item-level
  // approval says each fact is binding, the sign-off says the lane is finished.
  const signoff = signoffVerdict(workspaces(spec.lane), approved);

  const stage: RoleWorkflowStage = !hasPrimary
    ? "intake"
    : draft.length > 0
      ? "drafting"
      : reviewed.length > 0
        ? "awaiting-approval"
        : blockers.length > 0
          ? // Blockers outrank the gate deliberately: asking a person to sign off
            // work that is already known to be unusable wastes the one step in
            // this pipeline that cannot be automated.
            "blocked"
          : signoff.state === "rejected"
            ? "rejected"
            : signoff.state === "current"
              ? "ready"
              : "awaiting-signoff";

  return {
    lane: spec.lane,
    module,
    stage,
    nextAction: nextActionFor(spec, stage, {
      draft,
      reviewed,
      approved,
      blockers,
      carries,
      acknowledgedByTarget,
      signoff,
    }),
    draft: ids(draft),
    reviewed: ids(reviewed),
    approved: ids(approved),
    signoff,
    handoff,
  };
}

/** The lookup a real run uses: each lane's watermark, read off disk under one project root. */
export function workspacesUnder(projectRoot: string, module: string | null, now: string): WorkspaceLookup {
  return (lane) => loadRoleWorkspace(lane, module, projectRoot, now);
}

interface StageFacts {
  draft: KnowledgeItem[];
  reviewed: KnowledgeItem[];
  approved: KnowledgeItem[];
  blockers: string[];
  carries: string[];
  acknowledgedByTarget: boolean;
  signoff: SignoffVerdict;
}

function nextActionFor(spec: LaneSpec, stage: RoleWorkflowStage, facts: StageFacts): NextAction {
  switch (stage) {
    case "intake":
      return {
        actor: "human",
        agent: spec.leadAgent,
        what: `no ${spec.primaryKind} exists for this module yet — ${spec.humanGate}`,
      };

    case "drafting":
      return {
        actor: "agent",
        agent: null,
        what:
          `${ids(facts.draft).join(", ")} are draft — somebody other than the owner reviews them before a person can ` +
          "approve (T65: an owner marking its own work reviewed records that nothing happened)",
      };

    case "awaiting-approval":
      return {
        actor: "human",
        agent: null,
        what: `${ids(facts.reviewed).join(", ")} are reviewed and waiting on a person — ${spec.humanGate}`,
      };

    case "blocked":
      return { actor: "human", agent: null, what: facts.blockers.join("; ") };

    case "awaiting-signoff": {
      const because =
        facts.signoff.state === "stale"
          ? `${describeSignoff(facts.signoff, spec.lane)}`
          : `everything this lane owns is approved and nobody has signed the lane off — ${spec.humanGate}`;
      return {
        actor: "human",
        agent: null,
        what: `${because}. Record it with \`sta roles signoff ${spec.lane} --by <name>\`.`,
      };
    }

    case "rejected":
      return {
        actor: "human",
        agent: null,
        what:
          `${describeSignoff(facts.signoff, spec.lane)}. This lane is stopped until the objection is addressed and it is ` +
          "signed off again — a rejection is an answer, not an absence, so nothing re-asks it on its own",
      };

    case "ready": {
      if (spec.handoffTo === null) {
        return { actor: "human", agent: null, what: "everything this lane owns is approved; it hands off to nobody" };
      }
      if (facts.acknowledgedByTarget) {
        return {
          actor: "human",
          agent: null,
          what: `${LANE_LABEL[spec.handoffTo]} has acknowledged ${ids(facts.approved).join(", ")} — this lane is done for now`,
        };
      }
      const carried = facts.carries.length > 0 ? ` It carries: ${facts.carries.join("; ")}.` : "";
      return {
        actor: "human",
        agent: null,
        what:
          `hand off to ${LANE_LABEL[spec.handoffTo]}: ${ids(facts.approved).join(", ")} are approved. ` +
          `Record it with \`sta roles ack ${spec.handoffTo} ${ids(facts.approved).join(",")} --by <name>\`.${carried}`,
      };
    }
  }
}

/**
 * The stage word for one lane, for `sta roles`.
 *
 * All three lanes have a workflow now, so the `null` branch is not reachable
 * from the CLI — it is kept because `LANE_WORKFLOWS` is typed `Partial` and the
 * type is what forces a caller to handle the case. A lane whose workflow went
 * missing must print that it is missing, not print nothing and read as "no work
 * here".
 */
export function describeStage(state: RoleWorkflowState | null): string {
  return state === null ? "(no lane workflow defined)" : state.stage;
}
