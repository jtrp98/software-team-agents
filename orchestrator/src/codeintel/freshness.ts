import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  FreshnessStatus,
  IndexError,
  MissingIndexError,
  ProviderStatus,
  StaleIndexError,
} from "./provider.js";

/**
 * T-GR3 — freshness, because the indexing tool has no TTL.
 *
 * The tool ages silently: an index built last month looks exactly as
 * authoritative as one built this morning, and a stale graph that labels its
 * edges EXTRACTED is a very confident lie. So the index carries a small
 * metadata sidecar (written at build time) that records which revision it was
 * built from, and every query is gated on comparing that against the checkout's
 * current HEAD. There is no code path that reads the graph without passing
 * through here first — the resolver calls `assertQueryAllowed` before any
 * provider operation, and the provider itself re-checks in `getStatus`.
 *
 * POLICY (fixed): fresh → query · stale → refresh-or-fallback (refreshing is a
 * human's explicit decision — the orchestrator never builds on its own) ·
 * missing/error → fallback. Build is opt-in, never automatic.
 */

export interface GraphMetadata {
  provider: string;
  tool_version: string;
  target_id: string;
  /** Revision the checkout was at when someone decided to index it. */
  target_revision: string;
  /** Revision recorded inside the produced graph — normally equal to the above. */
  indexed_revision: string;
  indexed_at: string;
  code_only: boolean;
}

const METADATA_NAME = "graphify-metadata.yaml";
const GRAPH_DIR_NAME = "graphify-out";
const GRAPH_NAME = "graph.json";

export function metadataPath(cacheRoot: string, targetId: string, revision: string): string {
  return path.join(cacheRoot, targetId, revision, METADATA_NAME);
}

export function graphFileFor(cacheRoot: string, targetId: string, revision: string): string {
  return path.join(cacheRoot, targetId, revision, GRAPH_DIR_NAME, GRAPH_NAME);
}

/** Reads the sidecar; `null` when absent or unreadable — absence is data here, not a crash. */
export function readMetadata(cacheRoot: string, targetId: string, revision: string): GraphMetadata | null {
  const file = metadataPath(cacheRoot, targetId, revision);
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  const required = ["provider", "tool_version", "target_id", "target_revision", "indexed_revision", "indexed_at"];
  if (!required.every((k) => typeof m[k] === "string" && (m[k] as string).length > 0)) return null;
  return { ...(m as unknown as GraphMetadata), code_only: m.code_only === true };
}

/** Written by the (human-initiated) index step so the orchestrator can gate on it later. */
export function writeMetadata(cacheRoot: string, metadata: GraphMetadata): void {
  const file = metadataPath(cacheRoot, metadata.target_id, metadata.target_revision);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyYaml(metadata, { sortMapEntries: false }), "utf8");
}

/**
 * Pure comparison — no I/O — so tests can enumerate all four states and callers
 * can reuse the verdict for messages. A revision match is what makes an index
 * fresh; anything else (including a corrupt sidecar) degrades downward, never up.
 */
export function computeFreshness(input: {
  metadata: GraphMetadata | null;
  graphExists: boolean;
  currentRevision: string;
}): FreshnessStatus {
  if (!input.metadata || !input.graphExists) return "missing";
  if (input.metadata.target_id === "" || input.metadata.indexed_revision !== input.metadata.target_revision) {
    return "error";
  }
  return input.metadata.target_revision === input.currentRevision ? "fresh" : "stale";
}

/**
 * Disk-backed verdict for a target's CURRENT revision.
 *
 * Three places to look, in order: the exact revision directory (fresh/error),
 * then any OTHER revision of the same target (that is what stale means in
 * practice — the checkout moved on since someone last indexed), else missing.
 * Scanning is bounded: one directory listing per target, no graph parsing.
 */
export function getStatus(cacheRoot: string, targetId: string, revision: string): ProviderStatus {
  try {
    const exact = readMetadata(cacheRoot, targetId, revision);
    const exactGraphExists = fs.existsSync(graphFileFor(cacheRoot, targetId, revision));

    if (exact) {
      const consistent = exactGraphExists && exact.indexed_revision === exact.target_revision;
      return {
        status: consistent ? (exact.target_revision === revision ? "fresh" : "error") : "error",
        targetRevision: revision,
        indexedRevision: exact.indexed_revision,
        indexedAt: exact.indexed_at,
      };
    }

    const previous = newestOtherIndex(cacheRoot, targetId, revision);
    if (previous) {
      return {
        status: "stale",
        targetRevision: revision,
        indexedRevision: previous.indexed_revision,
        indexedAt: previous.indexed_at,
      };
    }
  } catch {
    return { status: "error", targetRevision: revision, indexedRevision: null, indexedAt: null };
  }
  return { status: "missing", targetRevision: revision, indexedRevision: null, indexedAt: null };
}

/** Newest index built from a DIFFERENT revision — the evidence that the map aged out. */
function newestOtherIndex(cacheRoot: string, targetId: string, currentRevision: string): GraphMetadata | null {
  const targetDir = path.join(cacheRoot, targetId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { metadata: GraphMetadata; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "." || entry.name === ".." || entry.name === currentRevision) continue;
    const metadata = readMetadata(cacheRoot, targetId, entry.name);
    if (!metadata || !fs.existsSync(graphFileFor(cacheRoot, targetId, entry.name))) continue;
    const mtime = fs.statSync(path.join(targetDir, entry.name)).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { metadata, mtime };
  }
  // An index counts as prior evidence only when it really was built from the
  // revision its folder claims — otherwise it is corruption, not staleness.
  return newest && newest.metadata.indexed_revision === newest.metadata.target_revision ? newest.metadata : null;
}

/**
 * The one gate every query passes through (checklist: "ไม่มีทาง query ผ่านได้โดยข้าม status check").
 * Throws typed errors the resolver maps onto fallback; never returns "just try it anyway".
 */
export function assertQueryAllowed(status: ProviderStatus): void {
  switch (status.status) {
    case "fresh":
      return;
    case "stale":
      throw new StaleIndexError(
        `code-intelligence index for "${status.targetRevision.slice(0, 12)}" is stale — refresh it explicitly or fall back to search`,
      );
    case "missing":
      throw new MissingIndexError("no code-intelligence index exists for this target/revision");
    case "error":
      throw new IndexError("code-intelligence index metadata is invalid");
  }
}
