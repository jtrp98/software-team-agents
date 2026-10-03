/* STA Core Web UI — a frontend only. Every rule lives in STA Core; this file
 * renders state from the Local API and sends the person's actions back to it.
 * DOM is built with createElement/textContent only (no innerHTML of data). */
"use strict";

const TOKEN = document.querySelector('meta[name="sta-token"]').content;
const SERVER_LANG = document.querySelector('meta[name="sta-lang"]').content;
let LANG = (() => { try { return localStorage.getItem("sta-lang") || SERVER_LANG || "th"; } catch { return SERVER_LANG || "th"; } })();
if (LANG !== "th" && LANG !== "en") LANG = "th";

const I18N = {
  th: {
    "nav.work": "งาน", "nav.runs": "Runs", "nav.runtimes": "Runtime", "nav.knowledge": "Knowledge", "nav.settings": "ตั้งค่า",
    "work.title": "สั่งงาน", "work.knowledge": "Knowledge", "work.module": "Module", "work.command": "คำสั่ง",
    "work.defaultCommand": "ทำงานที่พร้อมให้หมดจน QA ผ่าน\nแล้วหยุดให้ฉันตรวจ\nห้าม push\nห้าม merge\nห้าม deploy",
    "work.start": "เริ่มงาน", "work.preview": "ดูคำสั่งที่ระบบเข้าใจ", "work.targets": "Targets ของ Knowledge นี้",
    "work.recent": "Runs ล่าสุดของ Knowledge นี้", "work.noKnowledge": "ยังไม่มี Knowledge — ไปที่หน้า Knowledge เพื่อเพิ่ม",
    "work.started": "เริ่มงานแล้ว — ปิด browser ได้ งานยังทำต่อใน background",
    "work.policy": "push · merge · deploy ทำโดยคนเท่านั้น — STA จะไม่ทำเอง",
    "runs.title": "Runs", "runs.active": "กำลังทำงาน", "runs.paused": "พักไว้", "runs.waiting": "รอคนตัดสินใจ",
    "runs.exhausted": "Runtime ไม่ว่าง", "runs.completed": "เสร็จ / พร้อมตรวจ", "runs.failed": "ล้มเหลว / หยุด", "runs.none": "ไม่มี",
    "run.knowledge": "Knowledge", "run.module": "Module", "run.target": "Target", "run.task": "งานปัจจุบัน", "run.stage": "Stage ปัจจุบัน",
    "run.commander": "Commander", "run.engineer": "Engineer", "run.reviewer": "Reviewer", "run.qa": "QA",
    "run.tasks": "งาน", "run.verification": "ผลตรวจ", "run.changed": "ไฟล์ที่เปลี่ยน", "run.history": "ประวัติ Runtime",
    "run.fallbacks": "Fallback timeline", "run.gates": "Human gates", "run.handoffs": "Structured handoff", "run.events": "เหตุการณ์", "run.log": "Log ของ segment",
    "run.pause": "พัก", "run.resume": "ทำต่อ", "run.stop": "หยุด", "run.forceStop": "หยุดทันที", "run.review": "ไปหน้าตรวจงาน",
    "run.approve": "อนุมัติ", "run.chat.title": "STA Agent ต้องการคำตอบหรือการตัดสินใจ", "run.chat.badge": "รอคนตัดสินใจ",
    "run.chat.prompt": "Agent กำลังรองานและต้องการให้คุณตัดสินใจหรือตอบคำถามในประเด็นนี้:",
    "run.chat.placeholder": "พิมพ์คำตอบ หมายเหตุ หรือคำสั่งเพิ่มเติม... (เช่น 'อนุมัติผ่านได้', 'ดำเนินการต่อ')",
    "run.chat.namePlaceholder": "ชื่อผู้ตอบ", "run.chat.sendResume": "ตอบ & ทำต่อ", "run.chat.approve": "อนุมัติ",
    "run.chat.sent": "ส่งคำตอบแล้ว", "run.chat.waitingHint": "STA Agent รอการตัดสินใจจากคุณ — คลิกเพื่อเปิดดูและตอบ",
    "run.chat.quickApprove": "ยืนยันอนุมัติ", "run.chat.quickProceed": "ดำเนินการต่อ",
    "run.commanderNotes": "บันทึกของ Commander", "run.reviewPassed": "Review ผ่าน", "run.qaPassed": "QA ผ่าน", "run.securityPassed": "Security ผ่าน", "run.done": "เสร็จ",
    "review.title": "ตรวจงาน", "review.status": "สถานะ", "review.tasksCompleted": "งานที่เสร็จ", "review.build": "Build / deterministic gate",
    "review.reviewFindings": "Review", "review.qaFindings": "QA", "review.viewDiff": "ดู Diff", "review.approve": "อนุมัติ", "review.sendBack": "ส่งกลับ",
    "review.resume": "ทำงานต่อ", "review.prepareCommit": "เตรียม Commit", "review.notDone": "ยังไม่ได้ทำ: push · merge · deploy",
    "review.name": "ชื่อผู้ตรวจ", "review.note": "หมายเหตุ", "review.approved": "อนุมัติแล้ว — ยังไม่มีการ push/merge/deploy",
    "rt.title": "Runtime", "rt.installed": "ติดตั้ง", "rt.version": "เวอร์ชัน", "rt.auth": "การยืนยันตัวตน", "rt.background": "พร้อมทำงาน background",
    "rt.security": "Security", "rt.health": "สุขภาพตอนนี้", "rt.quota": "Quota", "rt.lastError": "Error ล่าสุด", "rt.roles": "บทบาทที่ STA ใช้ได้",
    "rt.connect": "Connect", "rt.login": "Login", "rt.reconnect": "Reconnect", "rt.test": "Test",
    "rt.refresh": "ตรวจทั้งหมดอีกครั้ง", "rt.loginHint": "รันคำสั่งนี้ใน terminal ของคุณเอง แล้วกด Reconnect:", "rt.never": "ยังไม่เคยตรวจ — กด ตรวจทั้งหมดอีกครั้ง",
    "kn.title": "Knowledge Workspaces", "kn.add": "เพิ่ม Knowledge", "kn.name": "ชื่อ (a-z, 0-9, -)", "kn.path": "Path", "kn.makeDefault": "ตั้งเป็นค่าเริ่มต้น",
    "kn.validate": "Validate", "kn.setDefault": "ตั้งเป็นค่าเริ่มต้น", "kn.open": "เปิด", "kn.refresh": "Refresh", "kn.remove": "ลบการลงทะเบียน",
    "kn.removeConfirm": "ลบการลงทะเบียน Knowledge นี้? (ไฟล์ใน repository จะไม่ถูกลบ)", "kn.targets": "targets", "kn.modules": "modules", "kn.default": "ค่าเริ่มต้น",
    "st.title": "ตั้งค่า", "st.machineRoot": "Machine root (ขอบเขตนอกสุด)", "st.language": "ภาษา", "st.defaultKnowledge": "Knowledge เริ่มต้น",
    "st.intent": "Intent API", "st.provider": "Provider", "st.model": "Model", "st.key": "API key", "st.keySet": "ตั้งค่าแล้ว", "st.keyUnset": "ยังไม่ได้ตั้ง (ใช้ตัวแปลแบบ offline)",
    "st.saveKey": "บันทึก key", "st.deleteKey": "ลบ key", "st.routing": "ลำดับ Runtime ต่อบทบาท", "st.commander": "Commander", "st.engineer": "Engineer", "st.reviewer": "Reviewer", "st.qa": "QA",
    "st.fallback": "ใช้ตัวถัดไปเมื่อใช้ไม่ได้ (preferred)", "st.exclusive": "ใช้ตัวแรกเท่านั้น (exclusive — ไม่ fallback)",
    "st.permissions": "นโยบายสิทธิ์", "st.autonomy": "Autonomy ของงาน", "st.health": "Cooldown (นาที)", "st.save": "บันทึก", "st.saved": "บันทึกแล้ว",
    "st.permText": "Machine root → Knowledge/Target → Task → Role/packet — แต่ละชั้นแคบกว่าชั้นนอก · push / merge / deploy = คนเท่านั้น · secret ไม่ถูกส่งกลับมาที่หน้าเว็บ",
    "common.loading": "กำลังโหลด…", "common.error": "ผิดพลาด", "common.yes": "ใช่", "common.no": "ไม่", "common.unknown": "ไม่ทราบ",
    "core.running": "STA Core ทำงาน", "core.down": "ติดต่อ STA Core ไม่ได้",
  },
  en: {
    "nav.work": "Work", "nav.runs": "Runs", "nav.runtimes": "Runtimes", "nav.knowledge": "Knowledge", "nav.settings": "Settings",
    "work.title": "Start work", "work.knowledge": "Knowledge", "work.module": "Module", "work.command": "Command",
    "work.defaultCommand": "Work every ready task until QA passes,\nthen stop for my review.\nNo push. No merge. No deploy.",
    "work.start": "Start Work", "work.preview": "Show how STA reads this", "work.targets": "Targets of this Knowledge",
    "work.recent": "Recent runs of this Knowledge", "work.noKnowledge": "No Knowledge yet — add one on the Knowledge page",
    "work.started": "Work started — you can close the browser; it keeps going in the background",
    "work.policy": "push · merge · deploy are human-only — STA never does them",
    "runs.title": "Runs", "runs.active": "Active", "runs.paused": "Paused", "runs.waiting": "Waiting for Human",
    "runs.exhausted": "Runtime Exhausted", "runs.completed": "Completed / Ready for review", "runs.failed": "Failed / Stopped", "runs.none": "none",
    "run.knowledge": "Knowledge", "run.module": "Module", "run.target": "Target", "run.task": "Current task", "run.stage": "Current stage",
    "run.commander": "Commander", "run.engineer": "Engineer", "run.reviewer": "Reviewer", "run.qa": "QA",
    "run.tasks": "Tasks", "run.verification": "Verification", "run.changed": "Changed files", "run.history": "Runtime history",
    "run.fallbacks": "Fallback timeline", "run.gates": "Human gates", "run.handoffs": "Structured handoffs", "run.events": "Events", "run.log": "Segment log",
    "run.pause": "Pause", "run.resume": "Resume", "run.stop": "Stop", "run.forceStop": "Force stop", "run.review": "Open review",
    "run.approve": "Approve", "run.chat.title": "STA Agent needs your decision", "run.chat.badge": "Waiting for Human",
    "run.chat.prompt": "The agent is paused and needs your decision or answer on this issue:",
    "run.chat.placeholder": "Type your answer, note, or extra instructions... (e.g. 'Approved', 'Proceed')",
    "run.chat.namePlaceholder": "Your name", "run.chat.sendResume": "Reply & Resume", "run.chat.approve": "Approve",
    "run.chat.sent": "Response sent", "run.chat.waitingHint": "STA Agent is waiting for your decision — click to view and reply",
    "run.chat.quickApprove": "Approve and proceed", "run.chat.quickProceed": "Proceed with current plan",
    "run.commanderNotes": "Commander notes", "run.reviewPassed": "Review passed", "run.qaPassed": "QA passed", "run.securityPassed": "Security passed", "run.done": "Done",
    "review.title": "Review", "review.status": "Status", "review.tasksCompleted": "Tasks completed", "review.build": "Build / deterministic gate",
    "review.reviewFindings": "Review", "review.qaFindings": "QA", "review.viewDiff": "View Diff", "review.approve": "Approve", "review.sendBack": "Send Back",
    "review.resume": "Resume Work", "review.prepareCommit": "Prepare Commit", "review.notDone": "Not done: push · merge · deploy",
    "review.name": "Reviewer name", "review.note": "Note", "review.approved": "Approved — nothing was pushed, merged or deployed",
    "rt.title": "Runtimes", "rt.installed": "Installed", "rt.version": "Version", "rt.auth": "Authentication", "rt.background": "Background ready",
    "rt.security": "Security", "rt.health": "Current health", "rt.quota": "Quota", "rt.lastError": "Last error", "rt.roles": "Roles STA may use it for",
    "rt.connect": "Connect", "rt.login": "Login", "rt.reconnect": "Reconnect", "rt.test": "Test",
    "rt.refresh": "Re-check all", "rt.loginHint": "Run this in your own terminal, then press Reconnect:", "rt.never": "Not checked yet — press Re-check all",
    "kn.title": "Knowledge Workspaces", "kn.add": "Add Knowledge", "kn.name": "Name (a-z, 0-9, -)", "kn.path": "Path", "kn.makeDefault": "Make default",
    "kn.validate": "Validate", "kn.setDefault": "Set Default", "kn.open": "Open", "kn.refresh": "Refresh", "kn.remove": "Remove registration",
    "kn.removeConfirm": "Remove this Knowledge registration? (The repository on disk is not deleted.)", "kn.targets": "targets", "kn.modules": "modules", "kn.default": "default",
    "st.title": "Settings", "st.machineRoot": "Machine root (outer boundary)", "st.language": "Language", "st.defaultKnowledge": "Default Knowledge",
    "st.intent": "Intent API", "st.provider": "Provider", "st.model": "Model", "st.key": "API key", "st.keySet": "configured", "st.keyUnset": "not set (offline parser is used)",
    "st.saveKey": "Save key", "st.deleteKey": "Delete key", "st.routing": "Runtime order per role", "st.commander": "Commander", "st.engineer": "Engineer", "st.reviewer": "Reviewer", "st.qa": "QA",
    "st.fallback": "Fall back to the next one (preferred)", "st.exclusive": "First one only (exclusive — no fallback)",
    "st.permissions": "Permission policy", "st.autonomy": "Work autonomy", "st.health": "Cooldowns (minutes)", "st.save": "Save", "st.saved": "Saved",
    "st.permText": "Machine root → Knowledge/Target → Task → Role/packet — each narrower than the one outside · push / merge / deploy = human only · secrets are never sent back to this page",
    "common.loading": "Loading…", "common.error": "Error", "common.yes": "yes", "common.no": "no", "common.unknown": "unknown",
    "core.running": "STA Core running", "core.down": "Cannot reach STA Core",
  },
};
const tr = (key) => (I18N[LANG] && I18N[LANG][key]) || I18N.th[key] || key;

const RUNTIME_NAMES = { "claude-code": "Claude Code", codex: "Codex", antigravity: "AGY", zcode: "ZCode" };
const STATUS_TONE = {
  RUNNING: "info", QUEUED: "info", PAUSING: "warn", STOPPING: "warn", PAUSED: "warn", WAITING_FOR_HUMAN: "warn",
  PAUSED_RUNTIME_EXHAUSTED: "warn", READY_FOR_REVIEW: "ok", APPROVED: "ok", STOPPED: "", FAILED: "bad",
};
const STATUS_LABEL = {
  th: { QUEUED: "รอเริ่ม", RUNNING: "กำลังทำงาน", PAUSING: "กำลังพัก", PAUSED: "พักไว้", STOPPING: "กำลังหยุด", STOPPED: "หยุดแล้ว", WAITING_FOR_HUMAN: "รอคนตัดสินใจ", PAUSED_RUNTIME_EXHAUSTED: "Runtime ไม่ว่างทุกตัว", READY_FOR_REVIEW: "พร้อมตรวจสอบ", APPROVED: "อนุมัติแล้ว", FAILED: "ล้มเหลว" },
  en: { QUEUED: "Queued", RUNNING: "Running", PAUSING: "Pausing", PAUSED: "Paused", STOPPING: "Stopping", STOPPED: "Stopped", WAITING_FOR_HUMAN: "Waiting for Human", PAUSED_RUNTIME_EXHAUSTED: "Runtime Exhausted", READY_FOR_REVIEW: "Ready for Review", APPROVED: "Approved", FAILED: "Failed" },
};
const statusLabel = (s) => (STATUS_LABEL[LANG] || STATUS_LABEL.th)[s] || s;

// ───────────────────────── helpers ─────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const pill = (text, tone) => h("span", { class: `pill ${tone || ""}` }, text);
const statusPill = (status) => pill(statusLabel(status), STATUS_TONE[status]);
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString(LANG === "th" ? "th-TH" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "-");
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(LANG === "th" ? "th-TH" : "en-GB") : "-");
const rtName = (id) => (id ? RUNTIME_NAMES[id] || id : "-");

async function api(method, path, body) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "x-sta-token": TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

let toastTimer = null;
function toast(message, bad) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${bad ? "bad" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 9000 : 4500);
}
async function act(fn, okMessage) {
  try {
    const result = await fn();
    if (okMessage) toast(okMessage);
    return result;
  } catch (error) {
    toast(`${tr("common.error")}: ${error.message}`, true);
    return undefined;
  }
}

const app = () => document.getElementById("app");
function mount(...nodes) { app().replaceChildren(...nodes.filter((node) => node !== null && node !== undefined && node !== false)); }

let pollTimer = null;
function poll(fn, ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) fn(); }, ms);
}

function rememberSelection(knowledge, module) {
  try {
    if (knowledge) localStorage.setItem("sta-knowledge", knowledge);
    if (module !== undefined) localStorage.setItem(`sta-module:${knowledge}`, module || "");
  } catch { /* storage may be unavailable */ }
}
function recalled(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }

// ───────────────────────── pages ─────────────────────────
async function pageWork() {
  mount(h("p", { class: "muted" }, tr("common.loading")));
  const knowledge = await api("GET", "knowledge");
  if (knowledge.length === 0) {
    mount(h("h1", {}, tr("work.title")), h("div", { class: "empty" }, h("a", { href: "#/knowledge" }, tr("work.noKnowledge"))));
    return;
  }
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  let selected = query.get("knowledge") || recalled("sta-knowledge");
  if (!knowledge.some((k) => k.name === selected)) selected = (knowledge.find((k) => k.isDefault) || knowledge[0]).name;

  const knowledgeSelect = h("select", { id: "knowledge-select", "aria-label": tr("work.knowledge") },
    knowledge.map((k) => h("option", { value: k.name }, `${k.isDefault ? "● " : ""}${k.name} — ${k.state}`)));
  knowledgeSelect.value = selected;
  const moduleSelect = h("select", { id: "module-select", "aria-label": tr("work.module") });
  const command = h("textarea", { id: "command", "aria-label": tr("work.command") });
  command.value = tr("work.defaultCommand");
  const intentBox = h("div", { class: "hidden" });
  const targetsBox = h("div", {});
  const recentBox = h("div", { class: "stack" });

  async function loadModules() {
    const name = knowledgeSelect.value;
    rememberSelection(name);
    const data = await api("GET", `knowledge/${encodeURIComponent(name)}/modules`);
    // Modules and targets come from this Knowledge only.
    moduleSelect.replaceChildren(...data.modules.map((m) => h("option", { value: m }, m)));
    const remembered = recalled(`sta-module:${name}`);
    if (data.modules.includes(remembered)) moduleSelect.value = remembered;
    targetsBox.replaceChildren(
      data.targets.length === 0 ? h("p", { class: "muted small" }, "-")
        : h("ul", { class: "small" }, data.targets.map((target) => h("li", {}, h("code", {}, target.targetId), ` ${target.type || ""} · ${target.status}${target.localPath ? ` · ${target.localPath}` : ""}`))),
    );
    const runs = await api("GET", `runs?knowledge=${encodeURIComponent(name)}`);
    recentBox.replaceChildren(...(runs.length === 0 ? [h("p", { class: "muted small" }, tr("runs.none"))] : runs.slice(0, 6).map(runCard)));
  }
  knowledgeSelect.addEventListener("change", () => { intentBox.classList.add("hidden"); loadModules(); });
  moduleSelect.addEventListener("change", () => rememberSelection(knowledgeSelect.value, moduleSelect.value));

  const startButton = h("button", { class: "primary btn-lg", type: "button", onclick: async () => {
    startButton.disabled = true;
    const result = await act(() => api("POST", "runs", { knowledge: knowledgeSelect.value, module: moduleSelect.value, text: command.value }));
    startButton.disabled = false;
    if (result) {
      toast(tr("work.started"));
      location.hash = `#/runs/${result.run.runId}`;
    }
  } }, tr("work.start"));
  const previewButton = h("button", { class: "link", type: "button", onclick: async () => {
    const result = await act(() => api("POST", "intent/preview", { knowledge: knowledgeSelect.value, module: moduleSelect.value, text: command.value }));
    if (!result) return;
    intentBox.replaceChildren(
      h("div", { class: "row" }, pill(`source: ${result.source}`, result.source === "gemini" ? "info" : "")),
      ...result.overrides.map((o) => h("div", { class: "banner warn small" }, o)),
      ...result.warnings.map((w) => h("div", { class: "banner warn small" }, w)),
      h("pre", { class: "log" }, JSON.stringify(result.intent, null, 2)),
    );
    intentBox.classList.remove("hidden");
  } }, tr("work.preview"));

  mount(
    h("h1", {}, tr("work.title")),
    h("div", { class: "grid grid-2" },
      h("div", { class: "card stack" },
        h("div", {}, h("label", { for: "knowledge-select" }, tr("work.knowledge")), knowledgeSelect),
        h("div", {}, h("label", { for: "module-select" }, tr("work.module")), moduleSelect),
        h("div", {}, h("label", { for: "command" }, tr("work.command")), command),
        h("div", { class: "row space" }, startButton, previewButton),
        h("p", { class: "muted small" }, tr("work.policy")),
        intentBox,
      ),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h3", {}, tr("work.targets")), targetsBox),
        h("div", { class: "card" }, h("h3", {}, tr("work.recent")), recentBox),
      ),
    ),
  );
  await loadModules();
}

function runCard(run) {
  const isWaiting = run.status === "WAITING_FOR_HUMAN";
  return h("div", { class: `card clickable ${isWaiting ? "waiting-card" : ""}`, onclick: () => { location.hash = `#/runs/${run.runId}`; } },
    h("div", { class: "row space" }, h("strong", {}, `${run.knowledge} / ${run.module}`), statusPill(run.status)),
    h("div", { class: "muted small" }, `${run.runId} · ${fmtDate(run.createdAt)}`),
    isWaiting ? h("div", { class: "banner warn small", style: "font-weight: 600;" }, `💬 ${tr("run.chat.waitingHint")}`) : null,
    run.statusReason ? h("div", { class: "small" }, run.statusReason) : null,
    h("div", { class: "small muted" },
      `${tr("run.commander")}: ${rtName(run.commander)} · ${tr("run.engineer")}: ${rtName(run.workers.engineer)} · ${tr("run.reviewer")}: ${rtName(run.workers.reviewer)} · ${tr("run.qa")}: ${rtName(run.workers.qa)}`,
      run.tasksTotal !== null ? ` · ${run.tasksDone}/${run.tasksTotal}` : "",
      run.fallbacks ? ` · fallback ×${run.fallbacks}` : ""),
  );
}

const GROUPS = [
  ["runs.active", ["QUEUED", "RUNNING", "PAUSING", "STOPPING"]],
  ["runs.paused", ["PAUSED"]],
  ["runs.waiting", ["WAITING_FOR_HUMAN"]],
  ["runs.exhausted", ["PAUSED_RUNTIME_EXHAUSTED"]],
  ["runs.completed", ["READY_FOR_REVIEW", "APPROVED"]],
  ["runs.failed", ["FAILED", "STOPPED"]],
];

async function pageRuns() {
  const render = async () => {
    const runs = await api("GET", "runs");
    mount(
      h("h1", {}, tr("runs.title")),
      ...GROUPS.map(([key, statuses]) => {
        const group = runs.filter((run) => statuses.includes(run.status));
        return h("section", {},
          h("div", { class: "section-title" }, h("h2", {}, tr(key)), h("span", { class: "count" }, String(group.length))),
          group.length === 0 ? h("div", { class: "empty small" }, tr("runs.none")) : h("div", { class: "grid grid-2" }, group.map(runCard)));
      }),
    );
  };
  await render();
  poll(render, 4000);
}

function timeline(items) {
  if (items.length === 0) return h("p", { class: "muted small" }, tr("runs.none"));
  return h("ul", { class: "timeline" }, items.map((item) => h("li", {}, h("time", {}, fmtTime(item.at)), h("div", { class: item.cls || "" }, item.text))));
}

function historyItems(run) {
  return run.runtimeHistory.slice(-80).map((entry) => ({
    at: entry.at,
    cls: entry.event === "failure" ? "fail" : "",
    text: `${rtName(entry.runtimeId)} → ${entry.role} · ${entry.event}${entry.failureClass ? ` · ${entry.failureClass}` : ""}${entry.detail && entry.event !== "success" ? ` — ${entry.detail}` : ""}`,
  }));
}

function renderChatCard(run, gates, render) {
  const gateItems = gates.length > 0 ? gates : [{ id: "waiting", kind: "decision", at: Date.now(), reason: run.statusReason || tr("runs.waiting") }];
  
  const reviewerInput = h("input", {
    type: "text",
    class: "chat-name-input",
    placeholder: tr("run.chat.namePlaceholder"),
    value: recalled("sta-reviewer") || "",
  });
  reviewerInput.addEventListener("input", () => {
    try { localStorage.setItem("sta-reviewer", reviewerInput.value.trim()); } catch { /* ignore */ }
  });

  const textarea = h("textarea", {
    class: "chat-textarea",
    placeholder: tr("run.chat.placeholder"),
  });

  const getReviewer = () => reviewerInput.value.trim() || recalled("sta-reviewer") || "human";

  const btnApprove = h("button", {
    type: "button",
    class: "primary btn-approve",
    onclick: async () => {
      const by = getReviewer();
      try { localStorage.setItem("sta-reviewer", by); } catch { /* ignore */ }
      const note = textarea.value.trim() || "Approved via Web UI";
      const done = await act(() => api("POST", `runs/${run.runId}/approve`, { by, note }), tr("review.approved"));
      if (done) render();
    },
  }, `✓ ${tr("run.chat.approve")}`);

  const btnResume = h("button", {
    type: "button",
    class: "primary",
    onclick: async () => {
      const by = getReviewer();
      try { localStorage.setItem("sta-reviewer", by); } catch { /* ignore */ }
      const note = textarea.value.trim() || undefined;
      const done = await act(() => api("POST", `runs/${run.runId}/resume`, { by, note }), tr("run.chat.sent"));
      if (done) render();
    },
  }, `▶ ${tr("run.chat.sendResume")}`);

  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      btnResume.click();
    }
  });

  const quickChip = (text) => h("button", {
    type: "button",
    class: "link small",
    style: "border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; background: var(--surface); text-decoration: none;",
    onclick: () => { textarea.value = text; textarea.focus(); },
  }, `+ ${text}`);

  const chips = [
    quickChip(tr("run.chat.quickApprove")),
    quickChip(tr("run.chat.quickProceed")),
  ];

  return h("div", { class: "chat-card" },
    h("div", { class: "chat-card-header" },
      h("div", { class: "chat-avatar" }, "🤖"),
      h("div", { class: "chat-header-info" },
        h("div", { class: "chat-title" }, tr("run.chat.title")),
        h("div", { class: "muted small" }, tr("run.chat.prompt")),
      ),
      h("span", { class: "pill warn", style: "margin-left: auto;" }, tr("run.chat.badge")),
    ),
    h("div", { class: "chat-conversation" },
      gateItems.map((g) => h("div", { class: "chat-msg-row" },
        h("div", { class: "chat-bubble agent" },
          h("div", { class: "chat-msg-meta" },
            pill(g.kind || "gate", "warn"),
            g.at ? h("time", { class: "small muted" }, fmtTime(g.at)) : null,
          ),
          h("div", { class: "chat-msg-text" }, g.reason),
        ),
      )),
    ),
    h("div", { class: "chat-reply-box" },
      h("div", { class: "chat-input-row" },
        h("label", { class: "small muted", style: "margin: 0; white-space: nowrap;" }, `${tr("review.name")}:`),
        reviewerInput,
        h("div", { class: "row", style: "gap: 6px; margin-left: auto;" }, ...chips),
      ),
      textarea,
      h("div", { class: "chat-actions" },
        h("span", { class: "small muted", style: "margin-right: auto;" }, "Ctrl+Enter = " + tr("run.chat.sendResume")),
        btnResume,
        btnApprove,
      ),
    ),
  );
}

async function pageRun(runId) {
  let segmentShown = null;
  const logPre = h("pre", { class: "log" }, "");
  const render = async () => {
    const data = await api("GET", `runs/${encodeURIComponent(runId)}`);
    const run = data.run;
    const snap = run.snapshot || {};
    const tasks = snap.tasks || [];
    const v = snap.verification || {};
    const gates = run.humanGates.filter((g) => g.resolvedAt === null);
    const isWaiting = run.status === "WAITING_FOR_HUMAN" || gates.length > 0;
    const reviewerName = () => recalled("sta-reviewer") || "human";

    const controls = h("div", { class: "row" },
      ["RUNNING", "QUEUED"].includes(run.status) ? h("button", { onclick: () => act(() => api("POST", `runs/${runId}/pause`), tr("run.pause")).then(render) }, tr("run.pause")) : null,
      isWaiting ? h("button", { class: "primary btn-approve", onclick: () => act(() => api("POST", `runs/${runId}/approve`, { by: reviewerName(), note: "Approved via Web UI" }), tr("review.approved")).then(render) }, `✓ ${tr("run.approve")}`) : null,
      ["PAUSED", "PAUSED_RUNTIME_EXHAUSTED", "WAITING_FOR_HUMAN", "STOPPED"].includes(run.status) ? h("button", { class: isWaiting ? "" : "primary", onclick: () => act(() => api("POST", `runs/${runId}/resume`), tr("run.resume")).then(render) }, tr("run.resume")) : null,
      !["STOPPED", "APPROVED", "FAILED"].includes(run.status) ? h("button", { class: "danger", onclick: () => act(() => api("POST", `runs/${runId}/stop`, {}), tr("run.stop")).then(render) }, tr("run.stop")) : null,
      ["RUNNING", "STOPPING", "PAUSING"].includes(run.status) ? h("button", { class: "danger", onclick: () => { if (confirm(tr("run.forceStop") + "?")) act(() => api("POST", `runs/${runId}/stop`, { force: true })).then(render); } }, tr("run.forceStop")) : null,
      ["READY_FOR_REVIEW", "APPROVED"].includes(run.status) ? h("a", { href: `#/review/${runId}` }, h("button", { class: "primary" }, tr("run.review"))) : null,
    );
    const chatCard = isWaiting ? renderChatCard(run, gates, render) : null;
    mount(
      h("div", { class: "row space" }, h("h1", {}, `${run.knowledge.name} / ${run.module}`), statusPill(run.status)),
      run.statusReason ? h("div", { class: `banner ${STATUS_TONE[run.status] || ""}` }, run.statusReason) : null,
      h("p", { class: "muted small" }, `${run.runId} · ${fmtDate(run.createdAt)} · ${run.intentSource}`),
      controls,
      chatCard,
      h("div", { class: "grid grid-2" },
        h("div", { class: "card" }, h("dl", { class: "kv" },
          h("dt", {}, tr("run.knowledge")), h("dd", {}, `${run.knowledge.name} — `, h("code", {}, run.knowledge.path)),
          h("dt", {}, tr("run.module")), h("dd", {}, run.module),
          h("dt", {}, tr("run.target")), h("dd", {}, snap.targetId || run.targets.join(", ") || "-"),
          h("dt", {}, tr("run.task")), h("dd", {}, snap.currentTask || "-"),
          h("dt", {}, tr("run.stage")), h("dd", {}, snap.currentStage || "-"),
        )),
        h("div", { class: "card" }, h("dl", { class: "kv" },
          h("dt", {}, tr("run.commander")), h("dd", {}, rtName(run.commander.current)),
          h("dt", {}, tr("run.engineer")), h("dd", {}, rtName(run.workers.engineer)),
          h("dt", {}, tr("run.reviewer")), h("dd", {}, rtName(run.workers.reviewer)),
          h("dt", {}, tr("run.qa")), h("dd", {}, rtName(run.workers.qa)),
          h("dt", {}, tr("run.verification")), h("dd", {}, `${tr("run.done")} ${v.done ?? 0}/${v.total ?? tasks.length} · ${tr("run.reviewPassed")} ${v.reviewPassed ?? 0} · ${tr("run.qaPassed")} ${v.qaPassed ?? 0} · ${tr("run.securityPassed")} ${v.securityPassed ?? 0}`),
        )),
      ),
      gates.length ? h("div", { class: "section-title" }, h("h2", {}, tr("run.gates"))) : null,
      ...gates.map((g) => h("div", { class: "banner warn" }, `⚑ ${g.reason}`)),
      h("div", { class: "section-title" }, h("h2", {}, tr("run.tasks")), h("span", { class: "count" }, String(tasks.length))),
      tasks.length === 0 ? h("div", { class: "empty small" }, tr("runs.none")) : h("div", { class: "card table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Task", "Phase", "Status", "Stage", "Runtime", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, tasks.map((task) => h("tr", {},
          h("td", {}, h("code", {}, task.taskId)), h("td", {}, String(task.phase)), h("td", {}, task.status), h("td", {}, task.stage || "-"),
          h("td", {}, task.attempts.map((a) => `${a.stage}:${rtName(a.runtime)}(${a.status})`).join(" ") || "-"),
          h("td", { class: "small muted" }, task.reason))))),
      ),
      h("div", { class: "grid grid-2" },
        h("div", { class: "card" }, h("h3", {}, tr("run.history")), timeline(historyItems(run))),
        h("div", { class: "card" }, h("h3", {}, tr("run.fallbacks")), timeline(run.fallbacks.map((f) => ({ at: f.at, cls: "fallback", text: `${f.role}: ${rtName(f.from)} → ${rtName(f.to)} (${f.failureClass})` })))),
      ),
      h("div", { class: "grid grid-2" },
        h("div", { class: "card" }, h("h3", {}, tr("run.changed")), (snap.changedFiles || []).length === 0 ? h("p", { class: "muted small" }, "-")
          : h("ul", { class: "small mono" }, snap.changedFiles.slice(0, 300).map((f) => h("li", {}, `${f.status}  ${f.path}`)))),
        h("div", { class: "card" }, h("h3", {}, tr("run.commanderNotes")), timeline(run.commander.notes.map((n) => ({ at: n.at, cls: n.accepted ? "" : "fail", text: `${rtName(n.runtimeId)} · ${n.phase} · ${n.decision}${n.accepted ? "" : " (not accepted)"} — ${n.summary}${n.policyNote ? ` [${n.policyNote}]` : ""}` })))),
      ),
      run.handoffs.length ? h("details", { class: "card" }, h("summary", {}, `${tr("run.handoffs")} (${run.handoffs.length})`), h("pre", { class: "log" }, JSON.stringify(run.handoffs.slice(-5), null, 2))) : null,
      h("details", { class: "card" }, h("summary", {}, tr("run.events")), timeline(data.events.slice(-60).map((e) => ({ at: e.at, text: `${e.kind}: ${e.message}` })))),
      h("details", { class: "card", ontoggle: async (event) => {
        if (!event.target.open) return;
        const segment = run.segments.length;
        segmentShown = segment;
        const log = await api("GET", `runs/${runId}/log?segment=${segment}`);
        logPre.textContent = log.log || "-";
      } }, h("summary", {}, `${tr("run.log")} (${run.segments.length})`), logPre),
    );
    if (segmentShown !== null) {
      const log = await api("GET", `runs/${runId}/log?segment=${run.segments.length}`).catch(() => ({ log: "" }));
      logPre.textContent = log.log || "-";
    }
  };
  await render();
  poll(render, 4000);
}

function renderDiff(text) {
  const pre = h("pre", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    pre.append(h("span", { class: cls }, line + "\n"));
  }
  return pre;
}

async function pageReview(runId) {
  const data = await api("GET", `runs/${encodeURIComponent(runId)}`);
  const run = data.run;
  const snap = run.snapshot || {};
  const tasks = snap.tasks || [];
  const v = snap.verification || {};
  const diffBox = h("div", {});
  const commitBox = h("div", {});
  const nameInput = h("input", { type: "text", id: "reviewer", "aria-label": tr("review.name") });
  try { nameInput.value = localStorage.getItem("sta-reviewer") || ""; } catch { /* ignore */ }
  const noteInput = h("textarea", { id: "review-note", "aria-label": tr("review.note") });
  const findings = tasks.reduce((sum, task) => sum + (task.findings || 0), 0);
  const reviewer = () => { const name = nameInput.value.trim(); try { localStorage.setItem("sta-reviewer", name); } catch { /* ignore */ } return name; };

  mount(
    h("div", { class: "row space" }, h("h1", {}, tr("review.title")), statusPill(run.status)),
    h("div", { class: "grid grid-2" },
      h("div", { class: "card" }, h("dl", { class: "kv" },
        h("dt", {}, "Knowledge"), h("dd", {}, run.knowledge.name),
        h("dt", {}, "Module"), h("dd", {}, run.module),
        h("dt", {}, tr("review.status")), h("dd", {}, statusLabel(run.status)),
        h("dt", {}, tr("review.tasksCompleted")), h("dd", {}, `${v.done ?? 0} / ${v.total ?? tasks.length}`),
        h("dt", {}, tr("review.build")), h("dd", {}, (v.done ?? 0) > 0 || (v.checkpointed ?? 0) > 0 ? (LANG === "th" ? "ผ่าน (ทุก checkpoint ผ่าน deterministic gate)" : "passed (every checkpoint passed the deterministic gate)") : "-"),
        h("dt", {}, tr("review.reviewFindings")), h("dd", {}, `${tr("run.reviewPassed")} ${v.reviewPassed ?? 0}`),
        h("dt", {}, tr("review.qaFindings")), h("dd", {}, `${tr("run.qaPassed")} ${v.qaPassed ?? 0} · findings ${findings}`),
        h("dt", {}, tr("run.changed")), h("dd", {}, String((snap.changedFiles || []).length)),
      ), h("p", { class: "banner warn small" }, tr("review.notDone"))),
      h("div", { class: "card" }, h("h3", {}, tr("run.history")), timeline(historyItems(run))),
    ),
    h("div", { class: "card stack" },
      h("div", {}, h("label", { for: "reviewer" }, tr("review.name")), nameInput),
      h("div", {}, h("label", { for: "review-note" }, tr("review.note")), noteInput),
      h("div", { class: "row" },
        h("button", { onclick: async () => {
          const diff = await act(() => api("GET", `runs/${runId}/diff`));
          if (diff) diffBox.replaceChildren(diff.note ? h("p", { class: "muted" }, diff.note) : renderDiff(diff.diff || "(empty)"), diff.truncated ? h("p", { class: "muted small" }, "…truncated") : null);
        } }, tr("review.viewDiff")),
        ["READY_FOR_REVIEW", "WAITING_FOR_HUMAN"].includes(run.status) ? h("button", { class: "primary btn-approve", onclick: async () => {
          if (!reviewer()) { toast(tr("review.name"), true); return; }
          const done = await act(() => api("POST", `runs/${runId}/approve`, { by: reviewer(), note: noteInput.value || undefined }), tr("review.approved"));
          if (done) pageReview(runId);
        } }, tr("review.approve")) : null,
        run.status === "READY_FOR_REVIEW" ? h("button", { onclick: async () => {
          if (!reviewer() || !noteInput.value.trim()) { toast(`${tr("review.name")} + ${tr("review.note")}`, true); return; }
          const done = await act(() => api("POST", `runs/${runId}/send-back`, { by: reviewer(), note: noteInput.value }));
          if (done) location.hash = `#/runs/${runId}`;
        } }, tr("review.sendBack")) : null,
        ["WAITING_FOR_HUMAN", "PAUSED", "PAUSED_RUNTIME_EXHAUSTED"].includes(run.status) ? h("button", { onclick: async () => {
          const done = await act(() => api("POST", `runs/${runId}/resume`));
          if (done) location.hash = `#/runs/${runId}`;
        } }, tr("review.resume")) : null,
        h("button", { onclick: async () => {
          const prep = await act(() => api("GET", `runs/${runId}/prepare-commit`));
          if (prep) commitBox.replaceChildren(h("p", { class: "small" }, prep.note), h("pre", { class: "log" }, prep.commands.join("\n") || "-"));
        } }, tr("review.prepareCommit")),
      ),
      commitBox,
    ),
    h("div", { class: "card" }, h("h3", {}, tr("run.changed")), (snap.changedFiles || []).length === 0 ? h("p", { class: "muted small" }, "-")
      : h("ul", { class: "small mono" }, snap.changedFiles.map((f) => h("li", {}, `${f.status}  ${f.path}`)))),
    diffBox,
  );
}

async function pageRuntimes() {
  const render = async (data) => {
    const statuses = data.statuses || [];
    const health = data.health || {};
    const cards = ["claude-code", "codex", "antigravity", "zcode"].map((id) => {
      const s = statuses.find((x) => x.runtimeId === id);
      const hh = health[id] || {};
      const healthText = hh.usable === false ? `${hh.status} — ${hh.skipReason || ""}` : (hh.status || "healthy");
      const hint = h("div", { class: "hidden" }, h("p", { class: "small" }, tr("rt.loginHint")), h("pre", { class: "log" }, s ? s.loginHint : ""));
      const actions = h("div", { class: "row" },
        h("button", { onclick: async () => { const r = await act(() => api("POST", "runtimes/refresh")); if (r) render(r); } }, tr("rt.connect")),
        h("button", { onclick: () => hint.classList.toggle("hidden") }, tr("rt.login")),
        h("button", { onclick: async () => { await act(() => api("POST", `runtimes/${id}/clear-health`)); const r = await act(() => api("POST", "runtimes/refresh")); if (r) render(r); } }, tr("rt.reconnect")),
        h("button", { onclick: async (event) => {
          event.target.disabled = true;
          const r = await act(() => api("POST", `runtimes/${id}/test`));
          event.target.disabled = false;
          if (r) toast(`${RUNTIME_NAMES[id]}: ${r.ok ? "OK" : `${r.status} ${r.failureClass || ""} — ${r.detail}`}`, !r.ok);
          const refreshed = await api("GET", "runtimes"); render(refreshed);
        } }, tr("rt.test")),
      );
      return h("div", { class: "card stack" },
        h("div", { class: "row space" }, h("h2", {}, RUNTIME_NAMES[id]), s ? pill(s.state, s.state === "CONNECTED" ? "ok" : s.state === "NOT_INSTALLED" ? "bad" : "warn") : pill("?", "")),
        !s ? h("p", { class: "muted small" }, tr("rt.never")) : h("dl", { class: "kv" },
          h("dt", {}, tr("rt.installed")), h("dd", {}, s.installed ? tr("common.yes") : tr("common.no")),
          h("dt", {}, tr("rt.version")), h("dd", {}, s.version || "-"),
          h("dt", {}, tr("rt.auth")), h("dd", {}, `${s.authentication}${s.authDetail ? ` — ${s.authDetail}` : ""}`),
          h("dt", {}, tr("rt.background")), h("dd", {}, s.backgroundReady ? "ready" : "not ready"),
          h("dt", {}, tr("rt.security")), h("dd", {}, s.securityDetail),
          h("dt", {}, tr("rt.roles")), h("dd", {}, Object.entries(s.securityRoles).filter(([, ok]) => ok).map(([r]) => r).join(", ") || "-"),
          h("dt", {}, tr("rt.health")), h("dd", {}, healthText),
          h("dt", {}, tr("rt.quota")), h("dd", {}, hh.status === "quota_exhausted" ? `exhausted until ${fmtDate(hh.cooldownUntil)}` : tr("common.unknown")),
          h("dt", {}, tr("rt.lastError")), h("dd", {}, s.lastError || hh.lastError || "-"),
        ),
        actions, hint,
      );
    });
    mount(
      h("div", { class: "row space" }, h("h1", {}, tr("rt.title")), h("button", { onclick: async () => { const r = await act(() => api("POST", "runtimes/refresh")); if (r) render(r); } }, tr("rt.refresh"))),
      h("div", { class: "grid grid-2" }, cards),
    );
  };
  mount(h("p", { class: "muted" }, tr("common.loading")));
  await render(await api("GET", "runtimes"));
}

async function pageKnowledge() {
  const nameInput = h("input", { type: "text", id: "kn-name", placeholder: "timetable" });
  const pathInput = h("input", { type: "text", id: "kn-path", placeholder: "C:\\src\\timetable-knowledge" });
  const defaultBox = h("input", { type: "checkbox", id: "kn-default" });
  const render = async () => {
    const all = await api("GET", "knowledge");
    mount(
      h("h1", {}, tr("kn.title")),
      h("div", { class: "grid grid-2" }, all.map((k) => h("div", { class: "card stack" },
        h("div", { class: "row space" }, h("h2", {}, `${k.isDefault ? "● " : "○ "}${k.name}`), pill(k.state, k.state === "READY" ? "ok" : k.state === "WARNING" ? "warn" : "bad")),
        h("code", { class: "small" }, k.path),
        h("div", { class: "small muted" }, `${k.targets.length} ${tr("kn.targets")} · ${k.modules.length} ${tr("kn.modules")}${k.isDefault ? ` · ${tr("kn.default")}` : ""}`),
        ...k.problems.map((p) => h("div", { class: "banner bad small" }, p)),
        ...k.warnings.map((w) => h("div", { class: "banner warn small" }, w)),
        h("div", { class: "row" },
          h("button", { onclick: async () => { const r = await act(() => api("POST", `knowledge/${k.name}/validate`)); if (r) toast(`${k.name}: ${r.state}${r.problems.length ? ` — ${r.problems.join("; ")}` : ""}`, r.state === "INVALID"); } }, tr("kn.validate")),
          !k.isDefault ? h("button", { onclick: async () => { await act(() => api("POST", `knowledge/${k.name}/default`)); render(); } }, tr("kn.setDefault")) : null,
          h("button", { onclick: () => { rememberSelection(k.name); location.hash = `#/work?knowledge=${encodeURIComponent(k.name)}`; } }, tr("kn.open")),
          h("button", { class: "danger", onclick: async () => { if (!confirm(tr("kn.removeConfirm"))) return; const r = await act(() => api("DELETE", `knowledge/${k.name}`)); if (r) { toast(r.note); render(); } } }, tr("kn.remove")),
        ),
      ))),
      h("div", { class: "row" }, h("button", { onclick: render }, tr("kn.refresh"))),
      h("div", { class: "section-title" }, h("h2", {}, tr("kn.add"))),
      h("div", { class: "card stack" },
        h("div", {}, h("label", { for: "kn-name" }, tr("kn.name")), nameInput),
        h("div", {}, h("label", { for: "kn-path" }, tr("kn.path")), pathInput),
        h("label", { class: "row" }, defaultBox, tr("kn.makeDefault")),
        h("div", {}, h("button", { class: "primary", onclick: async () => {
          const r = await act(() => api("POST", "knowledge", { name: nameInput.value.trim(), path: pathInput.value.trim(), makeDefault: defaultBox.checked }), tr("kn.add"));
          if (r) { nameInput.value = ""; pathInput.value = ""; render(); }
        } }, tr("kn.add"))),
      ),
    );
  };
  await render();
}

function orderEditor(title, ids, fallback, onChange) {
  const list = h("ul", { class: "dnd" });
  let dragged = null;
  const emit = () => onChange([...list.children].map((li) => li.dataset.id));
  const item = (id) => {
    const li = h("li", { draggable: "true", "data-id": id },
      h("span", { class: "handle", "aria-hidden": "true" }, "☰"), RUNTIME_NAMES[id] || id,
      h("span", { class: "move" },
        h("button", { type: "button", "aria-label": "up", onclick: () => { if (li.previousElementSibling) { list.insertBefore(li, li.previousElementSibling); emit(); } } }, "↑"),
        h("button", { type: "button", "aria-label": "down", onclick: () => { if (li.nextElementSibling) { list.insertBefore(li.nextElementSibling, li); emit(); } } }, "↓")));
    li.addEventListener("dragstart", () => { dragged = li; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => { li.classList.remove("dragging"); dragged = null; emit(); });
    li.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === li) return;
      const rect = li.getBoundingClientRect();
      list.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? li : li.nextSibling);
    });
    return li;
  };
  for (const id of ids) list.append(item(id));
  const toggle = h("select", {}, h("option", { value: "true" }, tr("st.fallback")), h("option", { value: "false" }, tr("st.exclusive")));
  toggle.value = String(fallback.value);
  toggle.addEventListener("change", () => { fallback.value = toggle.value === "true"; });
  return h("div", { class: "card stack" }, h("h3", {}, title), list, toggle);
}

async function pageSettings() {
  const data = await api("GET", "settings");
  const machine = data.machine;
  const knowledge = await api("GET", "knowledge");
  const fill = (ids) => [...ids, ...["claude-code", "codex", "antigravity", "zcode"].filter((id) => !ids.includes(id))];
  const draft = {
    commander: { order: fill(machine.commander.order), fallback: { value: machine.commander.fallback } },
    engineer: { order: fill(machine.roles.engineer.order), fallback: { value: machine.roles.engineer.fallback } },
    reviewer: { order: fill(machine.roles.reviewer.order), fallback: { value: machine.roles.reviewer.fallback } },
    qa: { order: fill(machine.roles.qa.order), fallback: { value: machine.roles.qa.fallback } },
  };
  const roots = h("input", { type: "text", id: "st-roots", value: machine.workspace.allowed_roots.join("; ") });
  const language = h("select", { id: "st-lang" }, h("option", { value: "th" }, "ไทย"), h("option", { value: "en" }, "English"));
  language.value = machine.language;
  const provider = h("select", { id: "st-provider" }, h("option", { value: "gemini" }, "Gemini"), h("option", { value: "offline" }, "Offline parser"));
  provider.value = machine.intent.provider;
  const model = h("input", { type: "text", id: "st-model", value: machine.intent.model });
  const key = h("input", { type: "password", id: "st-key", autocomplete: "off", placeholder: data.intentKey.configured ? `•••••• (${data.intentKey.source})` : "" });
  const autonomy = h("select", { id: "st-autonomy" }, h("option", { value: "edit" }, "edit"), h("option", { value: "full" }, "full"));
  autonomy.value = machine.runtime.default_autonomy;
  const cooldowns = ["quota_cooldown_minutes", "rate_limit_cooldown_minutes", "unavailable_cooldown_minutes", "auth_cooldown_minutes", "timeout_cooldown_minutes"].map((field) => {
    const input = h("input", { type: "number", min: "1", value: String(machine.health[field]), "data-field": field });
    return h("div", {}, h("label", {}, field.replace(/_/g, " ")), input);
  });
  const keyStatus = h("span", { class: "pill" }, data.intentKey.configured ? `${tr("st.keySet")} (${data.intentKey.source})` : tr("st.keyUnset"));

  mount(
    h("h1", {}, tr("st.title")),
    h("div", { class: "grid grid-2" },
      h("div", { class: "card stack" },
        h("div", {}, h("label", { for: "st-roots" }, tr("st.machineRoot")), roots),
        h("div", {}, h("label", { for: "st-lang" }, tr("st.language")), language),
        h("div", {}, h("label", {}, tr("st.defaultKnowledge")), h("div", {}, (knowledge.find((k) => k.isDefault) || {}).name || "-", " · ", h("a", { href: "#/knowledge" }, tr("nav.knowledge")))),
        h("div", {}, h("label", { for: "st-autonomy" }, tr("st.autonomy")), autonomy),
      ),
      h("div", { class: "card stack" },
        h("h3", {}, tr("st.intent")),
        h("div", {}, h("label", { for: "st-provider" }, tr("st.provider")), provider),
        h("div", {}, h("label", { for: "st-model" }, tr("st.model")), model),
        h("div", {}, h("label", { for: "st-key" }, tr("st.key")), key),
        h("div", { class: "row" }, keyStatus,
          h("button", { onclick: async () => { if (!key.value.trim()) return; const r = await act(() => api("PUT", "settings/intent-key", { apiKey: key.value.trim() }), tr("st.saved")); key.value = ""; if (r) pageSettings(); } }, tr("st.saveKey")),
          h("button", { class: "danger", onclick: async () => { const r = await act(() => api("DELETE", "settings/intent-key")); if (r) pageSettings(); } }, tr("st.deleteKey"))),
      ),
    ),
    h("div", { class: "section-title" }, h("h2", {}, tr("st.routing"))),
    h("div", { class: "grid grid-4" },
      orderEditor(tr("st.commander"), draft.commander.order, draft.commander.fallback, (o) => { draft.commander.order = o; }),
      orderEditor(tr("st.engineer"), draft.engineer.order, draft.engineer.fallback, (o) => { draft.engineer.order = o; }),
      orderEditor(tr("st.reviewer"), draft.reviewer.order, draft.reviewer.fallback, (o) => { draft.reviewer.order = o; }),
      orderEditor(tr("st.qa"), draft.qa.order, draft.qa.fallback, (o) => { draft.qa.order = o; }),
    ),
    h("div", { class: "section-title" }, h("h2", {}, tr("st.health"))),
    h("div", { class: "card grid grid-4" }, cooldowns),
    h("div", { class: "section-title" }, h("h2", {}, tr("st.permissions"))),
    h("div", { class: "card small" }, tr("st.permText")),
    h("div", { class: "row" }, h("button", { class: "primary btn-lg", onclick: async () => {
      const health = { ...machine.health };
      for (const input of document.querySelectorAll("input[data-field]")) health[input.dataset.field] = Number(input.value);
      const next = {
        ...machine,
        workspace: { allowed_roots: roots.value.split(";").map((x) => x.trim()).filter(Boolean) },
        language: language.value,
        runtime: { default_autonomy: autonomy.value },
        intent: { ...machine.intent, provider: provider.value, model: model.value.trim() },
        commander: { ...machine.commander, order: draft.commander.order, fallback: draft.commander.fallback.value },
        roles: {
          engineer: { order: draft.engineer.order, fallback: draft.engineer.fallback.value },
          reviewer: { order: draft.reviewer.order, fallback: draft.reviewer.fallback.value },
          qa: { order: draft.qa.order, fallback: draft.qa.fallback.value },
        },
        health,
      };
      const r = await act(() => api("PUT", "settings", { machine: next }), tr("st.saved"));
      if (r && r.machine.language !== LANG) { LANG = r.machine.language; try { localStorage.setItem("sta-lang", LANG); } catch { /* ignore */ } applyChrome(); pageSettings(); }
    } }, tr("st.save"))),
  );
}

// ───────────────────────── router ─────────────────────────
function applyChrome() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  document.getElementById("lang-toggle").textContent = LANG === "th" ? "EN" : "ไทย";
}

async function route() {
  clearInterval(pollTimer);
  const hash = location.hash.replace(/^#\/?/, "") || "work";
  const [path] = hash.split("?");
  const [page, id] = path.split("/");
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.dataset.route === (page === "review" ? "runs" : page));
  try {
    if (page === "runs" && id) await pageRun(decodeURIComponent(id));
    else if (page === "runs") await pageRuns();
    else if (page === "review" && id) await pageReview(decodeURIComponent(id));
    else if (page === "runtimes") await pageRuntimes();
    else if (page === "knowledge") await pageKnowledge();
    else if (page === "settings") await pageSettings();
    else await pageWork();
  } catch (error) {
    mount(h("div", { class: "banner bad" }, `${tr("common.error")}: ${error.message}`));
  }
}

async function heartbeat() {
  const el = document.getElementById("core-pill");
  try {
    const state = await api("GET", "state");
    el.textContent = `${tr("core.running")} · v${state.version}`;
    el.className = "pill ok";
  } catch {
    el.textContent = tr("core.down");
    el.className = "pill bad";
  }
}

document.getElementById("lang-toggle").addEventListener("click", () => {
  LANG = LANG === "th" ? "en" : "th";
  try { localStorage.setItem("sta-lang", LANG); } catch { /* ignore */ }
  applyChrome();
  route();
});
window.addEventListener("hashchange", route);
applyChrome();
route();
heartbeat();
setInterval(heartbeat, 15000);
