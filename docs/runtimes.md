# Runtimes — ระดับการรองรับ, guard coverage และ routing

เอกสารนี้เป็น canonical home ของ runtime support และ runtime routing source of truth เดียวของระบบคือ
`orchestrator/src/runtime/runtimeSupport.ts` — `sta runtimes` อ่านจาก record เดียวกัน และ test pin ไว้
ไม่ให้ตารางนี้ drift จากสิ่งที่ preflight บังคับใช้จริง

## Support levels — ความหมาย

สถานะเป็นชุดปิด:

- **Supported** — headless pipeline + guards verified บน install จริง
- **Preview** — launch paths ใช้ได้, gap ที่เหลือถูกระบุชื่อและมี coverage
- **Experimental** — spike-proven เท่านั้น
- **Unsupported** — ไม่เสนอ

## Guard coverage — ทำไมต้องดูคู่กัน

Guard coverage per runtime คือ verdict เดียวกับที่ `open` preflight ตรวจก่อน launch —
`codex`/`opencode` ไม่ใช่แค่ "support ต่ำกว่า" แต่คือ **launch requirement จริง**:
`software-team-agents open --runtime codex` refuse ที่จะเริ่ม (`NOT READY — UNGUARDED`)
โดยไม่มี bypass flag หรือ acknowledgement override อีกต่อไป (`--allow-unguarded-runtime` ถูกถอดออกแล้วใน V13)

- **enforced** — guards ทั้งหก wired และ verified
- **partial** — native runtime guard บังคับได้บางส่วน; exit checks ที่ runtime ไม่บังคับเองจะถูก
  `ExitCheckRunner` กลางตรวจแบบ fail-closed หลัง process จบ
- **unguarded** — ไม่มี native pre-tool enforcement ที่เชื่อถือได้; การมีไฟล์ config อย่างเดียวไม่นับ
  เป็น enforcement

## ตาราง runtime

| Runtime | สถานะ | Guard coverage |
|---|---|---|
| **Claude Code** | ✅ **Supported** — hooks/pipeline เคย verify แล้ว แต่ V13 TASK-027 a1 หยุด production role dispatch ก่อน spawn เพราะยังไม่มี OS write boundary สำหรับ approval channel; unattended Target writes ไม่ certified | **hook enforced** สำหรับ guard เดิม; ไม่ใช้เป็นหลักฐาน approval isolation |
| **Codex** | ✅ **Supported** — interactive และ headless adapter verify บน Codex 0.154.0/0.155.1 แล้ว; headless enforcement = per-run native permission profile (เขียนเฉพาะ path ที่ packet อนุญาต ปิด network บล็อก Git ด้วย execpolicy + OS deny) และ TASK-027 เพิ่ม OS read/write deny ของ approval channel; UAT กับโปรไฟล์ที่ adapter สร้างบน Codex 0.155.0-alpha.16.4 ปฏิเสธ read/write แบบ glob, ตัวแปร และ encoded command ต่อไฟล์จำลอง โดยยังอ่าน/เขียน workspace ได้; certified for unattended Target writes; **interactive session ยัง unguarded** — direct-mode launch ปฏิเสธการรัน (ไม่มี acknowledgement bypass แล้ว — V13 TASK-012) และจำกัดเฉพาะ analysis/proposal ผ่าน STA dispatch | **headless enforced / interactive unguarded** — adapter ใช้ native permission profile + isolated execpolicy โดยไม่พึ่ง project hook; `.codex/hooks.json` ยังเป็น compatibility payload สำหรับ interactive เท่านั้น (default trust ข้าม hooks, hook พัง fail-open — ไม่ถูก claim เป็น enforcement ฝั่ง headless); exit checks ใช้ `ExitCheckRunner` กลางหลัง process จบ |
| **OpenCode** | 🧪 **Experimental** — plugin/adapter เคย verify แล้ว; V13 TASK-027 a1 หยุด production role dispatch ก่อน spawn เพราะยังไม่มี OS write boundary สำหรับ approval channel | **partial** — plugin บังคับ guard บางส่วน; ไม่ใช้เป็นหลักฐาน approval isolation |
| **Antigravity** | ✅ **Supported** — bridge hook เคย verify แล้ว แต่ V13 TASK-027 a1 หยุด production role dispatch ก่อน spawn เพราะยังไม่มี OS write boundary สำหรับ approval channel; unattended Target writes ไม่ certified | **bridge hook enforced** สำหรับ guard เดิม; ไม่ใช้เป็นหลักฐาน approval isolation |
| **ZCode Desktop** | 🧪 **Experimental** — desktop role-play และ headless adapter เคย verify แล้ว; V13 TASK-027 a1 หยุด production role dispatch ก่อน spawn เพราะยังไม่มี OS write boundary สำหรับ approval channel; unattended Target writes ยัง refuse | **partial** — project hooks และ post-run check ไม่ใช้เป็นหลักฐาน approval isolation |

Same verdict, three places: ตารางนี้, `sta runtimes` (อ่าน `RUNTIME_SUPPORT` ตรง) และ
`software-team-agents --help`'s `--runtime` line — ทั้งสาม quote `guardSettings.ts`'s
`codexCoverage()`/`opencodeCoverageWithPlugin()` จึง claim coverage ไม่ได้หลุดจากสิ่งที่ preflight
enforce จริง (`orchestrator/src/runtime/runtimeSupport.test.ts` pin ไว้)

## Unattended runs

การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` — default (`propose`) ติด permission prompt
ที่ไม่มีคนกดใน headless run สิทธิ์เขียน Target แบบ unattended เป็นของ runtime ที่ได้รับ certification
(ดูตาราง — หลัง V13 TASK-027 a1 เหลือ Codex headless adapter; runtime อื่นหยุด production role dispatch)

### ตรวจสถานะ login ก่อน run ยาว

run ที่ยาวขึ้นคือ quota ที่เสียเปล่ามากขึ้นเมื่อ auth มีปัญหา — เช็คก่อนเริ่มด้วยคำสั่งที่ยืนยันแล้ว
บน install จริงของแต่ละ runtime:
| Runtime | คำสั่งเช็ค | หมายเหตุ |
|---|---|---|
| Claude Code | `claude auth status` | subcommand ยืนยันบน 2.1.278 (`claude auth --help`: login/logout/status) |
| Codex | `codex login status` · `codex doctor` | ยืนยันบน 0.154.0 — `login status` ตอบสถานะ (เช่น "Logged in using ChatGPT"); `doctor` วินิจฉัย config/auth/runtime ครบและ read-only |
| Antigravity (agy) | — ไม่มี subcommand เช็ค auth บน 1.2.7 | ปัญหา auth จะแสดงเป็น error/denied ตอน run เท่านั้น (ดู [`troubleshooting.md`](troubleshooting.md)) |
| ZCode | `node <ZCode>/resources/glm/zcode.cjs --version` · `… hooks trust status --json` | ยืนยันบน CLI 0.16.9 (ZCode 3.14.3) — adapter ส่ง `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`/`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` ให้เอง; auth/signing ที่ใช้ไม่ได้จะแสดงเป็น `UNAVAILABLE` ตอน run |

### Quota windows

| Runtime | หน้าต่างที่รายงาน |
|---|---|
| Claude Code | 5 ชม. / 7 วัน |
| Codex | 7 วัน |
| Antigravity | 5 ชม. / 7 วัน |
| ZCode | 5 ชม. / 7 วัน |

> ที่มา: รายงานโดยผู้ใช้ 2026-09-21 (BA round Q7) — รูปแบบหน้าต่าง/เพดานจริงต้องยืนยันตอนใช้;
> ตัวเลขนี้ใช้วางแผนรัน probe/UAT เป็นช่วงสั้น ๆ ไม่ใช่ข้อกำหนดที่ผู้ให้บริการประกาศ

## Runtime routing — interactive selection vs pipeline routing

สองทางเข้า runtime ต่างกันชัดเจน:

- **Interactive selection** — `software-team-agents open --runtime <claude|codex|opencode|antigravity>`
  เป็น direct user choice ไม่ผ่าน router และไม่ใช้ precedence ใดเลย
- **Pipeline routing** — `sta run` resolve **candidate เดียว** ยกเว้นเมื่อ operator ประกาศ
  `routing.order` ใน `.sta/config.yaml`

### Precedence ของ pipeline routing

| ลำดับ | ที่มาของ route | precedence ใน run log |
|---|---|---|
| 1 | `--runtime <id>` และ/หรือ `--model <name>` / `--effort <name>` ของ run นั้น | `level-1` |
| 2 | `routing.by_role.<role>` ใน `.sta/config.yaml` (`"runtime:model"` หรือ `{ runtime, model, effort }`) | `level-2` |
| 3 | default runner (`execution.runner` หรือ `claude-code`) หรือ `routing.order` (เมื่อตั้งค่า) | `level-4` |

ตารางนี้เลือก runtime/camp เท่านั้น หลังได้ camp แล้ว resolver กลางเลือก model/effort ด้วย precedence
`operator model/effort → task Tier → role default Tier → runtime default` และบันทึก effective
Tier/requested values/winner basis ใน route log — รายละเอียด operator ที่
[`tier-and-effort-run.md`](tier-and-effort-run.md)

candidate ต้อง registered + available + มี capability ที่ stage ต้องใช้ (Target-write stage ต้องมี
`PRE_TOOL_GUARD`; `business-analyst` ต้องมี `INTERACTIVE_PROMPTS`) — ขาด capability ถูกตัดออกเสมอ;
ถ้าเป็น candidate เดียวจะ **refuse** พร้อมเหตุผล

### Fallback semantics

ถ้า route ที่เลือกรันไม่ได้ (unavailable / ต่ำกว่า supported โดยไม่ opt in / ขาด capability / runner คืน
`UNAVAILABLE`-`ERROR`-`TIMEOUT`) → pipeline **STOP → Human** พร้อมเหตุผล (`fallback_count` = 0) —
ไม่มีการสลับ runner เงียบ ๆ

**ข้อยกเว้นเดียว — `routing.order` (ลำดับ 3):** `UNAVAILABLE` hop ไป entry ถัดไป แต่
**`ERROR`/`TIMEOUT` ไม่ hop** (task failure ไม่ใช่ outage); ทุก hop เขียน `fallback_reason` และ +1
`fallback_count` หมดทุก entry = task หยุด · `--runtime`/`--model` (ลำดับ 1) และ `routing.by_role`
(ลำดับ 2) ชนะขาด — ordering ไม่ถูกอ่านเลย · `routing.fallback_on` รับ `unavailable` ค่าเดียว
(`error` ถูกปฏิเสธตอน load) · camp switch กลาง phase `🔒 Security gate` ทำ QA/security pass เดิมของ
phase นั้นเป็นโมฆะ (ADR-025)

config เก่า (`execution.mode`, `execution.allow_handoff`, `execution.allow_paid_fallback`,
`routing.strategy`, `model_routing`) โหลดได้แต่ไม่มีผล — `status` รายงาน `ignored keys: ...`;
`sta run --mode ...` error พร้อมบอกคำสั่งแทนที่

ดู surface ทั้งหมดที่ build นี้รับจริงด้วย `sta --help` และผล routing/fallback ที่บันทึกด้วย
`sta status <task-id>` / `sta audit <task-id>`
