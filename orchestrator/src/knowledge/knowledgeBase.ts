import { AgentStage } from "../types.js";
import {
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeStatus,
  type Relation,
  type RelationType,
  checkKnowledgeItem,
  describeRelationRule,
  isRelationLegal,
} from "./knowledgeModel.js";
import { loadKnowledge } from "./knowledgeStore.js";
import { SourceRegistry, crossCheckRegistry, loadSourceRegistry } from "./sourceRegistry.js";
import { loadResolutions, reportConflicts } from "./knowledgeConflicts.js";
import { checkKnowledgePolicyFile } from "./knowledgePolicy.js";
import { checkOwnership, deprecatedStillDependedOn } from "./ownership.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { readBootstrapState } from "../bootstrap/bootstrapStore.js";
import { loadTargetRegistry } from "../threeRepo/targets.js";

/**
 * The single entry point every agent asks the project knowledge through.
 *
 * `query()` takes one filter for all nine kinds rather than nine per-kind
 * finders, and the graph methods walk relations without caring what the two
 * ends are. That is the whole point of the single envelope: "which tests
 * verify the tasks that implement this requirement" is one traversal here, and
 * would be a join each caller wrote for itself under a per-kind split.
 *
 * The reverse index is built here, in memory, from the outgoing edges the files
 * store — the same arrangement `TaskGraph` uses. Writing both directions to
 * disk would be one fact recorded twice, and a merge that updated only one of
 * them would leave the graph quietly wrong.
 */

export interface KnowledgeQuery {
  kinds?: KnowledgeKind[];
  /** Current bound Target ids. Scoped items must intersect; [] means only global items. Undefined preserves legacy unscoped retrieval. */
  target_ids?: string[];
  /**
   * `null` selects project-wide items specifically. `undefined` — whether the
   * key is absent or explicitly set — means "do not filter on this", so passing
   * a `string | undefined` variable straight through widens the query instead of
   * emptying it.
   */
  repo?: string | null;
  module?: string | null;
  owner?: AgentStage;
  status?: KnowledgeStatus | KnowledgeStatus[];
  sensitive?: boolean;
  /** Case-insensitive substring over id, title and body. */
  text?: string;
}

export interface TraverseOptions {
  types?: RelationType[];
  direction: "outgoing" | "incoming" | "both";
  /** Default 1 — one hop. Depth is capped because a knowledge graph has cycles by design (conflicts-with, references). */
  maxDepth?: number;
}

export interface KnowledgeChain {
  requirement: KnowledgeItem;
  architecture: KnowledgeItem[];
  apis: KnowledgeItem[];
  dbModels: KnowledgeItem[];
  tasks: KnowledgeItem[];
  tests: KnowledgeItem[];
}

export interface KnowledgeCheckResult {
  ok: boolean;
  problems: string[];
}

interface IncomingEdge {
  from: KnowledgeItem;
  relation: Relation;
}

export class KnowledgeBase {
  private readonly byId = new Map<string, KnowledgeItem>();
  private readonly byQualifiedId = new Map<string, KnowledgeItem>();
  private readonly bareMatches = new Map<string, KnowledgeItem[]>();
  private readonly incomingIndex = new Map<string, IncomingEdge[]>();
  readonly items: KnowledgeItem[];

  /**
   * @param loadProblems problems produced while reading the files (unparseable
   * YAML, duplicate ids, a file in the wrong folder). Carried rather than
   * thrown so `check()` reports the whole picture: an item missing because its
   * file would not parse and an item that was never written look identical to
   * a query, and only one of them is a real gap.
   */
  constructor(
    items: KnowledgeItem[],
    private readonly loadProblems: string[] = [],
  ) {
    this.items = items;
    for (const item of items) {
      // Duplicate ids are reported by the loader; last one wins here so a
      // constructed base is never left with a half-built index.
      this.byId.set(item.id, item);
      this.byQualifiedId.set(qualifiedKnowledgeId(item), item);
      this.bareMatches.set(item.id, [...(this.bareMatches.get(item.id) ?? []), item]);
    }
    for (const item of items) {
      for (const relation of item.relations) {
        const list = this.incomingIndex.get(relation.to) ?? [];
        list.push({ from: item, relation });
        this.incomingIndex.set(relation.to, list);
      }
    }
  }

  static load(projectRoot: string = defaultProjectRoot()): KnowledgeBase {
    const { items, problems } = loadKnowledge(projectRoot);
    return new KnowledgeBase(items, problems);
  }

  get(id: string): KnowledgeItem | null {
    if (id.includes("/")) return this.byQualifiedId.get(id) ?? null;
    const matches = this.bareMatches.get(id) ?? [];
    return matches.length === 1 ? matches[0] : null;
  }

  resolve(id: string, module: string | null): KnowledgeItem | null {
    if (id.includes("/")) return this.byQualifiedId.get(id) ?? null;
    const matches = this.bareMatches.get(id) ?? [];
    const local = matches.filter((item) => item.module === module);
    return local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : null;
  }

  query(filter: KnowledgeQuery = {}): KnowledgeItem[] {
    const statuses = filter.status === undefined ? undefined : ([] as KnowledgeStatus[]).concat(filter.status);
    const text = filter.text?.toLowerCase();

    return this.items.filter((item) => {
      if (filter.kinds && !filter.kinds.includes(item.kind)) return false;
      // `undefined` is "no filter" even when the key is present. Keying off
      // `"repo" in filter` instead made `query({ module: maybeUndefined })`
      // return nothing at all from a base holding everything — a silent empty
      // result at any call site that forwards an optional value, which is most
      // of them. `null` still means project-wide, which is why this cannot just
      // be a truthiness check.
      if (filter.repo !== undefined && item.repo !== filter.repo) return false;
      if (filter.module !== undefined && item.module !== filter.module) return false;
      if (filter.target_ids !== undefined) {
        const scope = item.target_ids ?? [];
        if (scope.length > 0 && !scope.some((targetId) => filter.target_ids!.includes(targetId))) return false;
      }
      if (filter.owner !== undefined && item.owner !== filter.owner) return false;
      if (statuses && !statuses.includes(item.status)) return false;
      if (filter.sensitive !== undefined && item.sensitive !== filter.sensitive) return false;
      if (text) {
        const haystack = `${item.id}\n${item.title}\n${item.body}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  /** Items this one points at. A target that does not exist is skipped here and reported by `check()` — during discovery, knowledge arrives in batches. */
  outgoing(id: string, type?: RelationType | RelationType[]): KnowledgeItem[] {
    const item = this.byId.get(id);
    if (!item) return [];
    const types = type === undefined ? undefined : ([] as RelationType[]).concat(type);
    const out: KnowledgeItem[] = [];
    for (const relation of item.relations) {
      if (types && !types.includes(relation.type)) continue;
      const target = this.resolve(relation.to, relation.to_module ?? item.module);
      if (target) out.push(target);
    }
    return out;
  }

  /** Items that point at this one. */
  incoming(id: string, type?: RelationType | RelationType[]): KnowledgeItem[] {
    const types = type === undefined ? undefined : ([] as RelationType[]).concat(type);
    return (this.incomingIndex.get(id) ?? [])
      .filter((edge) => !types || types.includes(edge.relation.type))
      .map((edge) => edge.from);
  }

  /** Breadth-first, excluding the start item, deduped. Returns [] for an unknown id rather than throwing — an id that is not here yet is a normal answer. */
  traverse(id: string, options: TraverseOptions): KnowledgeItem[] {
    const maxDepth = options.maxDepth ?? 1;
    if (!this.byId.has(id) || maxDepth < 1) return [];

    const seen = new Set<string>([id]);
    const result: KnowledgeItem[] = [];
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const current of frontier) {
        const neighbours: KnowledgeItem[] = [];
        if (options.direction === "outgoing" || options.direction === "both") {
          neighbours.push(...this.outgoing(current, options.types));
        }
        if (options.direction === "incoming" || options.direction === "both") {
          neighbours.push(...this.incoming(current, options.types));
        }
        for (const neighbour of neighbours) {
          if (seen.has(neighbour.id)) continue;
          seen.add(neighbour.id);
          result.push(neighbour);
          next.push(neighbour.id);
        }
      }
      frontier = next;
    }
    return result;
  }

  /**
   * Requirement -> Architecture -> API/DB -> Task -> Test, the same chain
   * `traceability.ts` reconstructs by reading four Markdown documents.
   * Built from relations here instead of from same-line id co-occurrence
   * there, and the two are tested against each other on one data set — that
   * equivalence is the evidence this model holds what the pipeline already
   * has, rather than only what is new.
   *
   * Every edge is followed in the direction the matrix defines it:
   * architecture *refines* the requirement, a task *implements* the
   * architecture/API/model, an API *references* a model, a test *verifies* the
   * requirement or the task.
   */
  chain(requirementId: string): KnowledgeChain {
    const requirement = this.byId.get(requirementId);
    if (!requirement) {
      throw new Error(`no knowledge item with id "${requirementId}"`);
    }
    if (requirement.kind !== "requirement") {
      throw new Error(`chain() starts at a requirement; "${requirementId}" is a ${requirement.kind}`);
    }

    const architecture = this.incoming(requirementId, "refines").filter((i) => i.kind === "architecture");

    // Whatever was derived out of those architecture notes: endpoints and models.
    const derived = architecture.flatMap((a) => this.incoming(a.id));
    const apis = dedupe(derived.filter((i) => i.kind === "api"));
    const dbFromArchitecture = derived.filter((i) => i.kind === "db-schema");

    const implementTargets = new Set([...architecture, ...apis, ...dbFromArchitecture].map((i) => i.id));
    const tasks = dedupe(
      this.items.filter(
        (item) =>
          item.kind === "task" &&
          item.relations.some((r) => r.type === "implements" && implementTargets.has(r.to)),
      ),
    );

    const dbModels = dedupe([
      ...dbFromArchitecture,
      ...apis.flatMap((a) => this.outgoing(a.id, "references")).filter((i) => i.kind === "db-schema"),
      ...tasks.flatMap((t) => this.outgoing(t.id, "implements")).filter((i) => i.kind === "db-schema"),
    ]);

    const tests = dedupe(
      [requirement, ...tasks].flatMap((i) => this.incoming(i.id, "verifies")).filter((i) => i.kind === "test"),
    );

    return { requirement, architecture, apis, dbModels, tasks, tests };
  }

  /**
   * Everything that makes the graph untrustworthy, in one list. Deliberately
   * not throwing: `--check-knowledge` and CI want the whole set, and half of
   * these are normal mid-discovery states that a person, not a program, has to
   * judge.
   */
  check(): KnowledgeCheckResult {
    const problems: string[] = [...this.loadProblems];

    for (const item of this.items) {
      // Re-run the per-item rules here too. Items reaching a base are not
      // always ones that came off disk — fromArtifacts.ts builds them in
      // memory — and an item that would be rejected by the file schema should
      // not be silently trusted just because it never got written.
      for (const issue of checkKnowledgeItem(item)) problems.push(`${item.id}: ${issue}`);

      if (item.status === "approved" && item.sources.length === 0) {
        problems.push(`${item.id}: is approved but names no source — nothing downstream can check where it came from`);
      }

      for (const relation of item.relations) {
        const target = item.schema_version >= 2 && relation.to_module === undefined
          ? (this.bareMatches.get(relation.to) ?? []).filter((candidate) => candidate.module === item.module)[0] ?? null
          : this.resolve(relation.to, relation.to_module ?? item.module);
        if (!target) {
          const candidates = this.bareMatches.get(relation.to) ?? [];
          const crossModule = item.schema_version >= 2 && relation.to_module === undefined && candidates.some((candidate) => candidate.module !== item.module);
          const detail = crossModule
            ? ` — cross-module relations require to_module (candidates: ${candidates.map(qualifiedKnowledgeId).join(", ")})`
            : candidates.length > 1 ? ` — ambiguous: ${candidates.map(qualifiedKnowledgeId).join(", ")}` : "";
          problems.push(`${candidates.length > 1 || crossModule ? qualifiedKnowledgeId(item) : item.id}: ${relation.type} -> "${relation.to}", which is not a knowledge item here${detail}`);
          continue;
        }
        if (!isRelationLegal(relation.type, item.kind, target.kind)) {
          problems.push(
            `${item.id} (${item.kind}) ${relation.type} -> ${target.id} (${target.kind}), which is not a legal pair — ` +
              `${relation.type} allows ${describeRelationRule(relation.type)}`,
          );
        }
      }
    }

    problems.push(...this.supersedeCycles());
    return { ok: problems.length === 0, problems };
  }

  /** A supersedes cycle means every version of the item claims to replace another one — there is then no current version at all. */
  private supersedeCycles(): string[] {
    const problems: string[] = [];
    const state = new Map<string, "visiting" | "done">();

    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting") {
        const start = trail.indexOf(id);
        problems.push(`supersedes cycle: ${[...trail.slice(start), id].join(" -> ")} — no version of this is the current one`);
        return;
      }
      state.set(id, "visiting");
      for (const next of this.outgoing(id, "supersedes")) visit(next.id, [...trail, id]);
      state.set(id, "done");
    };

    for (const item of this.items) visit(item.id, []);
    return problems;
  }
}

function dedupe(items: KnowledgeItem[]): KnowledgeItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Stable cross-module identity. Bare ids are only safe when unique. */
export function qualifiedKnowledgeId(item: Pick<KnowledgeItem, "module" | "id">): string {
  return `${item.module ?? "_project"}/${item.id}`;
}

export interface KnowledgeCheckReport extends KnowledgeCheckResult {
  notes: string[];
}

/**
 * What `--check-knowledge` runs. A repo with no `knowledge/` yet passes with a
 * note, the same way `--check-doc-structure` treats a project that has not
 * reached `business-analyst` yet: this checks consistency, not progress.
 *
 * The cross-file half lives here rather than in `KnowledgeBase.check()`: the
 * base is pure over a set of items, while "does this source id resolve" needs
 * the registry, and "is this policy coherent" needs the policy file. Folding
 * those into one flag rather than three keeps CI's list of checks matched to
 * subsystems instead of to files.
 */
export function checkKnowledge(projectRoot: string = defaultProjectRoot()): KnowledgeCheckReport {
  const { items, problems, missing } = loadKnowledge(projectRoot);
  if (missing) {
    return { ok: true, problems: [], notes: ["no `knowledge/` directory yet — nothing to check."] };
  }

  const registryLoad = loadSourceRegistry(projectRoot);
  const cross = crossCheckRegistry(items, new SourceRegistry(registryLoad.records), projectRoot);
  const kb = new KnowledgeBase(items, problems);
  const base = kb.check();
  const v2Problems: string[] = [];
  if (items.some((item) => item.schema_version >= 2)) {
    try {
      const registry = loadTargetRegistry(projectRoot);
      const known = new Set(registry.targets.map((target) => target.target_id));
      for (const item of items) {
        for (const targetId of item.target_ids ?? []) if (!known.has(targetId)) v2Problems.push(`${qualifiedKnowledgeId(item)}: unknown target_id "${targetId}"`);
        if (item.kind === "task" && item.payload.tag !== null && item.payload.target_id !== null && item.payload.target_id !== undefined && !known.has(item.payload.target_id)) {
          v2Problems.push(`${qualifiedKnowledgeId(item)}: task payload.target_id "${item.payload.target_id}" is not in targets.yaml`);
        }
      }
    } catch (error) {
      v2Problems.push(`schema v2 knowledge requires valid targets.yaml: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const resolutionLoad = loadResolutions(projectRoot);
  const conflicts = reportConflicts(kb, resolutionLoad.resolutions);
  const policy = checkKnowledgePolicyFile(projectRoot);

  const allProblems = [
    ...base.problems,
    ...v2Problems,
    ...registryLoad.problems,
    ...cross.problems,
    ...resolutionLoad.problems,
    ...policy.problems,
    ...checkOwnership(items).map((p) => `${p.id}: ${p.problem}`),
    // Declared conflicts only. A `conflicts-with` relation was written by
    // somebody who meant it, so an undecided one blocks; a duplicate found by
    // pattern-matching is a suggestion and goes to notes below.
    ...conflicts.unresolvedDeclared.map(
      (c) => `${c.id}: ${c.summary} — unresolved; a person decides (knowledge/_conflicts/${c.id}.yaml)`,
    ),
  ];

  const bootstrap = readBootstrapState(projectRoot);
  const bootstrapProblems = [...bootstrap.problems.map((p) => `knowledge/_bootstrap/STATE.yaml: ${p}`)];
  if (bootstrap.state) {
    const itemIds = new Set(items.map((i) => i.id));
    for (const stage of bootstrap.state.stages) {
      for (const id of stage.knowledge_ids) {
        if (!itemIds.has(id)) {
          bootstrapProblems.push(`knowledge/_bootstrap/STATE.yaml: stage "${stage.id}" claims item "${id}" which does not exist`);
        }
      }
      // Blocking on purpose: discovery re-read the material and it disagrees
      // with knowledge somebody already reviewed. Nothing downstream can tell
      // which of the two is right, which is exactly why a person has to.
      for (const id of stage.conflict_ids ?? []) {
        bootstrapProblems.push(
          `${id}: the ${stage.id} stage re-read its source and got something different, but the item is past \`draft\` — ` +
            "a person decides whether the material or the reviewed item is right",
        );
      }
    }
  }
  allProblems.push(...bootstrapProblems);

  const notes: string[] = [...policy.notes];
  // A note, not a problem: keeping a deprecated item *because* something still
  // cites it is the intended state. This is the list of citations to re-point
  // before it can go, which is only useful if somebody can see it.
  for (const entry of deprecatedStillDependedOn(kb)) {
    notes.push(`${entry.id} is deprecated but still cited by: ${entry.dependents.join(", ")}`);
  }
  if (cross.staleSources.length > 0) {
    notes.push(
      `${cross.staleSources.length} registered source(s) no longer match what was read: ${cross.staleSources.join(", ")}`,
    );
  }
  if (!bootstrap.state && bootstrap.problems.length === 0) notes.push("bootstrap (T73) has not started — no knowledge/_bootstrap/STATE.yaml yet.");
  else if (bootstrap.state) notes.push(`bootstrap (T73) status: ${bootstrap.state.status}`);
  if (items.length === 0) notes.push("`knowledge/` holds no items yet.");
  for (const c of conflicts.unresolvedDetected) notes.push(`possible conflict ${c.id}: ${c.summary}`);
  for (const r of conflicts.staleResolutions) {
    notes.push(`${r.id} resolves a conflict that no longer exists — the fix worked; the file can go.`);
  }
  if (cross.underived.length > 0) {
    // Not a problem: during discovery this list is the queue of material still
    // to be read properly. Silence would be worse than a note — it is the only
    // place the raw/derived split becomes visible.
    notes.push(
      `${cross.underived.length} registered source(s) nothing has been derived from yet: ${cross.underived
        .map((r) => r.id)
        .join(", ")}`,
    );
  }

  return { ok: allProblems.length === 0, problems: allProblems, notes };
}
