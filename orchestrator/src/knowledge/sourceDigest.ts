import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The one definition of "the digest of what a source locator points at".
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * A source digest is written by one side (discovery, recording what it read)
 * and recomputed by another (freshness, asking whether the material moved).
 * Those two numbers only mean anything *together*: a digest whose
 * recomputation can never equal it does not say "the file changed", it says
 * nothing at all, while looking exactly like the strongest signal freshness has.
 *
 * That is not hypothetical: every discovery stage used to carry its own
 * `digestOf()` — five copies, all truncating to 16 hex — while freshness
 * computed the full 64, so *every* discovered item reported `source-changed`
 * against files nobody had touched. Two of the five also hashed different text
 * (a regex match rather than the line it sat on; a model block rather than the
 * line range naming it), so widening the truncation alone would not have fixed
 * those two.
 *
 * So there is one function, both sides call it, and agreement is a property of
 * the code rather than a convention someone has to maintain. A digest recorded
 * by `digestOfSource(locator, root)` is by construction the value
 * `freshnessOf()` will recompute for that same locator.
 *
 * WHAT CANNOT BE HASHED RECORDS null
 *
 * A person, a conversation, a directory listing, a folder-name signal — these
 * have no bytes to hash, and `digest: null` is the schema's word for that.
 * Inventing a digest for them is worse than having none: it reads as a
 * checkable claim and cannot be checked, so the check reports the material as
 * *gone* the first time anybody asks.
 */

/** `path#L10-L24` -> the file and the line window it names. A bare path names the whole file. */
export function parseLocator(locator: string): { file: string; from?: number; to?: number } {
  const match = /^(.*?)#L(\d+)(?:-L(\d+))?$/.exec(locator);
  if (!match) return { file: locator };
  return { file: match[1], from: Number(match[2]), to: match[3] ? Number(match[3]) : Number(match[2]) };
}

/**
 * The digest of what a source locator points at, or null when there is nothing
 * readable there. Hashes only the named lines when the locator names a range:
 * an item derived from lines 48-61 has not gone stale because line 900 changed.
 *
 * Call this to *record* a digest as well as to check one — see the module note.
 */
export function digestOfSource(locator: string, projectRoot: string): string | null {
  const { file, from, to } = parseLocator(locator);
  const full = path.isAbsolute(file) ? file : path.join(projectRoot, file);

  let contents: string;
  try {
    contents = fs.readFileSync(full, "utf8");
  } catch {
    // Missing, or a directory: either way there are no bytes this locator names.
    return null;
  }

  const text =
    from === undefined
      ? contents
      : contents
          .split(/\r?\n/)
          .slice(from - 1, to)
          .join("\n");

  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
