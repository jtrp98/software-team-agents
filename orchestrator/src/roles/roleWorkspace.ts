import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { ApprovalType } from "../gates/approval.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import { type StaleReference, staleReferences } from "../knowledge/knowledgeHistory.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { LANE_LABEL, type RoleLane, ROLE_LANES, isRoleLane, laneOf } from "./roleLane.js";

/**
 * The role workspace — where one lane stands in the shared knowledge base, so
 * BA, SA and DEV can work independently against one set of facts instead of
 * three copies of them.
 *
 * It holds exactly one field, `seen`: a watermark of which version of which
 * item the person in this lane has acknowledged. That is the only thing here
 * that cannot be worked out from `knowledge/` itself — everything else a
 * caller wants is derived (`laneView()`): what the lane is drafting, what
 * moved under it since it last looked, what it depends on and has never
 * acknowledged at all. Conflicts are re-detected every run rather than
 * stored, because a stored list keeps escalating things somebody already
 * fixed; only the *decision* is kept. A change notification is the same
 * shape of thing — it stops being true the moment the reader catches up —
 * so the notification is derived and only the acknowledgement is stored.
 *
 * The consequence that matters most: because the inbox is derived from the
 * *reader's* watermark, nothing ever writes into another lane's file. BA
 * amending REQ-003 does not notify DEV; DEV notices, because DEV's own
 * recorded version of REQ-003 no longer matches. So "no lane writes another
 * lane's workspace" costs nothing to enforce, and "every affected lane is
 * told, not just some of them" is a property of the arithmetic rather than a
 * discipline someone has to keep.
 *
 * Nothing here advances `seen` on its own: `acknowledge()` is the only
 * writer, it requires a person's name, and it takes the version from the
 * knowledge base rather than from the caller — you acknowledge what is
 * actually in front of you, not a number you supply. If retrieval advanced
 * the watermark, every notification would be marked read before anyone had
 * seen it, which is the failure this whole file exists to prevent. Agents
 * are kept out of it at a lower level too: `knowledge/_roles/**` is in
 * `UNIVERSAL_DENY`, so no agent can write one of these files in any mode,
 * with or without a contract. The writer is a person, through the CLI.
 */

export const ROLE_WORKSPACE_SCHEMA_VERSION = 1;

/** Reserved directory under `knowledge/`, alongside `_sources`/`_conflicts`/`_bootstrap`. */
export const ROLES_DIRNAME = "_roles";

/** Folder for a lane working project-wide (`module: null`) — the same convention `relativePathFor()` uses for items. */
export const PROJECT_WIDE_DIR = "_project";

/** A recorded "the person in this lane has seen version N of item X". */
export interface SeenRef {
  id: string;
  version: number;
  at: string;
  /** A person's name. Free text, like an approval's `decidedBy`. */
  by: string;
}

/** One `{id, version}` a sign-off covered. */
export interface SignoffItemRef {
  id: string;
  version: number;
}

/** The person in this lane answering their own gate — see `roleApproval.ts` for the rules. */
export interface LaneSignoff {
  type: ApprovalType;
  status: "approved" | "rejected";
  items: SignoffItemRef[];
  at: string;
  by: string;
  note: string | null;
}

export interface RoleWorkspace {
  schema_version: number;
  lane: RoleLane;
  module: string | null;
  seen: SeenRef[];
  /** Optional so an older file still loads; absent and `[]` mean the same thing. */
  signoffs?: LaneSignoff[];
  updated_at: string;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "role-workspace.schema.json",
);

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

export class RoleWorkspaceError extends Error {
  constructor(
    public readonly label: string,
    public readonly issues: string[],
  ) {
    super(`${label} is not a usable role workspace:\n- ${issues.join("\n- ")}`);
    this.name = "RoleWorkspaceError";
  }
}

export function rolesDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(knowledgeDir(projectRoot), ROLES_DIRNAME);
}

/** The one path a lane's file may live at, derived from the lane and module themselves. */
export function relativePathForWorkspace(lane: RoleLane, module: string | null): string {
  return `${ROLES_DIRNAME}/${module ?? PROJECT_WIDE_DIR}/${lane}.yaml`;
}

export function roleWorkspacePath(
  lane: RoleLane,
  module: string | null,
  projectRoot: string = defaultProjectRoot(),
): string {
  return path.join(knowledgeDir(projectRoot), ...relativePathForWorkspace(lane, module).split("/"));
}

/** A lane that has never acknowledged anything. Absence of the file and this value mean the same thing, on purpose — a lane does not have to be created before it can be read. */
export function emptyWorkspace(lane: RoleLane, module: string | null, now: string): RoleWorkspace {
  return { schema_version: ROLE_WORKSPACE_SCHEMA_VERSION, lane, module, seen: [], updated_at: now };
}

function parseWorkspace(data: unknown, label: string): RoleWorkspace {
  const validate = validator();
  if (!validate(data)) {
    throw new RoleWorkspaceError(
      label,
      (validate.errors ?? []).map((e) => {
        const where = e.instancePath || "(root)";
        const what = e.message ?? "is invalid";
        const extra = e.params as Record<string, unknown> | undefined;
        if (typeof extra?.additionalProperty === "string") return `${where} ${what}: "${extra.additionalProperty}"`;
        if (Array.isArray(extra?.allowedValues)) {
          return `${where} ${what}: ${(extra.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
        }
        return `${where} ${what}`;
      }),
    );
  }

  const workspace = data as RoleWorkspace;

  // One id, one watermark. Two entries for the same item means one of them is
  // being ignored, and which one depends on iteration order — so it is rejected
  // rather than resolved by a rule nobody would remember.
  const seenIds = new Set<string>();
  const duplicates: string[] = [];
  for (const ref of workspace.seen) {
    if (seenIds.has(ref.id)) duplicates.push(ref.id);
    seenIds.add(ref.id);
  }
  if (duplicates.length > 0) {
    throw new RoleWorkspaceError(label, [
      `acknowledges ${[...new Set(duplicates)].join(", ")} more than once — an item has one watermark`,
    ]);
  }

  return workspace;
}

/** Reads one lane's file, or throws. A half-understood watermark is worse than none: it decides what a person is told about. */
export function readRoleWorkspaceFile(filePath: string, label = filePath): RoleWorkspace {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new RoleWorkspaceError(label, [`no file at ${filePath}`]);
  }

  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(raw)) {
    throw new RoleWorkspaceError(label, [
      "contains an unresolved git conflict marker — two people's acknowledgements have not been merged yet",
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new RoleWorkspaceError(label, [`is not valid YAML: ${(e as Error).message}`]);
  }

  return parseWorkspace(parsed, label);
}

/** One lane's workspace, or an empty one when it has never been written. */
export function loadRoleWorkspace(
  lane: RoleLane,
  module: string | null,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): RoleWorkspace {
  const filePath = roleWorkspacePath(lane, module, projectRoot);
  if (!fs.existsSync(filePath)) return emptyWorkspace(lane, module, now);
  return readRoleWorkspaceFile(filePath, relativePathForWorkspace(lane, module));
}

/** Every `_roles/<module>/<lane>.yaml` in the project, as paths relative to `knowledge/`, sorted. */
export function listRoleWorkspaceFiles(projectRoot: string = defaultProjectRoot()): string[] {
  const root = rolesDir(projectRoot);
  const found: string[] = [];

  let moduleDirs: fs.Dirent[];
  try {
    moduleDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const moduleDir of moduleDirs) {
    if (!moduleDir.isDirectory()) {
      found.push(`${ROLES_DIRNAME}/${moduleDir.name}`);
      continue;
    }
    for (const entry of fs.readdirSync(path.join(root, moduleDir.name), { withFileTypes: true })) {
      found.push(`${ROLES_DIRNAME}/${moduleDir.name}/${entry.name}`);
    }
  }

  return found.sort();
}

function orderedForYaml(workspace: RoleWorkspace): Record<string, unknown> {
  return {
    schema_version: workspace.schema_version,
    lane: workspace.lane,
    module: workspace.module,
    updated_at: workspace.updated_at,
    seen: workspace.seen,
    // Omitted entirely rather than written as `[]`, so a lane that has never been
    // signed off produces the same file it did before this field was added.
    ...(workspace.signoffs && workspace.signoffs.length > 0 ? { signoffs: workspace.signoffs } : {}),
  };
}

export function renderRoleWorkspace(workspace: RoleWorkspace): string {
  return stringifyYaml(orderedForYaml(workspace), { lineWidth: 0 });
}

/**
 * Writes a lane's file to the one path it belongs at.
 *
 * No version-conflict check, unlike `writeKnowledgeItem`. One file belongs to
 * one lane in one module, so two concurrent edits are two people acting as the
 * same lane — a case git's own merge on a short list of `{id, version}` entries
 * handles better than a rejection would, and one where losing an
 * acknowledgement is recoverable by acknowledging again.
 */
export function writeRoleWorkspace(workspace: RoleWorkspace, projectRoot: string = defaultProjectRoot()): string {
  parseWorkspace(workspace, relativePathForWorkspace(workspace.lane, workspace.module));
  const filePath = roleWorkspacePath(workspace.lane, workspace.module, projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderRoleWorkspace(workspace), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export class AcknowledgementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcknowledgementError";
  }
}

/**
 * Records that a person in this lane has seen the current version of each id.
 *
 * Three things it refuses, each of which would otherwise make the watermark lie:
 *
 *   - **An empty `by`.** An acknowledgement is a human act; one with nobody
 *     attached is an agent marking work seen on a person's behalf, which this
 *     mechanism exists to prevent.
 *   - **An unknown id.** A watermark for an item that does not exist can never
 *     be compared against anything, so it silently drops out of every report.
 *   - **Nothing to acknowledge.** An empty call would bump `updated_at` and
 *     record a person having done something they did not do.
 *
 * The version is read from the knowledge base rather than passed in: you
 * acknowledge what is actually there. A caller supplying its own number could
 * record having seen a version that never existed, and `staleReferences()`
 * would then report `ahead` — correctly, but about a mistake made here.
 */
export function acknowledge(
  workspace: RoleWorkspace,
  kb: KnowledgeBase,
  ids: string[],
  by: string,
  now: string,
): RoleWorkspace {
  if (by.trim() === "") {
    throw new AcknowledgementError(
      "an acknowledgement needs the name of the person making it — the watermark records a human act, not an automatic one",
    );
  }
  if (ids.length === 0) {
    throw new AcknowledgementError("nothing to acknowledge — name at least one item id");
  }

  const unknown = ids.filter((id) => kb.get(id) === null);
  if (unknown.length > 0) {
    throw new AcknowledgementError(
      `no knowledge item with id ${unknown.join(", ")} — a watermark for an item that does not exist can never be checked against anything`,
    );
  }

  const byId = new Map(workspace.seen.map((ref) => [ref.id, ref]));
  for (const id of ids) {
    // Non-null: every id was resolved above.
    const item = kb.get(id) as KnowledgeItem;
    byId.set(id, { id, version: item.version, at: now, by });
  }

  return {
    ...workspace,
    // Sorted by id so two people acknowledging different items produce a diff
    // git can merge, instead of two rewrites of the same reordered list.
    seen: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    updated_at: now,
  };
}

/**
 * Whether this lane is working from current facts.
 *
 * Only two values, and deliberately not four. The first version of this had
 * `idle`/`drafting`/`awaiting-approval` here too — which is where the lane's own
 * work sits on the draft/reviewed/approved path, and that is
 * `RoleWorkflowStage`'s question (`roleWorkflow.ts`). Two vocabularies
 * answering overlapping questions print as `BA drafting [drafting]` and
 * diverge the first time one is edited, so this one shrank to the half only
 * it can answer: has anything this lane depends on moved since the person in
 * it last looked. `active` and `awaitingApproval` stay below as data — it is
 * the single-word verdict that had two owners.
 */
export type LaneStatus = "up-to-date" | "behind";

export interface LaneView {
  lane: RoleLane;
  module: string | null;
  status: LaneStatus;
  /** Items this lane owns that are still open (`draft` or `reviewed`). Derived — no `active` field is stored. */
  active: string[];
  /** Items this lane owns that only a person can now move on. */
  awaitingApproval: string[];
  /** Cross-lane dependencies whose acknowledged version is no longer current. Feeds change propagation. */
  stale: StaleReference[];
  /** Cross-lane dependencies never acknowledged at all — so an empty `seen` does not read as "nothing to do". */
  unseen: string[];
  /**
   * Acknowledged ids that nothing this lane owns points at. Reported, never
   * auto-removed — and deliberately not called "safe to drop", because there are
   * two ways to get here and only one of them is leftover bookkeeping. The other
   * is a handoff the lane accepted before writing anything that cites it, which
   * is the normal state right after `roles ack`.
   */
  orphanedSeen: string[];
}

/**
 * What this lane depends on: the items its own items point at, that another
 * lane owns.
 *
 * Deliberately narrow. "Which knowledge might matter to DEV" is a question with
 * an expansive answer (`impactOf` sharpens it further), but the answer that
 * is certainly right and cheap is the one the lane has already written down: a
 * task that `implements` an API declares a dependency on that API, in the
 * knowledge graph, by the lane that owns the task. Items this lane owns itself
 * are excluded — a lane does not acknowledge its own work, it does it.
 */
export function dependenciesOf(lane: RoleLane, module: string | null, kb: KnowledgeBase): string[] {
  const owned = kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
  const deps = new Set<string>();

  for (const item of owned) {
    for (const relation of item.relations) {
      const target = kb.get(relation.to);
      if (!target) continue;
      const targetLane = laneOf(target.owner);
      if (targetLane === null || targetLane === lane) continue;
      deps.add(target.id);
    }
  }

  return [...deps].sort();
}

/** Everything about a lane that is computed rather than stored. */
export function laneView(workspace: RoleWorkspace, kb: KnowledgeBase): LaneView {
  const { lane, module } = workspace;

  const owned = kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
  const active = owned.filter((i) => i.status === "draft" || i.status === "reviewed").map((i) => i.id).sort();
  const awaitingApproval = owned.filter((i) => i.status === "reviewed").map((i) => i.id).sort();

  const deps = dependenciesOf(lane, module, kb);
  const depSet = new Set(deps);
  const seenById = new Map(workspace.seen.map((ref) => [ref.id, ref]));

  // Only dependencies are compared. An acknowledgement of something that is no
  // longer a dependency is bookkeeping to tidy, not a change to report.
  const stale = staleReferences(
    deps.filter((id) => seenById.has(id)).map((id) => seenById.get(id) as SeenRef),
    kb.query({}),
  );
  const unseen = deps.filter((id) => !seenById.has(id));
  const orphanedSeen = workspace.seen.filter((ref) => !depSet.has(ref.id)).map((ref) => ref.id).sort();

  const status: LaneStatus = stale.length > 0 || unseen.length > 0 ? "behind" : "up-to-date";

  return { lane, module, status, active, awaitingApproval, stale, unseen, orphanedSeen };
}

export interface RoleWorkspaceCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** The module name a `_roles/<dir>/` folder stands for. `_project` is the null module, not a module called "_project". */
function moduleOfDir(dirName: string): string | null {
  return dirName === PROJECT_WIDE_DIR ? null : dirName;
}

/**
 * What `--check-roles` runs. No `_roles/` at all is a note, not a problem —
 * most projects have not opened a lane yet, the same reading `--check-knowledge`
 * gives a repo with nothing captured.
 *
 * A `seen` entry pointing at a missing item, or claiming a version the item
 * never reached, is a problem: both mean the watermark is being compared
 * against something that is not what it thinks it is, and a comparison that
 * cannot be made is silently dropped from every report. An entry that is merely
 * no longer a dependency is a note — the file is untidy, not wrong.
 */
export function checkRoleWorkspaces(projectRoot: string = defaultProjectRoot()): RoleWorkspaceCheckResult {
  const root = rolesDir(projectRoot);
  if (!fs.existsSync(root)) {
    return {
      ok: true,
      problems: [],
      notes: [`no knowledge/${ROLES_DIRNAME}/ — no role workspace has been opened yet.`],
    };
  }

  const problems: string[] = [];
  const notes: string[] = [];
  const workspaces: RoleWorkspace[] = [];

  for (const rel of listRoleWorkspaceFiles(projectRoot)) {
    const parts = rel.split("/");
    if (parts.length !== 3) {
      problems.push(
        `knowledge/${rel}: everything under ${ROLES_DIRNAME}/ is a <module>/<lane>.yaml — ` +
          `a loose file there belongs to no lane and is read by nothing`,
      );
      continue;
    }

    const [, dirName, fileName] = parts;
    if (!fileName.endsWith(".yaml") || !isRoleLane(fileName.slice(0, -".yaml".length))) {
      problems.push(
        `knowledge/${rel}: "${fileName}" is not one of ${ROLE_LANES.map((l) => `${l}.yaml`).join(", ")}`,
      );
      continue;
    }

    const lane = fileName.slice(0, -".yaml".length) as RoleLane;
    const module = moduleOfDir(dirName);

    let workspace: RoleWorkspace;
    try {
      workspace = readRoleWorkspaceFile(path.join(knowledgeDir(projectRoot), ...parts), rel);
    } catch (e) {
      problems.push(e instanceof RoleWorkspaceError ? e.message : `knowledge/${rel}: ${String(e)}`);
      continue;
    }

    // The filename is the identity, the same rule knowledgeStore.ts applies to
    // items: a file that disagrees with its own path is findable by a walk and
    // by nothing else, so every lookup by (lane, module) would miss it.
    const expected = relativePathForWorkspace(workspace.lane, workspace.module);
    if (expected !== rel) {
      problems.push(
        `knowledge/${rel}: declares lane "${workspace.lane}" and module ` +
          `${workspace.module === null ? "(project-wide)" : `"${workspace.module}"`}, so it belongs at knowledge/${expected}`,
      );
      continue;
    }
    // Unreachable while the path check above holds, but stated rather than
    // assumed: these two are read from different places and must agree.
    if (workspace.lane !== lane || workspace.module !== module) continue;

    workspaces.push(workspace);
  }

  const loaded = KnowledgeBase.load(projectRoot);
  const items = loaded.query({});

  for (const workspace of workspaces) {
    const where = `knowledge/${relativePathForWorkspace(workspace.lane, workspace.module)}`;

    for (const bad of staleReferences(workspace.seen, items)) {
      if (bad.reason === "missing") {
        problems.push(
          `${where}: acknowledges ${bad.id}, which no longer exists — remove the entry, or restore the item it refers to`,
        );
      } else if (bad.reason === "ahead") {
        problems.push(
          `${where}: acknowledges ${bad.id} v${bad.version} but that item has only reached v${bad.currentVersion} — ` +
            "the two are not talking about the same item",
        );
      }
    }

    const view = laneView(workspace, loaded);
    if (view.orphanedSeen.length > 0) {
      notes.push(
        `${where}: acknowledges ${view.orphanedSeen.join(", ")}, which nothing this lane owns points at — either it was ` +
          "handed over before this lane wrote anything citing it, or the acknowledgement is left over from work that moved",
      );
    }
    if (view.stale.length > 0 || view.unseen.length > 0) {
      notes.push(
        `${LANE_LABEL[workspace.lane]} on ${workspace.module ?? "(project-wide)"} is behind: ` +
          `${view.stale.length} changed, ${view.unseen.length} never acknowledged`,
      );
    }
  }

  if (workspaces.length === 0 && problems.length === 0) {
    notes.push(`knowledge/${ROLES_DIRNAME}/ exists but holds no lane file yet.`);
  }

  return { ok: problems.length === 0, problems, notes };
}
