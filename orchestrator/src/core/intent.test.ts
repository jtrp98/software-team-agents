import { describe, expect, it, vi } from "vitest";
import { geminiProvider, interpretCommand, IntentRejectedError, parseIntentOffline, validateIntent, type IntentContext, type IntentProvider } from "./intent.js";

/** Obvious placeholder, not a credential. */
const PLACEHOLDER = ["changeme", "placeholder", "intent"].join("-");

const context: IntentContext = { knowledge: "timetable", modules: ["timetableai", "reports"], language: "th" };
const THAI = "ทำงานที่พร้อมให้หมดจน QA ผ่าน\nแล้วหยุดให้ฉันตรวจ\nห้าม push\nห้าม merge\nห้าม deploy";

function provider(answer: unknown | (() => never)): IntentProvider {
  return { name: "gemini", complete: vi.fn(async () => (typeof answer === "function" ? (answer as () => never)() : JSON.stringify(answer))) };
}

describe("STA Intent Engine", () => {
  it("Thai → a valid structured intent with the selected Knowledge included (offline parser)", async () => {
    const result = await interpretCommand(THAI, { ...context, module: "timetableai" }, null);
    expect(result.source).toBe("offline");
    expect(result.intent).toMatchObject({
      action: "work", knowledge_root: "timetable", module: "timetableai", scope: "ready_tasks",
      completion_target: "qa_passed", stop_for_human_review: true, allow_push: false, allow_merge: false, allow_deploy: false,
    });
  });

  it("Thai → intent through the model, with the module found in the text", async () => {
    const model = provider({ action: "work", knowledge_root: "timetable", module: "timetableai", completion_target: "qa_passed" });
    const result = await interpretCommand("ทำ timetableai ต่อจน QA ผ่าน แล้วหยุดให้ฉันตรวจ", context, model);
    expect(result.source).toBe("gemini");
    expect(result.intent.module).toBe("timetableai");
    expect(result.intent.knowledge_root).toBe("timetable");
  });

  it("an invalid action is rejected by the schema", () => {
    expect(() => validateIntent({ action: "deploy", module: "timetableai" }, context)).toThrow(IntentRejectedError);
  });

  it("the model cannot choose another Knowledge root", async () => {
    const model = provider({ action: "work", knowledge_root: "company-a", module: "timetableai" });
    await expect(interpretCommand("work", context, model)).rejects.toThrow(/comes from your selection/);
  });

  it("a module outside the selected Knowledge is rejected", () => {
    expect(() => validateIntent({ action: "work", module: "billing" }, context)).toThrow(/does not exist in Knowledge "timetable"/);
  });

  it("the model cannot override policy: allow_deploy/push/merge true are forced off and reported", async () => {
    const model = provider({ action: "work", knowledge_root: "timetable", module: "timetableai", allow_deploy: true, allow_push: true, allow_merge: true, stop_for_human_review: false });
    const result = await interpretCommand("deploy it", context, model);
    expect(result.intent.allow_deploy).toBe(false);
    expect(result.intent.allow_push).toBe(false);
    expect(result.intent.allow_merge).toBe(false);
    expect(result.intent.stop_for_human_review).toBe(true);
    expect(result.overrides).toHaveLength(3);
    expect(result.overrides[2]).toMatch(/deploy/);
  });

  it("an Intent API failure is handled: the offline parser answers and says so", async () => {
    const failing = provider(() => { throw new Error("Intent API HTTP 503"); });
    const result = await interpretCommand(THAI, { ...context, module: "timetableai" }, failing);
    expect(result.source).toBe("offline");
    expect(result.warnings[0]).toMatch(/503/);
  });

  it("the offline parser understands pause/resume/stop/status in Thai and English", () => {
    const ctx = { ...context, module: "timetableai" };
    expect((parseIntentOffline("หยุดชั่วคราว", ctx) as { action: string }).action).toBe("pause");
    expect((parseIntentOffline("ทำต่อ", ctx) as { action: string }).action).toBe("resume");
    expect((parseIntentOffline("stop timetableai", ctx) as { action: string }).action).toBe("stop");
    expect((parseIntentOffline("สถานะเป็นยังไง", ctx) as { action: string }).action).toBe("status");
    expect((parseIntentOffline("ทำ phase 2 จนถึง gate ถัดไป", ctx) as { phase: number; completion_target: string })).toMatchObject({ phase: 2, completion_target: "next_gate" });
  });

  it("the Gemini provider sends the key in a header — never in the URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"action\":\"work\"}" }] } }] }), { status: 200 }));
    const p = geminiProvider({ endpoint: "https://example.test/v1beta", model: "gemini-3.5-flash-lite", apiKey: PLACEHOLDER, timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.complete("system", "user");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(url).not.toContain(PLACEHOLDER);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(PLACEHOLDER);
  });
});
