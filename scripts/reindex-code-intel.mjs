#!/usr/bin/env node
/**
 * Manual re-index for the optional Graphify code-intelligence provider
 * (`orchestrator/src/codeintel/`). Deliberately NOT wired to a git hook —
 * `freshness.ts`'s policy is "build is opt-in, never automatic", and a
 * post-commit hook would burn a full LLM extraction (`graphify extract`,
 * no `--code-only`) on every trivial commit. Run this by hand instead,
 * before a real `sta run`/`sta bounded-run` round or after pulling a
 * batch of upstream changes.
 *
 * Usage:
 *   node scripts/reindex-code-intel.mjs <target-id> <target-root> [--full]
 *
 *   <target-root> MUST be the Target's repo root — the same path a DEV
 *   workspace's own `targetRoot` resolves to (`contextCommand.ts`'s
 *   `role === "dev"` branch: `input.projectRoot` itself, never a stack
 *   `source_roots` subdirectory). Indexing a subdirectory instead makes
 *   every candidate path in the graph misaligned with the root the
 *   resolver reads real source through — candidates still list a
 *   file:line, but source verification silently fails and no `Signature:`
 *   ever appears (caught for real on sb-web-student: 2026-09-14).
 *
 *   --full   force a full `graphify extract` (semantic, needs an LLM
 *            backend) instead of the default `--code-only` AST pass, for
 *            a target that has never been indexed before.
 *
 * Two paths, chosen automatically:
 *   - <target-root>/graphify-out/graph.json already exists (a target that
 *     already carries its own full extraction, e.g. one indexed directly
 *     by a developer) → `graphify update <target-root>` refreshes it
 *     in place (incremental, no LLM), then it is copied into the cache.
 *   - otherwise → `graphify extract <target-root> [--code-only] --no-cluster
 *     --out <cache-dir>` writes straight into the cache location.
 *
 * Either way this writes `graphify-metadata.yaml` itself (the freshness
 * sidecar `orchestrator/src/codeintel/freshness.ts` gates every query on)
 * stamped with the Target's current HEAD — the one step a plain `graphify`
 * invocation never does on its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

function fail(message) {
  console.error(`[reindex-code-intel] ${message}`);
  process.exit(1);
}

const [, , targetId, targetRoot, ...rest] = process.argv;
const full = rest.includes("--full");

if (!targetId || !targetRoot) {
  fail("usage: node scripts/reindex-code-intel.mjs <target-id> <target-root> [--full]");
}
if (!fs.existsSync(targetRoot)) {
  fail(`target root does not exist: ${targetRoot}`);
}

const resolvedTargetRoot = path.resolve(targetRoot);

function defaultCacheRoot() {
  const fromEnv = process.env.STA_CODE_INTEL_CACHE_ROOT;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "software-team-agents", "cache", "code-intelligence");
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "software-team-agents", "cache", "code-intelligence");
}

const graphifyBin = process.env.STA_CODE_INTEL_BIN?.trim() || "graphify";

function run(args, cwd) {
  console.log(`[reindex-code-intel] $ ${graphifyBin} ${args.join(" ")}`);
  execFileSync(graphifyBin, args, { cwd, stdio: "inherit", windowsHide: true });
}

function graphifyVersion() {
  try {
    const out = execFileSync(graphifyBin, ["--version"], { windowsHide: true }).toString("utf8");
    return /v?(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "unknown";
  } catch {
    fail(`could not run "${graphifyBin} --version" — is Graphify installed and STA_CODE_INTEL_BIN/PATH correct?`);
  }
}

function revisionOf(root) {
  const rev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true }).toString("utf8").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(rev)) fail(`could not resolve HEAD revision of ${root}`);
  return rev;
}

function writeMetadata(cacheDir, { toolVersion, revision, codeOnly }) {
  const body = [
    "provider: graphify",
    `tool_version: ${toolVersion}`,
    `target_id: ${targetId}`,
    `target_revision: ${revision}`,
    `indexed_revision: ${revision}`,
    `indexed_at: ${new Date().toISOString()}`,
    `code_only: ${codeOnly}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(cacheDir, "graphify-metadata.yaml"), body, "utf8");
}

const revision = revisionOf(resolvedTargetRoot);
const toolVersion = graphifyVersion();
const cacheDir = path.join(defaultCacheRoot(), targetId, revision);
const cacheGraphOut = path.join(cacheDir, "graphify-out");
const inRepoGraph = path.join(resolvedTargetRoot, "graphify-out", "graph.json");

fs.mkdirSync(cacheDir, { recursive: true });

if (fs.existsSync(inRepoGraph)) {
  console.log(`[reindex-code-intel] found existing in-repo graph — refreshing incrementally (no LLM)`);
  run(["update", resolvedTargetRoot], undefined);
  fs.rmSync(cacheGraphOut, { recursive: true, force: true });
  fs.cpSync(path.join(resolvedTargetRoot, "graphify-out"), cacheGraphOut, { recursive: true });
  writeMetadata(cacheDir, { toolVersion, revision, codeOnly: false });
} else {
  const extractArgs = ["extract", resolvedTargetRoot, "--no-cluster", "--out", cacheDir];
  if (!full) extractArgs.splice(2, 0, "--code-only");
  run(extractArgs, undefined);
  writeMetadata(cacheDir, { toolVersion, revision, codeOnly: !full });
}

console.log(`[reindex-code-intel] ${targetId} @ ${revision} — index ready at ${cacheGraphOut}`);
