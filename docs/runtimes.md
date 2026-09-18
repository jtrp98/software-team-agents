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
`software-team-agents open --runtime codex` refuse ที่จะเริ่ม (`NOT READY — UNGUARDED`) เว้นแต่ส่ง
`--allow-unguarded-runtime` ซึ่งจะพิมพ์ `[UNGUARDED SESSION — acknowledged]` บน launch line

- **enforced** — guards ทั้งหก wired และ verified
- **partial** — บังคับได้บางส่วน; ส่วนที่ขาดรายงานเป็น `GUARD GAP` และให้ QA round เป็นตัวครอบ
- **unguarded** — payload ไม่มีกลไก hook ฝั่งนั้นเลย

## ตาราง runtime

| Runtime | สถานะ | Guard coverage |
|---|---|---|
| **Claude Code** | ✅ **Supported** — implemented + verified (pipeline, guards, capability probe); the only V8 runtime certified for unattended Target writes | **enforced** — ครบทั้งหก (`block-git`, `block-outside-repo`, `block-path-permissions`, `block-doc-rewrite`, `block-secret-leak`, `require-green-before-stop`) |
| **Codex** | ⚠️ **Preview** — `open --runtime codex` เปิด interactive session ได้ และ `.codex/agents/*.toml` + skills mirror `.agents/skills/**` ถูก generate ครบ แต่ headless pipeline (`sta run`) วิ่งบน Claude Code เป็น default; `CodexAdapter` ยังเป็น implementation ที่ไม่เคย verify กับ install จริง; V8 จำกัดไว้ที่ analysis/proposal และ refuse unattended Target writes | **unguarded** — payload ไม่ ship Codex hook wiring เลย; launch ต้อง `--allow-unguarded-runtime` |
| **OpenCode** | 🧪 **Experimental** — bindings + plugin `sta-guards.js` + commands mirror sync ครบ (`/name` ผ่าน `opencode run --command`), `open --runtime opencode` และ `sta run --runtime opencode` ใช้ได้; adapter/permission ผ่านการ spike แต่ exit checks (typecheck/secret ตอนจบ run) ยังไม่มี in-band — รายงานเป็น GUARD GAP และให้ QA round เป็นตัวครอบ; V8 จำกัดไว้ที่ analysis/proposal | **partial** — plugin บังคับ `block-outside-repo` + `block-path-permissions`, permission block ของ binding บังคับ `block-git`; `block-doc-rewrite`, `block-secret-leak`, `require-green-before-stop` ไม่มีกลไกบน OpenCode workspace **ที่ขาด plugin = unguarded** ไม่ใช่ partial (OpenCode default posture คือ allow-all) |
| **Antigravity** | 🧪 **Experimental** — runtime id `antigravity`, binary `agy`; probe, headless `-p`, JSON envelope, token usage และ adapter round-trip เต็มรอบ verify แล้วบน install จริง (agy 1.1.27/Windows 11) ไม่มี project agent store → role ถูก fold เข้า prompt; envelope ไม่มีช่อง cost → ไม่ claim `COST_REPORTING`; Target-write stages ยังถูกปฏิเสธ | **unguarded** — deny path มีจริงและ fail closed จริง (hook คืน `deny` → block; hook load ไม่ขึ้น → block) แต่ agy อ่าน hooks **จาก `~/.gemini/config/hooks.json` ระดับเครื่องเท่านั้น** — `.agents/hooks.json` ใน workspace ไม่เคยถูกอ่าน → guard ที่ ship มากับ repo ไม่ enforce อะไร |

Same verdict, three places: ตารางนี้, `sta runtimes` (อ่าน `RUNTIME_SUPPORT` ตรง) และ
`software-team-agents --help`'s `--runtime` line — ทั้งสาม quote `guardSettings.ts`'s
`codexCoverage()`/`opencodeCoverageWithPlugin()` จึง claim coverage ไม่ได้หลุดจากสิ่งที่ preflight
enforce จริง (`orchestrator/src/runtime/runtimeSupport.test.ts` pin ไว้)

## Unattended runs

การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` — default (`propose`) ติด permission prompt
ที่ไม่มีคนกดใน headless run สิทธิ์เขียน Target แบบ unattended เป็นของ runtime ที่ได้รับ certification
(ดูตาราง — ปัจจุบันคือ Claude Code เท่านั้น)

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
