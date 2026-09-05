import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
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
  assetsForRole,
  KnowledgeBindingError,
  launchEnv,
  resolveKnowledgeBinding,
  resolveTargetBinding,
  hasKnowledgeMarkers,
  TargetBindingError,
  WORKSPACE_ROLE_LABEL,
  ROLE_WORKSPACE_KIND,
  detectWorkspaceKind,
  type KnowledgeBinding,
  type WorkspaceRole,
  type TargetBinding,
} from "./roleWorkspace.js";
import { configureKnowledgeRoot } from "../threeRepo/installation.js";
import { formatResolvedCommand, resolveBundledStaCli } from "../runtime/npmCliResolver.js";
import { environmentPrerequisites, runTargetInit } from "./initCommand.js";
import { isTargetInitialized } from "./targetMeta.js";
import { measureWorkspaceStatic, recordInteractiveSession } from "../observability/sessionRecord.js";
import { CLAUDE_SETTINGS_PATH, guardCoverage, type GuardCoverage } from "./guardSettings.js";
import { checkDocSize } from "../docs/docStructure.js";
import { resolveModule } from "../agents/moduleDocs.js";

/**
 * Role-aware execution: preflight, then hand over to the real agent runtime
 * FROM the Role Workspace.
 *
 *   ba  → cwd = knowledgeRoot. Framework ✓, Knowledge ✓ writable, tooling
 *         synced, Target never required.
 *   dev → cwd = targetRoot. Everything above plus a REQUIRED, validated
 *         Knowledge binding — a DEV session without project knowledge fails
 *         closed with recovery instructions.
 *
 * Both flows auto-initialize an unambiguous workspace on first run (init is
 * idempotent and never touches non-managed content), stop on sync conflicts
 * rather than forcing, and enforce write policy through the launch itself:
 * the session gets exactly its own workspace as cwd and an explicitly empty
 * AGENTCLAUDE_WRITABLE_WORK_ROOTS, so cross-repository writes hit the
 * block-outside-repo guard.
 */

export type RuntimeName = "claude" | "codex" | "opencode";

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
  /** An explicit candidate is offered, never silently recorded. */
  knowledgeRoot?: string;
  /** Test/UI seam for the one interactive confirmation. */
  confirmKnowledgeBinding?: (candidate: string) => Promise<boolean>;
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

function siblingKnowledgeRoot(targetRoot: string): string | undefined {
  const parent = path.dirname(targetRoot);
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name))
      .find((candidate) => candidate !== targetRoot && hasKnowledgeMarkers(candidate));
  } catch {
    return undefined;
  }
}

async function confirmKnowledgeBinding(candidate: string, options: RoleRunOptions): Promise<boolean> {
  if (options.confirmKnowledgeBinding) return options.confirmKnowledgeBinding(candidate);
  // Headless executions preserve the existing fail-closed behaviour: no prompt
  // and, critically, no write to installation-local state.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await readline.question(`[software-team-agents] Use sibling Knowledge repository "${candidate}" on this machine? [y/N] `)).trim());
  } finally {
    readline.close();
  }
}

async function offerKnowledgeBinding(options: RoleRunOptions): Promise<boolean> {
  const roots = resolveRoots({ targetRoot: options.targetRoot });
  const config = loadTargetConfig(roots.targetRoot);
  if (config?.knowledge?.path) return false; // workspace binding always wins
  try {
    if (resolveKnowledgeBinding({ targetRoot: roots.targetRoot, installationConfigPath: options.installationConfigPath })) return false;
  } catch {
    return false; // invalid existing state must be repaired explicitly, never replaced
  }
  const candidate = options.knowledgeRoot ?? siblingKnowledgeRoot(roots.targetRoot);
  if (!candidate || !hasKnowledgeMarkers(candidate)) return false;
  if (!(await confirmKnowledgeBinding(candidate, options))) return false;
  configureKnowledgeRoot(candidate, options.installationConfigPath, roots.frameworkRoot);
  return true;
}

function defaultProbe(cmd: string): { available: boolean; detail?: string } {
  const result = nodeSpawnSync(cmd, ["--version"], { encoding: "utf8", shell: process.platform === "win32", timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return { available: false, detail: `"${cmd} --version" failed — install ${cmd} and make sure it is on PATH` };
  }
  return { available: true, detail: (result.stdout ?? "").trim().split("\n")[0] };
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
  /** Resolved for DEV (required); also reported for BA when a machine-wide binding exists (informational only). */
  knowledge?: KnowledgeBinding;
  /** Resolved for BA when `target.target_id` is set and resolves; always optional, never blocks a BA session. */
  target?: TargetBinding;
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
  const expectedKind = ROLE_WORKSPACE_KIND[role];
  checks.push({ name: "Workspace", ok: true, detail: roots.targetRoot });

  const config = loadTargetConfig(roots.targetRoot);
  const initialized = isTargetInitialized(roots.targetRoot);

  // Role/workspace agreement. An uninitialized workspace initializes here —
  // init is safe by construction — but only when its markers agree with the
  // command; anything else is told how to say what it wants explicitly.
  if (!initialized) {
    const kind = detectWorkspaceKind(roots.targetRoot);
    if (kind === "ambiguous") {
      fail(`${WORKSPACE_ROLE_LABEL[role]} workspace`, "repository is ambiguous (Knowledge and application markers both present) — run software-team-agents init --role <ba|dev> explicitly");
    }
    if (kind !== expectedKind && kind !== "unrecognized") {
      fail(
        `${WORKSPACE_ROLE_LABEL[role]} workspace`,
        `this repository looks like a ${kind === "knowledge" ? "Knowledge" : "Target"} repository — run \`software-team-agents init --role ${kind === "knowledge" ? "ba" : "dev"}\` there instead`,
      );
    }
    runTargetInit({ targetRoot: roots.targetRoot, templatesDir: options.templatesDir, now: options.now ?? new Date().toISOString(), role });
    checks.push({ name: "Initialization", ok: true, detail: `auto-initialized as ${WORKSPACE_ROLE_LABEL[role]} workspace` });
  } else {
    if (!config) {
      fail("Initialization", ".agent-team/config.yaml is missing although manifest.json exists — restore it or delete .agent-team and re-init");
    }
    if (config && config.role && config.role !== role) {
      fail(
        `${WORKSPACE_ROLE_LABEL[role]} workspace`,
        `this workspace is registered as ${WORKSPACE_ROLE_LABEL[config.role as WorkspaceRole]} — use software-team-agents ${config.role}, or re-init with --role ${role} if that was wrong`,
      );
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
      include: assetsForRole(role),
      installationConfigPath: options.installationConfigPath,
    });
    const plan = planSync({
      targetRoot: roots.targetRoot,
      templatesDir,
      manifest,
      config,
      include: assetsForRole(role),
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
      const result = runTargetSync({ targetRoot: roots.targetRoot, templatesDir, manifest, config, include: assetsForRole(role), role, installationConfigPath: options.installationConfigPath, now: options.now ?? new Date().toISOString() });
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

  // Role dependencies.
  /** Set exactly when role === "dev" and the binding resolved — the required-dependency result. */
  let devKnowledge: KnowledgeBinding | undefined;
  /** Set exactly when role === "ba" and a Target binding resolved; always optional. */
  let baTarget: TargetBinding | undefined;
  if (role === "dev") {
    const resolved: KnowledgeBinding | undefined = (() => {
      try {
        return resolveKnowledgeBinding({
          targetRoot: roots.targetRoot,
          configKnowledgePath: config?.knowledge?.path,
          installationConfigPath: options.installationConfigPath,
        });
      } catch (e) {
        if (e instanceof KnowledgeBindingError) fail("Knowledge", e.message);
        throw e;
      }
    })();
    if (!resolved) {
      fail(
        "Knowledge",
        "no Knowledge repository bound to this Target — set knowledge.path in .agent-team/config.yaml (e.g. ../project-knowledge) or run `sta configure knowledge-root <path>` once on this machine",
      );
    }
    devKnowledge = resolved;
    checks.push({ name: "Knowledge", ok: true, detail: `${resolved.knowledgeRoot} (via ${resolved.via})` });
    // A valid, marker-complete binding still leaves the BA workspace role
    // entirely unusable if nobody ever ran `init --role ba` there. DEV reads
    // Knowledge fine either way (it only needs the markers), so this is a
    // note, not a failing check.
    if (!isTargetInitialized(resolved.knowledgeRoot)) {
      checks.push({
        name: "Knowledge (BA workspace role)",
        ok: true,
        detail: `bound but not initialized as a BA workspace — the BA workspace role is unusable on this machine until: cd "${resolved.knowledgeRoot}" && software-team-agents init --role ba`,
      });
    }
    checks.push({ name: "Target writable", ok: true, detail: roots.targetRoot });
  } else {
    // BA: Target optional (T-ROLE-07) — a machine-wide binding may exist and is
    // reported informationally, never required, and never blocks the session.
    try {
      resolveKnowledgeBinding({ targetRoot: roots.targetRoot, installationConfigPath: options.installationConfigPath });
    } catch {
      // informational only — never blocks a BA session
    }
    // An optional Target binding lets BA read the real app repo (schema.prisma,
    // code) without ever requiring it. Any problem is reported as a
    // non-blocking check, like the "Knowledge (BA workspace role)" note above —
    // it is never a reason to fail preflight.
    try {
      const resolved = resolveTargetBinding({
        knowledgeRoot: roots.targetRoot,
        configTargetId: config?.target?.target_id,
        frameworkRoot: roots.frameworkRoot,
      });
      if (resolved) {
        baTarget = resolved;
        checks.push({
          name: "Target (BA workspace role)",
          ok: true,
          detail: `${resolved.targetRoot} (via ${resolved.via}, read-only)`,
        });
      }
      // The removed committed path is stripped by the schema, so say so here
      // too: without it a workspace that still sets it only sees its Target
      // quietly missing. Non-blocking, like every check in this block — a BA
      // Target binding is optional by design.
      const legacy = removedTargetPath(roots.targetRoot);
      if (legacy !== undefined) {
        checks.push({ name: "Target (BA workspace role)", ok: true, detail: removedTargetPathProblem(legacy) });
      }
    } catch (e) {
      if (e instanceof TargetBindingError) {
        checks.push({ name: "Target (BA workspace role)", ok: true, detail: e.message });
      } else {
        throw e;
      }
    }

    // The same `--check-doc-size` ceiling as a non-blocking note: a BA is
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
  }

  const probe = options.probe ?? defaultProbe;
  for (const prerequisite of environmentPrerequisites(launchRuntime, probe)) {
    if (!prerequisite.ok) fail(prerequisite.name, `${prerequisite.detail} — ${prerequisite.fix}`);
    checks.push({ name: prerequisite.name, ok: true, detail: prerequisite.detail });
  }

  return { checks, role, workspaceRoot: roots.targetRoot, frameworkRoot: roots.frameworkRoot, templatesDir, knowledge: devKnowledge, target: baTarget, runtime: launchRuntime, guards: coverage };
}

/** DEV-only aliases kept for the original callers/tests. */
export const devPreflight = (options: RoleRunOptions = {}): WorkspaceContext => workspacePreflight("dev", options);

export type DevOptions = RoleRunOptions;

/**
 * Full flow for a role: preflight → launch. Resolves to the launched runtime's
 * exit code; a preflight failure resolves to 1 without launching anything.
 */
async function runRoleSession(role: WorkspaceRole, options: RoleRunOptions): Promise<number> {
  let ctx: WorkspaceContext;
  try {
    try {
      ctx = workspacePreflight(role, options);
    } catch (error) {
      if (role !== "dev" || !(error instanceof PreflightError) || error.failed.name !== "Knowledge" || !(await offerKnowledgeBinding(options))) throw error;
      ctx = workspacePreflight(role, options);
    }
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
  const measurement = measureWorkspaceStatic(ctx.workspaceRoot, role, ctx.runtime);
  try {
    const sta = resolveBundledStaCli(ctx.frameworkRoot);
    const contextCommand = sta ? `${formatResolvedCommand(sta)} context` : undefined;
    return await launch(
      ctx.runtime,
      [],
      ctx.workspaceRoot,
      launchEnv(role, process.env, ctx.knowledge?.knowledgeRoot, ctx.target?.targetRoot, contextCommand),
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

export const runDev = (options: RoleRunOptions = {}): Promise<number> => runRoleSession("dev", options);
export const runBa = (options: RoleRunOptions = {}): Promise<number> => runRoleSession("ba", options);
