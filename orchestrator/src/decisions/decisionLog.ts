import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Reads `decisions/*.md` — Architecture Decision Records for project-wide
 * choices (stack, cross-cutting architecture, permission model) that would
 * otherwise get re-asked, or re-decided differently, on every fresh run that
 * touches the area (T16).
 *
 * Unlike `workflows/*.yml` or `contracts/*.yaml`, an ADR has no runtime
 * behaviour to diff against — there is no "classifier" it can drift from,
 * because the decision it records lives in prose, read by a person and by a
 * model, not executed. What this module checks instead is the shape every
 * ADR has to have to be findable and trustworthy: valid frontmatter, an id
 * that matches the filename, no id reused by two files, and a `superseded`
 * record that actually names what replaced it. `decisions/README.md` has
 * the full format.
 */

export type AdrStatus = "proposed" | "accepted" | "superseded" | "rejected";

export interface AdrFrontmatter {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  supersedes?: string;
  superseded_by?: string;
}

export interface Adr {
  frontmatter: AdrFrontmatter;
  file: string;
  body: string;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "adr.schema.json",
);

const FILENAME_PATTERN = /^(ADR-[0-9]{3})-[a-z0-9-]+\.md$/;
const REQUIRED_SECTIONS = ["## Status", "## Context", "## Decision", "## Consequences"];

export function decisionsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "decisions");
}

export class AdrError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: string[],
  ) {
    super(`${file} is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "AdrError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/** Splits `---\n<yaml>\n---\n<body>` into its two halves. Throws when the file has no frontmatter block at all. */
function splitFrontmatter(raw: string, file: string): { frontmatterYaml: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new AdrError(file, ["no YAML frontmatter block (expected the file to start with '---')"]);
  }
  return { frontmatterYaml: match[1], body: match[2] };
}

/** Reads and validates one ADR. Throws rather than returning a partly trusted record — a decision an agent can't fully parse is one it shouldn't rely on. */
export function loadAdr(fileName: string, projectRoot: string = defaultProjectRoot()): Adr {
  const filePath = path.join(decisionsDir(projectRoot), fileName);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new AdrError(fileName, [`no file at ${filePath}`]);
  }

  const { frontmatterYaml, body } = splitFrontmatter(raw, fileName);

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch (e) {
    throw new AdrError(fileName, [`frontmatter is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new AdrError(
      fileName,
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }

  const frontmatter = parsed as AdrFrontmatter;
  const filenameMatch = FILENAME_PATTERN.exec(fileName);
  if (!filenameMatch) {
    throw new AdrError(fileName, [
      `filename must match ADR-<NNN>-<slug>.md (e.g. ADR-004-caching.md), got "${fileName}"`,
    ]);
  }
  if (filenameMatch[1] !== frontmatter.id) {
    throw new AdrError(fileName, [
      `declares id "${frontmatter.id}" but the filename says "${filenameMatch[1]}" — the filename is the identity`,
    ]);
  }

  const missingSections = REQUIRED_SECTIONS.filter((heading) => !body.includes(heading));
  if (missingSections.length > 0) {
    throw new AdrError(fileName, [`body is missing required section(s): ${missingSections.join(", ")}`]);
  }

  return { frontmatter, file: fileName, body };
}

/** Every ADR filename present on disk, sorted so ADR-002 always precedes ADR-010. */
export function listAdrFiles(projectRoot: string = defaultProjectRoot()): string[] {
  try {
    return fs
      .readdirSync(decisionsDir(projectRoot))
      .filter((f) => f !== "README.md" && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

export function loadAllAdrs(projectRoot: string = defaultProjectRoot()): Adr[] {
  return listAdrFiles(projectRoot).map((f) => loadAdr(f, projectRoot));
}

export interface DecisionLogCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * The check `--check-decisions` runs: every ADR parses, every id is unique
 * and matches its filename, every `superseded`/`supersedes` link resolves to
 * a real record, and no `superseded` record forgot to name what replaced it.
 */
export function checkDecisions(projectRoot: string = defaultProjectRoot()): DecisionLogCheckResult {
  const problems: string[] = [];
  const dir = decisionsDir(projectRoot);

  if (!fs.existsSync(dir)) {
    return { ok: false, problems: [`no decisions/ directory at ${dir}`] };
  }

  const files = listAdrFiles(projectRoot);
  if (files.length === 0) {
    return { ok: false, problems: [`decisions/ has no ADR files (only README.md, or nothing at all)`] };
  }

  const adrs: Adr[] = [];
  for (const file of files) {
    try {
      adrs.push(loadAdr(file, projectRoot));
    } catch (e) {
      problems.push(e instanceof AdrError ? e.message : String(e));
    }
  }

  const byId = new Map<string, Adr[]>();
  for (const adr of adrs) {
    const list = byId.get(adr.frontmatter.id) ?? [];
    list.push(adr);
    byId.set(adr.frontmatter.id, list);
  }
  for (const [id, list] of byId) {
    if (list.length > 1) {
      problems.push(`${id} is declared by more than one file: ${list.map((a) => a.file).join(", ")}`);
    }
  }

  for (const adr of adrs) {
    const { supersedes, superseded_by } = adr.frontmatter;
    if (supersedes && !byId.has(supersedes)) {
      problems.push(`${adr.file}: supersedes "${supersedes}", but no ADR with that id exists`);
    }
    if (superseded_by && !byId.has(superseded_by)) {
      problems.push(`${adr.file}: superseded_by "${superseded_by}", but no ADR with that id exists`);
    }
    if (superseded_by) {
      const replacement = byId.get(superseded_by)?.[0];
      if (replacement && replacement.frontmatter.supersedes !== adr.frontmatter.id) {
        problems.push(
          `${adr.file}: says superseded_by "${superseded_by}", but ${replacement.file} does not link back with supersedes: "${adr.frontmatter.id}"`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

export class DecisionLogError extends Error {
  constructor(public readonly problems: string[]) {
    super(`decisions/ has problems:\n- ${problems.join("\n- ")}`);
    this.name = "DecisionLogError";
  }
}

export function assertDecisions(projectRoot: string = defaultProjectRoot()): void {
  const result = checkDecisions(projectRoot);
  if (!result.ok) throw new DecisionLogError(result.problems);
}
