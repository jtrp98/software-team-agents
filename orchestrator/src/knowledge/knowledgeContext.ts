import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { KNOWLEDGE_KINDS, type KnowledgeItem, type KnowledgeKind, type SourceRef } from "./knowledgeModel.js";
import { KnowledgeBase, type KnowledgeQuery } from "./knowledgeBase.js";
import { SourceRegistry, type SourceRecord } from "./sourceRegistry.js";
import {
  DEFAULT_KNOWLEDGE_POLICY,
  type KnowledgePolicy,
  type VisibleItem,
  loadKnowledgePolicy,
  visibleItemFor,
} from "./knowledgePolicy.js";
import { kindsFor } from "./roleView.js";
import { type Freshness, freshnessOf } from "./freshness.js";

/**
 * The Shared Context API (T70), with permission-aware retrieval (T69) and
 * provenance (T72) built in rather than bolted on.
 *
 * ONE DOOR
 *
 * Every agent asks the project's knowledge through here instead of reading
 * `knowledge/*.yaml` directly. That is the point of T70: a dozen call sites each
 * opening files is a dozen places where the role filter, the field policy and
 * the freshness warning can each be forgotten independently.
 *
 * PERMISSION IS NOT AN AFTERTHOUGHT
 *
 * T69's requirement, stated plainly: the check happens *before* the agent sees
 * anything, not after. There is no method here that returns a raw
 * `KnowledgeItem` — retrieval produces a `VisibleItem`, already filtered by kind
 * (T67) and by field (T68). "Show the agent everything and trust it not to
 * mention the sensitive parts" is not access control; it is a hope.
 *
 * NOTHING IS WITHHELD SILENTLY
 *
 * Every result says what it left out: which ids the policy hid, which kinds are
 * outside this role's view, and which fields were redacted on each item. An
 * agent that cannot tell an absent fact from a withheld one will implement
 * around the gap — `contextManager.ts` learned this for document slices, and it
 * is the same failure at a finer grain.
 *
 * EVERY ANSWER CARRIES ITS SOURCE AND ITS AGE
 *
 * Provenance and freshness ride along with each item rather than being separate
 * lookups, because a caller that has to ask a second question to find out
 * whether the first answer is trustworthy will skip the second question.
 */

export interface ResolvedSource {
  type: SourceRef["type"];
  locator: string;
  captured_at: string;
  digest: string | null;
  /** The registry record (T62) this cites, when it names or matches one. */
  record: SourceRecord | null;
}

export interface Provenance {
  id: string;
  version: number;
  sources: ResolvedSource[];
  /** Transitive ancestry through `derived-from`/`refines` — what this was worked out from. */
  derivedFrom: string[];
  /** One line an agent can quote when it uses this: what it is, which version, and where it came from. */
  citation: string;
}

export interface RetrievedItem {
  item: VisibleItem;
  provenance: Provenance;
  freshness: Freshness;
}

export interface RetrievalResult {
  role: AgentStage;
  items: RetrievedItem[];
  /** Ids the field policy hid entirely. Listed, never merely omitted. */
  hidden: string[];
  /** Kinds this role's view excludes — so "no API items" is distinguishable from "no API items you may see". */
  kindsNotInView: KnowledgeKind[];
}

export type RetrievalOutcome =
  | { status: "ok"; item: RetrievedItem }
  | { status: "not-found" }
  | { status: "withheld"; reason: string };

export interface RoleChain {
  requirement: RetrievedItem;
  architecture: RetrievedItem[];
  apis: RetrievedItem[];
  dbModels: RetrievedItem[];
  tasks: RetrievedItem[];
  tests: RetrievedItem[];
  /** Items in the real chain this role does not get to see. The chain is never quietly shorter. */
  hidden: string[];
}

export interface KnowledgeContextOptions {
  /** ISO date-time, for freshness. Passed in — an agent does not know today's date. */
  now: string;
  policy?: KnowledgePolicy;
  registry?: SourceRegistry;
  /** Enables digest checking against the real files. Omit to get age-only freshness. */
  projectRoot?: string;
}

export class KnowledgeContext {
  readonly policy: KnowledgePolicy;
  readonly registry: SourceRegistry;

  constructor(
    readonly kb: KnowledgeBase,
    private readonly options: KnowledgeContextOptions,
  ) {
    this.policy = options.policy ?? DEFAULT_KNOWLEDGE_POLICY;
    this.registry = options.registry ?? new SourceRegistry([]);
  }

  /** Everything loaded from one project: items, source registry, field policy. */
  static load(projectRoot: string = defaultProjectRoot(), now: string = new Date().toISOString()): KnowledgeContext {
    return new KnowledgeContext(KnowledgeBase.load(projectRoot), {
      now,
      policy: loadKnowledgePolicy(projectRoot),
      registry: SourceRegistry.load(projectRoot),
      projectRoot,
    });
  }

  forRole(role: AgentStage): RoleContext {
    return new RoleContext(role, this.kb, this.policy, this.registry, this.options);
  }

  provenanceOf(item: KnowledgeItem): Provenance {
    const sources: ResolvedSource[] = item.sources.map((source) => ({
      type: source.type,
      locator: source.locator,
      captured_at: source.captured_at,
      digest: source.digest,
      record: source.source_id ? this.registry.get(source.source_id) : this.registry.forLocator(source.locator),
    }));

    const derivedFrom = this.kb
      .traverse(item.id, { types: ["derived-from", "refines"], direction: "outgoing", maxDepth: 5 })
      .map((i) => i.id);

    const where = sources
      .map((s) => `${s.locator} (read ${s.captured_at.slice(0, 10)})`)
      .join("; ");

    return {
      id: item.id,
      version: item.version,
      sources,
      derivedFrom,
      citation: `${item.id} v${item.version} [${item.status}, owned by ${item.owner}] — ${where}`,
    };
  }
}

export class RoleContext {
  private readonly visibleKinds: KnowledgeKind[];

  constructor(
    readonly role: AgentStage,
    private readonly kb: KnowledgeBase,
    private readonly policy: KnowledgePolicy,
    private readonly registry: SourceRegistry,
    private readonly options: KnowledgeContextOptions,
  ) {
    this.visibleKinds = kindsFor(role);
  }

  private context(): KnowledgeContext {
    return new KnowledgeContext(this.kb, { ...this.options, policy: this.policy, registry: this.registry });
  }

  /**
   * Both filters, in one place. The kind check belongs here and not only in
   * `query()`: `chain()` and `get()` reach items by following relations rather
   * than by querying, and a filter that only guards the front door is one an
   * item walks around.
   */
  private retrieve(item: KnowledgeItem): RetrievedItem | null {
    if (!this.visibleKinds.includes(item.kind)) return null;
    const visible = visibleItemFor(item, this.role, this.policy);
    if (!visible) return null;
    return {
      item: visible,
      provenance: this.context().provenanceOf(item),
      freshness: freshnessOf(item, {
        now: this.options.now,
        policy: this.policy,
        projectRoot: this.options.projectRoot,
      }),
    };
  }

  /**
   * The role's slice, already filtered by kind and by field. A `kinds` filter
   * naming something outside the view throws (see `viewFor`) rather than
   * quietly returning less.
   */
  query(filter: KnowledgeQuery = {}): RetrievalResult {
    const requested = filter.kinds ?? this.visibleKinds;
    for (const kind of requested) {
      if (!this.visibleKinds.includes(kind)) {
        throw new Error(`${this.role} does not see ${kind} items — asking for them is a bug at the call site`);
      }
    }

    const items: RetrievedItem[] = [];
    const hidden: string[] = [];
    for (const item of this.kb.query({ ...filter, kinds: requested })) {
      const retrieved = this.retrieve(item);
      if (retrieved) items.push(retrieved);
      else hidden.push(item.id);
    }

    return {
      role: this.role,
      items,
      hidden,
      kindsNotInView: KNOWLEDGE_KINDS.filter((k) => !this.visibleKinds.includes(k)),
    };
  }

  /** Three outcomes, deliberately distinct: it is not here, you may not see it, or here it is. */
  get(id: string): RetrievalOutcome {
    const item = this.kb.get(id);
    if (!item) return { status: "not-found" };
    if (!this.visibleKinds.includes(item.kind)) {
      return { status: "withheld", reason: `${this.role} does not see ${item.kind} items` };
    }
    const retrieved = this.retrieve(item);
    if (!retrieved) return { status: "withheld", reason: `the field policy hides ${id} from ${this.role}` };
    return { status: "ok", item: retrieved };
  }

  /** The requirement -> design -> API/model -> task -> test chain, filtered the same way everything else is. */
  chain(requirementId: string): RoleChain {
    const raw = this.kb.chain(requirementId);
    const hidden: string[] = [];

    const filter = (items: KnowledgeItem[]): RetrievedItem[] => {
      const kept: RetrievedItem[] = [];
      for (const item of items) {
        if (!this.visibleKinds.includes(item.kind)) {
          hidden.push(item.id);
          continue;
        }
        const retrieved = this.retrieve(item);
        if (retrieved) kept.push(retrieved);
        else hidden.push(item.id);
      }
      return kept;
    };

    const requirement = this.retrieve(raw.requirement);
    if (!requirement) {
      throw new Error(`${this.role} may not see ${requirementId}, so it cannot be the head of a chain for this role`);
    }

    return {
      requirement,
      architecture: filter(raw.architecture),
      apis: filter(raw.apis),
      dbModels: filter(raw.dbModels),
      tasks: filter(raw.tasks),
      tests: filter(raw.tests),
      hidden,
    };
  }

  /** Where an item came from and which version this is — refused for anything the role may not see. */
  provenance(id: string): Provenance | null {
    const outcome = this.get(id);
    return outcome.status === "ok" ? outcome.item.provenance : null;
  }

  freshness(id: string): Freshness | null {
    const outcome = this.get(id);
    return outcome.status === "ok" ? outcome.item.freshness : null;
  }

  /** The one-line attribution an agent quotes when it uses a fact. */
  citation(id: string): string | null {
    return this.provenance(id)?.citation ?? null;
  }
}
