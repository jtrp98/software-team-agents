/**
 * The `roles` sub-commands that are not `ack`, split out so `runRolesVerb` stays
 * the readable "show me the lanes" path it started as (T103-T107).
 *
 * Every writing one takes `--by`, and every one of them writes something only a
 * person may write. That is not politeness: `knowledge/_roles/**` is denied to
 * every agent at the tool level, and `approve` goes through `applyTransition`,
 * which refuses any actor but a person.
 */
async function runRolesSubCommand(
  args: string[],
  rest: string[],
  projectRoot: string,
  moduleFlag: string | undefined,
  kb: KnowledgeBase,
  now: string,
): Promise<number> {
  const module = moduleFlag ?? null;
  const by = flagValue(rest, "--by");
  const workspaces = workspacesUnder(projectRoot, module, now);

  const requireLane = (): RoleLane => {
    const lane = args[1];
    if (lane === undefined || !isRoleLane(lane)) {
      throw new CliUsageError(`roles ${args[0]}: a lane is required — one of ${ROLE_LANES.join(", ")}`);
    }
    return lane;
  };
  const requireBy = (): string => {
    if (by === undefined) throw new CliUsageError(`roles ${args[0]}: --by <name> is required — this is a person's decision`);
    return by;
  };

  switch (args[0]) {
    case "signoff": {
      const lane = requireLane();
      const signer = requireBy();
      const spec = workflowFor(lane);
      if (!spec) throw new CliUsageError(`roles signoff: no lane workflow is defined for ${lane}`);

      const state = roleWorkflowState(spec, module, kb, workspaces);
      const approved = kb.query({ module }).filter((item) => state.approved.includes(item.id));
      // Dogfood F3: project-wide scope (no --module) sees nothing when the lane's
      // approved work sits in modules. Say which, instead of the misleading
      // "nothing approved" that contradicts what `sta roles` just displayed.
      if (module === null && approved.length === 0) {
        const withApproved = [...new Set(kb.query({}).filter((i) => i.status === "approved").map((i) => i.module ?? "(project-wide)"))];
        if (withApproved.length > 0) {
          throw new CliUsageError(
            `roles signoff: nothing is approved at project-wide scope; approved items live in module(s): ${withApproved.join(", ")} — add --module <name>`,
          );
        }
      }
      const reject = rest.includes("--reject");

      // Refusing to sign off over a blocker is the whole point of having one: a
      // person waving through work already known to be unusable spends the single
      // step in this pipeline that cannot be redone cheaply.
      if (!reject && state.handoff.blockers.length > 0) {
        console.error(`[orchestrator] the ${LANE_LABEL[lane]} lane cannot be signed off while these stand:`);
        for (const blocker of state.handoff.blockers) console.error(`  - ${blocker}`);
        return 1;
      }

      try {
        const updated = recordSignoff(workspaces(lane), {
          approved,
          approve: !reject,
          by: signer,
          note: flagValue(rest, "--note"),
          now,
        });
        writeRoleWorkspace(updated, projectRoot);
      } catch (e) {
        console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }

      console.log(
        `[orchestrator] ${LANE_LABEL[lane]} on ${module ?? "(project-wide)"}: ${signer} ` +
          `${reject ? "rejected" : "signed off"} ${state.approved.join(", ")}.`,
      );
      for (const carried of state.handoff.carries) console.log(`[orchestrator] carries: ${carried}`);
      return 0;
    }

    case "review": {
      // One id-list token: commas separate items, exactly like `roles ack`'s.
      // Extra positional tokens are ignored rather than mistaken for more ids —
      // unknown value-flags must never turn their values into item names.
      const ids = (args[1] ?? "").split(",").filter((a) => a !== "");
      const as = flagValue(rest, "--as");
      if (ids.length === 0) throw new CliUsageError("roles review: an item id is required");
      if (!as) throw new CliUsageError("roles review: --as <agent> is required — a review's content is which discipline looked");
      if (!Object.values(AgentStage).includes(as as AgentStage)) {
        throw new CliUsageError(`roles review: "${as}" is not an agent role`);
      }
      for (const id of ids) {
        const item = kb.get(id);
        if (!item) {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        try {
          writeKnowledgeItem(reviewItem(item, as as AgentStage, now), projectRoot);
        } catch (e) {
          console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
        console.log(`[orchestrator] ${id} reviewed as ${as}. It confirmed:`);
        for (const line of checklistFor(item.kind)) console.log(`  - ${line}`);
      }
      return 0;
    }

    case "approve": {
      const ids = (args[1] ?? "").split(",").filter((a) => a !== "");
      const approver = requireBy();
      if (ids.length === 0) throw new CliUsageError("roles approve: an item id is required");
      for (const id of ids) {
        const item = kb.get(id);
        if (!item) {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        try {
          writeKnowledgeItem(approveItem(item, now), projectRoot);
        } catch (e) {
          console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
        // The approver's name is not written into the item on purpose — see
        // artifactReview.ts. It is echoed so the person sees their own act recorded
        // in the terminal, and git carries the rest.
        console.log(`[orchestrator] ${id} approved by ${approver}. It is binding now; downstream lanes may rely on it.`);
      }
      return 0;
    }

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

/**
 * `roles [--module <name>]` — where each lane stands, and
 * `roles ack <lane> <id>[,<id>...] --by <name>` — record that a person in that lane has
 * seen the current version of those items (T99).
 *
 * This verb is the *only* writer of a role workspace. `knowledge/_roles/**` is in
 * `UNIVERSAL_DENY`, so no agent can write one in any mode — an acknowledgement is a human
 * act, and an agent able to record one could mark its own work seen on a person's behalf.
 * `--by` is required for the same reason: the file has to say who.
 */
export async function runRolesVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const moduleFlag = flagValue(rest, "--module");
  const args = positionalArgs(rest);
  const kb = KnowledgeBase.load(projectRoot);
  const now = new Date().toISOString();

  const SUB_COMMANDS = ["ack", "signoff", "review", "approve", "inbox", "impact", "context"];
  if (args.length > 0 && !SUB_COMMANDS.includes(args[0])) {
    throw new CliUsageError(`roles: unknown sub-command "${args[0]}" — one of ${SUB_COMMANDS.join(", ")}`);
  }
  if (args.length > 0 && args[0] !== "ack") {
    return runRolesSubCommand(args, rest, projectRoot, moduleFlag, kb, now);
  }

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
        // work has got to (T100), `deps` is whether what it depends on moved
        // under it (T99). A lane can be `ready` and `behind` at the same time.
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

  const lane = args[1];
  if (lane === undefined || !isRoleLane(lane)) {
    throw new CliUsageError(`roles ack: a lane is required — one of ${ROLE_LANES.join(", ")}`);
  }
  const ids = args.slice(2).flatMap((a) => a.split(",")).filter((a) => a !== "");
  const by = flagValue(rest, "--by");
  if (by === undefined) {
    throw new CliUsageError("roles ack: --by <name> is required — an acknowledgement records who made it");
  }

  const module = moduleFlag ?? null;
  try {
    const updated = acknowledge(loadRoleWorkspace(lane, module, projectRoot, now), kb, ids, by, now);
    writeRoleWorkspace(updated, projectRoot);
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(
    `[orchestrator] ${LANE_LABEL[lane]} on ${module ?? "(project-wide)"}: ${by} acknowledged ${ids.join(", ")}.`,
  );
  return 0;
}
import { AgentStage } from "../../types.js";
import { CliUsageError } from "../../cli.js";
import { KnowledgeBase } from "../../knowledge/knowledgeBase.js";
import { KnowledgeContext } from "../../knowledge/knowledgeContext.js";
import { renderKnowledgeRetrieval } from "../../knowledge/retrievalRender.js";
import { writeKnowledgeItem } from "../../knowledge/knowledgeStore.js";
import { LANE_LABEL, ROLE_LANES, isRoleLane, type RoleLane } from "../../roles/roleLane.js";
import { acknowledge, laneView, loadRoleWorkspace, writeRoleWorkspace } from "../../roles/roleWorkspace.js";
import { describeStage, roleWorkflowState, workflowFor, workspacesUnder } from "../../roles/roleWorkflow.js";
import { recordSignoff } from "../../roles/roleApproval.js";
import { approveItem, checklistFor, reviewItem } from "../../roles/artifactReview.js";
import { lanesAffectedBy, notificationsFor } from "../../roles/changePropagation.js";
import { laneContext, laneGet } from "../../roles/laneContext.js";
import { flagValue, positionalArgs } from "../support.js";
