import * as fs from "node:fs";
import * as path from "node:path";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { SOURCES_DIRNAME } from "../knowledge/sourceRegistry.js";

/**
 * Where Claude Design / Figma export material lives, and how a derived
 * recommendation stays honest about what it was derived from (T-UX5).
 *
 * TWO SUPPORTED PATHS, ONE CONVENTION
 *
 *  - **Path A — handoff bundle** (Claude runtime): the person places the
 *    bundle their design tool handed off under
 *    `<module>/handoff/` inside this directory. Read as ordinary files.
 *  - **Path B — export files**: plain HTML/MD/folder exports under
 *    `<module>/`. Same reading rule.
 *
 * The location is `knowledge/_sources/design/<module>/` because `_sources`
 * is already a reserved top-level directory of the knowledge model
 * (knowledgeStore.ts's RESERVED_DIRS) for exactly this kind of thing:
 * material a person or discovery placed there for items to cite. Reusing it
 * means no second convention for "where do source bytes live", and the
 * agent-side write guard is already right (`knowledge/_sources/**` is denied
 * to every role — only people place files here; agents read them).
 *
 * THE DIGEST IS THE EXISTING ONE
 *
 * {@link digestOfSource} is the framework's single definition of "the digest
 * of what a source locator points at" — the same function freshness (T71)
 * recomputes with. Recording a Path B file's digest through it means an
 * `ux-design` item whose source moved reports `changed` by ordinary
 * freshness arithmetic, with no new mechanism invented here.
 */

export const DESIGN_SOURCES_DIRNAME = "design";

/** `knowledge/_sources/design/<module>` under one project/knowledge root. */
export function designSourceDir(projectRoot: string, moduleName: string): string {
  return path.join(projectRoot, SOURCES_DIRNAME, DESIGN_SOURCES_DIRNAME, moduleName);
}

/** Every file in a module's design-source directory (recursive), forward-slashed and relative to the project root, sorted. Empty when nothing has been placed yet. */
export function listDesignSources(projectRoot: string, moduleName: string): string[] {
  const root = designSourceDir(projectRoot, moduleName);
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(projectRoot, full).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return found.sort();
}

export interface DesignSourceDigest {
  /** Project-root-relative locator, exactly the shape a knowledge item's `sources[].locator` carries. */
  locator: string;
  /** `sha256:…` over the whole file, or null when unreadable — null records honestly rather than inventing a value. */
  digest: string | null;
}

/** Records what a Path B export said at capture time. One row per file, straight into the deriving item's `sources`. */
export function digestDesignSource(projectRoot: string, moduleName: string, relativeFile: string): DesignSourceDigest {
  const locator = relativeFile.replace(/\\/g, "/");
  return { locator, digest: digestOfSource(locator, projectRoot) };
}

/**
 * Whether a recorded digest still matches the file on disk now — the strong
 * freshness signal. `null` digest (unhashable then) can never verify, so it
 * refuses too: a conclusion nobody can re-check against its material is not
 * current, whatever the calendar says.
 */
export function designSourceIsCurrent(recorded: DesignSourceDigest, projectRoot: string): boolean {
  if (recorded.digest === null) return false;
  const current = digestOfSource(recorded.locator, projectRoot);
  return current !== null && current === recorded.digest;
}
