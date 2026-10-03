import { z } from "zod";
import { t } from "./i18n.js";
import type { Language, MachineConfig } from "./machineConfig.js";

/**
 * The Intent Engine — natural language in, a validated STA intent out, and
 * nothing else.
 *
 * The model is a translator with zero execution authority: it never sees a
 * shell, a file, a process or a git command; its output is JSON that goes
 * through (1) schema validation, (2) machine policy, (3) Knowledge/module
 * binding against what the user selected, and only then reaches STA Core. A
 * model that says `allow_deploy: true` is overridden by policy with the
 * override recorded; a model that names another Knowledge root is refused —
 * the Knowledge a run uses is the user's selection, never the model's.
 *
 * An Intent outage never stops an active run (runs are structured state, not
 * conversations) and never blocks a new one: the deterministic offline parser
 * covers the commands the Web home and CLI need, and says it was used.
 */

export const INTENT_ACTIONS = ["work", "status", "pause", "resume", "stop"] as const;
export const COMPLETION_TARGETS = ["qa_passed", "next_gate"] as const;

export const StructuredIntentSchema = z.object({
  action: z.enum(INTENT_ACTIONS),
  knowledge_root: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  scope: z.enum(["ready_tasks", "phase", "tasks"]).default("ready_tasks"),
  phase: z.number().int().positive().optional(),
  tasks: z.array(z.string().min(1)).optional(),
  completion_target: z.enum(COMPLETION_TARGETS).default("qa_passed"),
  stop_for_human_review: z.boolean().default(true),
  allow_push: z.boolean().default(false),
  allow_merge: z.boolean().default(false),
  allow_deploy: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});
export type StructuredIntent = z.output<typeof StructuredIntentSchema>;

export interface IntentContext {
  /** The Knowledge root the user selected — binding for the result. */
  knowledge: string;
  /** The module the user selected, if any — binding when present. */
  module?: string;
  /** Modules of the selected Knowledge root only. */
  modules: readonly string[];
  language: Language;
}

export interface IntentResult {
  intent: StructuredIntent & { knowledge_root: string; module: string };
  source: "gemini" | "offline";
  /** Fields machine policy changed, in the user's language. */
  overrides: string[];
  warnings: string[];
}

export class IntentRejectedError extends Error {}

export interface IntentProvider {
  readonly name: "gemini";
  /** Returns the model's raw JSON text. Throws on transport/API failure. */
  complete(systemPrompt: string, userText: string): Promise<string>;
}

/** Machine policy for side effects the model may ask for. All are human-only. */
export const SIDE_EFFECT_POLICY = { push: "human_only", merge: "human_only", deploy: "human_only" } as const;

/**
 * Schema → policy → binding. Pure and deterministic: given the model's JSON
 * (or the offline parser's), the outcome depends only on the user's selection
 * and machine policy.
 */
export function validateIntent(raw: unknown, context: IntentContext): { intent: IntentResult["intent"]; overrides: string[] } {
  const parsed = StructuredIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntentRejectedError(`intent does not match the STA intent schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  }
  const intent = { ...parsed.data };
  const overrides: string[] = [];
  if (intent.allow_push) { intent.allow_push = false; overrides.push(t(context.language, "intent.policy_push")); }
  if (intent.allow_merge) { intent.allow_merge = false; overrides.push(t(context.language, "intent.policy_merge")); }
  if (intent.allow_deploy) { intent.allow_deploy = false; overrides.push(t(context.language, "intent.policy_deploy")); }
  // A finished run always stops for a person; nothing auto-continues past review.
  intent.stop_for_human_review = true;

  if (intent.knowledge_root !== undefined && intent.knowledge_root !== context.knowledge) {
    throw new IntentRejectedError(
      `the intent names Knowledge "${intent.knowledge_root}" but "${context.knowledge}" is selected — the Knowledge root comes from your selection, never from the model`,
    );
  }
  let moduleName = intent.module;
  if (context.module) {
    if (moduleName !== undefined && moduleName !== context.module) {
      throw new IntentRejectedError(`the intent names module "${moduleName}" but "${context.module}" is selected`);
    }
    moduleName = context.module;
  }
  if (!moduleName) throw new IntentRejectedError("no module: select a module or name one in the command");
  if (!context.modules.includes(moduleName)) {
    throw new IntentRejectedError(`module "${moduleName}" does not exist in Knowledge "${context.knowledge}" (available: ${context.modules.join(", ") || "none"})`);
  }
  if (intent.scope === "phase" && intent.phase === undefined) throw new IntentRejectedError("scope phase needs a phase number");
  if (intent.scope === "tasks" && (!intent.tasks || intent.tasks.length === 0)) throw new IntentRejectedError("scope tasks needs task ids");
  return { intent: { ...intent, knowledge_root: context.knowledge, module: moduleName }, overrides };
}

const PAUSE = /(หยุดชั่วคราว|พักไว้|พักงาน|\bpause\b)/i;
const RESUME = /(ทำต่อ|ทำงานต่อ|resume|continue)/i;
const STOP = /(ยกเลิก|หยุดงาน|หยุดทำ|\bstop\b|\bcancel\b)/i;
const STATUS = /(สถานะ|ความคืบหน้า|\bstatus\b|\bprogress\b)/i;
const NEXT_GATE = /(gate ถัดไป|next.?gate)/i;

/**
 * The deterministic offline parser: a handful of Thai/English command shapes,
 * enough to start, pause, resume, stop and ask for status without any API.
 * "ห้าม push/merge/deploy" needs no parsing — they are always off.
 */
export function parseIntentOffline(text: string, context: IntentContext): unknown {
  const normalized = text.normalize("NFC");
  let action: (typeof INTENT_ACTIONS)[number] = "work";
  if (PAUSE.test(normalized)) action = "pause";
  else if (STOP.test(normalized) && !/ห้าม/.test(normalized.slice(Math.max(0, normalized.search(STOP) - 6), normalized.search(STOP)))) action = "stop";
  else if (RESUME.test(normalized) && !/ทำ.*(ให้หมด|จน)/.test(normalized)) action = "resume";
  else if (STATUS.test(normalized)) action = "status";
  const mentioned = context.modules.find((name) => normalized.toLowerCase().includes(name.toLowerCase()));
  const phase = /(?:phase|เฟส)\s*(\d+)/i.exec(normalized)?.[1];
  const taskIds = [...normalized.matchAll(/\b(?:T|TASK|BE|FE)-\d+\b/gi)].map((match) => match[0].toUpperCase());
  return {
    action,
    knowledge_root: context.knowledge,
    ...(context.module ?? mentioned ? { module: context.module ?? mentioned } : {}),
    scope: taskIds.length > 0 ? "tasks" : phase ? "phase" : "ready_tasks",
    ...(phase ? { phase: Number(phase) } : {}),
    ...(taskIds.length > 0 ? { tasks: taskIds } : {}),
    completion_target: NEXT_GATE.test(normalized) ? "next_gate" : "qa_passed",
    stop_for_human_review: true,
    allow_push: false,
    allow_merge: false,
    allow_deploy: false,
  };
}

export function intentSystemPrompt(context: IntentContext): string {
  return [
    "You translate a software team lead's command (Thai or English) into ONE JSON object for STA, a deterministic orchestrator.",
    "You have no tools and no authority: output JSON only, no prose, no markdown.",
    "Schema: {\"action\": \"work\"|\"status\"|\"pause\"|\"resume\"|\"stop\", \"knowledge_root\": string, \"module\": string, \"scope\": \"ready_tasks\"|\"phase\"|\"tasks\", \"phase\"?: integer, \"tasks\"?: string[], \"completion_target\": \"qa_passed\"|\"next_gate\", \"stop_for_human_review\": boolean, \"allow_push\": boolean, \"allow_merge\": boolean, \"allow_deploy\": boolean, \"notes\"?: string}",
    `The selected Knowledge root is "${context.knowledge}" — always use exactly it.`,
    context.module ? `The selected module is "${context.module}" — always use exactly it.` : `Choose the module only from: ${context.modules.join(", ")}.`,
    "Default: action work, scope ready_tasks, completion_target qa_passed, stop_for_human_review true, allow_push/merge/deploy false.",
    "Never set allow_push, allow_merge or allow_deploy to true unless the user explicitly asks; policy may still refuse them.",
  ].join("\n");
}

/** Gemini `generateContent` — the key travels in a header, never in the URL. */
export function geminiProvider(options: { endpoint: string; model: string; apiKey: string; timeoutMs: number; fetchImpl?: typeof fetch }): IntentProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "gemini",
    async complete(systemPrompt, userText) {
      const url = `${options.endpoint.replace(/\/+$/, "")}/models/${encodeURIComponent(options.model)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Intent API HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      if (!text.trim()) throw new Error("Intent API returned no content");
      return text;
    },
  };
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Accept exactly one fenced JSON block; never scrape arbitrary substrings.
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    if (fenced) return JSON.parse(fenced[1]!);
    throw new IntentRejectedError("the Intent model did not return JSON");
  }
}

/**
 * Interpret one command. With a provider, the model translates; on any
 * transport/API failure the offline parser answers instead (with a warning).
 * A model answer that fails validation is a rejection, not a silent fallback:
 * the model understood something, and guessing past it would be worse.
 */
export async function interpretCommand(text: string, context: IntentContext, provider: IntentProvider | null): Promise<IntentResult> {
  const warnings: string[] = [];
  if (provider) {
    let raw: string | undefined;
    try {
      raw = await provider.complete(intentSystemPrompt(context), text);
    } catch (error) {
      warnings.push(t(context.language, "intent.offline_fallback", { reason: error instanceof Error ? error.message : String(error) }));
    }
    if (raw !== undefined) {
      const { intent, overrides } = validateIntent(parseModelJson(raw), context);
      return { intent, source: "gemini", overrides, warnings };
    }
  }
  const { intent, overrides } = validateIntent(parseIntentOffline(text, context), context);
  return { intent, source: "offline", overrides, warnings };
}

export function providerFromConfig(config: MachineConfig, apiKey: string | undefined, fetchImpl?: typeof fetch): IntentProvider | null {
  if (config.intent.provider !== "gemini" || !apiKey) return null;
  return geminiProvider({ endpoint: config.intent.endpoint, model: config.intent.model, apiKey, timeoutMs: config.intent.timeout_ms, fetchImpl });
}
