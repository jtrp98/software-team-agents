import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import * as path from "node:path";
import { readTemplateManifest } from "../packaging/templateManifest.js";
import { resolveRoots } from "./roots.js";
import {
  TargetNotInitializedError,
  loadTargetConfig,
  readTargetManifest,
} from "./targetMeta.js";
import { blockingConflicts, devDerivedContent, planSync, projectOwnedPaths, runTargetSync } from "./syncEngine.js";
import { sameMajor } from "./version.js";
import {
  assetsForRole,
  KnowledgeBindingError,
  launchEnv,
  resolveKnowledgeBinding,
  resolveTargetBinding,
  TargetBindingError,
  ROLE_LABEL,
  ROLE_WORKSPACE_KIND,
  detectWorkspaceKind,
  type KnowledgeBinding,
  type RoleName,
  type TargetBinding,
} from "./roleWorkspace.js";
import { runTargetInit } from "./initCommand.js";
import { isTargetInitialized } from "./targetMeta.js";

/**
 * T-ROLE-03 / T-ROLE-04 / T-ROLE-19 — role-aware execution: preflight, then
 * hand over to the real agent runtime FROM the Role Workspace.
 *
 *   ba  → cwd = knowledgeRoot. Framework ✓, Knowledge ✓ writable, tooling
 *         synced, Target never required.
 *   dev → cwd = targetRoot. Everything above plus a REQUIRED, validated
 *         Knowledge binding — a DEV session without project knowledge fails
 *         closed with recovery instructions (T-ROLE-08).
 *
 * Both flows auto-initialize an unambiguous workspace on first run (init is
 * idempotent and never touches non-managed content), stop on sync conflicts
 * rather than forcing, and enforce write policy through the launch itself:
 * the session gets exactly its own workspace as cwd and an explicitly empty
 * AGENTCLAUDE_WRITABLE_WORK_ROOTS, so cross-repository writes hit the
 * block-outside-repo guard (T-ROLE-12/13).
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
  now?: string;
  /** Overrides where the machine-wide installation binding is read from (tests; unusual setups). */
  installationConfigPath?: string;
  /** Test seams. */
  probe?: (cmd: string) => { available: boolean; detail?: string };
  launch?: (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<number>;
}

export class PreflightError extends Error {
  constructor(
    public readonly checks: PreflightCheck[],
    public readonly failed: PreflightCheck,
  ) {
    super(`${failed.name}: ${failed.detail ?? "failed"}`);
  }
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
  role: RoleName;
  /** The Role Workspace the session will execute from. */
  workspaceRoot: string;
  frameworkRoot: string;
  templatesDir: string;
  /** Resolved for DEV (required); also reported for BA when a machine-wide binding exists (informational only). */
  knowledge?: KnowledgeBinding;
  /** T-LV1 — resolved for BA when `target.path` is set and valid; always optional, never blocks a BA session. */
  target?: TargetBinding;
  runtime: RuntimeName;
}

/**
 * The full preflight for one role, ordered cheapest-first. Throws
 * PreflightError naming the first failing check; returns everything the
 * launch step needs otherwise.
 */
export function workspacePreflight(role: RoleName, options: RoleRunOptions = {}): WorkspaceContext {
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
      fail(`${ROLE_LABEL[role]} workspace`, "repository is ambiguous (Knowledge and application markers both present) — run software-team-agents init --role <ba|dev> explicitly");
    }
    if (kind !== expectedKind && kind !== "unrecognized") {
      fail(
        `${ROLE_LABEL[role]} workspace`,
        `this repository looks like a ${kind === "knowledge" ? "Knowledge" : "Target"} repository — run \`software-team-agents init --role ${kind === "knowledge" ? "ba" : "dev"}\` there instead`,
      );
    }
    runTargetInit({ targetRoot: roots.targetRoot, templatesDir: options.templatesDir, now: options.now ?? new Date().toISOString(), role });
    checks.push({ name: "Initialization", ok: true, detail: `auto-initialized as ${ROLE_LABEL[role]} workspace` });
  } else {
    if (!config) {
      fail("Initialization", ".agent-team/config.yaml is missing although manifest.json exists — restore it or delete .agent-team and re-init");
    }
    if (config && config.role && config.role !== role) {
      fail(
        `${ROLE_LABEL[role]} workspace`,
        `this workspace is registered as ${ROLE_LABEL[config.role as RoleName]} — use software-team-agents ${config.role}, or re-init with --role ${role} if that was wrong`,
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

  // Managed-file integrity under this role's asset profile: auto-sync only
  // what is provably safe; a conflict stops everything (no forced sync behind
  // the user's back).
  try {
    const manifest = readTargetManifest(roots.targetRoot);
    // T-WG7 — plan against rendered bytes so a dev workspace's CLAUDE.md is
    // judged by what sync actually writes there, not by the shipped template.
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
    const needsSync = plan.entries.some((e) => ["add", "update", "restore", "remove-stale"].includes(e.action));
    if (needsSync) {
      if (options.autoSync === false) {
        fail("Managed files", "managed assets are outdated — run software-team-agents sync, or drop --no-auto-sync");
      }
      runTargetSync({ targetRoot: roots.targetRoot, templatesDir, manifest, config, include: assetsForRole(role), role, installationConfigPath: options.installationConfigPath, now: options.now ?? new Date().toISOString() });
      checks.push({ name: "Managed files", ok: true, detail: `auto-synced to Framework ${plan.frameworkVersion}${ownedNote}` });
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
  /** T-LV1 — set exactly when role === "ba" and a Target binding resolved; always optional. */
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
    // T-WG1 — a valid, marker-complete binding still leaves the BA-lane
    // entirely unusable if nobody ever ran `init --role ba` there. DEV reads
    // Knowledge fine either way (it only needs the markers), so this is a
    // note, not a failing check.
    if (!isTargetInitialized(resolved.knowledgeRoot)) {
      checks.push({
        name: "Knowledge (BA lane)",
        ok: true,
        detail: `bound but not initialized as a BA workspace — BA-lane is unusable on this machine until: cd "${resolved.knowledgeRoot}" && software-team-agents init --role ba`,
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
    // T-LV1 — an optional Target binding lets BA read the real app repo
    // (schema.prisma, code) without ever requiring it. Any problem is
    // reported as a non-blocking check, exactly like T-WG1's "Knowledge (BA
    // lane)" note — it is never a reason to fail preflight.
    try {
      const resolved = resolveTargetBinding({ knowledgeRoot: roots.targetRoot, configTargetPath: config?.target?.path });
      if (resolved) {
        baTarget = resolved;
        checks.push({ name: "Target (BA lane)", ok: true, detail: `${resolved.targetRoot} (via ${resolved.via}, read-only)` });
      }
    } catch (e) {
      if (e instanceof TargetBindingError) {
        checks.push({ name: "Target (BA lane)", ok: true, detail: e.message });
      } else {
        throw e;
      }
    }
  }

  const runtime = options.runtime ?? "claude";
  const probe = options.probe ?? defaultProbe;
  const verdict = probe(runtime);
  if (!verdict.available) fail(`Runtime (${runtime})`, verdict.detail ?? `${runtime} is unavailable`);
  checks.push({ name: `Runtime (${runtime})`, ok: true, detail: verdict.detail });

  return { checks, role, workspaceRoot: roots.targetRoot, frameworkRoot: roots.frameworkRoot, templatesDir, knowledge: devKnowledge, target: baTarget, runtime };
}

/** DEV-only aliases kept for the original callers/tests. */
export const devPreflight = (options: RoleRunOptions = {}): WorkspaceContext => workspacePreflight("dev", options);

export type DevOptions = RoleRunOptions;

/**
 * Full flow for a role: preflight → launch. Resolves to the launched runtime's
 * exit code; a preflight failure resolves to 1 without launching anything.
 */
async function runRoleSession(role: RoleName, options: RoleRunOptions): Promise<number> {
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
  console.log(`[software-team-agents] starting ${ctx.runtime} (${ROLE_LABEL[role]}) from ${ctx.workspaceRoot} ...`);
  const launch = options.launch ?? defaultLaunch;
  return launch(ctx.runtime, [], ctx.workspaceRoot, launchEnv(role, process.env, ctx.knowledge?.knowledgeRoot, ctx.target?.targetRoot));
}

export const runDev = (options: RoleRunOptions = {}): Promise<number> => runRoleSession("dev", options);
export const runBa = (options: RoleRunOptions = {}): Promise<number> => runRoleSession("ba", options);
