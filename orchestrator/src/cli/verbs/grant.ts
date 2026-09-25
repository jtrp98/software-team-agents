import * as fs from "node:fs";
import { getAgent } from "../../agents/registry.js";
import { resolveAuthoritativeContract } from "../../agents/agentContract.js";
import { pathRulesFor } from "../../agents/pathPermissions.js";
import { resolveStackPathRules } from "../../profile/projectProfile.js";
import { loadTargetConfig } from "../../targetcli/targetMeta.js";
import {
  AttemptGrantRejectedError,
  AttemptGrantTokenSchema,
  ATTEMPT_GRANT_TOKEN_PATH,
  consumeAttemptGrant,
  issueAttemptGrant,
  loadOrCreateGrantKey,
  readAttemptGrantTokenFile,
  readGrantKey,
  verifyIssuedAttemptGrant,
  type GrantScope,
} from "../../governance/attemptGrant.js";
import { isAgentAssignedAt, isTaskDone } from "../../orchestrator/taskStatus.js";
import { AgentStage } from "../../types.js";
import { CliUsageError } from "../../cli.js";
import { flagValue, openStore, positionalArg, positionalArgs } from "../support.js";

/**
 * `sta grant issue|verify|consume` — V13 TASK-012, the STA-issued scoped
 * attempt grant for direct mode.
 *
 * `issue` is a dispatch decision, not a role claim: STA checks its own
 * workflow state (the requested stage is the one assigned right now), resolves
 * the authoritative contract, scopes the grant to what that contract and the
 * recorded stack layout allow, then signs and records the token. A session
 * holds the token; it never wrote the authority it carries.
 *
 * `verify` is the authoritative out-of-band check — signature, expiry and the
 * durable issuance record in the evidence store (a token the in-band hook
 * accepted but STA never issued answers `unknown-grant` here).
 *
 * `consume` spends a single-use grant: the consumption record is what makes a
 * replay answer `already-consumed` from the store, and the token file is
 * removed so the file channel closes with it.
 */

const DEFAULT_TTL_HOURS = 4;
const MAX_TTL_HOURS = 72;

export const GRANT_USAGE =
  "  sta grant issue <task-id> --stage <stage> [--ttl-hours <n>] [--project-root <path>] [--state-db <path>]   STA-issued scoped attempt grant for a direct-mode session\n" +
  "  sta grant verify [--file <path>] [--project-root <path>]   authoritative check against the evidence store (exit 1 when rejected)\n" +
  "  sta grant consume [--file <path>] [--project-root <path>]   spend a single-use grant; a replay is refused from the store\n";

function parseStage(value: string | undefined): AgentStage {
  if (!value) throw new CliUsageError("grant issue: --stage is required");
  const match = Object.values(AgentStage).find((stage) => stage === value);
  if (!match) {
    throw new CliUsageError(`grant issue: unknown stage "${value}" — use one of: ${Object.values(AgentStage).join(", ")}`);
  }
  return match;
}

function scopeFor(stage: AgentStage, role: string, projectRoot: string): GrantScope {
  // The same resolution the orchestrated path enforces: contract boundary plus
  // the stack layout this workspace recorded, kept as two halves so the hook
  // can apply the layout only to the grant's own role.
  const rules = pathRulesFor(stage, projectRoot);
  const stack = loadTargetConfig(projectRoot)?.stack;
  const layout = resolveStackPathRules({ role, projectRoot, profile: stack?.profile, sourceRoots: stack?.source_roots });
  return {
    write: [...rules.write],
    deny: [...rules.deny],
    stack: { write: [...layout.write], deny: [...layout.deny] },
  };
}

function readTokenFromOptions(projectRoot: string, file?: string) {
  if (file) {
    try {
      return AttemptGrantTokenSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (e) {
      throw new CliUsageError(`grant: cannot read a valid token from ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const token = readAttemptGrantTokenFile(projectRoot);
  if (!token) {
    throw new CliUsageError(`grant: no token at ${ATTEMPT_GRANT_TOKEN_PATH} under ${projectRoot} (pass --file to name one)`);
  }
  return token;
}

export async function runGrantVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const action = positionalArg(rest);
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const file = flagValue(rest, "--file");

  if (action === "issue") {
    // The task id is the positional after the action word (`sta grant issue <task-id>`).
    const taskId = positionalArgs(rest)[1];
    if (!taskId) throw new CliUsageError("grant issue: a task id is required");
    const stage = parseStage(flagValue(rest, "--stage"));
    const ttlHoursRaw = flagValue(rest, "--ttl-hours");
    const ttlHours = ttlHoursRaw === undefined ? DEFAULT_TTL_HOURS : Number(ttlHoursRaw);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
      throw new CliUsageError(`grant issue: --ttl-hours must be an integer between 1 and ${MAX_TTL_HOURS} (got ${ttlHoursRaw ?? "nothing"})`);
    }

    const { store } = openStore(projectRoot, stateDb);
    try {
      const task = store.loadTask(taskId);
      if (!task) throw new CliUsageError(`grant issue: task ${taskId} is not in this store`);
      if (task.cancelled) {
        console.error(`[orchestrator] refused: task ${taskId} is cancelled — no grant is issued.`);
        return 1;
      }
      if (isTaskDone(task)) {
        console.error(`[orchestrator] refused: task ${taskId} is Done — no grant is issued.`);
        return 1;
      }
      // The dispatch decision: STA grants exactly the stage its workflow state
      // assigns right now, under the contract that resolves for it. Anything
      // else is a self-serve role claim by another name.
      if (!isAgentAssignedAt(stage, task.machine.current, task.deployPrepared)) {
        console.error(
          `[orchestrator] refused: stage ${stage} is not the stage task ${taskId} assigns at state ${task.machine.current} — ` +
            "a grant follows the workflow, it does not pick a stage.",
        );
        return 1;
      }
      let contractDigest: string;
      try {
        contractDigest = resolveAuthoritativeContract(stage, projectRoot).digest;
      } catch (e) {
        throw new CliUsageError(`grant issue: the contract for ${stage} does not resolve: ${e instanceof Error ? e.message : String(e)}`);
      }
      const role = getAgent(stage).role;
      const now = Date.now();
      const { token, tokenPath } = issueAttemptGrant(store, {
        stateRoot: projectRoot,
        taskId,
        stage,
        role,
        contractDigest,
        scope: scopeFor(stage, role, projectRoot),
        ttlMs: ttlHours * 3_600_000,
        now,
      });
      console.log(`[orchestrator] attempt grant ${token.grant_id} issued: role=${token.role} task=${token.task_id} expires=${token.expires_at}`);
      console.log(`[orchestrator]   token: ${tokenPath} (the session reads it; the per-role layer applies while it is valid and unconsumed)`);
      console.log(`[orchestrator]   spend it with \`sta grant consume --file ${tokenPath}\` when the attempt is done.`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (action === "verify" || action === "consume") {
    const { store } = openStore(projectRoot, stateDb);
    try {
      const token = readTokenFromOptions(projectRoot, file);
      const keyHex = readGrantKey(projectRoot) ?? loadOrCreateGrantKey(projectRoot);
      const now = Date.now();
      if (action === "verify") {
        const result = verifyIssuedAttemptGrant(store, token, { keyHex, now });
        if (!result.ok) {
          console.error(`[orchestrator] refused: ${result.code} — ${result.reason}`);
          return 1;
        }
        console.log(`[orchestrator] ${result.grant.grant_id} verifies: role=${result.grant.role} task=${result.grant.task_id} contract=${result.grant.contract_digest.slice(0, 12)}… expires=${result.grant.expires_at}`);
        return 0;
      }
      try {
        const { grant } = consumeAttemptGrant(store, token, { keyHex, now, grantRoot: projectRoot });
        console.log(`[orchestrator] consumed ${grant.grant_id} — the token file is removed and the grant cannot be presented again.`);
        return 0;
      } catch (e) {
        if (e instanceof AttemptGrantRejectedError) {
          console.error(`[orchestrator] refused: ${e.message}`);
          return 1;
        }
        throw e;
      }
    } finally {
      store.close();
    }
  }

  throw new CliUsageError(`grant: unknown action ${action ?? "(none)"} — use issue, verify or consume`);
}
