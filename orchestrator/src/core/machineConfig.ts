import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { corePaths } from "./corePaths.js";

/**
 * Machine configuration for STA Core (`machine.yaml`, beside
 * `installation.yaml`).
 *
 * Deliberately a sibling file, not new keys in `installation.yaml`: that file
 * is the strict, versioned Knowledge-root registry (named roots, default root,
 * identities) with its own migration rules, and it stays the ONE place named
 * Knowledge roots live — this file never repeats them. `machine.yaml` holds
 * what the Core needs on top: the outer machine boundary, the user language,
 * the Intent provider, and runtime routing order per role.
 *
 * Nothing here can widen a task's write scope. `workspace.allowed_roots` is an
 * outer fence the Core checks Knowledge and Target paths against; task, Target
 * and role scopes are still the packet's, and are always narrower.
 */

/** The four first-class pool runtimes, by their canonical registry ids. */
export const POOL_RUNTIME_IDS = ["claude-code", "codex", "antigravity", "zcode"] as const;
export type PoolRuntimeId = (typeof POOL_RUNTIME_IDS)[number];

/** User-facing spellings accepted on input; the registry id is what is stored. */
const RUNTIME_ALIASES: Readonly<Record<string, PoolRuntimeId>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  agy: "antigravity",
  antigravity: "antigravity",
  zcode: "zcode",
};

export function canonicalPoolRuntimeId(value: string): PoolRuntimeId | undefined {
  return RUNTIME_ALIASES[value.trim().toLowerCase()];
}

export const ROUTE_ROLES = ["commander", "engineer", "reviewer", "qa"] as const;
export type RouteRole = (typeof ROUTE_ROLES)[number];

export const LANGUAGES = ["th", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

const RuntimeIdSchema = z.string().transform((value, ctx) => {
  const id = canonicalPoolRuntimeId(value);
  if (!id) {
    ctx.addIssue({ code: "custom", message: `unknown runtime "${value}" (expected one of ${POOL_RUNTIME_IDS.join(", ")} or alias agy)` });
    return z.NEVER;
  }
  return id;
});

/**
 * One role's route. `order` is preference; `fallback: false` makes it
 * exclusive — the first entry only, never another runtime. The two words are
 * kept explicit so "preferred" can never silently mean "locked".
 */
const RouteSchema = z.object({
  order: z.array(RuntimeIdSchema).min(1).refine((ids) => new Set(ids).size === ids.length, "a runtime may appear at most once in an order"),
  fallback: z.boolean().default(true),
});
export type RouteConfig = z.infer<typeof RouteSchema>;

const MachineConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  workspace: z.object({
    allowed_roots: z.array(z.string().min(1)).default([]),
  }).default({ allowed_roots: [] }),
  language: z.enum(LANGUAGES).default("th"),
  runtime: z.object({
    default_autonomy: z.enum(["edit", "full"]).default("edit"),
  }).default({ default_autonomy: "edit" }),
  intent: z.object({
    provider: z.enum(["gemini", "offline"]).default("gemini"),
    model: z.string().min(1).default("gemini-3.5-flash-lite"),
    endpoint: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
    timeout_ms: z.number().int().positive().default(20_000),
  }).default({ provider: "gemini", model: "gemini-3.5-flash-lite", endpoint: "https://generativelanguage.googleapis.com/v1beta", timeout_ms: 20_000 }),
  commander: z.object({
    enabled: z.boolean().default(true),
    order: z.array(RuntimeIdSchema).min(1).default(["claude-code", "codex", "antigravity", "zcode"]),
    fallback: z.boolean().default(true),
  }).default({ enabled: true, order: ["claude-code", "codex", "antigravity", "zcode"], fallback: true }),
  roles: z.object({
    engineer: RouteSchema.default({ order: ["codex", "claude-code", "antigravity", "zcode"], fallback: true }),
    reviewer: RouteSchema.default({ order: ["claude-code", "antigravity", "zcode", "codex"], fallback: true }),
    qa: RouteSchema.default({ order: ["antigravity", "zcode", "claude-code", "codex"], fallback: true }),
  }).default({
    engineer: { order: ["codex", "claude-code", "antigravity", "zcode"], fallback: true },
    reviewer: { order: ["claude-code", "antigravity", "zcode", "codex"], fallback: true },
    qa: { order: ["antigravity", "zcode", "claude-code", "codex"], fallback: true },
  }),
  health: z.object({
    quota_cooldown_minutes: z.number().positive().default(60),
    rate_limit_cooldown_minutes: z.number().positive().default(5),
    unavailable_cooldown_minutes: z.number().positive().default(10),
    auth_cooldown_minutes: z.number().positive().default(30),
    timeout_retry_limit: z.number().int().min(1).default(2),
    timeout_cooldown_minutes: z.number().positive().default(15),
  }).default({
    quota_cooldown_minutes: 60,
    rate_limit_cooldown_minutes: 5,
    unavailable_cooldown_minutes: 10,
    auth_cooldown_minutes: 30,
    timeout_retry_limit: 2,
    timeout_cooldown_minutes: 15,
  }),
  service: z.object({
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(4317),
  }).default({ host: "127.0.0.1", port: 4317 }),
  work: z.object({
    /** Upper bound on bounded-run segments one work run may launch — the autonomous loop is never unbounded. */
    max_segments: z.number().int().min(1).max(200).default(24),
    /** Resume a run paused for runtime exhaustion once a cooldown lapses. */
    auto_resume_after_cooldown: z.boolean().default(true),
  }).default({ max_segments: 24, auto_resume_after_cooldown: true }),
}).strict();

export type MachineConfig = z.output<typeof MachineConfigSchema>;
export type MachineConfigInput = z.input<typeof MachineConfigSchema>;

export class MachineConfigError extends Error {}

/** A machine root is a fence, not a grant; a whole drive or filesystem root is refused outright. */
export function assertAcceptableMachineRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new MachineConfigError(`machine root "${root}" must be an absolute path`);
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved || path.dirname(resolved) === resolved) {
    throw new MachineConfigError(`machine root "${root}" is a filesystem/drive root — choose a directory such as C:\\src; STA never takes unrestricted drive access`);
  }
  return resolved;
}

export function parseMachineConfig(raw: unknown): MachineConfig {
  const parsed = MachineConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new MachineConfigError(`machine config is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
  }
  const config = parsed.data;
  config.workspace.allowed_roots = config.workspace.allowed_roots.map(assertAcceptableMachineRoot);
  return config;
}

export function defaultMachineConfig(): MachineConfig {
  return parseMachineConfig({});
}

export function loadMachineConfig(file = corePaths().machineConfig): MachineConfig {
  if (!fs.existsSync(file)) return defaultMachineConfig();
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new MachineConfigError(`cannot read machine config ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMachineConfig(raw);
}

/** Validates the whole document before anything reaches disk; the write is atomic (tmp + rename). */
export function saveMachineConfig(config: MachineConfigInput, file = corePaths().machineConfig): MachineConfig {
  const normalized = parseMachineConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, stringifyYaml(normalized, { sortMapEntries: false }), "utf8");
  fs.renameSync(tmp, file);
  return normalized;
}

/** Applies a partial update on top of the current file, through the same validation. */
export function updateMachineConfig(mutate: (current: MachineConfig) => MachineConfigInput, file = corePaths().machineConfig): MachineConfig {
  return saveMachineConfig(mutate(loadMachineConfig(file)), file);
}

function canonicalForCompare(value: string): string {
  const resolved = path.resolve(value);
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // a path that does not exist yet is compared as written
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** True when `candidate` is the root or strictly inside it (separator-aware, case-folded on Windows, symlinks resolved). */
export function isInsideRoot(candidate: string, root: string): boolean {
  const c = canonicalForCompare(candidate);
  const r = canonicalForCompare(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
}

/**
 * The outer machine fence. With no configured root nothing is fenced here
 * (a pre-Core machine keeps working); with roots, a path outside every one is
 * refused with the configured roots named.
 */
export function assertInsideMachineRoots(config: MachineConfig, candidate: string, label: string): void {
  const roots = config.workspace.allowed_roots;
  if (roots.length === 0) return;
  if (roots.some((root) => isInsideRoot(candidate, root))) return;
  throw new MachineConfigError(`${label} "${candidate}" is outside the machine root(s) ${roots.join(", ")} — STA only works inside the configured machine boundary`);
}
