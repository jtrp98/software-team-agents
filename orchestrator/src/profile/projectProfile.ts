import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { Capability } from "../agents/capabilities.js";
import { defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Framework self-profile and shipped stack catalog. Target stack resolution
 * lives in `.agent-team/config.yaml`; this module must never be used as a
 * default for the application currently being worked on.
 *
 * The one place a Framework self-check looks up what this package is built with, and
 * the technology profiles it can be built with.
 *
 * Before this, "what stack is this?" was answered by reading
 * `.claude/agents/backend-engineer.md` and inferring. That worked while there
 * was one stack and one reader; it stops working the moment anything needs to
 * *decide* something from it — which agent can take a task, whether a
 * capability is covered, which build command to run.
 *
 * THE current/target SPLIT, AND WHY IT IS NOT A FUDGE
 *
 * TASKS.md names .NET 10 / C# / EF Core as this project's target. The agent
 * prompts implement Node + Express + Prisma, and CLAUDE.md requires the user to
 * confirm a stack change before those prompts are rewritten. Both facts are
 * true, and a profile that recorded only one of them would be actively harmful:
 *
 *   - target only  — every capability lookup would return an agent that cannot
 *     build the thing, and the checker would pass while doing so. A green check
 *     on a false claim is worse than no check.
 *   - current only — the decision that has already been made disappears, and
 *     the next person re-litigates it.
 *
 * So the file carries both, and this module holds them to different standards:
 * `current` must agree with the agent roster, `target` need only name a stack
 * profile that exists. `target.blocked_on` names what would close the gap,
 * which is what makes it a tracked migration rather than a contradiction.
 */

/**
 * One engineer role's path globs for one stack layout.
 *
 * `contracts/<role>.yaml` used to hold these, which tied the role boundary to a
 * single stack: `server/**`, `src/lib/**`, `app/api/**`, `prisma/**` describe a
 * Node/Prisma repository, not "what a backend engineer owns". The one real
 * Target (.NET/EF, source root `ClassOnlineWeb`) matched none of them, so its
 * engineers could write nothing and the project claimed both prompts through
 * `overrides` instead — permanently detaching them from Framework updates.
 *
 * A contract now expresses the role boundary (`_docs/module/**` denied,
 * `contracts/**` denied, capabilities, tools, states) and a stack profile
 * expresses the layout. `--check-contracts` fails if a stack-shaped glob drifts
 * back into a contract.
 *
 * `{source_root}` expands to each root recorded in the Target's
 * `.agent-team/config.yaml` `stack.source_roots`, so a profile names layout
 * without naming any particular Target's directories. A source root of `.`
 * expands the prefix away entirely (`{source_root}/**` → `**`): the Target root
 * *is* the project, and the universal floor, the workspace-role rules and the
 * contract's own denies all still apply on top.
 */
const StackRolePermissionsSchema = z.object({
  read: z.array(z.string().min(1)).default([]),
  write: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
});
export type StackRolePermissions = z.infer<typeof StackRolePermissionsSchema>;

export const StackProfileSchema = z.object({
  stack: z.string().min(1),
  kind: z.enum(["backend", "frontend"]),
  language: z.string().min(1),
  runtime: z.string().min(1),
  frameworks: z.array(z.string().min(1)),
  orm: z.string().min(1).optional(),
  database: z.array(z.string().min(1)),
  api: z.array(z.string().min(1)),
  package_manager: z.string().min(1),
  commands: z.object({
    install: z.string().min(1),
    build: z.string().min(1),
    test: z.string().min(1),
    lint: z.string().min(1),
    typecheck: z.string().min(1),
  }),
  /** File extensions the offline security pattern sweep may inspect for this profile. Empty means unsupported, never clean. */
  scan_extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).default([]),
  capabilities: z.array(z.enum(Capability)),
  /** Stack-shaped engineer path globs, keyed by agent role. Absent means the role falls back to {@link STACK_PERMISSION_FALLBACK}. */
  permissions: z.record(z.string().min(1), StackRolePermissionsSchema).default({}),
});
export type StackProfile = z.infer<typeof StackProfileSchema>;

/** The roles whose path globs a stack profile may declare. Every other role's paths are role-shaped and stay in its contract. */
export const STACK_SCOPED_ROLES: readonly string[] = ["backend-engineer", "frontend-engineer"];

/**
 * Where a role's globs come from when the resolved profile declares none — and
 * when a workspace has recorded no stack at all. Both point at the Node/Prisma
 * profiles, which carry exactly the globs the contracts carried before,
 * so an existing installation resolves the same write set it always
 * had rather than losing access.
 */
export const STACK_PERMISSION_FALLBACK: Readonly<Record<string, string>> = {
  "backend-engineer": "node",
  "frontend-engineer": "frontend",
};

function expandSourceRoots(globs: readonly string[], sourceRoots: readonly string[]): string[] {
  const roots = sourceRoots.length > 0 ? sourceRoots : ["."];
  const out: string[] = [];
  for (const glob of globs) {
    if (!glob.includes("{source_root}")) {
      if (!out.includes(glob)) out.push(glob);
      continue;
    }
    for (const root of roots) {
      // `.` is the Target root itself: drop the prefix rather than emit `./**`,
      // which normalizes to `**` anyway and reads like a mistake.
      const expanded = root === "." || root === "" ? glob.replace(/\{source_root\}\/?/g, "") : glob.replaceAll("{source_root}", root);
      if (expanded !== "" && !out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

/**
 * The stack-shaped half of one engineer role's path rules, resolved from the
 * Target's recorded profile. Returns empty lists for a role no profile scopes,
 * and never throws for a missing profile: a guard that failed closed here would
 * strip an engineer's write access over a packaging problem.
 */
export function resolveStackPathRules(options: {
  role: string;
  projectRoot: string;
  profile?: string;
  sourceRoots?: readonly string[];
}): StackRolePermissions {
  const empty: StackRolePermissions = { read: [], write: [], deny: [] };
  if (!STACK_SCOPED_ROLES.includes(options.role)) return empty;

  const attempts = [options.profile, STACK_PERMISSION_FALLBACK[options.role]].filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
  for (const name of attempts) {
    let profile: StackProfile;
    try {
      profile = loadStackProfile(name, options.projectRoot);
    } catch {
      continue;
    }
    const declared = profile.permissions[options.role];
    if (!declared) continue;
    return {
      read: expandSourceRoots(declared.read, options.sourceRoots ?? []),
      write: expandSourceRoots(declared.write, options.sourceRoots ?? []),
      deny: expandSourceRoots(declared.deny, options.sourceRoots ?? []),
    };
  }
  return empty;
}

const SideSchema = z.object({
  stack: z.string().min(1),
  language: z.string().min(1),
  framework: z.string().min(1),
  orm: z.string().min(1).optional(),
});

const ProfileBodySchema = z.object({
  backend: SideSchema,
  frontend: SideSchema,
  database: z.object({ type: z.string().min(1) }),
  api: z.array(z.string().min(1)),
});

export const ProjectProfileSchema = z.object({
  project: z.object({ name: z.string().min(1), description: z.string().min(1) }),
  current: ProfileBodySchema,
  target: ProfileBodySchema.extend({
    /** What has to happen before `target` can become `current`. Required: a target nobody can act on is a wish. */
    blocked_on: z.string().min(1),
  }).optional(),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export class ProfileError extends Error {
  constructor(public readonly issues: string[]) {
    super(`project profile is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "ProfileError";
  }
}

export function projectProfilePath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "project.yaml");
}

export function stacksDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "stacks");
}

export function stackProfilePath(stack: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(stacksDir(projectRoot), stack, "stack.yaml");
}

function readYaml(file: string): unknown {
  return parseYaml(fs.readFileSync(file, "utf8"));
}

export function loadProjectProfile(projectRoot: string = defaultProjectRoot()): ProjectProfile {
  const file = projectProfilePath(projectRoot);
  let parsed: unknown;
  try {
    parsed = readYaml(file);
  } catch (e) {
    throw new ProfileError([`cannot read ${file}: ${(e as Error).message}`]);
  }
  const result = ProjectProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProfileError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}

export function loadStackProfile(stack: string, projectRoot: string = defaultProjectRoot()): StackProfile {
  const file = stackProfilePath(stack, projectRoot);
  let parsed: unknown;
  try {
    parsed = readYaml(file);
  } catch {
    throw new ProfileError([`no stack profile at ${file}`]);
  }
  const result = StackProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProfileError(result.error.issues.map((i) => `${stack}: ${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  if (result.data.stack !== stack) {
    throw new ProfileError([`stacks/${stack}/stack.yaml declares stack "${result.data.stack}" — the folder is the identity`]);
  }
  return result.data;
}

export function listStacks(projectRoot: string = defaultProjectRoot()): string[] {
  try {
    return fs
      .readdirSync(stacksDir(projectRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(stackProfilePath(e.name, projectRoot)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The commands to run for a side of the project — what a build or verification step actually invokes. */
export function commandsFor(
  side: "backend" | "frontend",
  projectRoot: string,
): StackProfile["commands"] {
  const profile = loadProjectProfile(projectRoot);
  return loadStackProfile(profile.current[side].stack, projectRoot).commands;
}

export interface ProfileCheckResult {
  ok: boolean;
  problems: string[];
  /** Things that are true and worth saying but are not failures — the tracked migration, notably. */
  notes: string[];
}

/**
 * The check `--check-profile` runs.
 *
 * `current` is held to the agent roster: if the profile says the backend is
 * TypeScript, some agent had better be able to write TypeScript, or the profile
 * is describing a team that does not exist. `target` is held only to the stack
 * profiles: it is allowed to name something nothing can build yet, because that
 * is what a target is — but it must name a real profile and say what blocks it,
 * so it stays actionable rather than aspirational.
 */
export function checkProfile(projectRoot: string = defaultProjectRoot()): ProfileCheckResult {
  const problems: string[] = [];
  const notes: string[] = [];

  let profile: ProjectProfile;
  try {
    profile = loadProjectProfile(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof ProfileError ? e.issues : [String(e)], notes };
  }

  const available = listStacks(projectRoot);
  if (available.length === 0) {
    problems.push(`no stack profiles found in ${stacksDir(projectRoot)}`);
  }

  for (const [which, body] of [
    ["current", profile.current],
    ...(profile.target ? ([["target", profile.target]] as const) : []),
  ] as const) {
    for (const side of ["backend", "frontend"] as const) {
      const name = body[side].stack;
      if (!available.includes(name)) {
        problems.push(`${which}.${side} names stack "${name}", which has no profile under stacks/`);
        continue;
      }

      const stack = loadStackProfile(name, projectRoot);
      if (stack.kind !== side) {
        problems.push(`${which}.${side} uses stack "${name}", which declares kind "${stack.kind}"`);
      }
      if (stack.language.toLowerCase() !== body[side].language.toLowerCase()) {
        problems.push(
          `${which}.${side} says language "${body[side].language}" but stacks/${name}/stack.yaml says "${stack.language}"`,
        );
      }
    }
  }

  // `current` must be buildable by agents that actually exist.
  const roster = Object.values(AGENT_REGISTRY);
  for (const side of ["backend", "frontend"] as const) {
    const language = profile.current[side].language.toLowerCase();
    const capable = roster.filter((a) => a.capability.languages.some((l) => l.toLowerCase() === language));
    if (capable.length === 0) {
      problems.push(
        `current.${side} is "${profile.current[side].language}" but no agent declares that language — ` +
          "the profile describes a team this project does not have",
      );
    }
    const framework = profile.current[side].framework.toLowerCase();
    if (!roster.some((a) => a.capability.frameworks.some((f) => f.toLowerCase() === framework))) {
      problems.push(`current.${side} uses "${profile.current[side].framework}" but no agent declares that framework`);
    }
  }

  // `target` is allowed to be unbuildable — that is what makes it a target. Say so plainly.
  if (profile.target) {
    const targetLanguage = profile.target.backend.language.toLowerCase();
    const capable = roster.filter((a) => a.capability.languages.some((l) => l.toLowerCase() === targetLanguage));
    if (capable.length === 0) {
      notes.push(
        `target.backend is "${profile.target.backend.language}" and no agent can write it yet. ` +
          `Blocked on: ${profile.target.blocked_on.trim()}`,
      );
    }
    for (const api of profile.target.api) {
      const capability = api.toLowerCase() === "grpc" ? Capability.GRPC : null;
      if (capability && !roster.some((a) => a.capability.capabilities.includes(capability))) {
        notes.push(`target.api includes "${api}" and no agent declares the ${capability} capability yet`);
      }
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

/** Which agents can take work on a side of this project, by the language the profile declares. */
export function agentsForCurrentStack(
  side: "backend" | "frontend",
  projectRoot: string,
): AgentStage[] {
  const language = loadProjectProfile(projectRoot).current[side].language.toLowerCase();
  return Object.values(AGENT_REGISTRY)
    .filter((a) => a.capability.languages.some((l) => l.toLowerCase() === language))
    .map((a) => a.name);
}
