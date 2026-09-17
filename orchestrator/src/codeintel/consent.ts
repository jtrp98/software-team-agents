import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { defaultCacheRoot, revisionDir } from "./cache.js";
import { getStatus, writeMetadata } from "./freshness.js";
import { resolveTargetRevision } from "./targetRevision.js";
import { codeIntelEnabled } from "../runtime/codeIntelAssembly.js";
import type { ProviderStatus } from "./provider.js";

/**
 * Per-revision consent to build or refresh a code-intelligence index
 * (ADR-006 Option A): ask-before-indexing is unchanged — what moved is WHERE
 * the ask lives. It used to exist only as a person remembering to run
 * `scripts/reindex-code-intel.mjs` out of band, so on any machine where nobody
 * remembered, the index never came into being. Now the run asks once, at
 * start, with the facts a person needs to decide.
 *
 * The record is machine-local and lives beside the cache it consents to
 * (outside every repo, like the index itself) keyed by `targetId + revision`:
 * a new revision is a new question, because the thing being consented to is
 * not the same work. An unattended run with no record never blocks — it
 * proceeds on fallback (`policies/security.md`: code-intel is never a
 * dependency of a stage).
 */

export type CodeIntelConsentAnswer = "approved" | "declined";

export interface CodeIntelConsentRecord {
  targetId: string;
  revision: string;
  /** The freshness verdict the person was shown when asked. */
  freshness: "missing" | "stale" | "error";
  answer: CodeIntelConsentAnswer;
  askedAt: number;
  /** Consent is a human act — recorded, never assumed. */
  decidedBy: string;
}

/**
 * `<cacheRoot>/<targetId>/<revision>.consent.json` — a FILE beside the
 * revision directory, not inside it: freshness/pruning enumerate directories,
 * so a consent record for a never-built index stays invisible to them, and a
 * declined answer still counts as an answer on the next run in that revision.
 * Reusing `revisionDir`'s validation keeps path traversal out for free.
 */
export function consentPath(cacheRoot: string, targetId: string, revision: string): string {
  return `${revisionDir(cacheRoot, targetId, revision)}.consent.json`;
}

/** `null` when absent, unreadable, or not the recorded shape — absence reads as "never asked". */
export function readConsent(cacheRoot: string, targetId: string, revision: string): CodeIntelConsentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(consentPath(cacheRoot, targetId, revision), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (
    typeof r.targetId !== "string" || r.targetId !== targetId ||
    typeof r.revision !== "string" || r.revision !== revision ||
    (r.freshness !== "missing" && r.freshness !== "stale" && r.freshness !== "error") ||
    (r.answer !== "approved" && r.answer !== "declined") ||
    typeof r.askedAt !== "number" ||
    typeof r.decidedBy !== "string"
  ) {
    return null;
  }
  return {
    targetId: r.targetId,
    revision: r.revision,
    freshness: r.freshness,
    answer: r.answer,
    askedAt: r.askedAt,
    decidedBy: r.decidedBy,
  };
}

export function writeConsent(cacheRoot: string, record: CodeIntelConsentRecord): void {
  const file = consentPath(cacheRoot, record.targetId, record.revision);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
}

export interface IndexConsentRequest {
  targetId: string;
  targetRoot: string;
}

export interface IndexConsentDeps {
  cacheRoot?: string;
  env?: Record<string, string | undefined>;
  /** Who answered, when a person did. Free text — there is no identity system. */
  actor?: string;
  /**
   * The ask itself. `undefined` means unattended: the question is never
   * posed and the run proceeds on fallback — a missing consent record must
   * never stop a run (ADR-006 Option A).
   */
  prompt?: (question: string) => Promise<string>;
  buildIndex?: (input: { cacheRoot: string; targetId: string; targetRoot: string; revision: string }) => Promise<{ ok: boolean; detail: string }>;
  revisionOf?: (root: string) => Promise<string>;
  getStatus?: (cacheRoot: string, targetId: string, revision: string) => ProviderStatus;
  now?: () => number;
  log?: (line: string) => void;
}

export type IndexConsentSkip = "disabled" | "fresh" | "no-revision" | "already-answered" | "unattended";

export interface IndexConsentOutcome {
  asked: boolean;
  record: CodeIntelConsentRecord | null;
  /** True when the consented build ran to completion — a failed build is reported, never thrown. */
  built: boolean;
  buildDetail?: string;
  skip?: IndexConsentSkip;
}

/**
 * One target's consent flow: fresh → silent; answered revision → silent;
 * unattended → silent fallback; interactive + unanswered → ask, record, and
 * (on yes) build. Every failure degrades — the run proceeding is the
 * requirement, the index is the optimization.
 */
export async function resolveIndexConsent(request: IndexConsentRequest, deps: IndexConsentDeps = {}): Promise<IndexConsentOutcome> {
  const log = deps.log ?? (() => {});

  if (!codeIntelEnabled(deps.env)) return { asked: false, record: null, built: false, skip: "disabled" };

  let revision: string;
  try {
    revision = await (deps.revisionOf ?? resolveTargetRevision)(request.targetRoot);
  } catch {
    // No revision → no freshness verdict is even expressible; stay byte-identical to a non-git checkout.
    return { asked: false, record: null, built: false, skip: "no-revision" };
  }

  const cacheRoot = deps.cacheRoot ?? defaultCacheRoot();
  const status = (deps.getStatus ?? getStatus)(cacheRoot, request.targetId, revision);
  if (status.status === "fresh") return { asked: false, record: null, built: false, skip: "fresh" };

  const existing = readConsent(cacheRoot, request.targetId, revision);
  if (existing) return { asked: false, record: existing, built: false, skip: "already-answered" };

  if (!deps.prompt) {
    // Unattended with no record: proceed on fallback — never a prompt, never a stop.
    return { asked: false, record: null, built: false, skip: "unattended" };
  }

  const indexedRevision = status.indexedRevision ?? "(none)";
  const question = [
    `code-intel index for target "${request.targetId}" is ${status.status}:`,
    `  indexed revision: ${indexedRevision}`,
    `  current revision: ${revision}`,
    "  indexing runs the Graphify AST extractor over this checkout — it can be slow and memory-heavy on small machines.",
    "  Declining changes nothing: the run continues on native search fallback.",
    "  Build/refresh the index now? [y/N]",
  ].join("\n");
  const answer = await deps.prompt(question);
  const approved = /^y(es)?$/i.test(answer.trim());
  const record: CodeIntelConsentRecord = {
    targetId: request.targetId,
    revision,
    freshness: status.status,
    answer: approved ? "approved" : "declined",
    askedAt: deps.now?.() ?? Date.now(),
    decidedBy: deps.actor ?? "human",
  };
  writeConsent(cacheRoot, record);

  if (!approved) {
    log(`[code-intel] ${request.targetId}: declining keeps the native-search fallback for revision ${revision.slice(0, 12)}.`);
    return { asked: true, record, built: false };
  }

  let built = false;
  let buildDetail: string | undefined;
  try {
    const build = deps.buildIndex ?? buildCodeIntelIndex;
    const result = await build({ cacheRoot, targetId: request.targetId, targetRoot: request.targetRoot, revision });
    built = result.ok;
    buildDetail = result.detail;
    log(`[code-intel] ${request.targetId}: index build ${result.ok ? "finished" : "failed"} — ${result.detail}`);
  } catch (error) {
    buildDetail = error instanceof Error ? error.message : String(error);
    log(`[code-intel] ${request.targetId}: index build failed — ${buildDetail}`);
  }
  return { asked: true, record, built, buildDetail };
}

/**
 * The consented build: same default path as `scripts/reindex-code-intel.mjs`
 * (AST/code-only `graphify extract`, no LLM) straight into the cache revision
 * directory, plus the metadata sidecar every query is freshness-gated on. The
 * script's in-repo incremental `update` variant stays script-only.
 */
export async function buildCodeIntelIndex(
  input: { cacheRoot: string; targetId: string; targetRoot: string; revision: string },
  deps: { command?: string; run?: (command: string, args: string[]) => Promise<string> } = {},
): Promise<{ ok: boolean; detail: string }> {
  const run =
    deps.run ??
    ((command: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(new Error(String((error as { message?: string }).message ?? error)));
          else resolve(stdout);
        });
      }));

  const fromEnv = process.env["STA_CODE_INTEL_BIN"]?.trim();
  const command = deps.command ?? (fromEnv ? fromEnv : "graphify");
  let toolVersion = "unknown";
  try {
    toolVersion = (await run(command, ["--version"])).match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
  } catch (error) {
    return {
      ok: false,
      detail: `"${command} --version" failed (${error instanceof Error ? error.message : String(error)}) — install Graphify or point STA_CODE_INTEL_BIN at it; the run continues on native search.`,
    };
  }

  const outDir = revisionDir(input.cacheRoot, input.targetId, input.revision);
  try {
    await run(command, ["extract", input.targetRoot, "--code-only", "--no-cluster", "--out", outDir]);
  } catch (error) {
    return { ok: false, detail: `graphify extract failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  writeMetadata(input.cacheRoot, {
    provider: "graphify",
    tool_version: toolVersion,
    target_id: input.targetId,
    target_revision: input.revision,
    indexed_revision: input.revision,
    indexed_at: new Date().toISOString(),
    code_only: true,
  });
  return { ok: true, detail: `index ready at ${path.join(outDir, "graphify-out")}` };
}
