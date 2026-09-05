import * as fs from "node:fs";
import type { KnowledgeItem } from "./knowledgeModel.js";
import {
  pathFor,
  readKnowledgeFile,
  relativePathFor,
  sameKnowledgeContent,
  writeKnowledgeItem,
} from "./knowledgeStore.js";

/**
 * Putting a derived item on disk without overwriting reviewed knowledge.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * This logic was pulled out of `bootstrap/bootstrapRunner.ts`, where discovery
 * wrote every item with `force: true` — so an item a person had taken to
 * `approved` at version 3 came back as `draft` at version 1 on the next run,
 * while the bootstrap state still said `ready` and still named the person who
 * had validated it.
 *
 * The rule is needed in more than one place, including a dry run whose entire
 * job is to say what an apply *would* do. A dry run with its own copy of this
 * decision could disagree with the apply it is previewing. So the decision
 * lives here once, `classifyLanding` answers it without writing anything, and
 * `applyLanding` is the only thing that writes. A preview and an apply cannot
 * drift, because they are the same function called twice.
 *
 * THE RULE, BY WHAT IS ALREADY ON DISK
 *
 *   nothing there            -> create. Nothing to conflict with.
 *   `draft`                  -> update, one version on. Draft means nobody has
 *                               checked it, so re-deriving it from its source
 *                               is the whole point; git keeps what it replaced.
 *   past `draft`, same text  -> unchanged. Re-finding what somebody already
 *                               approved is agreement, not an event.
 *   past `draft`, new text   -> conflict. The material and the reviewed
 *                               knowledge now disagree; which one is right is a
 *                               person's call, not a stage's.
 */

export type LandingAction = "create" | "update" | "unchanged" | "conflict";

export interface LandingDecision {
  id: string;
  action: LandingAction;
  /** Absolute path the item belongs at, whether or not anything will be written there. */
  path: string;
  /** Same path, repo-relative and forward-slashed — what a manifest and a dry-run report quote. */
  relativePath: string;
  /** Version already on disk, or null when there is no file yet. */
  existingVersion: number | null;
  /**
   * Exactly what `applyLanding` would write, or null for `unchanged`/`conflict`.
   * Resolved here rather than at write time so the preview and the apply cannot
   * differ by a version number or a timestamp.
   */
  next: KnowledgeItem | null;
}

/**
 * Decides what would happen to one item, touching nothing. A file that exists
 * but cannot be read as an item is reported as a conflict rather than thrown
 * past the caller: a stage that found forty items should not fail entirely
 * because one file on disk is broken, and overwriting a file nobody can read is
 * not a safe default either.
 */
export function classifyLanding(item: KnowledgeItem, projectRoot: string, now: string): LandingDecision {
  const filePath = pathFor(item, projectRoot);
  const relativePath = `knowledge/${relativePathFor(item)}`;
  const base = { id: item.id, path: filePath, relativePath };

  if (!fs.existsSync(filePath)) {
    return { ...base, action: "create", existingVersion: null, next: item };
  }

  let existing: KnowledgeItem;
  try {
    existing = readKnowledgeFile(filePath, relativePathFor(item));
  } catch {
    return { ...base, action: "conflict", existingVersion: null, next: null };
  }

  // Two fields are carried over before comparing, because neither is something
  // a derivation has an opinion about:
  //
  //   `created_at` — belongs to the item, not to this run.
  //   `status`     — the reviewer's mark. `applyTransition` counts status as
  //                  content (rightly: an approved item is not the draft it
  //                  was), but the question here is narrower — "does the
  //                  material still say what it said" — and comparing a freshly
  //                  derived `draft` against an `approved` copy would answer
  //                  "no" every single time, turning agreement into a conflict.
  //
  // Nothing is written back under a carried-over status: a non-draft item is
  // refused below either way, so the only status this can preserve is `draft`.
  const candidate: KnowledgeItem = { ...item, created_at: existing.created_at, status: existing.status };

  if (sameKnowledgeContent(existing, candidate)) {
    return { ...base, action: "unchanged", existingVersion: existing.version, next: null };
  }
  if (existing.status !== "draft") {
    return { ...base, action: "conflict", existingVersion: existing.version, next: null };
  }

  return {
    ...base,
    action: "update",
    existingVersion: existing.version,
    next: { ...candidate, version: existing.version + 1, updated_at: now },
  };
}

/** Writes the decision's item when there is one. Returns the path written, or null when the decision was `unchanged`/`conflict`. */
export function applyLanding(decision: LandingDecision, projectRoot: string): string | null {
  if (decision.next === null) return null;
  return writeKnowledgeItem(decision.next, projectRoot);
}

export interface LandedItems {
  /** Written: either new, or an update to something still `draft`. */
  written: string[];
  /** Already on disk, saying the same thing. Nothing to do and nothing to report. */
  unchanged: string[];
  /** Re-derived differently, but past `draft` — left alone, reported. */
  conflicts: string[];
}

export function emptyLanded(): LandedItems {
  return { written: [], unchanged: [], conflicts: [] };
}

/**
 * Classify + apply + sort into buckets, the combination a writer with nothing
 * else to do wants. The decision is returned, so a caller that needs to act on
 * the path — adoption takes a backup before overwriting anything, for rollback
 * — reads it from there rather than this module growing a callback for a
 * concern it should not know about.
 */
export function landItem(
  item: KnowledgeItem,
  projectRoot: string,
  now: string,
  landed: LandedItems,
): LandingDecision {
  const decision = classifyLanding(item, projectRoot, now);
  switch (decision.action) {
    case "create":
    case "update":
      applyLanding(decision, projectRoot);
      landed.written.push(item.id);
      break;
    case "unchanged":
      landed.unchanged.push(item.id);
      break;
    case "conflict":
      landed.conflicts.push(item.id);
      break;
  }
  return decision;
}
