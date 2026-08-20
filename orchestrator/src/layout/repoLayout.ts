import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { CONTRACTED_AGENTS, defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Reads and enforces `layout.yaml` — the one declaration of which concept owns
 * which directory.
 *
 * `.claude/` had become the home of five different things: who the agents are,
 * what capabilities exist, what is forbidden, when each role runs, and what is
 * true right now. Each answers a different question, and with them interleaved
 * the only way to place a new file was to copy whatever the last one did.
 *
 * The manifest states the boundaries; this module checks them against the real
 * filesystem, which is the part that makes it more than a diagram. Every check
 * here exists because its absence would let a specific drift happen silently:
 *
 *   - a home that vanished, so the concept quietly has nowhere to live
 *   - an agent with a prompt but no contract (or the reverse), which is how the
 *     two halves of one role drift apart
 *   - two concepts claiming the same directory, which puts the "where does this
 *     go?" question straight back where it started
 *   - a hook sitting in .claude/hooks that settings.json never wires up: present,
 *     looking installed, enforcing nothing. This repo has shipped that failure
 *     for real, twice.
 *
 * Problems are collected, never thrown on the first: a layout that is wrong in
 * three places should say so once rather than across three fix rounds.
 */

export type HomeStatus = "active" | "reserved" | "planned";

export interface LayoutHome {
  path: string;
  status: HomeStatus;
  holds: string;
  pattern?: string;
  per_agent?: boolean;
  read_by?: string;
  enforced_by_settings?: boolean;
  optional?: boolean;
  filled_by?: string;
}

export interface LayoutConcept {
  answers: string;
  why: string;
  homes: LayoutHome[];
}

export interface RepoLayout {
  version: number;
  concepts: Record<string, LayoutConcept>;
}

export const LAYOUT_FILENAME = "layout.yaml";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "repo-layout.schema.json",
);

export class LayoutError extends Error {
  constructor(public readonly issues: string[]) {
    super(`${LAYOUT_FILENAME} is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "LayoutError";
  }
}

export function layoutPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, LAYOUT_FILENAME);
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/**
 * Reads the manifest. Throws rather than returning a partly trusted object:
 * every caller uses it to decide where something belongs, and a half-read
 * boundary is worse than no boundary.
 */
export function loadLayout(projectRoot: string = defaultProjectRoot()): RepoLayout {
  const file = layoutPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new LayoutError([`no layout file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new LayoutError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new LayoutError((validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`));
  }
  return parsed as RepoLayout;
}

/** Every home of every concept, tagged with the concept that claims it. */
export function allHomes(layout: RepoLayout): Array<LayoutHome & { concept: string }> {
  return Object.entries(layout.concepts).flatMap(([concept, c]) => c.homes.map((h) => ({ ...h, concept })));
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `child` is the same path as `parent`, or sits underneath it. */
function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Which concept owns a repo-relative path — the question the manifest exists to
 * answer. The most specific home wins, so `.claude/hooks/x.js` resolves to
 * policy even if some future home claims `.claude` wholesale. Returns null for a
 * path no concept claims, which is a real answer: root-level files like
 * CLAUDE.md and this file itself belong to no concept.
 */
export function conceptOf(layout: RepoLayout, relPath: string): string | null {
  const target = normalize(relPath);
  let best: { concept: string; depth: number } | null = null;

  for (const home of allHomes(layout)) {
    const home_ = normalize(home.path);
    if (!isWithin(target, home_)) continue;
    const depth = home_.split("/").length;
    if (!best || depth > best.depth) best = { concept: home.concept, depth };
  }
  return best?.concept ?? null;
}

/** The homes one concept declares. Throws for an unknown id rather than returning [] — a typo'd concept should not read as "no homes". */
export function homesOf(layout: RepoLayout, concept: string): LayoutHome[] {
  const entry = layout.concepts[concept];
  if (!entry) {
    throw new LayoutError([`no concept "${concept}" in ${LAYOUT_FILENAME} (have: ${Object.keys(layout.concepts).join(", ")})`]);
  }
  return entry.homes;
}

export interface LayoutCheckResult {
  ok: boolean;
  /** One entry per problem, already formatted for printing. */
  problems: string[];
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function extensionOf(pattern: string): string {
  return pattern.slice(1); // "*.md" -> ".md"
}

/** Homes must not overlap: two concepts claiming one directory is the problem this file was written to end. */
function checkNoOverlap(homes: Array<LayoutHome & { concept: string }>, problems: string[]): void {
  for (let i = 0; i < homes.length; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const a = homes[i];
      const b = homes[j];
      if (a.concept === b.concept) continue;
      const pa = normalize(a.path);
      const pb = normalize(b.path);
      if (pa === pb) {
        problems.push(`"${pa}" is claimed by both ${a.concept} and ${b.concept} — a directory answers one question`);
      } else if (isWithin(pa, pb)) {
        problems.push(`${a.concept}'s "${pa}" sits inside ${b.concept}'s "${pb}" — ownership of files under it is ambiguous`);
      } else if (isWithin(pb, pa)) {
        problems.push(`${b.concept}'s "${pb}" sits inside ${a.concept}'s "${pa}" — ownership of files under it is ambiguous`);
      }
    }
  }
}

/** A `per_agent: true` home holds exactly one file per agent — no missing half, no orphan. */
function checkPerAgent(home: LayoutHome & { concept: string }, dir: string, problems: string[]): void {
  const ext = home.pattern ? extensionOf(home.pattern) : "";
  const present = new Set(
    listFiles(dir)
      .filter((f) => (ext ? f.endsWith(ext) : true))
      .map((f) => (ext ? f.slice(0, -ext.length) : f)),
  );

  for (const agent of CONTRACTED_AGENTS) {
    if (!present.has(agent)) {
      problems.push(`${home.concept}: "${home.path}" has no file for agent ${agent} — every agent needs all of its halves`);
    }
  }
  for (const name of present) {
    if (!(CONTRACTED_AGENTS as string[]).includes(name)) {
      problems.push(`${home.concept}: "${home.path}/${name}${ext}" is not an agent this orchestrator knows — an orphan half`);
    }
  }
}

/** A hook the settings file never references is installed-looking and inert. */
function checkEnforcedBySettings(
  home: LayoutHome & { concept: string },
  dir: string,
  projectRoot: string,
  problems: string[],
): void {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  let settings: string;
  try {
    settings = fs.readFileSync(settingsPath, "utf8");
  } catch {
    problems.push(`${home.concept}: "${home.path}" is declared enforced_by_settings but ${settingsPath} is unreadable`);
    return;
  }

  const ext = home.pattern ? extensionOf(home.pattern) : "";
  for (const file of listFiles(dir)) {
    if (ext && !file.endsWith(ext)) continue;
    if (!settings.includes(file)) {
      problems.push(
        `${home.concept}: "${home.path}/${file}" is never referenced in .claude/settings.json — ` +
          "a guard that is not wired up enforces nothing while looking installed",
      );
    }
  }
}

/**
 * The check `--check-layout` (and CI) runs: the manifest parses, and the
 * filesystem agrees with it.
 */
export function checkLayout(projectRoot: string = defaultProjectRoot()): LayoutCheckResult {
  const problems: string[] = [];

  let layout: RepoLayout;
  try {
    layout = loadLayout(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof LayoutError ? e.issues : [String(e)] };
  }

  const homes = allHomes(layout);
  checkNoOverlap(homes, problems);

  for (const home of homes) {
    const dir = path.join(projectRoot, home.path);
    const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();

    if (home.status === "planned") {
      // Named so nobody invents a second home for it. Nothing to check on disk.
      continue;
    }
    if (!exists) {
      if (home.optional) continue; // created at runtime or by the pipeline's output
      problems.push(`${home.concept}: "${home.path}" is declared ${home.status} but does not exist`);
      continue;
    }

    if (home.status === "reserved") {
      const stray = listFiles(dir).filter((f) => f !== "README.md");
      if (stray.length > 0) {
        problems.push(
          `${home.concept}: "${home.path}" is reserved for ${home.filled_by} but already holds ${stray.join(", ")} — ` +
            `flip its status to active once ${home.filled_by} lands`,
        );
      }
      if (!listFiles(dir).includes("README.md")) {
        problems.push(`${home.concept}: reserved "${home.path}" has no README.md saying what it is reserved for`);
      }
      continue;
    }

    if (home.per_agent) checkPerAgent(home, dir, problems);
    if (home.enforced_by_settings) checkEnforcedBySettings(home, dir, projectRoot, problems);
  }

  return { ok: problems.length === 0, problems };
}

export class LayoutMismatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`${LAYOUT_FILENAME} and the repo disagree:\n- ${problems.join("\n- ")}`);
    this.name = "LayoutMismatchError";
  }
}

export function assertLayout(projectRoot: string = defaultProjectRoot()): void {
  const result = checkLayout(projectRoot);
  if (!result.ok) throw new LayoutMismatchError(result.problems);
}
