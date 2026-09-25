/** Read-only lane inspection. Human decisions require a trusted channel (TASK-001). */
async function runRolesSubCommand(
  args: string[],
  rest: string[],
  projectRoot: string,
  moduleFlag: string | undefined,
  kb: KnowledgeBase,
  now: string,
): Promise<number> {
  const module = moduleFlag ?? null;
  const workspaces = workspacesUnder(projectRoot, module, now);
  const requireLane = (): RoleLane => {
    const lane = args[1];
    if (lane === undefined || !isRoleLane(lane)) {
      throw new CliUsageError(`roles ${args[0]}: a lane is required — one of ${ROLE_LANES.join(", ")}`);
    }
    return lane;
  };
  switch (args[0]) {
    case "inbox": {
      const lanes = args[1] !== undefined && isRoleLane(args[1]) ? [args[1] as RoleLane] : [...ROLE_LANES];
      let total = 0;
      for (const lane of lanes) {
        const notifications = notificationsFor(lane, module, kb, workspaces(lane));
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
      const lane = requireLane();
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
        console.log(`[orchestrator] ${id} as the ${LANE_LABEL[lane]} lane sees it (via ${viaRole}):`);
        console.log(`  ${item.title} [${item.kind}, ${item.status}, owned by ${item.owner}]`);
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

/** Read-only role lane status and context. Unauthenticated status writes fail closed. */
export async function runRolesVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const moduleFlag = flagValue(rest, "--module");
  const args = positionalArgs(rest);
  if (["ack", "signoff", "review", "approve"].includes(args[0] ?? "")) {
    throw new CliUsageError(`roles ${args[0]}: trusted human decision channel is unavailable; --by cannot authorize a status change`);
  }
  const SUB_COMMANDS = ["inbox", "impact", "context"];
  if (args.length > 0 && !SUB_COMMANDS.includes(args[0])) {
    throw new CliUsageError(`roles: unknown sub-command "${args[0]}" — one of ${SUB_COMMANDS.join(", ")}`);
  }
  const kb = KnowledgeBase.load(projectRoot);
  const now = new Date().toISOString();
  if (args.length > 0) return runRolesSubCommand(args, rest, projectRoot, moduleFlag, kb, now);
  if (args.length === 0) {
    // No --module shows every module that has knowledge in it, so a lane sitting behind
    // in a module the caller forgot about is still visible.
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
    for (const module of modules) {
      console.log(`\n${module ?? "(project-wide)"}`);
      const workspaces = workspacesUnder(projectRoot, module, now);
      for (const lane of ROLE_LANES) {
        const view = laneView(workspaces(lane), kb);
        const spec = workflowFor(lane);
        const state = spec ? roleWorkflowState(spec, module, kb, workspaces) : null;

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
        if (view.awaitingApproval.length > 0) console.log(`       waiting on a person: ${view.awaitingApproval.join(", ")}`);
      }
    }
    return 0;
  }

  throw new CliUsageError("roles: unhandled command");
}
import { CliUsageError } from "../../cli.js";
import { KnowledgeBase } from "../../knowledge/knowledgeBase.js";
import { KnowledgeContext } from "../../knowledge/knowledgeContext.js";
import { renderKnowledgeRetrieval } from "../../knowledge/retrievalRender.js";
import { LANE_LABEL, ROLE_LANES, isRoleLane, type RoleLane } from "../../roles/roleLane.js";
import { laneView } from "../../roles/roleWorkspace.js";
import { describeStage, roleWorkflowState, workflowFor, workspacesUnder } from "../../roles/roleWorkflow.js";
import { lanesAffectedBy, notificationsFor } from "../../roles/changePropagation.js";
import { laneContext, laneGet } from "../../roles/laneContext.js";
import { flagValue, positionalArgs } from "../support.js";
