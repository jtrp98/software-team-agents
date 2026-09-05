import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { checkKnowledgeItem, type KnowledgeItem } from "./knowledgeModel.js";
import { pathFor, relativePathFor } from "./knowledgeStore.js";

/**
 * Knowledge versioning and history.
 *
 * WHY HISTORY IS READ FROM GIT AND NOT STORED
 *
 * The obvious design is a sidecar: `REQ-003.history.yaml` next to the item,
 * appended on every edit. It is the wrong one twice over. It is a derived copy
 * of something git already stores perfectly — "a stored derivation is a second
 * source of truth waiting to disagree with the first" — and worse, it undoes
 * the reason items are one file each: two people editing two different items
 * would both append to their own history files, fine, but two people editing
 * *one* item now conflict twice instead of once, in two places, one of which
 * merges "cleanly" into a lie.
 *
 * So `version` (the integer in the file) is the counter, and git is the log.
 * This module reads it: what changed, when, by whom, between which versions.
 *
 * WHEN THERE IS NO GIT
 *
 * A project may not be a git repo at all, and a just-written item is not
 * committed yet. Both are normal, and both produce `available: false` with a
 * reason rather than an empty history — "nothing ever changed" and "I cannot
 * see the history" must not look the same to the caller, or a stale item reads
 * as a fresh one.
 */

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface HistoryEntry {
  commit: string;
  author: string;
  /** Author date, ISO-8601. */
  date: string;
  subject: string;
  /** The item's `version` at this commit, or null when the file at that commit could not be parsed. */
  version: number | null;
  /** What this commit changed, relative to the commit before it. Empty for the oldest entry in the window. */
  changes: FieldChange[];
}

export interface ItemHistory {
  id: string;
  /** Newest first, the order `git log` gives and the order a person asks in. */
  entries: HistoryEntry[];
  available: boolean;
  /** Why history could not be read. Set only when `available` is false. */
  reason?: string;
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

/**
 * Every field that differs between two versions of one item. `payload` is
 * compared key by key rather than as one blob: "payload changed" is not a
 * useful thing to tell someone reviewing an amendment.
 */
export function diffItems(before: KnowledgeItem, after: KnowledgeItem): FieldChange[] {
  const changes: FieldChange[] = [];

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("payload");
  for (const key of [...keys].sort()) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field: key, from: display(a), to: display(b) });
    }
  }

  // Defaulted rather than assumed: everything this module compares came out of
  // `git show` on a historical revision, and a revision whose payload is missing
  // is a thing that exists. The type says otherwise; the bytes on disk decide.
  const beforePayload = (before.payload ?? {}) as unknown as Record<string, unknown>;
  const afterPayload = (after.payload ?? {}) as unknown as Record<string, unknown>;

  const payloadKeys = new Set([...Object.keys(beforePayload), ...Object.keys(afterPayload)]);
  for (const key of [...payloadKeys].sort()) {
    const a = beforePayload[key];
    const b = afterPayload[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field: `payload.${key}`, from: display(a), to: display(b) });
    }
  }

  return changes;
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** True when `projectRoot` is inside a git work tree. Read-only: `rev-parse` changes nothing, which is why the repo's no-git rule permits it. */
export function isGitRepo(projectRoot: string = defaultProjectRoot()): boolean {
  try {
    return git(projectRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export interface HistoryOptions {
  /** How many commits back to look. History is for reviewing a recent change, not for archaeology, and each entry costs a `git show`. */
  maxEntries?: number;
}

/** ASCII unit separator: git emits it for %x1f, and no commit subject contains one. */
const FIELD_SEPARATOR = "\u001f";

/**
 * The commits that touched one item's file, newest first, each with the
 * version it left behind and what it changed.
 */
export function historyOf(
  item: Pick<KnowledgeItem, "id" | "kind" | "module">,
  projectRoot: string = defaultProjectRoot(),
  options: HistoryOptions = {},
): ItemHistory {
  const maxEntries = options.maxEntries ?? 20;
  const relative = path.relative(projectRoot, pathFor(item, projectRoot)).replace(/\\/g, "/");

  if (!isGitRepo(projectRoot)) {
    return { id: item.id, entries: [], available: false, reason: `${projectRoot} is not a git repository` };
  }

  let log: string;
  try {
    log = git(projectRoot, [
      "log",
      `--max-count=${maxEntries}`,
      "--follow",
      `--format=%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`,
      "--",
      relative,
    ]);
  } catch (e) {
    return { id: item.id, entries: [], available: false, reason: `git log failed: ${(e as Error).message}` };
  }

  const rows = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [commit, author, date, ...rest] = line.split(FIELD_SEPARATOR);
      return { commit, author, date, subject: rest.join(FIELD_SEPARATOR) };
    });

  if (rows.length === 0) {
    return {
      id: item.id,
      entries: [],
      available: false,
      reason: `${relativePathFor(item)} has no commits yet — the item exists but its history does not`,
    };
  }

  // Oldest first while building, so each entry can be diffed against the one
  // before it, then reversed at the end.
  const ordered = [...rows].reverse();
  const entries: HistoryEntry[] = [];
  let previous: KnowledgeItem | null = null;

  for (const row of ordered) {
    let snapshot: KnowledgeItem | null = null;
    try {
      const parsed = parseYaml(git(projectRoot, ["show", `${row.commit}:${relative}`])) as unknown;
      // Validated, not just cast. `--follow` traces renames back past the point
      // where the path held a knowledge item at all — routine during a legacy
      // import — and a bare cast let a `{some: "text"}` through to `diffItems`,
      // which reads `.payload` and threw a TypeError out of a function whose
      // whole contract is to report a reason instead of throwing.
      snapshot = checkKnowledgeItem(parsed).length === 0 ? (parsed as KnowledgeItem) : null;
    } catch {
      // A commit that deleted or renamed the file, or left it unparseable. The
      // commit still happened, so it stays in the log with version null rather
      // than vanishing from the history.
      snapshot = null;
    }

    entries.push({
      ...row,
      version: typeof snapshot?.version === "number" ? snapshot.version : null,
      changes: previous && snapshot ? diffItems(previous, snapshot) : [],
    });
    if (snapshot) previous = snapshot;
  }

  return { id: item.id, entries: entries.reverse(), available: true };
}

/**
 * A recorded "I was written against version N of item X" — the same idea as
 * `design.md`'s Contract Version line, applied to knowledge.
 */
export interface KnowledgeVersionRef {
  id: string;
  version: number;
}

export interface StaleReference extends KnowledgeVersionRef {
  currentVersion: number | null;
  reason: "behind" | "missing" | "ahead";
}

/**
 * Which recorded references are no longer true. Three outcomes, deliberately
 * distinguished:
 *
 *   `behind`  the item moved on — whatever was built against it may not match.
 *   `missing` the item is gone — the reference cannot be checked at all.
 *   `ahead`   the reference claims a version the item never reached, which
 *             means the two are not talking about the same item. Silently
 *             treating it as "fine, not behind" is how a bad id survives.
 */
export function staleReferences(refs: KnowledgeVersionRef[], items: KnowledgeItem[]): StaleReference[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const stale: StaleReference[] = [];

  for (const ref of refs) {
    const item = byId.get(ref.id);
    if (!item) {
      stale.push({ ...ref, currentVersion: null, reason: "missing" });
    } else if (item.version > ref.version) {
      stale.push({ ...ref, currentVersion: item.version, reason: "behind" });
    } else if (item.version < ref.version) {
      stale.push({ ...ref, currentVersion: item.version, reason: "ahead" });
    }
  }

  return stale;
}
