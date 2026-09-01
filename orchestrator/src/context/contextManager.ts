import { AgentStage } from "../types.js";
import { ArtifactType, type HandoffArtifact } from "../artifacts/schemas.js";
import { moduleDocPath, readModuleDoc } from "../agents/moduleDocs.js";
import { CONTEXT_POLICY, ContextLeakageError, type ContextCategory } from "./contextSelection.js";
import { narrowSelectedContext, selectDocContext, type SelectedContext } from "./docSelection.js";
import { needsTraceability, traceabilityScopeFor, unavailableTrace, type TraceabilityScope } from "./traceability.js";

/** The module documents this understands. `test-plan`/`security`/`deploy` have no §10 slicing rule, so they pass through whole. */
export type DocKind = "requirement" | "design" | "plan" | "test-plan" | "review" | "security" | "deploy";

export const DOC_FILENAME: Record<DocKind, string> = {
  requirement: "requirement.md",
  design: "design.md",
  plan: "plan.md",
  "test-plan": "test-plan.md",
  review: "review.md",
  security: "security.md",
  deploy: "deploy.md",
};

/** Which document backs each category a role's context policy may allow. */
export const CATEGORY_TO_DOC: Partial<Record<ContextCategory, DocKind>> = {
  [ArtifactType.REQUIREMENTS]: "requirement",
  [ArtifactType.DESIGN]: "design",
  [ArtifactType.PLAN]: "plan",
  [ArtifactType.TEST_PLAN]: "test-plan",
  [ArtifactType.QA_REPORT]: "review",
  [ArtifactType.SECURITY_REPORT]: "security",
};

const DOC_TO_CATEGORY: Partial<Record<DocKind, ArtifactType>> = {
  requirement: ArtifactType.REQUIREMENTS,
  design: ArtifactType.DESIGN,
  plan: ArtifactType.PLAN,
  "test-plan": ArtifactType.TEST_PLAN,
  review: ArtifactType.QA_REPORT,
  security: ArtifactType.SECURITY_REPORT,
};

export type ReferencedSections = Partial<Record<DocKind, string[]>>;

/** Resolves only the three reference fields P6 authorizes for document narrowing. */
export function handoffReferencedSections(stage: AgentStage, handoff: HandoffArtifact): ReferencedSections {
  const policy = CONTEXT_POLICY[stage];
  if (!policy) return {};
  const out: ReferencedSections = {};
  const qualifiedDocs = (Object.keys(DOC_FILENAME) as DocKind[])
    .filter((doc) => doc !== "deploy")
    .sort((a, b) => DOC_FILENAME[b].length - DOC_FILENAME[a].length);

  const add = (reference: string, fallback: DocKind): void => {
    const qualified = qualifiedDocs.find((doc) => reference.startsWith(`${DOC_FILENAME[doc]}#`));
    const doc = qualified ?? fallback;
    const category = DOC_TO_CATEGORY[doc];
    if (!category) return;
    if (!policy.reads.includes(category)) {
      if (qualified) throw new ContextLeakageError(stage, category);
      return;
    }
    (out[doc] ??= []).push(reference);
  };

  for (const reference of handoff.constraint_refs) add(reference, "requirement");
  for (const reference of [...handoff.contract_refs.produces, ...handoff.contract_refs.consumes]) add(reference, "design");
  for (const reference of handoff.test_refs) add(reference, "test-plan");
  for (const [doc, references] of Object.entries(out) as Array<[DocKind, string[]]>) out[doc] = [...new Set(references)];
  return out;
}

export interface ContextManagerOptions {
  projectRoot: string;
  moduleName: string;
}

export class ContextManager {
  private lastReadCount = 0;

  constructor(private readonly opts: ContextManagerOptions) {}

  path(doc: DocKind): string {
    return moduleDocPath(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]);
  }

  /** One document, sliced. Null when the document does not exist — a missing doc is a fact for the caller, not an empty string to reason over. */
  read(stage: AgentStage, doc: DocKind, phases?: number[], taskId?: string, traceability?: TraceabilityScope): SelectedContext | null {
    const cache = new Map<DocKind, string | null>();
    const load = (kind: DocKind): string | null => {
      if (!cache.has(kind)) cache.set(kind, readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[kind]));
      return cache.get(kind)!;
    };
    const markdown = load(doc);
    if (markdown === null) {
      this.lastReadCount = cache.size;
      return null;
    }
    const trace = traceability ?? (needsTraceability(stage, doc) ? this.traceability(phases, taskId, load) : unavailableTrace("this document/owner does not need traceability slicing"));
    this.lastReadCount = cache.size;
    return selectDocContext({ stage, doc, phases, moduleName: this.opts.moduleName, traceability: trace }, markdown);
  }

  private traceability(phases?: number[], taskId?: string, load?: (doc: DocKind) => string | null): TraceabilityScope {
    if (!phases || phases.length === 0) return unavailableTrace("no phase was supplied");
    const read = load ?? ((doc: DocKind) => readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]));
    return traceabilityScopeFor(read("requirement"), read("design"), read("plan"), phases, taskId);
  }

  /** Everything one stage may read, already sliced: the category policy decides which documents, §10 decides how much of each. */
  forStage(stage: AgentStage, phases?: number[], taskId?: string, referencedSections?: ReferencedSections): SelectedContext[] {
    const policy = CONTEXT_POLICY[stage];
    if (!policy) return [];

    const cache = new Map<DocKind, string | null>();
    const load = (doc: DocKind): string | null => {
      if (!cache.has(doc)) cache.set(doc, readModuleDoc(this.opts.projectRoot, this.opts.moduleName, DOC_FILENAME[doc]));
      return cache.get(doc)!;
    };
    const out: SelectedContext[] = [];
    const policyDocs = policy.reads.map((category) => CATEGORY_TO_DOC[category]).filter((doc): doc is DocKind => doc !== undefined);
    const traceability = policyDocs.some((doc) => needsTraceability(stage, doc))
      ? this.traceability(phases, taskId, load)
      : unavailableTrace("this stage's documents do not need traceability slicing");
    for (const category of policy.reads) {
      const doc = CATEGORY_TO_DOC[category];
      if (!doc) continue;
      const markdown = load(doc);
      if (markdown !== null) {
        const normal = selectDocContext({ stage, doc, phases, moduleName: this.opts.moduleName, traceability }, markdown);
        out.push(referencedSections === undefined ? normal : narrowSelectedContext(normal, referencedSections[doc] ?? [], stage));
      }
    }
    this.lastReadCount = cache.size;
    return out;
  }

  /** Unique module-document read attempts made by the last read/forStage call. */
  directFileReads(): number {
    return this.lastReadCount;
  }

  /** What the slicing saved, for the run log. */
  savings(selected: SelectedContext[]): { bytesBefore: number; bytesAfter: number; savedPct: number } {
    const bytesBefore = selected.reduce((n, s) => n + s.bytesBefore, 0);
    const bytesAfter = selected.reduce((n, s) => n + s.bytesAfter, 0);
    const savedPct = bytesBefore === 0 ? 0 : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 100);
    return { bytesBefore, bytesAfter, savedPct };
  }
}

export { sectionMap, type Section } from "./sections.js";
export { traceabilityScopeFor, type TraceabilityScope } from "./traceability.js";
export {
  HANDOFF_REFERENCE_MAX_SECTION_RATIO,
  keepDesignSection,
  selectDocContext,
  type ContextRequest,
  type DesignSectionVerdict,
  type SelectedContext,
} from "./docSelection.js";
