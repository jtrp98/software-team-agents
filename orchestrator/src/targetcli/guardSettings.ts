import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isUserOverridden, type TargetConfig, type TargetManifest } from "./targetMeta.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { AGY_GUARD_WRAPPER_PATH, AGY_HOOKS_PATH, CODEX_HOOKS_PATH, ZCODE_CONFIG_PATH } from "../runtime/bindingGenerator.js";
import type { WorkspaceRuntime } from "./roleWorkspace.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const OPENCODE_PLUGIN_PATH = ".opencode/plugin/sta-guards.js";
const GUARD_EVENTS = ["PreToolUse", "SubagentStop", "Stop"] as const;
type GuardEvent = (typeof GUARD_EVENTS)[number];

type JsonObject = Record<string, unknown>;

export interface FrameworkGuardRegistration {
  event: GuardEvent;
  hookPath: string;
  /** Complete event-array entry from the Framework template. */
  entry: JsonObject;
  /** The one hook command represented by this registration. */
  hook: JsonObject;
}

export interface GuardMergeResult {
  ok: boolean;
  changed?: boolean;
  content?: string;
  error?: string;
}

export interface GuardWiringStatus {
  hooksInstalled: number;
  hooksRegistered: number;
  missingRegistrations: FrameworkGuardRegistration[];
  overridden: boolean;
  settingsError?: string;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function hookScriptPath(value: unknown): string | undefined {
  const hook = asObject(value);
  if (!hook) return undefined;
  const candidates = [
    ...(Array.isArray(hook.args) ? hook.args.filter((part): part is string => typeof part === "string") : []),
    ...(typeof hook.command === "string" ? [hook.command] : []),
  ];
  for (const candidate of candidates) {
    const match = candidate.replaceAll("\\", "/").match(/\.claude\/hooks\/[^\s"']+\.js/);
    if (match) return match[0];
  }
  return undefined;
}

function parseSettings(content: string, label: string): { value?: JsonObject; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { error: `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const value = asObject(parsed);
  if (!value) return { error: `${label} root must be a JSON object` };
  if (value.hooks !== undefined && !asObject(value.hooks)) return { error: `${label} hooks must be an object` };
  const hooks = asObject(value.hooks);
  for (const event of GUARD_EVENTS) {
    if (hooks?.[event] !== undefined && !Array.isArray(hooks[event])) return { error: `${label} hooks.${event} must be an array` };
  }
  return { value };
}

/**
 * The single enumeration point for Claude guard registrations. It reads the
 * shipped template, so adding/removing a real hook changes merge, preflight,
 * status and doctor together instead of requiring another hand-maintained list.
 */
export function frameworkGuardRegistrations(templatesDir: string): FrameworkGuardRegistration[] {
  const settingsFile = path.join(templatesDir, ...CLAUDE_SETTINGS_PATH.split("/"));
  if (!fs.existsSync(settingsFile)) return [];
  const parsed = parseSettings(fs.readFileSync(settingsFile, "utf8"), "Framework settings.json");
  if (!parsed.value) throw new Error(parsed.error);
  const hooks = asObject(parsed.value.hooks) ?? {};
  const registrations: FrameworkGuardRegistration[] = [];
  for (const event of GUARD_EVENTS) {
    const entries = hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Framework settings.json hooks.${event} must be an array`);
    for (const rawEntry of entries) {
      const entry = asObject(rawEntry);
      if (!entry || !Array.isArray(entry.hooks)) throw new Error(`Framework settings.json hooks.${event} contains an unmergeable entry`);
      for (const rawHook of entry.hooks) {
        const hook = asObject(rawHook);
        const hookPath = hookScriptPath(rawHook);
        if (!hook || !hookPath) throw new Error(`Framework settings.json hooks.${event} contains a command without a .claude/hooks/*.js path`);
        registrations.push({ event, hookPath, entry, hook });
      }
    }
  }
  const keys = new Set<string>();
  for (const registration of registrations) {
    const key = `${registration.event}|${registration.hookPath}`;
    if (keys.has(key)) throw new Error(`Framework settings.json repeats ${registration.hookPath} under ${registration.event}`);
    keys.add(key);
  }
  return registrations;
}

function registeredKeys(settings: JsonObject): Set<string> {
  const keys = new Set<string>();
  const hooks = asObject(settings.hooks) ?? {};
  for (const event of GUARD_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const rawEntry of entries) {
      const entry = asObject(rawEntry);
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        const hookPath = hookScriptPath(hook);
        if (hookPath) keys.add(`${event}|${hookPath}`);
      }
    }
  }
  return keys;
}

interface PropertySpan {
  key: string;
  valueStart: number;
  valueEnd: number;
}

function skipWhitespace(content: string, offset: number): number {
  while (offset < content.length && /\s/.test(content[offset]!)) offset += 1;
  return offset;
}

function stringEnd(content: string, start: number): number {
  let escaped = false;
  for (let offset = start + 1; offset < content.length; offset += 1) {
    const char = content[offset]!;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') return offset + 1;
  }
  throw new Error("unterminated JSON string");
}

function valueEnd(content: string, start: number): number {
  const first = content[start];
  if (first === '"') return stringEnd(content, start);
  if (first === "{" || first === "[") {
    const close = first === "{" ? "}" : "]";
    let depth = 1;
    let offset = start + 1;
    while (offset < content.length) {
      const char = content[offset]!;
      if (char === '"') offset = stringEnd(content, offset);
      else {
        if (char === first) depth += 1;
        else if (char === close && --depth === 0) return offset + 1;
        offset += 1;
      }
    }
    throw new Error("unterminated JSON container");
  }
  let offset = start;
  while (offset < content.length && !/[\s,}\]]/.test(content[offset]!)) offset += 1;
  return offset;
}

function objectProperties(content: string, start: number): { properties: PropertySpan[]; close: number } {
  if (content[start] !== "{") throw new Error("expected JSON object");
  const properties: PropertySpan[] = [];
  let offset = skipWhitespace(content, start + 1);
  while (content[offset] !== "}") {
    if (content[offset] !== '"') throw new Error("expected JSON property name");
    const keyEnd = stringEnd(content, offset);
    const key = JSON.parse(content.slice(offset, keyEnd)) as string;
    offset = skipWhitespace(content, keyEnd);
    if (content[offset] !== ":") throw new Error("expected JSON property colon");
    const valueStart = skipWhitespace(content, offset + 1);
    const end = valueEnd(content, valueStart);
    properties.push({ key, valueStart, valueEnd: end });
    offset = skipWhitespace(content, end);
    if (content[offset] === ",") offset = skipWhitespace(content, offset + 1);
    else if (content[offset] !== "}") throw new Error("expected JSON property separator");
  }
  return { properties, close: offset };
}

function insertObjectProperty(content: string, objectStart: number, key: string, rawValue: string): string {
  const object = objectProperties(content, objectStart);
  const insertion = `${object.properties.length > 0 ? "," : ""}${JSON.stringify(key)}:${rawValue}`;
  return content.slice(0, object.close) + insertion + content.slice(object.close);
}

function insertArrayValues(content: string, arrayStart: number, rawValues: readonly string[]): string {
  if (content[arrayStart] !== "[") throw new Error("expected JSON array");
  const close = valueEnd(content, arrayStart) - 1;
  const hasValues = content.slice(arrayStart + 1, close).trim().length > 0;
  const insertion = `${hasValues ? "," : ""}${rawValues.join(",")}`;
  return content.slice(0, close) + insertion + content.slice(close);
}

function missingEntry(registration: FrameworkGuardRegistration): JsonObject {
  return { ...registration.entry, hooks: [registration.hook] };
}

/**
 * Adds only missing Framework registrations. Existing project bytes are never
 * serialized: insertions occur at JSON container boundaries, so every original
 * byte remains in order and unchanged in the result.
 */
export function mergeFrameworkGuards(projectContent: string, frameworkContent: string): GuardMergeResult {
  const project = parseSettings(projectContent, "project settings.json");
  if (!project.value) return { ok: false, error: project.error };
  const framework = parseSettings(frameworkContent, "Framework settings.json");
  if (!framework.value) return { ok: false, error: framework.error };

  const registrations: FrameworkGuardRegistration[] = [];
  const frameworkHooks = asObject(framework.value.hooks) ?? {};
  for (const event of GUARD_EVENTS) {
    const entries = frameworkHooks[event];
    if (!Array.isArray(entries)) continue;
    for (const rawEntry of entries) {
      const entry = asObject(rawEntry);
      if (!entry || !Array.isArray(entry.hooks)) return { ok: false, error: `Framework settings.json hooks.${event} contains an unmergeable entry` };
      for (const rawHook of entry.hooks) {
        const hook = asObject(rawHook);
        const hookPath = hookScriptPath(rawHook);
        if (!hook || !hookPath) return { ok: false, error: `Framework settings.json hooks.${event} contains an unmergeable command` };
        registrations.push({ event, hookPath, entry, hook });
      }
    }
  }

  let content = projectContent;
  let current = project.value;
  let present = registeredKeys(current);
  const missing = registrations.filter((registration) => !present.has(`${registration.event}|${registration.hookPath}`));
  if (missing.length === 0) return { ok: true, changed: false, content };

  try {
    let root = objectProperties(content, skipWhitespace(content, 0));
    let hooksProperty = root.properties.find((property) => property.key === "hooks");
    if (!hooksProperty) {
      content = insertObjectProperty(content, skipWhitespace(content, 0), "hooks", "{}");
      root = objectProperties(content, skipWhitespace(content, 0));
      hooksProperty = root.properties.find((property) => property.key === "hooks")!;
    }
    for (const event of GUARD_EVENTS) {
      current = parseSettings(content, "merged settings.json").value!;
      present = registeredKeys(current);
      const eventMissing = missing.filter((registration) => registration.event === event && !present.has(`${event}|${registration.hookPath}`));
      if (eventMissing.length === 0) continue;
      root = objectProperties(content, skipWhitespace(content, 0));
      hooksProperty = root.properties.find((property) => property.key === "hooks")!;
      let hooksObject = objectProperties(content, hooksProperty.valueStart);
      let eventProperty = hooksObject.properties.find((property) => property.key === event);
      const rawEntries = eventMissing.map((registration) => JSON.stringify(missingEntry(registration)));
      if (!eventProperty) {
        content = insertObjectProperty(content, hooksProperty.valueStart, event, `[${rawEntries.join(",")}]`);
      } else {
        content = insertArrayValues(content, eventProperty.valueStart, rawEntries);
      }
    }
  } catch (error) {
    return { ok: false, error: `project settings.json has an unmergeable JSON layout: ${error instanceof Error ? error.message : String(error)}` };
  }

  const validated = parseSettings(content, "merged settings.json");
  if (!validated.value) return { ok: false, error: validated.error };
  return { ok: true, changed: content !== projectContent, content };
}

export function inspectGuardWiring(options: {
  targetRoot: string;
  templatesDir: string;
  manifest?: TargetManifest;
  config?: TargetConfig;
}): GuardWiringStatus {
  const registrations = frameworkGuardRegistrations(options.templatesDir);
  const manifestPaths = new Set((options.manifest?.files ?? []).map((file) => file.path));
  const installed = registrations.filter((registration) => {
    const relPath = registration.hookPath.replace(/^\//, "");
    return manifestPaths.has(relPath) && fs.existsSync(path.join(options.targetRoot, ...relPath.split("/")));
  });
  const overridden = isUserOverridden(options.targetRoot, CLAUDE_SETTINGS_PATH, options.config);
  let parsed: JsonObject | undefined;
  let settingsError: string | undefined;
  try {
    const result = parseSettings(fs.readFileSync(path.join(options.targetRoot, ...CLAUDE_SETTINGS_PATH.split("/")), "utf8"), "project settings.json");
    parsed = result.value;
    settingsError = result.error;
  } catch (error) {
    settingsError = `project settings.json is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const keys = parsed ? registeredKeys(parsed) : new Set<string>();
  const registered = installed.filter((registration) => keys.has(`${registration.event}|${registration.hookPath}`));
  return {
    hooksInstalled: installed.length,
    hooksRegistered: registered.length,
    missingRegistrations: installed.filter((registration) => !keys.has(`${registration.event}|${registration.hookPath}`)),
    overridden,
    settingsError,
  };
}

// --- guard coverage per runtime -----------------------------------------

/**
 * ONE guard verdict per runtime, for every caller that has to decide whether a
 * session is enforced. Every runtime gets an explicit verdict, so "this
 * runtime has no mechanism at all" is a *stated* result rather than the
 * absence of a check.
 *
 * The vocabulary is `RuntimeCapability`, not a new registry: the same
 * guard families the adapters already report per run.
 */
export type GuardCoverageLevel =
  /** Every guard mechanism this runtime has is present and verified active. */
  | "enforced"
  /** Some guard families are enforced; the rest are named, never implied. */
  | "partial"
  /** Nothing to enforce here — the payload ships no registrations for this profile, or the project claimed the wiring. */
  | "not-required"
  /** A mechanism exists but is misconfigured. Never acknowledgeable: it is a repairable fault, not a deliberate choice. */
  | "broken"
  /** This runtime has no guard mechanism in this workspace: a launch enforces nothing. */
  | "unguarded";

export interface GuardCoverage {
  runtime: WorkspaceRuntime;
  level: GuardCoverageLevel;
  /** Guard families verified active for this runtime in this workspace. */
  enforced: readonly RuntimeCapability[];
  /** Guard families this runtime does not enforce here. Named so a gap can never be silent. */
  unenforced: readonly RuntimeCapability[];
  /** One line naming the mechanism and both halves of the verdict. */
  detail: string;
  /** Claude only: the registration counts behind the verdict, so callers need not re-inspect. */
  wiring?: GuardWiringStatus;
}

const ALL_GUARD_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.POST_TOOL_GUARD,
  RuntimeCapability.EXIT_GUARD,
  RuntimeCapability.PER_AGENT_EXIT_GUARD,
];

/** A positive verdict: readiness may say READY and a launch needs no acknowledgement. */
export function guardCoverageIsPositive(coverage: GuardCoverage): boolean {
  return coverage.level === "enforced" || coverage.level === "partial" || coverage.level === "not-required";
}

function claudeCoverage(wiring: GuardWiringStatus): GuardCoverage {
  const base = { runtime: "claude" as const, wiring };
  if (wiring.overridden) {
    return { ...base, level: "not-required", enforced: [], unenforced: [], detail: "Framework guard wiring explicitly declined via overrides" };
  }
  if (wiring.hooksInstalled === 0) {
    return { ...base, level: "not-required", enforced: [], unenforced: [], detail: "no Framework guard registrations shipped for this profile" };
  }
  if (wiring.settingsError) {
    return { ...base, level: "broken", enforced: [], unenforced: ALL_GUARD_CAPABILITIES, detail: wiring.settingsError };
  }
  if (wiring.missingRegistrations.length > 0) {
    return {
      ...base,
      level: "broken",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: `${wiring.hooksRegistered}/${wiring.hooksInstalled} Framework guard registration(s) wired`,
    };
  }
  return {
    ...base,
    level: "enforced",
    enforced: ALL_GUARD_CAPABILITIES,
    unenforced: [],
    detail: `Framework guards wired (${wiring.hooksRegistered}/${wiring.hooksInstalled})`,
  };
}

/**
 * OpenCode's coverage is genuinely partial, and the verdict says which half is
 * which. The plugin (`.opencode/plugin/sta-guards.js`, auto-loaded from that
 * directory) enforces writes-outside-workspace and contract path ownership;
 * each rendered binding's `permission.bash` block denies state-changing git.
 * Doc-rewrite, secret-leak and green-before-stop have no OpenCode mechanism —
 * the plugin's own header says so, and OpenCode's default posture is allow-all,
 * so a missing plugin means nothing is enforced at all. Since V13 TASK-014 the
 * headless adapter refuses a run whose workspace lacks the plugin before any
 * spawn, instead of launching an unguarded run.
 */
/** The `partial` verdict when the plugin is present — pure/static, so documentation can quote it without a workspace. */
export function opencodeCoverageWithPlugin(): GuardCoverage {
  return {
    runtime: "opencode",
    level: "partial",
    enforced: [RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.POST_TOOL_GUARD],
    unenforced: [RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD],
    detail:
      `partial — ${OPENCODE_PLUGIN_PATH} enforces block-outside-repo and block-path-permissions, and each binding's permission block enforces block-git; ` +
      "block-doc-rewrite, block-secret-leak and require-green-before-stop have no OpenCode mechanism; the latter two are enforced after headless process exit by the provider-neutral ExitCheckRunner; " +
      "the headless adapter refuses a run whose workspace lacks this plugin before spawn (V13 TASK-014), because OpenCode's default posture is allow-all",
  };
}

function opencodeCoverage(targetRoot: string): GuardCoverage {
  const pluginPresent = fs.existsSync(path.join(targetRoot, ...OPENCODE_PLUGIN_PATH.split("/")));
  if (!pluginPresent) {
    return {
      runtime: "opencode",
      level: "unguarded",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: `no ${OPENCODE_PLUGIN_PATH} — OpenCode's default posture is allow-all, so block-git, block-outside-repo, block-path-permissions, block-doc-rewrite, block-secret-leak and require-green-before-stop are all inactive; the headless adapter refuses the run before spawn (V13 TASK-014); run software-team-agents sync`,
    };
  }
  return opencodeCoverageWithPlugin();
}

/**
 * A committed Codex hook payload is compatibility wiring, not enforcement for
 * an interactive `software-team-agents open` session.
 * Real-install V12 UAT proved that exec-mode PreToolUse denial requires
 * `--dangerously-bypass-hook-trust`, a crashing hook fails open, and
 * Stop/SubagentStop do not enforce exit checks. Presence therefore stays
 * `unguarded`; counting registrations as capability would be a fail-open claim.
 * The headless adapter is separate: it compiles the run packet into a native
 * permission profile and isolated execpolicy, so it does not claim these hooks.
 */
/** Pure/static — quotes the verified exec-mode posture into the registry claim. */
export function codexCoverageWithHooks(): GuardCoverage {
  return {
    runtime: "codex",
    level: "unguarded",
    enforced: [],
    unenforced: ALL_GUARD_CAPABILITIES,
    detail:
      "`.codex/hooks.json` is compatibility wiring only: real-install UAT on Codex 0.154.0/0.155.1 found PreToolUse denial only with --dangerously-bypass-hook-trust, hook crashes fail open, and Stop/SubagentStop do not enforce codex exec; interactive/project-hook guard capabilities remain unclaimed (the headless adapter uses a separate per-run native profile)",
  };
}

/** Static fallback for workspaces where the payload has never been synced — `unguarded`, never an assumed positive. */
export function codexCoverageUnsynced(): GuardCoverage {
  return {
    runtime: "codex",
    level: "unguarded",
    enforced: [],
    unenforced: ALL_GUARD_CAPABILITIES,
    detail:
      "no `.codex/hooks.json` in this workspace — the V12 Codex guard payload has not been synced (run software-team-agents sync), so block-git, block-outside-repo, block-path-permissions, block-doc-rewrite, block-secret-leak and require-green-before-stop are all inactive",
  };
}

/**
 * Inspectable verdict: payload presence can diagnose sync drift but never raises
 * the verified exec-mode coverage above `unguarded`.
 */
export function codexCoverage(targetRoot: string): GuardCoverage {
  const configPath = path.join(targetRoot, CODEX_HOOKS_PATH);
  if (!fs.existsSync(configPath)) return codexCoverageUnsynced();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      runtime: "codex",
      level: "unguarded",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: `${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — guards fail closed to unguarded; run software-team-agents sync to rewrite it`,
    };
  }
  const hooks = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).hooks : undefined;
  const events = hooks !== null && typeof hooks === "object" && !Array.isArray(hooks) ? (hooks as Record<string, unknown>).events ?? hooks : undefined;
  const owned = ["PreToolUse", "Stop", "SubagentStop"].filter(
    (event) => events !== null && typeof events === "object" && !Array.isArray(events) && Array.isArray((events as Record<string, unknown>)[event]) && ((events as Record<string, unknown>)[event] as unknown[]).length > 0,
  );
  if (owned.length < 3) {
    return {
      runtime: "codex",
      level: "unguarded",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: `\`.codex/hooks.json\` exists but wires ${owned.length}/3 managed events (${owned.join(", ") || "none"}) — run software-team-agents sync`,
    };
  }
  return codexCoverageWithHooks();
}

/**
 * ZCode Desktop was treated as an interactive role-play runtime (the V12
 * decision). V13 TASK-015 traced the install and found the ZCode agent CLI it
 * bundles (`resources/glm/zcode.cjs`, headless `-p --json`), so
 * `sta run --runtime zcode` now reaches the governed `ZcodeAdapter`; that
 * adapter refuses a guarded run unless every STA hook below is persistently
 * trusted, because the headless engine skips untrusted project hooks.
 * The `.zcode/config.json` hook payload (PreToolUse guards + a Stop hook whose
 * continuation is capped at three) was live-verified end to end on a real
 * ZCode Desktop session (2026-09-23, `planning/v12/evidence/zcode-uat/`): all
 * five PreToolUse denials, the declared-session-role bounds, and the Stop
 * secret-leak block fired for real. Full `enforced` stays unclaimed because
 * the Stop continuation cap and the missing PostToolUse guard remain.
 * The per-role path layer inside `block-path-permissions` resolves its role
 * from a STA-issued scoped attempt grant (`.workflow/attempt-grant.json`,
 * issued by `sta grant issue` — V13 TASK-012) when no orchestrator set
 * `STA_ROLE`, so a granted session gets the same Target/Knowledge write
 * bounds an orchestrated stage does; the retired `.workflow/session-role.json`
 * self-declaration grants nothing.
 */
/** Pure/static — quotes the shipped-payload wiring state into the registry claim, the way `opencodeCoverageWithPlugin` does for OpenCode. */
export function zcodeCoverageWithSyncedPayload(): GuardCoverage {
  return {
    runtime: "zcode",
    level: "partial",
    enforced: [RuntimeCapability.PRE_TOOL_GUARD],
    unenforced: [RuntimeCapability.POST_TOOL_GUARD, RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD],
    detail:
      "`.zcode/config.json` wires four PreToolUse guards (block-git, block-outside-repo, block-doc-rewrite, block-path-permissions) plus the Stop pair — live-verified end to end on a real ZCode Desktop session (2026-09-23, planning/v12/evidence/zcode-uat); the headless ZCode CLI runs them only once their declarations are persistently trusted (`zcode hooks trust review`, a person's decision), so the governed adapter refuses a guarded run until they are; block-path-permissions takes its role from a STA-issued attempt grant (`.workflow/attempt-grant.json`, issued via `sta grant issue`) when no orchestrator set STA_ROLE, so a granted session gets per-role Target/Knowledge write bounds; require-green-before-stop and block-secret-leak run on the Stop hook, but ZCode caps Stop continuations at three per session (GUARD GAP, covered by the QA round); PostToolUse and per-agent exit guards have no shipped guard",
  };
}

/** Static fallback for workspaces where the payload has never been synced — `unguarded`, never an assumed positive. */
export function zcodeCoverageUnsynced(): GuardCoverage {
  return {
    runtime: "zcode",
    level: "unguarded",
    enforced: [],
    unenforced: ALL_GUARD_CAPABILITIES,
    detail:
      "no `.zcode/config.json` in this workspace — the V12 ZCode guard payload has not been synced (run software-team-agents sync), so block-git, block-outside-repo, block-path-permissions, block-doc-rewrite, block-secret-leak and require-green-before-stop are all inactive",
  };
}

/**
 * Inspectable verdict: the payload is shipped and enabled → `partial` (the
 * Stop-hook continuation cap and the missing PostToolUse guard keep this from
 * `enforced`); anything uninspectable fails closed to `unguarded` — a file
 * that cannot be read is never reported as enforcement.
 */
export function zcodeCoverage(targetRoot: string): GuardCoverage {
  const configPath = path.join(targetRoot, ".zcode", "config.json");
  if (!fs.existsSync(configPath)) return zcodeCoverageUnsynced();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      runtime: "zcode",
      level: "unguarded",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: `${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — guards fail closed to unguarded; run software-team-agents sync to rewrite it`,
    };
  }
  const hooks = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).hooks : undefined;
  const enabled = typeof hooks === "object" && hooks !== null && (hooks as Record<string, unknown>).enabled === true;
  if (!enabled) {
    return {
      runtime: "zcode",
      level: "unguarded",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: "`.zcode/config.json` exists but `hooks.enabled` is not true — ZCode runs configuration-file hooks only when enabled, so every guard is inactive; run software-team-agents sync",
    };
  }
  return zcodeCoverageWithSyncedPayload();
}
/**
 * Antigravity machine-level hook coverage.
 *
 * Real agy UAT on 1.1.27/1.2.x proved the PreToolUse deny path works in-band
 * with fail-closed semantics (a denied step stops; an unparseable or crashing hook
 * also stops). But agy reads hooks exclusively from the machine-global
 * `~/.gemini/config/hooks.json`.
 *
 * When that file exists and wires PreToolUse to the workspace's
 * `.agents/hooks/sta-guard.js`, the verdict is `partial`: the universal floor,
 * writes outside workspace, and contract path permissions are enforced in-band.
 * Doc-rewrite, secret-leak, PostToolUse, and per-agent exit checks have no native
 * AGY mechanism.
 */
export function antigravityCoverageWithHooks(): GuardCoverage {
  return {
    runtime: "antigravity",
    level: "partial",
    enforced: [RuntimeCapability.PRE_TOOL_GUARD],
    unenforced: [
      RuntimeCapability.POST_TOOL_GUARD,
      RuntimeCapability.EXIT_GUARD,
      RuntimeCapability.PER_AGENT_EXIT_GUARD,
    ],
    detail:
      "machine-global ~/.gemini/config/hooks.json wires PreToolUse to .agents/hooks/sta-guard.js (fail-closed deny verified on agy 1.1.27/1.2.x); " +
      "block-outside-repo, block-path-permissions, and approval channel are enforced in-band; PostToolUse and exit checks have no native AGY mechanism",
  };
}

export function antigravityCoverageUnwired(detail?: string): GuardCoverage {
  return {
    runtime: "antigravity",
    level: "unguarded",
    enforced: [],
    unenforced: ALL_GUARD_CAPABILITIES,
    detail:
      detail ??
      "machine-global ~/.gemini/config/hooks.json does not wire PreToolUse to this workspace's .agents/hooks/sta-guard.js — " +
      "run software-team-agents install-antigravity-hook to wire machine-level hooks",
  };
}

export function antigravityCoverage(
  targetRoot: string,
  options?: { machineHooksPath?: string },
): GuardCoverage {
  const wrapperPresent = fs.existsSync(path.join(targetRoot, ...AGY_GUARD_WRAPPER_PATH.split("/")));
  if (!wrapperPresent) {
    return antigravityCoverageUnwired(
      `no ${AGY_GUARD_WRAPPER_PATH} in this workspace — run software-team-agents sync; note that syncing alone does not wire machine-global hooks`,
    );
  }

  const hooksFile = options?.machineHooksPath ?? path.join(os.homedir(), ".gemini", "config", "hooks.json");
  if (!fs.existsSync(hooksFile)) {
    return antigravityCoverageUnwired(
      `no machine-global ${hooksFile} found — run software-team-agents install-antigravity-hook to wire PreToolUse to this workspace's ${AGY_GUARD_WRAPPER_PATH}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch (e) {
    return antigravityCoverageUnwired(
      `${hooksFile} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — guards fail closed to unguarded; run software-team-agents install-antigravity-hook to restore/reinstall`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return antigravityCoverageUnwired(
      `${hooksFile} root must be a JSON object — run software-team-agents install-antigravity-hook to rewrite it`,
    );
  }

  const expectedGuardScript = path.resolve(targetRoot, ...AGY_GUARD_WRAPPER_PATH.split("/")).toLowerCase().replace(/\\/g, "/");
  const rootObj = parsed as Record<string, unknown>;

  let wired = false;
  for (const hookDef of Object.values(rootObj)) {
    if (!hookDef || typeof hookDef !== "object" || Array.isArray(hookDef)) continue;
    const def = hookDef as Record<string, unknown>;
    if (def.enabled === false) continue;
    const preToolUse = def.PreToolUse;
    if (!Array.isArray(preToolUse)) continue;
    for (const entry of preToolUse) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const hooks = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (!h || typeof h !== "object" || Array.isArray(h)) continue;
        const cmd = (h as Record<string, unknown>).command;
        if (typeof cmd === "string") {
          const normCmd = cmd.toLowerCase().replace(/\\/g, "/");
          if (normCmd.includes(expectedGuardScript)) {
            wired = true;
            break;
          }
        }
      }
      if (wired) break;
    }
    if (wired) break;
  }

  if (wired) return antigravityCoverageWithHooks();

  return antigravityCoverageUnwired(
    `machine-global ${hooksFile} exists but does not wire PreToolUse to this workspace's ${AGY_GUARD_WRAPPER_PATH} — run software-team-agents install-antigravity-hook to point machine hooks at this workspace`,
  );
}

export function guardCoverage(options: {
  runtime: WorkspaceRuntime;
  targetRoot: string;
  /** Required for `claude` unless a precomputed `wiring` is supplied. */
  templatesDir?: string;
  manifest?: TargetManifest;
  config?: TargetConfig;
  /** Reuses an already-computed Claude wiring instead of reading settings twice. */
  wiring?: GuardWiringStatus;
  /** Optional override for machine-level hooks (Antigravity). */
  machineHooksPath?: string;
}): GuardCoverage {
  if (options.runtime === "codex") return codexCoverage(options.targetRoot);
  if (options.runtime === "zcode") return zcodeCoverage(options.targetRoot);
  if (options.runtime === "antigravity") return antigravityCoverage(options.targetRoot, { machineHooksPath: options.machineHooksPath });
  if (options.runtime === "opencode") return opencodeCoverage(options.targetRoot);
  const wiring = options.wiring ?? (options.templatesDir === undefined
    ? undefined
    : inspectGuardWiring({ targetRoot: options.targetRoot, templatesDir: options.templatesDir, manifest: options.manifest, config: options.config }));
  if (!wiring) {
    // Fail closed: an uninspectable wiring is never reported as coverage.
    return {
      runtime: "claude",
      level: "broken",
      enforced: [],
      unenforced: ALL_GUARD_CAPABILITIES,
      detail: "guard wiring could not be inspected — no Framework templates directory was resolved",
    };
  }
  return claudeCoverage(wiring);
}
