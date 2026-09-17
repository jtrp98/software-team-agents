import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest } from "../packaging/templateManifest.js";
import { resolveRoots } from "./roots.js";
import {
  TargetNotInitializedError,
  loadTargetConfig,
  readTargetManifest,
  removedTargetPath,
  removedTargetPathProblem,
} from "./targetMeta.js";
import { blockingConflicts, devDerivedContent, pendingSyncEntries, planSync, projectOwnedPaths, runTargetSync } from "./syncEngine.js";
import { sameMajor } from "./version.js";
import {
  KnowledgeBindingError,
  launchEnv,
  resolveKnowledgeBinding,
  resolveTargetBinding,
  resolveSessionTargetWorkRoots,
  TargetBindingError,
  WORKSPACE_ROLE_LABEL,
  detectWorkspaceKind,
  type KnowledgeBinding,
  type WorkspaceRole,
  type TargetBinding,
} from "./roleWorkspace.js";
import { loadLocalTargetMapping, LocalTargetMappingError, localTargetsPath } from "../threeRepo/localTargets.js";
import { loadTargetRegistry, type TargetRegistry } from "../threeRepo/targets.js";
import type { GuardTargetWorkRoot } from "../agents/pathPermissions.js";
import { formatResolvedCommand, resolveBundledStaCli } from "../runtime/npmCliResolver.js";
import { environmentPrerequisites, probeRuntime, runTargetInit, runtimeCommand } from "./initCommand.js";
import { isTargetInitialized } from "./targetMeta.js";
import { measureWorkspaceStatic, recordInteractiveSession } from "../observability/sessionRecord.js";
import { CLAUDE_SETTINGS_PATH, guardCoverage, type GuardCoverage } from "./guardSettings.js";
import { checkDocSize } from "../docs/docStructure.js";
import { resolveModule } from "../agents/moduleDocs.js";

/**
 * Session launch: preflight, then hand over to the real agent runtime from
 * the invoking workspace. Since the lane collapse the workspace IS the
 * Knowledge root, so the preflight decides from what the session actually
 * uses — the Target mapping it binds and the selected runtime's guard
 * coverage — never from the recorded role. With `software-team-agents open`
 * (V10 TASK-026) there is no lane input left at all: the role is only the
 * workspace's own recorded identity, read back from its config to label the
 * launch and keep sync rendering consistent with what the workspace already
 * carries. A recorded role admits nothing and refuses nothing.
 *
 * The session auto-initializes an unambiguous workspace on first run (init is
 * idempotent and never touches non-managed content), stops on sync conflicts
 * rather than forcing, and enforces write policy through the launch itself:
 * the session gets exactly its own workspace as cwd and an explicitly empty
 * STA_WRITABLE_WORK_ROOTS, so cross-repository writes hit the
 * block-outside-repo guard.
 */

export type RuntimeName = "claude" | "codex" | "opencode" | "antigravity";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RoleRunOptions {
  targetRoot?: string;
  templatesDir?: string;
  runtime?: RuntimeName;
  /** Sync managed files automatically when the plan is conflict-free (default true). */
  autoSync?: boolean;
  /**
   * Deliberately accept a session on a runtime that enforces no guard. Never
   * a default and never implicit: without it, an unguarded runtime fails
   * preflight. It cannot excuse a *broken* guard mechanism.
   */
  allowUnguardedRuntime?: boolean;
  now?: string;
  /** Overrides where the machine-wide installation binding is read from (tests; unusual setups). */
  installationConfigPath?: string;
  /** Test seams. */
  probe?: (cmd: string) => { available: boolean; detail?: string };
  launch?: (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<number>;
  /** Observability seam: callers/tests may replace the fail-open recorder, never the launch flow. */
  recordSession?: typeof recordInteractiveSession;
}

export class PreflightError extends Error {
  constructor(
    public readonly checks: PreflightCheck[],
    public readonly failed: PreflightCheck,
  ) {
    super(`${failed.name}: ${failed.detail ?? "failed"}`);
  }
}

function defaultLaunch(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32";
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    const child = nodeSpawn([cmd, ...quoted].join(" "), { cwd, stdio: "inherit", shell, env });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export interface WorkspaceContext {
  checks: PreflightCheck[];
  role: WorkspaceRole;
  /** The Role Workspace the session will execute from. */
  workspaceRoot: string;
  frameworkRoot: string;
  templatesDir: string;
  /** Resolved when a Knowledge binding exists — context only, never required: the session runs from the Knowledge workspace itself. */
  knowledge?: KnowledgeBinding;
  /** Resolved when the workspace config names a `target_id` that resolves; informational, never blocks a session. */
  target?: TargetBinding;
  /** Every Target this machine maps, read-only, for the session's guard channel (V10 TASK-023). Empty when none map. */
  targetWorkRoots: GuardTargetWorkRoot[];
  runtime: RuntimeName;
  /** The guard verdict this launch was allowed under, for the launch record. */
  guards: GuardCoverage;
}

/**
 * The full preflight for one role, ordered cheapest-first. Throws
 * PreflightError naming the first failing check; returns everything the
 * launch step needs otherwise.
 */
export function workspacePreflight(role: WorkspaceRole, options: RoleRunOptions = {}): WorkspaceContext {
  const checks: PreflightCheck[] = [];
  // A function declaration, not a const arrow: TS applies never-return CFA
  // (callers may rely on post-fail narrowing) only to this form.
  function fail(name: string, detail: string): never {
    const failed: PreflightCheck = { name, ok: false, detail };
    throw new PreflightError([...checks, failed], failed);
  }

  const roots = (() => {
    try {
      return resolveRoots({ targetRoot: options.targetRoot });
    } catch (e) {
      return fail("Workspace", e instanceof Error ? e.message : String(e));
    }
  })();
  checks.push({ name: "Workspace", ok: true, detail: roots.targetRoot });

  const config = loadTargetConfig(roots.targetRoot);
  const initialized = isTargetInitialized(roots.targetRoot);

  // Workspace admission. An uninitialized workspace initializes here — init
  // is safe by construction — but only when its markers say it is a Knowledge
  // workspace (or say nothing at all): a session's cwd is the Knowledge
  // workspace, so an application checkout is told where sessions live instead
  // of being materialized. An already-initialized workspace opens whatever it
  // recorded — the recorded role decides nothing anymore (V10 TASK-026).
  if (!initialized) {
    const kind = detectWorkspaceKind(roots.targetRoot);
    if (kind === "ambiguous") {
      fail(
        `${WORKSPACE_ROLE_LABEL[role]} workspace`,
        'repository is ambiguous (Knowledge and application markers both present) — record which it is by setting "role: ba" or "role: dev" in .agent-team/config.yaml, then re-run',
      );
    }
    if (kind === "target") {
      fail(
        `${WORKSPACE_ROLE_LABEL[role]} workspace`,
        "this repository looks like a Target checkout — sessions open from the Knowledge workspace (`software-team-agents open` there); bind this checkout through .workflow/targets.local.yaml instead of initializing it",
      );
    }
    runTargetInit({ targetRoot: roots.targetRoot, templatesDir: options.templatesDir, now: options.now ?? new Date().toISOString(), role });
    checks.push({ name: "Initialization", ok: true, detail: `auto-initialized as ${WORKSPACE_ROLE_LABEL[role]} workspace` });
  } else {
    if (!config) {
      fail("Initialization", ".agent-team/config.yaml is missing although manifest.json exists — restore it or delete .agent-team and re-init");
    }
    checks.push({ name: "Initialization", ok: true });
  }

  const templatesDir = options.templatesDir ?? path.join(roots.frameworkRoot, "templates");
  let syncedVersion: string;
  try {
    syncedVersion = readTargetManifest(roots.targetRoot).framework_version;
  } catch (e) {
    if (e instanceof TargetNotInitializedError) fail("Initialization", e.message);
    throw e;
  }

  const installedVersion = readTemplateManifest(templatesDir).framework_version;
  if (!sameMajor(syncedVersion, installedVersion)) {
    fail(
      "Framework compatibility",
      `workspace synced Framework ${syncedVersion} but ${installedVersion} is installed — different majors are not guaranteed compatible. Re-run software-team-agents sync.`,
    );
  }
  checks.push({ name: "Framework compatibility", ok: true, detail: installedVersion });

  // Guard files being present is not evidence that the runtime will execute
  // them. Check effective coverage before any auto-sync so an already-installed
  // but unregistered guard fails closed with this exact diagnosis.
  //
  // This consults the verdict for whichever runtime is launching, not only
  // Claude. A runtime with no mechanism at all (`unguarded`) stops the launch
  // unless the user acknowledges it explicitly; a *broken* mechanism is never
  // acknowledgeable, because it is a repairable fault rather than a deliberate
  // choice, and letting a flag past it would weaken a guard that is enforced
  // today.
  const launchRuntime = options.runtime ?? "claude";
  const coverage = guardCoverage({
    runtime: launchRuntime,
    targetRoot: roots.targetRoot,
    templatesDir,
    manifest: readTargetManifest(roots.targetRoot),
    config: loadTargetConfig(roots.targetRoot),
  });
  const wiring = coverage.wiring;
  if (coverage.level === "broken") {
    if (wiring?.settingsError) {
      fail("Guards wired", `${wiring.settingsError} — run software-team-agents sync; if deliberate, claim ${CLAUDE_SETTINGS_PATH} in overrides`);
    }
    const missing = (wiring?.missingRegistrations ?? []).map((registration) => `${registration.event}:${registration.hookPath}`).join(", ");
    fail(
      "Guards wired",
      wiring
        ? `${wiring.hooksRegistered}/${wiring.hooksInstalled} Framework guard registration(s) active; missing ${missing} — run software-team-agents sync`
        : `${launchRuntime}: ${coverage.detail} — run software-team-agents sync`,
    );
  }
  if (coverage.level === "unguarded") {
    if (!options.allowUnguardedRuntime) {
      fail(
        "Guards wired",
        `${launchRuntime} enforces no guard in this workspace — ${coverage.detail}. ` +
          "Re-run with --allow-unguarded-runtime to accept an unguarded session deliberately, or launch with --runtime claude.",
      );
    }
    checks.push({
      name: "Guards wired",
      ok: true,
      detail: `${launchRuntime}: UNGUARDED, acknowledged via --allow-unguarded-runtime — ${coverage.detail}`,
    });
  } else if (coverage.level === "not-required") {
    checks.push({
      name: "Guards wired",
      ok: true,
      detail: wiring?.overridden
        ? `${CLAUDE_SETTINGS_PATH} is in overrides — explicit user choice; Framework guards are not required`
        : "0/0 Framework guard registrations shipped for this profile",
    });
  } else {
    checks.push({
      name: "Guards wired",
      ok: true,
      detail: wiring
        ? `${wiring.hooksRegistered}/${wiring.hooksInstalled} Framework guard registration(s) active`
        : `${launchRuntime}: ${coverage.detail}`,
    });
  }

  // Managed-file integrity under this role's asset profile: auto-sync only
  // what is provably safe; a conflict stops everything (no forced sync behind
  // the user's back).
  try {
    const manifest = readTargetManifest(roots.targetRoot);
    // Plan against rendered bytes so a dev workspace's CLAUDE.md is judged by
    // what sync actually writes there, not by the shipped template.
    const derived = devDerivedContent({
      targetRoot: roots.targetRoot,
      templatesDir,
      config,
      installationConfigPath: options.installationConfigPath,
    });
    const plan = planSync({
      targetRoot: roots.targetRoot,
      templatesDir,
      manifest,
      config,
      role,
      derivedContent: derived?.content,
    });
    // Gate on the same rule `sync` gates on — see isBlockingConflict. A path
    // the project owns is reported, never a reason to refuse the launch.
    const blocking = blockingConflicts(plan);
    if (blocking.length > 0) {
      const names = blocking.map((c) => c.path).join(", ");
      fail("Managed files", `sync conflicts in ${names} — run software-team-agents sync to review them`);
    }
    const owned = projectOwnedPaths(plan);
    const ownedNote = owned.length > 0 ? `; ${owned.length} project-owned path(s) left alone: ${owned.join(", ")}` : "";
    const pending = pendingSyncEntries(plan);
    if (pending.length > 0) {
      const named = pending.slice(0, 10).map((entry) => `${entry.action}: ${entry.path}`).join(", ");
      const remainder = pending.length > 10 ? `, ... ${pending.length - 10} more` : "";
      if (options.autoSync === false) {
        fail("Managed files", `managed assets are outdated (${named}${remainder}) — run software-team-agents sync, or drop --no-auto-sync`);
      }
      const result = runTargetSync({ targetRoot: roots.targetRoot, templatesDir, manifest, config, role, installationConfigPath: options.installationConfigPath, now: options.now ?? new Date().toISOString() });
      const changed = result.performed.filter((entry) => entry.action !== "unchanged" && entry.action !== "override");
      const changedNames = changed.slice(0, 10).map((entry) => `${entry.action}: ${entry.path}`).join(", ");
      const changedRemainder = changed.length > 10 ? `, ... ${changed.length - 10} more` : "";
      checks.push({ name: "Managed files", ok: true, detail: `auto-synced to Framework ${plan.frameworkVersion}; changed ${changed.length}: ${changedNames}${changedRemainder}${ownedNote}` });
    } else {
      checks.push({ name: "Managed files", ok: true, detail: `up to date${ownedNote}` });
    }
  } catch (e) {
    if (e instanceof PreflightError) throw e;
    fail("Managed files", e instanceof Error ? e.message : String(e));
  }

  // Session dependencies — one path for every session (V10 TASK-027): the
  // workspace is the Knowledge root, so what must hold is that the Target
  // mapping it owns resolves on this machine, not that a role-labeled binding
  // exists. A Knowledge binding is context (where STA_KNOWLEDGE_ROOT points
  // when the session itself is not the bound root), never a requirement.
  let knowledge: KnowledgeBinding | undefined;
  let target: TargetBinding | undefined;
  try {
    knowledge = resolveKnowledgeBinding({
      targetRoot: roots.targetRoot,
      configKnowledgePath: config?.knowledge?.path,
      installationConfigPath: options.installationConfigPath,
    });
  } catch (e) {
    if (!(e instanceof KnowledgeBindingError)) throw e;
    checks.push({
      name: "Knowledge",
      ok: true,
      detail: `${e.message} — advisory only; this session runs from its own Knowledge workspace, which needs no binding`,
    });
  }
  if (knowledge) {
    checks.push({ name: "Knowledge", ok: true, detail: `${knowledge.knowledgeRoot} (via ${knowledge.via})` });
  }

  // The Knowledge root the session reads its mapping from: the workspace
  // itself, unless a resolved binding names another root (a session whose cwd
  // is not yet the Knowledge workspace).
  const knowledgeHome = knowledge?.knowledgeRoot ?? roots.targetRoot;

  // The required dependency: a mapping file that exists must describe Targets
  // this machine can actually use — existing path, standalone repo, no
  // overlap, all owned by `loadLocalTargetMapping`. No mapping file is the
  // ordinary no-Target session and opens fine.
  if (fs.existsSync(localTargetsPath(knowledgeHome))) {
    let registry: TargetRegistry;
    try {
      registry = loadTargetRegistry(knowledgeHome);
    } catch (e) {
      fail("Targets", `${e instanceof Error ? e.message : String(e)} — fix targets.yaml in ${knowledgeHome} before opening a session`);
    }
    try {
      const sessionTargets = loadLocalTargetMapping(knowledgeHome, registry, roots.frameworkRoot);
      const ids = sessionTargets.map((entry) => entry.target_id).join(", ");
      checks.push({ name: "Targets", ok: true, detail: ids.length > 0 ? `${ids} resolve on this machine` : "the mapping declares no Target" });
    } catch (e) {
      if (e instanceof LocalTargetMappingError) {
        fail("Targets", `${e.message} — fix ${localTargetsPath(knowledgeHome)} before opening a session`);
      }
      throw e;
    }
  }

  // An optional Target binding via the workspace config stays informational:
  // it lets a session read the real app repo without ever requiring it. Any
  // problem is reported as a non-blocking check — it is never a reason to
  // fail preflight.
  try {
    const resolved = resolveTargetBinding({
      knowledgeRoot: knowledgeHome,
      configTargetId: config?.target?.target_id,
      frameworkRoot: roots.frameworkRoot,
    });
    if (resolved) {
      target = resolved;
      checks.push({ name: "Target", ok: true, detail: `${resolved.targetRoot} (via ${resolved.via}, read-only)` });
    }
    // The removed committed path is stripped by the schema, so say so here
    // too: without it a workspace that still sets it only sees its Target
    // quietly missing. Non-blocking, like every check in this block.
    const legacy = removedTargetPath(roots.targetRoot);
    if (legacy !== undefined) {
      checks.push({ name: "Target", ok: true, detail: removedTargetPathProblem(legacy) });
    }
  } catch (e) {
    if (e instanceof TargetBindingError) {
      checks.push({ name: "Target", ok: true, detail: e.message });
    } else {
      throw e;
    }
  }

  // The same `--check-doc-size` ceiling as a non-blocking note: a session is
  // never stopped by document growth, only told about it, since blocking
  // here would stand in the way of the very work needed to fix it (the CI
  // wiring that does block lives in the BA workflow).
  // Scoped to the one module `resolveModule` can resolve with no hint, the
  // same "never guess among candidates" rule `sta context` already applies —
  // an ambiguous or empty workspace measures nothing rather than the whole
  // repository, so preflight stays fast.
  const moduleResolution = resolveModule(roots.targetRoot);
  if (moduleResolution.status === "one") {
    const sizeResult = checkDocSize(roots.targetRoot, moduleResolution.module);
    checks.push({
      name: "Document size",
      ok: true,
      detail: sizeResult.problems.length === 0
        ? `${moduleResolution.module}: every document and section is inside its byte ceiling`
        : `${moduleResolution.module}: ${sizeResult.problems.length} over ceiling — ${sizeResult.problems.join("; ")}`,
    });
  }

  const probe = options.probe ?? probeRuntime;
  for (const prerequisite of environmentPrerequisites(launchRuntime, probe)) {
    if (!prerequisite.ok) fail(prerequisite.name, `${prerequisite.detail} — ${prerequisite.fix}`);
    checks.push({ name: prerequisite.name, ok: true, detail: prerequisite.detail });
  }

  // The mapping lives in the Knowledge root: the workspace's own, or the bound
  // one when this session's cwd is not yet the Knowledge workspace.
  const targetWorkRoots = resolveSessionTargetWorkRoots({
    knowledgeRoot: knowledgeHome,
    workspaceRoot: roots.targetRoot,
    frameworkRoot: roots.frameworkRoot,
  });
  if (targetWorkRoots.length > 0) {
    checks.push({
      name: "Targets (read-only)",
      ok: true,
      detail: `${targetWorkRoots.map((entry) => entry.targetId).join(", ")} — readable from this session; writing one is refused, run the stage instead`,
    });
  }

  return { checks, role, workspaceRoot: roots.targetRoot, frameworkRoot: roots.frameworkRoot, templatesDir, knowledge, target, targetWorkRoots, runtime: launchRuntime, guards: coverage };
}

/** Kept as the test seam for role-independence: the role passed here is the workspace's recorded identity, never a lane input. */
export const devPreflight = (options: RoleRunOptions = {}): WorkspaceContext => workspacePreflight("dev", options);

export type DevOptions = RoleRunOptions;

/**
 * The workspace's own recorded role, for the single entry command. It labels
 * the launch and keeps sync rendering consistent with what the workspace
 * already carries; it never decides admission (V10 TASK-026). An uninitialized
 * workspace has no recording yet, so the auto-init default applies.
 */
function recordedSessionRole(options: RoleRunOptions): WorkspaceRole {
  try {
    const recorded = loadTargetConfig(resolveRoots({ targetRoot: options.targetRoot }).targetRoot)?.role;
    if (recorded === "ba" || recorded === "dev") return recorded;
  } catch {
    // Preflight reports the Workspace problem itself; the default keeps the
    // failure message shaped like every other launch.
  }
  return "ba";
}

/**
 * Full flow for the one session kind: preflight → launch. Resolves to the
 * launched runtime's exit code; a preflight failure resolves to 1 without
 * launching anything.
 */
async function runRoleSession(role: WorkspaceRole, options: RoleRunOptions): Promise<number> {
  let ctx: WorkspaceContext;
  try {
    ctx = workspacePreflight(role, options);
  } catch (e) {
    if (e instanceof PreflightError) {
      console.error("[software-team-agents] preflight failed:");
      for (const c of e.checks) console.error(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      return 1;
    }
    throw e;
  }
  for (const c of ctx.checks) console.log(`[software-team-agents] ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  // An acknowledged unguarded launch is recorded as such on the launch line
  // itself, so the session's own transcript states that none of the six
  // guards was active.
  const unguarded = ctx.guards.level === "unguarded" ? " [UNGUARDED SESSION — acknowledged]" : "";
  console.log(`[software-team-agents] starting ${ctx.runtime} (${WORKSPACE_ROLE_LABEL[role]})${unguarded} from ${ctx.workspaceRoot} ...`);
  const launch = options.launch ?? defaultLaunch;
  const startedAt = Date.now();
  // Measure before the runtime starts: an interactive session may edit its own
  // project instructions, but telemetry must describe the bytes it launched with.
  const measurement = measureWorkspaceStatic(ctx.workspaceRoot, ctx.runtime);
  try {
    const sta = resolveBundledStaCli(ctx.frameworkRoot);
    const contextCommand = sta ? `${formatResolvedCommand(sta)} context` : undefined;
    return await launch(
      runtimeCommand(ctx.runtime),
      [],
      ctx.workspaceRoot,
      launchEnv(role, process.env, ctx.knowledge?.knowledgeRoot, ctx.target?.targetRoot, contextCommand, ctx.targetWorkRoots),
    );
  } finally {
    const record = options.recordSession ?? recordInteractiveSession;
    try {
      record({ workspaceRoot: ctx.workspaceRoot, role, runtime: ctx.runtime, startedAt, endedAt: Date.now(), measurement });
    } catch (error) {
      // A custom recorder is no more authoritative than the production one.
      console.error(`[software-team-agents] could not record interactive session telemetry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The single session entry (V10 TASK-026): `software-team-agents open`. */
export const runSession = (options: RoleRunOptions = {}): Promise<number> => runRoleSession(recordedSessionRole(options), options);
