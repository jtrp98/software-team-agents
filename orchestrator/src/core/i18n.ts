import type { Language } from "./machineConfig.js";

/**
 * User-facing words STA Core produces itself (status labels, human-gate
 * reasons, report lines). Thai is the default; English is the alternative.
 * Paths, commands, identifiers, runtime ids, log lines and verbatim errors are
 * never translated — they are interpolated as-is.
 */
const MESSAGES = {
  "status.QUEUED": { th: "รอเริ่ม", en: "Queued" },
  "status.RUNNING": { th: "กำลังทำงาน", en: "Running" },
  "status.PAUSING": { th: "กำลังพัก (รอ stage ปัจจุบันจบ)", en: "Pausing (after the current stage)" },
  "status.PAUSED": { th: "พักไว้", en: "Paused" },
  "status.STOPPING": { th: "กำลังหยุด", en: "Stopping" },
  "status.STOPPED": { th: "หยุดแล้ว", en: "Stopped" },
  "status.WAITING_FOR_HUMAN": { th: "รอคนตัดสินใจ", en: "Waiting for a person" },
  "status.PAUSED_RUNTIME_EXHAUSTED": { th: "พักไว้ — runtime ไม่ว่างทุกตัว", en: "Paused — every runtime unavailable" },
  "status.READY_FOR_REVIEW": { th: "พร้อมตรวจสอบ", en: "Ready for review" },
  "status.APPROVED": { th: "อนุมัติแล้ว (ยังไม่ push/merge/deploy)", en: "Approved (not pushed/merged/deployed)" },
  "status.FAILED": { th: "ล้มเหลว", en: "Failed" },
  "gate.runtime_exhausted": { th: "runtime ที่ใช้ได้หมดทุกตัวสำหรับ {role} — จะทำต่อเองเมื่อ runtime กลับมา ({when})", en: "No usable runtime left for {role} — resumes automatically when one recovers ({when})" },
  "gate.security_no_runtime": { th: "ไม่มี runtime ที่ผ่านเงื่อนไขความปลอดภัยสำหรับ {role} — ต้องให้คนแก้การตั้งค่า runtime", en: "No security-eligible runtime for {role} — a person must fix the runtime setup" },
  "gate.knowledge_changed": { th: "การลงทะเบียน Knowledge \"{name}\" เปลี่ยนไปจากตอนเริ่ม run — หยุดเพื่อไม่ให้ใช้ Knowledge ผิดตัว", en: "Knowledge \"{name}\" registration changed since the run started — stopped so the run never uses other Knowledge" },
  "gate.engine_waiting": { th: "งานรอคนตัดสินใจ: {reason}", en: "Work is waiting for a person: {reason}" },
  "gate.engine_halted": { th: "งานหยุดกลางทาง: {reason}", en: "Work halted: {reason}" },
  "gate.engine_refused": { th: "STA ปฏิเสธการเริ่มงาน: {reason}", en: "STA refused to start the work: {reason}" },
  "gate.segment_budget": { th: "ทำครบจำนวนรอบอัตโนมัติสูงสุด ({max}) แล้ว — ให้คนตรวจก่อนทำต่อ", en: "Reached the automatic segment limit ({max}) — a person reviews before continuing" },
  "gate.interrupted": { th: "process ทำงานถูกหยุดกะทันหัน — STA จะ resume ให้ ถ้ามีงานค้างใน working tree คนต้องตัดสินใจก่อน", en: "The work process stopped unexpectedly — STA resumes it; a partial diff needs a person first" },
  "commander.unavailable": { th: "Commander ใช้ไม่ได้ทุก runtime", en: "No commander runtime is available" },
  "report.not_done": { th: "ยังไม่ได้ทำ: push · merge · deploy", en: "Not done: push · merge · deploy" },
  "intent.offline_fallback": { th: "Intent API ใช้งานไม่ได้ ({reason}) — ใช้ตัวแปลคำสั่งแบบ offline แทน", en: "Intent API unavailable ({reason}) — used the offline command parser" },
  "intent.policy_push": { th: "ปิด push ตาม machine policy (push ทำโดยคนเท่านั้น)", en: "push disabled by machine policy (human only)" },
  "intent.policy_merge": { th: "ปิด merge ตาม machine policy (merge ทำโดยคนเท่านั้น)", en: "merge disabled by machine policy (human only)" },
  "intent.policy_deploy": { th: "ปิด deploy ตาม machine policy (deploy ทำโดยคนเท่านั้น)", en: "deploy disabled by machine policy (human only)" },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function t(language: Language, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = MESSAGES[key][language] ?? MESSAGES[key].th;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}
