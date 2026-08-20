import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import { knowledgeDir } from "../../knowledge/knowledgeStore.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * Human Knowledge Input (T79) — the sixth Discovery stage in T73's flow,
 * and the only one that is not automated discovery at all.
 *
 * T74-T78 can only find what already exists somewhere machine-readable.
 * Business rules and domain vocabulary often exist only in a person's head —
 * "refunds over $500 need manager approval" is not in any file until
 * someone writes it down. This stage is that channel: a person edits
 * `knowledge/_human-input/INPUT.yaml` directly (reserved dir, same
 * reasoning as `_sources`/`_conflicts`/`_bootstrap`), and this stage turns
 * each entry into a proper `business-rule` or `domain` item the next time
 * bootstrap runs a pass.
 *
 * ONLY THESE TWO KINDS, ON PURPOSE
 *
 * `requirement`, `architecture`, `decision`, and the rest already have an
 * agent/interview flow (`business-analyst`, `system-analyst`, ADRs) that
 * captures far more context than a flat list entry could — actors,
 * priority, feasibility, reasoning. Widening this file's schema to accept
 * those kinds would create a second, thinner way to write them, and the
 * thinner path would win by being easier. `business-rule` and `domain` are
 * the two kinds nothing else exists to originate.
 *
 * MALFORMED INPUT FAILS LOUD
 *
 * Unlike a stage reading generated/scanned material (a `package.json`, a
 * `schema.prisma`), this file was hand-written with intent. Silently
 * skipping a typo'd entry would hide the mistake from the person who made
 * it; this stage throws instead, the same "fail closed" choice T61 made for
 * a YAML conflict marker.
 */

export const HUMAN_INPUT_DIRNAME = "_human-input";
export const HUMAN_INPUT_FILENAME = "INPUT.yaml";

interface BusinessRuleEntry {
  kind: "business-rule";
  module?: string | null;
  statement: string;
  enforcement: "code" | "policy" | "manual" | "unknown";
  author: string;
}

interface DomainEntry {
  kind: "domain";
  module?: string | null;
  term: string;
  definition: string;
  aliases?: string[];
  author: string;
}

type HumanEntry = BusinessRuleEntry | DomainEntry;

interface HumanInputFile {
  schema_version: number;
  entries: HumanEntry[];
}

export class HumanInputError extends Error {
  constructor(public readonly issues: string[]) {
    super(`knowledge/${HUMAN_INPUT_DIRNAME}/${HUMAN_INPUT_FILENAME} is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "HumanInputError";
  }
}

export function humanInputPath(projectRoot: string): string {
  return path.join(knowledgeDir(projectRoot), HUMAN_INPUT_DIRNAME, HUMAN_INPUT_FILENAME);
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "schemas",
  "human-knowledge-input.schema.json",
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

function checkHumanInput(data: unknown): string[] {
  const validate = validator();
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function slugOf(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ENTRY";
}

function entryItem(entry: HumanEntry, now: string): { item: KnowledgeItem; source: SourceRecord } {
  const module = entry.module ?? null;

  if (entry.kind === "business-rule") {
    const id = `RULE-${shortHash(entry.statement)}`;
    const source: SourceRecord = {
      schema_version: KNOWLEDGE_SCHEMA_VERSION,
      id: `SRC-HUMAN-${id}`,
      type: "human",
      locator: entry.author,
      captured_at: now,
      captured_by: AgentStage.HUMAN,
      digest: null,
    };
    const item: KnowledgeItemOf<"business-rule"> = {
      schema_version: KNOWLEDGE_SCHEMA_VERSION,
      id,
      kind: "business-rule",
      title: entry.statement.length > 80 ? `${entry.statement.slice(0, 80)}…` : entry.statement,
      body: `Human Knowledge Input (T79) — recorded by ${entry.author}.`,
      repo: null,
      module,
      owner: AgentStage.BUSINESS_ANALYST,
      status: "draft",
      sensitive: false,
      version: 1,
      created_at: now,
      updated_at: now,
      sources: [{ type: "human", locator: entry.author, captured_at: now, digest: null, source_id: source.id }],
      relations: [],
      payload: { statement: entry.statement, enforcement: entry.enforcement },
    };
    return { item, source };
  }

  const id = `DOM-${slugOf(entry.term)}`;
  const source: SourceRecord = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: `SRC-HUMAN-${id}`,
    type: "human",
    locator: entry.author,
    captured_at: now,
    captured_by: AgentStage.HUMAN,
    digest: null,
  };
  const item: KnowledgeItemOf<"domain"> = {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind: "domain",
    title: entry.term,
    body: `Human Knowledge Input (T79) — recorded by ${entry.author}.`,
    repo: null,
    module,
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    sources: [{ type: "human", locator: entry.author, captured_at: now, digest: null, source_id: source.id }],
    relations: [],
    payload: { term: entry.term, definition: entry.definition, aliases: entry.aliases ?? [] },
  };
  return { item, source };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function humanInputDiscoveryStage(now: () => string = () => new Date().toISOString()): DiscoveryStage {
  return {
    id: "human-input",
    discover: (projectRoot: string): DiscoveryResult => {
      const filePath = humanInputPath(projectRoot);
      if (!fs.existsSync(filePath)) {
        return {
          items: [],
          sources: [],
          skipped: true,
          note: `no knowledge/${HUMAN_INPUT_DIRNAME}/${HUMAN_INPUT_FILENAME} — nothing for a person to have filled in yet`,
        };
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        throw new HumanInputError([`is not valid YAML: ${(e as Error).message}`]);
      }

      const problems = checkHumanInput(parsed);
      if (problems.length > 0) throw new HumanInputError(problems);

      const timestamp = now();
      const file = parsed as HumanInputFile;
      const items: KnowledgeItem[] = [];
      const sources: SourceRecord[] = [];
      for (const entry of file.entries) {
        const { item, source } = entryItem(entry, timestamp);
        items.push(item);
        sources.push(source);
      }

      if (items.length === 0) {
        return { items: [], sources: [], skipped: true, note: `knowledge/${HUMAN_INPUT_DIRNAME}/${HUMAN_INPUT_FILENAME} has no entries yet` };
      }
      return { items, sources };
    },
  };
}
