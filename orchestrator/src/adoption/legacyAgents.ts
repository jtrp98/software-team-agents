import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import {
  CONTRACTED_AGENTS,
  defaultProjectRoot,
  loadAgentContract,
  type AgentContract,
} from "../agents/agentContract.js";
import { resolveAgentModel } from "../agents/agentModel.js";
import { commaList, frontmatter } from "./markdown.js";

/**
 * Legacy Agent Discovery (T82).
 *
 * Reads the agent definitions a project already has (`.claude/agents/*.md`) and
 * expresses each one in this framework's Agent Contract shape (T03) — without
 * changing what the agent does, which is the requirement TASKS_V1.md states
 * ("โดยไม่เปลี่ยน behavior เดิม").
 *
 * WHY THE RESULT IS STAGED, NOT INSTALLED
 *
 * `contracts/<name>.yaml` is checked against the orchestrator's registry on
 * every CI run (`--check-contracts`), and `agent-contract.schema.json` closes
 * `agent.name` to exactly the ten roles this framework knows. So writing a
 * conversion straight into `contracts/` does one of two harmful things:
 * overwrite this framework's own contract for a role of the same name, or add
 * one for a role nothing recognises and turn CI red. Adopting a project would
 * then look like breaking the framework. Conversions land in
 * `knowledge/_adoption/contracts/` instead, and installing one is a separate
 * deliberate act by a person.
 *
 * WHAT "WITHOUT CHANGING BEHAVIOR" MEANS IN PRACTICE
 *
 * A prompt states two things a contract also states — its `description` and its
 * `tools` — and says nothing at all about the other six fields (inputs,
 * outputs, constraints, permissions, states, capability). So:
 *
 *   from the legacy prompt   description, tools, model, effort, version
 *   from this framework      everything else, taken from the role's own
 *                            contract, because a prompt cannot answer it and
 *                            inventing an answer is exactly the drift this is
 *                            supposed to avoid
 *
 * And where the two disagree, the difference is *reported*, never smoothed
 * over. A legacy agent holding the `Agent` tool is the sharpest example: that
 * agent can invoke the next one, which is the single structural rule this
 * pipeline is built on (CLAUDE.md: none of the ten holds `Agent`). Silently
 * writing the framework's tool list over it would produce a contract that reads
 * correct and describes an agent that behaves differently.
 *
 * AN AGENT THIS FRAMEWORK HAS NO ROLE FOR
 *
 * It gets no contract file, because there is no valid one to write — the schema
 * enum has ten names in it. It is reported by name, with its tools and
 * description, in `UNMAPPED.yaml`. Nothing is lost: the prompt file itself is
 * never touched, and adoption's job here is to say what it found, not to invent
 * a role.
 */

export const LEGACY_AGENTS_RELATIVE_DIR = ".claude/agents";

const KNOWN_ROLES = new Set<string>(CONTRACTED_AGENTS.map(String));

export interface LegacyAgentDefinition {
  /** Filename stem — the identity Claude Code resolves `--agent <name>` against. */
  name: string;
  /** The `name:` field, when it disagrees with the filename. Reported, not believed. */
  declaredName: string | undefined;
  relativePath: string;
  description: string;
  tools: string[];
  model: string | null;
  effort: string | null;
  version: number | null;
  /** Length of the prompt body, so a report can say "converted" without quoting the whole prompt. */
  promptLines: number;
}

export interface LegacyAgentConversion {
  definition: LegacyAgentDefinition;
  /** Null when this framework has no role of that name — see the module doc. */
  contract: AgentContract | null;
  /** Behavioural differences between the legacy prompt and this framework's role of the same name. */
  differences: string[];
}

export interface LegacyAgentScan {
  conversions: LegacyAgentConversion[];
  /** Files in the directory that carried no frontmatter at all, so there was nothing to convert. */
  unreadable: string[];
}

function definitionFrom(file: string, relativePath: string): LegacyAgentDefinition | null {
  const parsed = frontmatter(fs.readFileSync(file, "utf8"));
  if (!parsed) return null;

  const { fields, body } = parsed;
  const stem = path.basename(file, ".md");
  const version = Number.parseInt(fields.version ?? "", 10);

  return {
    // The filename is the identity (the same rule `loadAgentContract` and
    // `decisionLog` apply), so a `name:` field that disagrees is reported as a
    // difference rather than believed.
    name: stem,
    declaredName: fields.name,
    relativePath,
    description: fields.description ?? "",
    tools: commaList(fields.tools),
    model: fields.model ?? null,
    effort: fields.effort ?? null,
    version: Number.isNaN(version) ? null : version,
    promptLines: body.split(/\r?\n/).length,
  };
}

/** This framework's own contract for a role, as the base for the fields a prompt cannot express. */
function baseContractFor(name: string): AgentContract | null {
  try {
    return loadAgentContract(name as AgentStage);
  } catch {
    return null;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function differencesFor(definition: LegacyAgentDefinition, base: AgentContract): string[] {
  const out: string[] = [];

  if (definition.declaredName !== undefined && definition.declaredName !== definition.name) {
    out.push(`declares name "${definition.declaredName}" but the file is ${definition.name}.md — the filename is the identity`);
  }

  if (!sameSet(definition.tools, base.tools)) {
    const extra = definition.tools.filter((t) => !base.tools.includes(t));
    const missing = base.tools.filter((t) => !definition.tools.includes(t));
    const parts: string[] = [];
    if (extra.length > 0) parts.push(`has ${extra.join(", ")} which this framework's ${definition.name} does not`);
    if (missing.length > 0) parts.push(`lacks ${missing.join(", ")}`);
    out.push(`tools: ${parts.join("; ")}`);
  }

  // Called out separately from the tool diff above, because it is not a
  // difference of degree: an agent that can invoke another agent breaks the one
  // structural guarantee this pipeline rests on.
  if (definition.tools.includes("Agent") || definition.tools.includes("Task")) {
    out.push(
      "holds the Agent/Task tool, so it can invoke the next agent itself — no role in this framework may, and that is enforced by not granting the tool",
    );
  }

  // Model is not part of the contract, but a legacy agent running a different
  // model from the one this framework assigns the role is a quality difference
  // somebody should choose knowingly rather than inherit. Compared against the
  // framework's own prompt, not against a table copied into this file — CLAUDE.md
  // states the intent and `.claude/agents/<role>.md` is where it is actually set.
  const frameworkModel = resolveAgentModel(defaultProjectRoot(), definition.name);
  if (definition.model !== null && frameworkModel !== null && definition.model !== frameworkModel) {
    out.push(`runs model "${definition.model}" where this framework's ${definition.name} runs "${frameworkModel}"`);
  }

  return out;
}

/** Reads every legacy agent definition and converts what it can. Never writes — `runAdoptionStage` does that. */
export function scanLegacyAgents(projectRoot: string): LegacyAgentScan {
  const dir = path.join(projectRoot, ...LEGACY_AGENTS_RELATIVE_DIR.split("/"));
  if (!fs.existsSync(dir)) return { conversions: [], unreadable: [] };

  const conversions: LegacyAgentConversion[] = [];
  const unreadable: string[] = [];

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  for (const name of files) {
    const relativePath = `${LEGACY_AGENTS_RELATIVE_DIR}/${name}`;
    const definition = definitionFrom(path.join(dir, name), relativePath);
    if (!definition) {
      unreadable.push(relativePath);
      continue;
    }

    if (!KNOWN_ROLES.has(definition.name)) {
      conversions.push({ definition, contract: null, differences: [] });
      continue;
    }

    const base = baseContractFor(definition.name);
    if (!base) {
      conversions.push({
        definition,
        contract: null,
        differences: [`"${definition.name}" is a role this framework knows, but its own contract could not be read to convert against`],
      });
      continue;
    }

    conversions.push({
      definition,
      contract: {
        ...base,
        agent: {
          ...base.agent,
          // The legacy prompt's own words. Everything else comes from the base:
          // see the module doc for why a prompt is not asked questions it cannot
          // answer.
          description: definition.description === "" ? base.agent.description : definition.description,
        },
        tools: definition.tools.length > 0 ? definition.tools : base.tools,
      },
      differences: differencesFor(definition, base),
    });
  }

  return { conversions, unreadable };
}

export interface UnmappedAgentRecord {
  name: string;
  relativePath: string;
  description: string;
  tools: string[];
  note: string;
}

export function unmappedRecordsFrom(scan: LegacyAgentScan): UnmappedAgentRecord[] {
  return scan.conversions
    .filter((c) => c.contract === null && !KNOWN_ROLES.has(c.definition.name))
    .map((c) => ({
      name: c.definition.name,
      relativePath: c.definition.relativePath,
      description: c.definition.description,
      tools: c.definition.tools,
      note: "this framework has no role of this name, so no contract could be written — the prompt file is untouched and a person decides what it maps to",
    }));
}
