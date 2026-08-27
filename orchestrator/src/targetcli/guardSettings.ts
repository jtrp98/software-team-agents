import * as fs from "node:fs";
import * as path from "node:path";
import { isUserOverridden, type TargetConfig, type TargetManifest } from "./targetMeta.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
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
