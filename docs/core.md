# STA Core — local service, Web UI และ runtime failover

STA Core คือ **ตัวควบคุมแบบ deterministic (ไม่ใช่ LLM)** ที่รันเป็น background process ของผู้ใช้ในเครื่อง
ผู้ใช้สั่งงานผ่าน Web UI (หรือ `sta work`) ด้วยภาษาคน แล้ว STA Core เดินงาน implementation → review → QA
เองผ่าน `sta bounded-run` เดิม สลับ runtime เองเมื่อ quota หมด และหยุดให้คนตรวจตอนท้าย
**ไม่มีการ push / merge / deploy อัตโนมัติ**

> เอกสารนี้เป็นคู่มือหลักของ STA Core — ส่วน engine ข้างใต้ (freeze, checkpoint, gate) อยู่ที่
> [`bounded-run.md`](bounded-run.md) และ runtime support อยู่ที่ [`runtimes.md`](runtimes.md)

## 1. สถาปัตยกรรม

```text
Browser ──► Local API (127.0.0.1, token) ──► STA Core (deterministic, non-LLM)
                                               │
          ┌────────────────────┬───────────────┼────────────────────────┐
          ▼                    ▼               ▼                        ▼
   Knowledge registry    Intent Engine    Runtime router + health   Work-run controller
   (installation.yaml)   (Gemini → JSON   (machine.yaml orders,     (core.db, segments,
                          → schema →       cooldowns, security       gates, handoffs)
                          policy)          eligibility)                    │
                                                                           ▼
                                           `sta bounded-run --core-run <overlay>` (child process)
                                           owner engineer → reviewer → QA (→ security) ต่อ task
                                           Claude Code · Codex · AGY · ZCode (runtime adapters เดิม)
```

| ส่วน | ไฟล์ | หน้าที่ |
|---|---|---|
| Work-run controller | `orchestrator/src/core/workRunService.ts` | state machine ของ work run, segment, pause/resume/stop, gate, exhaustion |
| Runtime router | `core/runtimeRouter.ts` | เลือก runtime ต่อ role จาก order + security + health (pure) |
| Runtime health | `core/runtimeHealth.ts` | cooldown ต่อ runtime, ไม่ retry quota ซ้ำ, TIMEOUT แบบ bounded |
| Failure taxonomy | `runtime/runtimeFailureClass.ts` | class กลางที่ทุก adapter แปลงไปหา |
| Route overlay | `runtime/coreRouteOverlay.ts` | ช่องทางเดียวที่ child bounded-run รับ order/health/Knowledge pin |
| Commander | `core/commander.ts` | role ที่ให้คำแนะนำ (ไม่มี authority) + failover |
| Intent Engine | `core/intent.ts` | ภาษาคน → JSON → schema → policy |
| Local API / Web | `core/server.ts`, `orchestrator/web/` | frontend อย่างเดียว |
| Service | `core/service.ts` | `sta start` / `sta stop` (detached, user-level) |

**CLI และ Web ใช้ STA Core ตัวเดียวกัน** — `sta work` เรียก Local API เดียวกับ Web UI (และเปิด service ให้เอง
ถ้ายังไม่เปิด) ไม่มี orchestration สองชุด

## 2. ตั้งเครื่องครั้งแรก

```powershell
npm --prefix orchestrator run build
npm link
sta setup-machine --root C:\src --language th
```

`setup-machine` ทำซ้ำได้ (idempotent): ตรวจและ canonicalize machine root, เขียน
`%LOCALAPPDATA%\software-team-agents\machine.yaml`, ตรวจ runtime ทั้ง 4 ตัว (version / auth),
และรายงานสิ่งที่ยังขาด flag เพิ่มเติม:

| flag | ความหมาย |
|---|---|
| `--intent-provider gemini\|offline` `--intent-model <id>` | Intent API |
| `--intent-key-stdin` | อ่าน API key จาก stdin (ไม่รับเป็น argument เพื่อไม่ให้หลุดใน process list) |
| `--commander-order claude-code,codex,agy,zcode` `--engineer-order …` `--reviewer-order …` `--qa-order …` | ลำดับ runtime ต่อ role |
| `--knowledge <name>=<path>` (ซ้ำได้) | ลงทะเบียน Knowledge |
| `--no-detect` | ข้ามการตรวจ runtime |

### Machine config (`machine.yaml`)

```yaml
schema_version: 1
workspace:
  allowed_roots: [C:\src]        # ขอบเขตนอกสุด — ห้ามเป็น drive root ทั้งลูก
language: th                     # th | en (ค่าเริ่มต้น th)
runtime: { default_autonomy: edit }
intent: { provider: gemini, model: gemini-3.5-flash-lite }
commander: { enabled: true, order: [claude-code, codex, antigravity, zcode], fallback: true }
roles:
  engineer: { order: [codex, claude-code, antigravity, zcode], fallback: true }
  reviewer: { order: [claude-code, antigravity, zcode, codex], fallback: true }
  qa:       { order: [antigravity, zcode, claude-code, codex], fallback: true }
health: { quota_cooldown_minutes: 60, rate_limit_cooldown_minutes: 5, unavailable_cooldown_minutes: 10,
          auth_cooldown_minutes: 30, timeout_retry_limit: 2, timeout_cooldown_minutes: 15 }
service: { host: 127.0.0.1, port: 4317 }
work: { max_segments: 24, auto_resume_after_cooldown: true }
```

- `agy` เป็น alias ของ runtime id `antigravity` (id จริงใน registry)
- **Knowledge roots ไม่อยู่ในไฟล์นี้** — อยู่ใน `installation.yaml` (named roots เดิม) ที่เดียว
- `fallback: true` = *preferred* (ตัวแรกก่อน แล้วไล่ตัวถัดไป) · `fallback: false` = *exclusive*
  (ใช้ตัวแรกเท่านั้น ไม่ fallback) — สองคำนี้แยกชัด ไม่มีความหมายกำกวม

## 3. Knowledge หลายตัว

```powershell
sta knowledge add timetable C:\src\timetable-knowledge --default
sta knowledge add company-a C:\src\company-a-knowledge
sta knowledge list            # ● default, path, targets, modules, READY/WARNING/INVALID
sta knowledge validate        # รวม ownership proof ข้าม root
sta knowledge default company-a
sta knowledge remove company-a   # ลบ "การลงทะเบียน" เท่านั้น — ไฟล์ใน repo ไม่ถูกแตะ
sta knowledge modules timetable
```

`add` ตรวจ: path มีอยู่จริง, เป็น standalone Git repo, ดูเป็น Knowledge workspace (`_docs/`, `targets.yaml`,
`.agent-team/config.yaml` หรือ `knowledge/`), อ่าน `targets.yaml` ได้, ชื่อ/path ไม่ซ้ำ, อยู่ใน machine root
และ **ไม่ทำให้ Target เดียวมีเจ้าของสอง Knowledge** (ใช้ `auditTargetOwnershipAcrossRoots` เดิมกับสำเนาชั่วคราว
ของ registry ก่อนเขียนจริง) — ไม่ผ่านข้อใดข้อหนึ่ง = ไม่ลงทะเบียน

หน้า **Knowledge** ใน Web ทำได้เหมือนกัน: Add · Validate · Set Default · Open · Refresh · Remove registration

## 4. Knowledge isolation — 1 run = 1 Knowledge

- ตอนสร้าง run, STA Core **pin** `{name, canonical path}` ไว้ใน `core.db` และ `WorkRunStore.update` ปฏิเสธ
  ทุกการแก้ค่า pin ตลอดอายุ run
- ทุก segment: ตรวจว่า registration ของชื่อนั้นยังชี้ path เดิม — ถ้าเปลี่ยน → `WAITING_FOR_HUMAN`
  (`knowledge_changed`) ไม่ใช้ default ตัวอื่นแทน
- child `bounded-run` ได้รับ `--root <name>` + overlay ที่มี pin และ **ตรวจซ้ำเอง** (`assertPinnedKnowledge`)
  ทั้งตอนเริ่มและตอน `--resume`; environment ของ service (`STA_KNOWLEDGE_ROOT*`, `STA_RUN_ID`, `STA_ROLE`)
  ถูกลบก่อนส่งให้ child
- module / targets / plan / docs / ledger / projection / Commander context มาจาก root ที่ pin เท่านั้น
- runtime fallback ไม่เปลี่ยน Knowledge — handoff ทุกอันมี `knowledge_root` เสมอ
- Intent model ห้ามเลือก Knowledge เอง: ถ้าตอบ `knowledge_root` ไม่ตรงกับที่ผู้ใช้เลือก → ถูก reject

## 5. Runtime ทั้ง 4 ตัว

หน้า **Runtime** แสดงต่อ runtime: Installed · Version · Authentication · Background ready · Security ·
บทบาทที่ STA ใช้ได้ · Current health · Quota · Last error พร้อมปุ่ม Connect · Login · Reconnect · Test

| ปุ่ม | ทำอะไร |
|---|---|
| Connect | ตรวจซ้ำ (version, `claude auth status`, `codex login status`) ใน child process |
| Login | แสดงคำสั่ง login ให้คนรันเองใน terminal (`claude auth login`, `codex login`, `agy`) — STA ไม่กรอก credential |
| Reconnect | ล้าง cooldown ของ runtime แล้วตรวจซ้ำ |
| Test | ส่ง prompt read-only สั้น ๆ ผ่านทางเดียวกับ Commander จริง ผลถูกบันทึกลง health |

**ไม่มี Codex Windows sandbox (owner decision 2026-10-03):** runtime ทุกตัวรันแบบที่คนรันเอง — ใช้ login ของ
ผู้ใช้ อ่าน/เขียนไฟล์ปกติ ไม่มี UAC ไม่มีการ setup sandbox Claude Code headless รันตรง (ไม่ห่อด้วย `codex sandbox`)
และ `codex exec` รันด้วย `--dangerously-bypass-approvals-and-sandbox` (ไม่มี `windows.sandbox` / permission
profile) กฎ a1 ที่บังคับ OS sandbox ถูกยกเลิกไปพร้อมกัน guard ที่ยังทำงาน: hooks ของ workspace (Claude Code
ตรวจก่อนทุก tool call — ห้าม git, path permissions), execpolicy ห้าม git ของ Codex, การตรวจไฟล์ที่เขียนนอก scope
หลัง run, deterministic gate และ checkpoint ของ bounded-run

| runtime | pre-tool write guard | unattended Target write | บทบาทที่ STA ใช้ |
|---|---|---|---|
| Claude Code | ✅ hooks ใน `.claude/settings.json` | ✅ | Commander · Engineer · Reviewer · QA |
| Codex | ❌ (ไม่มี sandbox) | ❌ | Commander · Reviewer · QA |
| AGY | partial (machine hook) | ❌ | Commander · Reviewer · QA |
| ZCode | partial (project hooks) | ❌ | Commander · Reviewer · QA (experimental — automatic routing ต้อง opt-in `routing.allow_below_supported`) |

Engineer จึงเป็น Claude Code เท่านั้น: ถ้า Claude Code quota หมด งานเขียนโค้ดจะ `PAUSED_RUNTIME_EXHAUSTED`
จนกว่าจะกลับมา (ส่วน Commander/Reviewer/QA ยังสลับไปตัวอื่นได้) runtime ที่ไม่ certified ถูกข้ามสำหรับ
Engineer พร้อมเหตุผล `SECURITY: ... is not certified for unattended Target writes` — ไม่ถูกรันโดยลดการป้องกัน

## 7. Intent API

- ตั้งค่าใน Web: Settings › Intent API (Provider / Model / API key) หรือ
  `"<key>" | sta setup-machine --root C:\src --intent-key-stdin`
- model ตั้งได้ (ค่าเริ่มต้น `gemini-3.5-flash-lite` ตามที่ระบุ — ถ้าชื่อ model จริงของ provider ต่างไป
  ให้แก้ที่ Settings/`machine.yaml` โดยไม่ต้องแก้โค้ด)
- **ที่เก็บ key:** `%LOCALAPPDATA%\software-team-agents\secrets\intent-api-key.dpapi` เข้ารหัสด้วย Windows DPAPI
  (CurrentUser) — ไม่อยู่ใน repo, run state, log, overlay หรือ frontend; API คืนแค่ `{configured, source}`;
  key วิ่งไป PowerShell ทาง stdin และวิ่งไป Gemini ทาง header `x-goog-api-key` (ไม่อยู่ใน URL) ·
  ระบบอื่นที่ไม่ใช่ Windows ใช้ไฟล์ 0600 · หรือใช้ env `STA_INTENT_API_KEY` (ไม่ถูกเขียนลงดิสก์)
- Intent model ไม่มีอำนาจ execute ใด ๆ: ผลลัพธ์ผ่าน schema → policy (`push/merge/deploy = human_only`
  ถูกบังคับเป็น false และรายงานใน `overrides`) → binding Knowledge/module กับที่ผู้ใช้เลือก
- Intent API ล่ม: ใช้ offline parser (ไทย/อังกฤษ: ทำงาน/พัก/ทำต่อ/หยุด/สถานะ/phase/task) พร้อมคำเตือน;
  run ที่กำลังเดินไม่ได้ใช้ Intent อยู่แล้ว จึงไม่หยุด; `sta work …` ไม่ใช้ Intent API เลย

## 8. เปิด STA Core และ Web UI

```powershell
sta start            # detached, user-level; พิมพ์ URL เช่น http://127.0.0.1:4317/
sta core status
sta stop             # หยุด service — segment ที่กำลังรันยังทำต่อ และถูก reconcile ตอน start ครั้งหน้า
```

- service bind `127.0.0.1` เท่านั้น ทุก `/api` ต้องมี token ต่อการ start (ฝังในหน้าที่ service serve เอง),
  Host header ต้องเป็น loopback (กัน DNS rebinding), CSP `script-src 'self'`
- ปิด browser ≠ หยุดงาน · เปิด Web ใหม่ = เห็น state เดิมจาก `core.db`
- ไม่ใช่ Windows Service (ไม่ใช้ SYSTEM/Administrator) — เป็น process ของผู้ใช้ที่ login อยู่ ซึ่งเป็นเจ้าของ
  login ของ runtime ทั้งหลายด้วย ถ้าต้องการให้เปิดเองตอน login ให้คนตั้ง Task Scheduler รัน `sta start` เอง

## 9. เริ่มงาน

Web: หน้า **งาน** → เลือก Knowledge → Module (กรองจาก Knowledge นั้น) → พิมพ์คำสั่ง → **เริ่มงาน**
(ปุ่ม "ดูคำสั่งที่ระบบเข้าใจ" แสดง structured intent ก่อนเริ่ม)

CLI:

```powershell
sta work timetableai --root timetable                 # ทุก task ที่พร้อม จน QA ผ่าน แล้วหยุดให้คนตรวจ
sta work timetableai --root timetable --phase 2
sta work timetableai --root timetable --until next-gate
sta work timetableai --root timetable --text "ทำงานที่พร้อมให้หมดจน QA ผ่าน"   # ใช้ Intent API
sta work status [timetableai] [--root timetable]      # อ่าน core.db ตรง ใช้ได้แม้ service ไม่เปิด
sta work pause|resume|stop timetableai [--root timetable] [--force]
sta work approve timetableai --by <ชื่อ> [--note …]
sta stop timetableai                                  # = sta work stop timetableai
```

ความหมายของ "จน QA ผ่าน": STA Core สั่ง `sta bounded-run --module <m> --all --until done` — plan-task
workflow คือ owner engineer → reviewer → QA (→ security เมื่อ sensitive) **ไม่มี stage deploy** ดังนั้น
"done" คือทุก task ผ่าน QA และถูก checkpoint บน run branch, task ที่มี hard gate (schema/migration
approval) จอดรอคนโดย task อิสระอื่นเดินต่อ (`--until qa` ของ bounded-run หยุดตั้งแต่ QA verdict แรก จึงไม่ใช้)

| การกระทำ | กลไก |
|---|---|
| pause | ตั้ง flag pause ของ engine (`TaskRegistry.pause`) ให้ทุก task ที่ยังไม่เสร็จ — stage ปัจจุบันจบก่อน แล้วหยุด (`PAUSED`) |
| resume | unpause แล้ว `bounded-run --resume <id>` (frozen run เดิม, root/branch/plan เดิม) |
| stop | แบบเดียวกับ pause แต่จบเป็น `STOPPED` (ไม่ cancel task ไม่ลบอะไร); `--force` kill process (อาจเหลือ partial diff ให้คนตัดสินใจ) |

## 10. Runtime failover

**Failure taxonomy** (`runtime/runtimeFailureClass.ts`): `QUOTA_EXHAUSTED` · `RATE_LIMITED` ·
`PROVIDER_UNAVAILABLE` · `TEMPORARY_AUTH_FAILURE` · `TIMEOUT` · `EXECUTION_ERROR` · `TASK_FAILURE` ·
`SECURITY_FAILURE` · `HARD_HUMAN_GATE` — แต่ละ adapter แปลง output ของตัวเอง (`classifyClaudeRefusal`,
`classifyCodexRefusal`, ZCode/AGY refusal) และ *refine* ได้เฉพาะผลที่ adapter จัดเป็น `UNAVAILABLE` จาก field
โครงสร้างของมันแล้วเท่านั้น — ไม่มีการเดาจาก prose ที่ทำให้ task failure กลายเป็น provider failure

| class | ทำอะไร |
|---|---|
| QUOTA / RATE_LIMITED / PROVIDER_UNAVAILABLE / TEMPORARY_AUTH_FAILURE | บันทึก health + cooldown แล้วย้ายไป runtime ถัดไปในลำดับ |
| TIMEOUT | bounded: ครั้งแรกยังใช้ได้ (`degraded`, engine retry ตามปกติ) ครบ `timeout_retry_limit` → cooldown แล้วไปตัวถัดไป |
| EXECUTION_ERROR / TASK_FAILURE / SECURITY_FAILURE / HARD_HUMAN_GATE | **ไม่เปลี่ยน provider** — test/lint fail, bug, requirement conflict, security, การตัดสินใจของคน วิ่งตาม workflow (repair/gate) |

**Commander failover** (`core/commander.ts`): Commander เป็น role ไม่ใช่ provider — STA Core เลือก runtime ตาม
`commander.order`, spawn child (`sta core commander-job`, read-only, login ของผู้ใช้), ถ้าได้ class กลุ่ม
fallback → บันทึก health → เลือกตัวถัดไป → ส่ง context เดิม (structured, pinned) ทุก hop ถูกบันทึกเป็น fallback +
handoff; ถ้าไม่เหลือตัวใช้ได้ → `PAUSED_RUNTIME_EXHAUSTED`

**Worker failover** แยกจาก Commander: child `bounded-run` ได้ order ต่อ role จาก overlay; health ที่ cooling
จะถูกอ่านเป็น "unavailable" ใน `resolveRuntimeRoute` ก่อน dispatch (ทั้งตอน freeze attempt ของ engineer และตอน
route reviewer/QA) และทุกผล dispatch ถูกบันทึกเข้า health ร่วม → stage ถัดไปไม่ลอง runtime ที่ quota หมดซ้ำ;
reviewer/QA ที่เจอ `UNAVAILABLE` กลาง stage hop ไปตัวถัดไปใน stage เดียวกัน (กลไก `routing.order` เดิม)

**Runtime exhaustion:** ถ้าทุกตัวที่ใช้ได้สำหรับ role ใดหมด → run เป็น `PAUSED_RUNTIME_EXHAUSTED` (ไม่ใช่
`FAILED`) พร้อม `autoResumeAt` = cooldown ที่จบเร็วที่สุด; เมื่อถึงเวลา Core ตรวจ pool ใหม่แล้ว resume เอง
(`work.auto_resume_after_cooldown`) หรือคนกด Resume ได้ตลอด; task ที่ engine block ไว้เพราะ "ไม่มี runtime
ให้บริการ stage นี้" เท่านั้นถูกปลดด้วย `TaskRegistry.releaseRuntimeUnavailableBlock` (ไม่กิน retry, cursor
เดิม) — block ชนิดอื่นยังเป็นของคน · ถ้า exhausted เพราะ **security อย่างเดียว** (เช่นตั้ง QA ให้มีแค่ AGY/ZCode)
จะเป็น `WAITING_FOR_HUMAN` เพราะรอเวลาไม่ช่วย

**Structured handoff** (บันทึกทุกครั้งที่สลับ runtime):

```yaml
knowledge_root: timetable
knowledge_path: C:\src\timetable-knowledge
module: timetableai
target: timetable-api
task: TASK-123
stage: qa-engineer
role: qa
previous_runtime: antigravity
next_runtime: zcode
failure: { class: QUOTA_EXHAUSTED, reason: "quota exceeded" }
completed: ["TASK-122 (DONE)"]
files_changed: [src/parser.ts, tests/parser.test.ts]
verification: { TASK-122: DONE, TASK-123: RUNNING }
next_action: continue the stage on the next runtime from the frozen execution packet
```

worker ตัวใหม่ได้รับ execution packet ที่ engine freeze ไว้ (packet v2 — structured อยู่แล้ว) ส่วน handoff ของ
Core ใช้เป็นบันทึกและเป็น context ของ Commander

ตัวอย่าง timeline (Knowledge = timetable ตลอด):

```text
Claude Commander ── QUOTA_EXHAUSTED ──► Codex Commander
Claude Code Engineer (Codex/AGY/ZCode ถูกข้ามสำหรับ Engineer — ไม่ certified เขียน Target)
Claude Code Reviewer
AGY QA ── QUOTA_EXHAUSTED ──► ZCode QA
ทุก task QA ผ่าน ─► READY FOR HUMAN REVIEW   (push/merge/deploy: ยังไม่ทำ)
```

## 11. ตรวจงาน (Review)

หน้า **Runs** แบ่ง Active · Paused · Waiting for Human · Runtime Exhausted · Completed · Failed
หน้า run แสดง Knowledge, Module, Target, task/stage ปัจจุบัน, Commander/Engineer/Reviewer/QA, ผลตรวจ, ไฟล์ที่
เปลี่ยน, runtime history, fallback timeline, human gates, handoff, events และ log ของ segment

หน้า **Review** (เมื่อ `READY_FOR_REVIEW`): changed files, View Diff (`git diff base..run_branch` ผ่าน Git
command layer แบบ read-only), build/deterministic gate, review/QA, runtime history และปุ่ม
**Approve** (บันทึกการอนุมัติของคนเท่านั้น) · **Send Back** (บันทึกเหตุผล → `WAITING_FOR_HUMAN`; แก้ plan/
requirement แล้ว Resume) · **Resume Work** · **Prepare Commit** (แสดงคำสั่ง `git switch <base> && git merge
--ff-only <run_branch>` ให้คนรันเอง) — STA ไม่ push / merge / deploy

## 12. ขอบเขตสิทธิ์

```text
Machine root (machine.yaml: workspace.allowed_roots)        เช่น C:\src\**  — fence นอกสุด ไม่ใช่ grant
  └ Knowledge + Targets ที่ลงทะเบียน (ต้องอยู่ใน machine root)
      └ Task (Target ที่ task bind, frozen run branch)
          └ Role/packet (write globs ของ contract, guard, approval isolation)
```

- machine root ไม่เคยถูกส่งเป็น write grant — สิทธิ์เขียนจริงยังเป็นของ packet ต่อ stage เหมือนเดิม
- drive root (เช่น `C:\`) ถูกปฏิเสธเป็น machine root
- Knowledge root เป็น read-mostly: engineer เขียนได้เฉพาะ Target ตาม packet; ไฟล์ของ STA Core
  (`machine.yaml`, `core.db`, secrets) อยู่นอกทุก repo
- fallback ใช้ boundary เดิมทุกตัว: runtime ที่ไม่ certified สำหรับเขียน Target ถูกข้ามสำหรับ Engineer
- human gates ที่ยังบังคับ: schema/migration approval, security finding, repair budget หมด, plan drift,
  dirty tree/partial diff, การ deploy ทุกชนิด — STA ไม่ถามเรื่องเล็ก (npm/test/git status) ที่อยู่ในขอบเขต workflow แล้ว

## 13. ภาษา

ค่าเริ่มต้นภาษาไทย (`language: th`) ทั้ง Web, ข้อความสถานะ, human gate, รายงาน, Commander summary;
ส่วน worker (engineer/reviewer/QA) พูดและเขียนเอกสารเป็นภาษาไทยอยู่แล้วตาม
[`policies/documentation.md`](../policies/documentation.md) (กฎภาษาของ framework — `language: en` เปลี่ยนเฉพาะ
ข้อความของ STA Core/Web ไม่เปลี่ยนกฎนั้น);
source code / command / path / identifier / API name / log / error ดิบ ไม่ถูกแปล — เปลี่ยนเป็น English ได้ที่
Settings หรือปุ่ม EN มุมขวาบน (เฉพาะหน้าจอนั้น)

## 14. `sta doctor`

แสดง section **STA Core** ต่อท้าย: service, machine root, ภาษา, Knowledge roots (READY/…), Intent
(provider/model/key source) และ runtime 4 ตัว (ready / บทบาท) — อ่านอย่างเดียว ไม่เปลี่ยน exit code

## 15. Manual tests บน Windows (ยังต้องให้คนทำ)

1. เปิด Runtime › Test ของ Claude Code และ Codex — ต้องไม่มี UAC และไม่มี "Not logged in" (ใช้ login ปกติของคุณ)
2. รัน `sta work <module>` แล้วดูว่า engineer เป็น Claude Code และ QA เป็นตัวแรกในลำดับ QA ที่ใช้ได้
3. Claude Code usage limit จริง → Commander ย้ายไป Codex, runtime history แสดง `QUOTA_EXHAUSTED`
4. Codex usage limit จริงระหว่าง engineer → run เป็น `PAUSED_RUNTIME_EXHAUSTED` หรือย้ายไป Claude Code
   (ถ้ามี partial diff ค้าง → `WAITING_FOR_HUMAN` ตามกติกา dirty-tree ของ bounded-run)
5. ปิด browser ระหว่าง run แล้วเปิดใหม่ → state เดิม; `sta stop` + `sta start` ระหว่าง segment → reconcile ถูก
6. ตั้ง Intent API key จริง → "ดูคำสั่งที่ระบบเข้าใจ" แสดง `source: gemini`; ถอดสาย network → `source: offline`
   พร้อมคำเตือน
