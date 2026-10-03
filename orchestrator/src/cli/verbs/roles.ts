import { CliUsageError } from "../../cli.js";
import { ApprovalDecisionError, describeHumanActor } from "../../gates/approval.js";
import { chatRelayCredential } from "../chatRelay.js";
import { chatRelayInstructions } from "../../gates/chatRelayChannel.js";
import { resolveHumanDecisionChannel } from "../../gates/humanChannelConfig.js";
import { NoTrustedHumanChannelError, UntrustedHumanDecisionError } from "../../gates/humanDecision.js";
import type { LaneAction, LaneApprovalRecord } from "../../gates/laneApproval.js";
import { KnowledgeContext } from "../../knowledge/knowledgeContext.js";
import { renderKnowledgeRetrieval } from "../../knowledge/retrievalRender.js";
import { lanesAffectedBy, notificationsFor } from "../../roles/changePropagation.js";
import { laneContext, laneGet } from "../../roles/laneContext.js";
import {
  LaneActRefusedError,
  LaneDecisionService,
  canonicalKnowledgeRoot,
  laneItemRefs,
  laneWorkspaces,
  loadGovernedKnowledge,
  type GovernedKnowledge,
} from "../../roles/laneDecisions.js";
import { LANE_LABEL, ROLE_LANES, isRoleLane, type RoleLane } from "../../roles/roleLane.js";
import { describeStage, roleWorkflowState, workflowFor } from "../../roles/roleWorkflow.js";
import { laneView } from "../../roles/roleWorkspace.js";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";
import { staleSourcesAt } from "../../knowledge/freshness.js";
import { flagValue, positionalArgs } from "../support.js";
import { APPROVE_EXIT_ANNOUNCED, APPROVE_EXIT_NO_TRUSTED_CHANNEL, APPROVE_EXIT_REFUSED, APPROVAL_PROMPT } from "./approve.js";

/**
 * `sta roles` — where each lane stands, and the one way a person signs a lane
 * off or acknowledges a handoff (V13 TASK-028).
 *
 * Every reading here goes through the lane ledger (`laneDecisions.ts`): item
 * statuses are governed by trusted sign-off decisions, and each lane's
 * watermark and sign-off history are projections of trusted decisions. No
 * `knowledge/_roles/**` file is read.
 *
 * `signoff` and `ack` use the production trusted channel — the same one
 * `sta approve` uses. The first call opens a pending lane request with an
 * STA-minted id over the exact current `{id, version, digest}` of the items
 * and announces it to the Controller. After the human answers in chat, the
 * Controller relays it here with the exact request and chat reference.
 */

const DECISION_ACTS: Record<string, LaneAction> = { signoff: "signoff", ack: "ack" };

function requireLane(args: string[]): RoleLane {
  const lane = args[1];
  if (lane === undefined || !isRoleLane(lane)) {
    throw new CliUsageError(`roles ${args[0]}: a lane is required — one of ${ROLE_LANES.join(", ")}`);
  }
  return lane;
}

function describeRequest(record: LaneApprovalRecord): string {
  const { scope } = record;
  return (
    `lane request ${record.requestId} (${scope.type}, module ${scope.module}): ` +
    scope.items.map((item) => `${item.id} v${item.version} sha256:${item.digest}`).join(", ")
  );
}

async function runLaneDecision(
  act: LaneAction,
  args: string[],
  rest: string[],
  projectRoot: string,
  moduleFlag: string | undefined,
): Promise<number> {
  const lane = requireLane(args);
  if (moduleFlag === undefined) throw new CliUsageError(`roles ${act}: --module <name> is required — a lane decision is about one module`);
  const ids = args.slice(2).flatMap((a) => a.split(",")).filter((a) => a !== "");
  const requestId = flagValue(rest, "--request");
  const yes = rest.includes("--yes");
  const no = rest.includes("--no");
  const note = flagValue(rest, "--note");
  if (yes && no) throw new CliUsageError(`roles ${act}: --yes and --no are mutually exclusive`);
  if ((yes || no) && !requestId) throw new CliUsageError(`roles ${act}: Controller relay requires --request`);
  const credential = yes || no ? chatRelayCredential(rest) : undefined;
  const knowledgeRoot = flagValue(rest, "--knowledge-root") ?? projectRoot;

  const store = new SqliteTaskStore(flagValue(rest, "--state-db") ?? defaultStateDbPath(projectRoot));
  try {
    const service = new LaneDecisionService({ store, verifier: resolveHumanDecisionChannel() });
    try {
      if (requestId === undefined) {
        const request = service.request(knowledgeRoot, moduleFlag, lane, act, ids.length > 0 ? ids : undefined);
        console.log(`[orchestrator] pending ${describeRequest(request)}`);
        console.log(`[orchestrator]   ${APPROVAL_PROMPT[request.scope.type]}`);
        console.log(`[orchestrator]   ${chatRelayInstructions(request.requestId)}`);
        const publication = await service.publish(request.requestId);
        if (!publication) {
          throw new NoTrustedHumanChannelError(request.requestId);
        }
        console.log(`[orchestrator] request ${request.requestId} is announced on ${publication.channel}: ${publication.url ?? publication.ref}`);
        console.log("[orchestrator] show this request to the human in chat; then relay the answer with --request, --yes or --no and its chat reference.");
        return APPROVE_EXIT_ANNOUNCED;
      }

      const existing = store.loadLaneRequest(requestId);
      if (!existing) throw new ApprovalDecisionError("unknown-request", `no lane request ${requestId} was opened here`);
      if (existing.scope.lane !== lane || existing.scope.action !== act || existing.scope.module !== moduleFlag) {
        throw new ApprovalDecisionError(
          "scope-mismatch",
          `lane request ${requestId} is a ${existing.scope.lane} ${existing.scope.action} for module ${existing.scope.module}, not a ${lane} ${act} for ${moduleFlag}`,
        );
      }
      console.log(`[orchestrator] ${describeRequest(existing)}`);
      console.log(`[orchestrator]   ${chatRelayInstructions(existing.requestId)}`);
      const publication = await service.publish(requestId);
      if (!publication) throw new NoTrustedHumanChannelError(requestId);
      if (!yes && !no) {
        console.log(`[orchestrator] request ${requestId} is pending on ${publication.channel}; show it to the human in chat first.`);
        return APPROVE_EXIT_ANNOUNCED;
      }
      const { record: decided, settleError } = await service.submit({
        requestId,
        approved: yes,
        ...(note === undefined ? {} : { note }),
        credential,
      });
      if (settleError) console.error(`[orchestrator] decision recorded, but the channel could not settle its announcement: ${settleError}`);
      const decision = decided.decision!;
      console.log(`[orchestrator] ${decision.approved ? (act === "signoff" ? "signed off" : "acknowledged") : "rejected"} ${requestId} (${describeHumanActor(decision.actor)} via ${decision.source.channel}).`);
      return decision.approved ? 0 : 3;
    } catch (e) {
      if (e instanceof NoTrustedHumanChannelError) {
        console.error(`[orchestrator] refused: ${e.message}`);
        return APPROVE_EXIT_NO_TRUSTED_CHANNEL;
      }
      if (e instanceof ApprovalDecisionError || e instanceof UntrustedHumanDecisionError) {
        console.error(`[orchestrator] refused: ${e.message}`);
        return APPROVE_EXIT_REFUSED;
      }
      if (e instanceof LaneActRefusedError) {
        console.error(`[orchestrator] cannot ask for a ${LANE_LABEL[lane]} ${act} yet: ${e.message}`);
        return 1;
      }
      throw e;
    }
  } finally {
    store.close();
  }
}

/** Read-only lane inspection over the governed Knowledge and the lane ledger. */
async function runRolesSubCommand(
  args: string[],
  rest: string[],
  projectRoot: string,
  moduleFlag: string | undefined,
  governed: GovernedKnowledge,
  now: string,
): Promise<number> {
  const module = moduleFlag ?? null;
  const kb = governed.kb;
  const workspaces = laneWorkspaces(governed.recordsFor, governed.root, module, now);
  const refsOf = (items: Parameters<typeof laneItemRefs>[0]) => laneItemRefs(items, governed.root);
  switch (args[0]) {
    case "inbox": {
      const lanes = args[1] !== undefined && isRoleLane(args[1]) ? [args[1] as RoleLane] : [...ROLE_LANES];
      let total = 0;
      for (const lane of lanes) {
        const notifications = notificationsFor(lane, module, kb, workspaces(lane), refsOf);
        total += notifications.length;
        console.log(`\n${LANE_LABEL[lane]} — ${notifications.length} to look at`);
        for (const n of notifications) console.log(`  [${n.reason}] ${n.message}`);
      }
      if (total === 0) console.log("\n[orchestrator] every lane is up to date.");
      return 0;
    }

    case "impact": {
      const ids = args.slice(1).flatMap((a) => a.split(",")).filter((a) => a !== "");
      if (ids.length === 0) throw new CliUsageError("roles impact: name at least one item id");
      const unknown = ids.filter((id) => kb.get(id) === null);
      if (unknown.length > 0) {
        console.error(`[orchestrator] no knowledge item with id ${unknown.join(", ")}`);
        return 1;
      }
      const affected = lanesAffectedBy(kb, ids);
      console.log(`[orchestrator] changing ${ids.join(", ")} would reach:`);
      for (const lane of ROLE_LANES) {
        const items = affected.get(lane) ?? [];
        console.log(`  ${LANE_LABEL[lane].padEnd(4)} ${items.length === 0 ? "nothing" : items.map((i) => i.id).join(", ")}`);
      }
      return 0;
    }

    case "context": {
      const lane = requireLane(args);
      const id = args[2];
      const context = KnowledgeContext.load(projectRoot, now);

      if (id !== undefined) {
        const outcome = laneGet(lane, context, id);
        if (rest.includes("--full")) {
          const rendered = renderKnowledgeRetrieval(lane, id, outcome);
          if (outcome.status === "not-found") console.error(rendered.text);
          else console.log(rest.includes("--json") ? JSON.stringify(rendered.json, null, 2) : rendered.text);
          return outcome.status === "not-found" ? 1 : 0;
        }
        if (outcome.status === "not-found") {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        if (outcome.status === "withheld") {
          // Withheld is not an error: the lane asked a legitimate question and the
          // answer is "not for you". Exit 0 and say which, so it is never confused
          // with the item not existing.
          console.log(`[orchestrator] ${id}: withheld — ${outcome.reason}`);
          return 0;
        }
        const { item, viaRole, provenance } = outcome.item;
        const governedStatus = kb.resolve(item.id, item.module)?.status ?? item.status;
        console.log(`[orchestrator] ${id} as the ${LANE_LABEL[lane]} lane sees it (via ${viaRole}):`);
        console.log(`  ${item.title} [${item.kind}, ${governedStatus}, owned by ${item.owner}]`);
        if (item.withheld.length > 0) console.log(`  withheld: ${item.withheld.join(", ")}`);
        console.log(`  ${provenance.citation}`);
        return 0;
      }

      const result = laneContext(lane, context, module === null ? {} : { module });
      console.log(`[orchestrator] the ${LANE_LABEL[lane]} lane sees ${result.items.length} item(s):`);
      for (const entry of result.items) {
        const withheld = entry.item.withheld.length > 0 ? ` (withheld: ${entry.item.withheld.join(", ")})` : "";
        console.log(`  ${entry.item.id.padEnd(18)} ${entry.item.kind.padEnd(14)} via ${entry.viaRole}${withheld}`);
      }
      if (result.hidden.length > 0) console.log(`  hidden from every role in this lane: ${result.hidden.join(", ")}`);
      if (result.kindsNotInLane.length > 0) console.log(`  kinds outside this lane's view: ${result.kindsNotInLane.join(", ")}`);
      return 0;
    }
  }
  throw new CliUsageError(`roles: unhandled sub-command "${args[0]}"`);
}

/** Lane status and context, plus lane sign-off/acknowledgement through the trusted human channel. */
export async function runRolesVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const moduleFlag = flagValue(rest, "--module");
  const args = positionalArgs(rest);
  if (rest.includes("--by") || rest.includes("--as")) {
    throw new CliUsageError(
      `roles: ${rest.includes("--by") ? "--by" : "--as"} is not an identity or chat reference — a lane decision needs the pending request and Controller-relayed chat fields`,
    );
  }
  if (args[0] === "approve") {
    throw new CliUsageError(
      "roles approve: an item becomes binding through its lane's sign-off — run `sta roles signoff <lane> --module <name>`",
    );
  }
  if (args[0] === "review") {
    throw new CliUsageError("roles review: trusted human decision channel is unavailable for item review; a status change is never authorized from the command line");
  }
  const act = DECISION_ACTS[args[0] ?? ""];
  if (act) return runLaneDecision(act, args, rest, projectRoot, moduleFlag);

  if (args[0] === "history") {
    if (!moduleFlag) throw new CliUsageError("roles history: --module <name> is required");
    const store = new SqliteTaskStore(flagValue(rest, "--state-db") ?? defaultStateDbPath(projectRoot));
    try {
      const root = canonicalKnowledgeRoot(flagValue(rest, "--knowledge-root") ?? projectRoot);
      const records = store.laneRequests(root, moduleFlag);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(records, null, 2));
      } else {
        console.log(`[orchestrator] ${records.length} lane request(s) for ${moduleFlag}:`);
        for (const record of records) {
          const items = record.scope.items.map((item) => `${item.id}@${item.version}:${item.digest}`).join(", ");
          const decision = record.decision;
          console.log(`  ${record.requestId} ${record.scope.lane} ${record.scope.action} ${record.status} [${items}]`);
          if (decision) console.log(`    ${decision.source.channel} ${decision.source.evidenceRef} ${describeHumanActor(decision.actor)} ${decision.decidedAt} ${decision.note ?? ""}`);
        }
      }
      return 0;
    } finally {
      store.close();
    }
  }

  const SUB_COMMANDS = ["inbox", "impact", "context", "history"];
  if (args.length > 0 && !SUB_COMMANDS.includes(args[0])) {
    throw new CliUsageError(`roles: unknown sub-command "${args[0]}" — one of signoff, ack, ${SUB_COMMANDS.join(", ")}`);
  }
  const store = new SqliteTaskStore(flagValue(rest, "--state-db") ?? defaultStateDbPath(projectRoot));
  try {
    const governed = loadGovernedKnowledge(flagValue(rest, "--knowledge-root") ?? projectRoot, store);
    const now = new Date().toISOString();
    if (args.length > 0) return await runRolesSubCommand(args, rest, projectRoot, moduleFlag, governed, now);

    // No --module shows every module that has knowledge in it, so a lane sitting behind
    // in a module the caller forgot about is still visible.
    const kb = governed.kb;
    const modules: (string | null)[] =
      moduleFlag !== undefined
        ? [moduleFlag]
        : [...new Set(kb.query({}).map((item) => item.module))].sort((a, b) =>
            a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0,
          );
    if (modules.length === 0) {
      console.log("[orchestrator] no knowledge captured yet — a lane has nothing to stand on.");
      return 0;
    }
    const refsOf = (items: Parameters<typeof laneItemRefs>[0]) => laneItemRefs(items, governed.root);
    for (const module of modules) {
      console.log(`\n${module ?? "(project-wide)"}`);
      const workspaces = laneWorkspaces(governed.recordsFor, governed.root, module, now);
      for (const lane of ROLE_LANES) {
        const view = laneView(workspaces(lane), kb);
        const spec = workflowFor(lane);
        const state = spec ? roleWorkflowState(spec, module, kb, workspaces, refsOf, staleSourcesAt(governed.root, now)) : null;

        // Two different questions, both printed: `stage` is where the lane's own
        // work has got to, `deps` is whether what it depends on moved under it.
        // A lane can be `ready` and `behind` at the same time.
        console.log(`  ${LANE_LABEL[lane].padEnd(4)} ${describeStage(state).padEnd(20)} deps: ${view.status}`);
        if (state) {
          console.log(`       next (${state.nextAction.actor}): ${state.nextAction.what}`);
          for (const carried of state.handoff.carries) console.log(`       carries: ${carried}`);
        }
        if (view.stale.length > 0) {
          console.log(`       changed since acknowledged: ${view.stale.map((s) => `${s.id} v${s.version}->v${s.currentVersion}`).join(", ")}`);
        }
        if (view.unseen.length > 0) console.log(`       never acknowledged: ${view.unseen.join(", ")}`);
        if (view.awaitingApproval.length > 0) console.log(`       waiting on the lane sign-off: ${view.awaitingApproval.join(", ")}`);
      }
      if (module !== null) {
        for (const pending of governed.recordsFor(module).filter((r) => r.status === "pending")) {
          const where = pending.publication ? ` — answer at ${pending.publication.url ?? pending.publication.ref}` : " — not announced yet";
          console.log(`  pending ${describeRequest(pending)}${where}`);
        }
      }
    }
    return 0;
  } finally {
    store.close();
  }
}
