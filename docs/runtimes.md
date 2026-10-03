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
| **Claude Code** | ✅ **Supported** — headless run รัน `claude` ตรง ๆ แบบที่คนรัน (login ของผู้ใช้เอง ไม่มี Codex-sandbox wrapper — owner decision 2026-10-03); hooks ใน `.claude/settings.json` บังคับ universal floor, ห้าม git และ path permissions ของ contract ก่อนทุก tool call; certified for unattended Target writes ผ่าน pre-tool hooks; wrapper TASK-031 เหลือไว้เฉพาะ caller ที่ขอ `osIsolation: true` เอง | **headless enforced (hooks)** — PreToolUse hooks + write-scope check หลัง run; exit checks ใช้ `ExitCheckRunner` กลางหลัง process จบ |
| **Codex** | ✅ **Supported** — interactive และ headless adapter verify บน Codex 0.154.0/0.155.1/0.160.0; headless `codex exec` รัน**ไม่มี** Windows elevated sandbox และไม่มี OS permission profile (`--dangerously-bypass-approvals-and-sandbox` — owner decision 2026-10-03) อ่าน/เขียนไฟล์ปกติ; git ถูก execpolicy ปฏิเสธ, เขียนนอก grant ถูกจับหลัง run; **unattended Target writes ไม่ certified** — ใช้กับ analysis / review / QA, routing ข้ามสำหรับ stage ที่เขียน Target | **post-run** — ไม่มี pre-tool write guard ฝั่ง headless; `.codex/hooks.json` เป็น compatibility payload ของ interactive เท่านั้น; exit checks ใช้ `ExitCheckRunner` กลางหลัง process จบ |
| **OpenCode** | 🧪 **Experimental** — plugin/adapter เคย verify แล้ว; unattended Target writes ไม่ certified (Target-write stage refuse); automatic routing ต้อง opt-in `routing.allow_below_supported` | **partial** — plugin บังคับ guard บางส่วน |
| **Antigravity** | ✅ **Supported** — ติดตั้ง PreToolUse hook ระดับเครื่องด้วย `software-team-agents install-antigravity-hook` (ชี้ `~/.gemini/config/hooks.json` ไป `.agents/hooks/sta-guard.js` ของ workspace แบบ absolute path); ใน interactive session (`software-team-agents open --runtime antigravity`) บังคับ universal floor, บล็อกเขียนนอก workspace และ contract path permissions แบบ fail-closed deny; owner decision 2026-10-03 ยกเลิก a1 OS approval-isolation preflight — production dispatch ของ analysis / review / QA ทำได้; unattended Target writes ไม่ certified | **partial (machine hook)** — PreToolUse deny บังคับ path permissions ใน-band |
| **ZCode Desktop** | 🧪 **Experimental** — desktop role-play และ headless adapter เคย verify แล้ว; unattended Target writes ยัง refuse; automatic routing ต้อง opt-in `routing.allow_below_supported` | **partial** — project hooks และ post-run check |

Same verdict, three places: ตารางนี้, `sta runtimes` (อ่าน `RUNTIME_SUPPORT` ตรง) และ
`software-team-agents --help`'s `--runtime` line — ทั้งสาม quote `guardSettings.ts`'s
`codexCoverage()`/`opencodeCoverageWithPlugin()` จึง claim coverage ไม่ได้หลุดจากสิ่งที่ preflight
enforce จริง (`orchestrator/src/runtime/runtimeSupport.test.ts` pin ไว้)

## Codex interactive — pending work และเส้นทางเขียนจริง

Interactive ใช้อ่านสถานะ ลิสต์งานค้าง วิเคราะห์ และเสนอขั้นต่อไปได้ แต่ **direct write จาก
interactive ไม่ certified**: tool calls ใน Desktop/CLI อาจไม่มี framework guard คั่น และ
`.codex/hooks.json` เป็น compatibility payload เท่านั้น การ trust hooks หรือออก
`sta grant issue` ไม่เปลี่ยน Codex interactive ให้เป็น path ที่ enforced

งานเขียนจาก Codex controller ส่งผ่าน executor ที่บังคับ per-run native permission profile จริง:

```powershell
sta execute --runtime codex --task "<bounded task>" --workspace "<resolved Target root>" --write --role <role>
```

สิทธิ์มาจาก packet และ role contract ต่อ run; human gates/refusal ยังมีผลตามเดิม
ใช้ `sta run --runtime codex --task-id <id> --module <module>` เมื่อเป็นงาน pipeline
ดู [Execution model](execution.md) สำหรับผลลัพธ์/approval ของ executor
`software-team-agents open --runtime codex` ที่ preflight ปฏิเสธยังต้องรายงานตามจริง;
การเปิด CLI แบบ read-only เพื่ออ่านสถานะไม่ได้ยืนยันว่า STA interactive launch ผ่าน preflight

### Work ของ Codex — `$work` เป็นเส้นทางใช้งาน, legacy prompt ติดตั้งโดยคนสั่ง

เส้นทางที่ผู้ใช้ยอมรับสำหรับ Codex คือ **`$work`** หรือเลือก skill `work` ผ่าน `/skills`
จาก `.agents/skills/work/SKILL.md` ที่ sync จัดการอยู่แล้ว เป็น prompt shortcut เท่านั้น
ไม่มีการเพิ่ม alias `/work` หรือจำลอง enforcement

Source เดียวคือ `.claude/commands/work.md`; `COMMAND_RENDERINGS` สร้าง
`.codex/prompts/work.md` โดย inline guardrails ไม่มี Claude `@import`, และคง
`description`/`argument-hint` ของ Codex ไว้ `npm run build` บรรจุ rendering ใน
`templates/manifest.json`; sync สร้างและติดตามสำเนาใน workspace ที่เลือก runtime codex
**sync ไม่เขียน Codex home และไม่ติดตั้ง global ให้อัตโนมัติ**

[OpenAI custom prompts](https://learn.chatgpt.com/docs/custom-prompts) ระบุให้ติดตั้ง
ใน `CODEX_HOME/prompts` (default `~/.codex/prompts`) และเรียก **`/prompts:work`**
ไม่ใช่ alias `/work`; custom prompts deprecated แล้ว และเอกสารครอบคลุม CLI/IDE
อย่าอนุมานการรองรับใน Codex Desktop จากการผ่านของ CLI

ผลทดลองบนเครื่องนี้กับ **codex-cli 0.159.2**: วาง `.codex/prompts/work.md` ใน repo
แล้วเปิด TUI ใหม่ ไม่พบ work custom prompt; ติดตั้งใน `C:\Users\jabja\.codex\prompts\work.md`
ด้วย hash ตรงกันแล้วเปิดใหม่ ก็ยังไม่พบในเมนู ดังนั้น **ไม่ได้ยืนยัน global-only discovery
บนรุ่นนี้** เอกสาร legacy ไม่ใช่หลักฐานว่า client ที่ติดตั้งรองรับ ส่วน `skills/list` พบ
repo skill `work` จริงทั้ง framework และ `C:\src\schoolbright-knowledge`

คำสั่งติดตั้ง PowerShell สำหรับ client ที่ยังรองรับ legacy custom prompts
ที่คนสั่งเองจาก framework หรือ workspace ที่ sync แล้ว
(แสดง source/destination, ไม่ทับไฟล์เดิม):

```powershell
$staPromptSource = (Resolve-Path -LiteralPath '.codex/prompts/work.md').Path
$staPromptHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$staPromptDir = Join-Path $staPromptHome 'prompts'
$staPromptDestination = Join-Path $staPromptDir 'work.md'
Write-Output "Install $staPromptSource -> $staPromptDestination"
if (Test-Path -LiteralPath $staPromptDestination) { throw 'work.md exists; review it before replacing it manually' }
New-Item -ItemType Directory -Path $staPromptDir -Force | Out-Null
Copy-Item -LiteralPath $staPromptSource -Destination $staPromptDestination
```

การตรวจเส้นทางใช้งานที่ยอมรับ: เปิด session ใหม่ด้วย
`codex -C C:\src\schoolbright-knowledge -s read-only` แล้วเรียก
`$work มีงานค้างอะไรบ้างใน module timetableai` ต้องอ่าน `_docs/status.md` จริง
หากอ่านไม่สำเร็จ ให้รายงานว่าไม่ผ่าน; คำตอบที่ตรงจากความจำไม่ใช่หลักฐานการอ่าน

เฉพาะการตรวจ legacy custom prompt หลังติดตั้ง เปิด session ใหม่: `codex -C C:\src\schoolbright-knowledge -s read-only -a never`
ตรวจเมนู `/prompts:work` ก่อนส่ง `/prompts:work timetableai` แล้วถาม
"มีงานค้างอะไรบ้างใน module timetableai" ต้องอ่าน `_docs/status.md` จริง
การตรวจนี้ไม่ใช้ `sync`/`init`/`upgrade` และไม่เขียนใน Knowledge repository

`.agents/skills/work/SKILL.md` เป็นอีก rendering ของ source เดียวกัน ใช้ explicit
`$work` ผ่าน skills ได้ใน client ที่รองรับ; การพบ skill ไม่ใช่หลักฐานว่ามี slash alias `/work`
ดู baseline และผลตรวจจริงใน [Codex work verification](codex-work-verification.md)

## Unattended runs

การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` — default (`propose`) ติด permission prompt
ที่ไม่มีคนกดใน headless run สิทธิ์เขียน Target แบบ unattended เป็นของ runtime ที่ได้รับ certification
(ดูตาราง — หลัง V13 TASK-027 a1 และ TASK-031 เหลือ Codex headless adapter และ Claude Code headless ภายใต้ Codex sandbox บน Windows; runtime อื่นหยุด production role dispatch)

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

**STA Core (`sta work` / Web UI):** child `bounded-run` ที่ Core เปิดรับลำดับต่อ role (engineer/reviewer/qa) และ
runtime health ร่วมผ่าน `--core-run <overlay>` — ลำดับนั้นแทน `routing.order` ที่ level-4 เท่านั้น (level 1/2 ยังชนะ),
runtime ที่อยู่ใน cooldown (quota/rate limit/outage/auth/timeout ซ้ำ) อ่านเป็น unavailable ก่อน dispatch, และ
gate ด้าน certification/capability/approval isolation ทั้งหมดยังทำงานเหมือนเดิม — runtime ที่ไม่ผ่านถูกข้าม
ไม่ถูกลดระดับ (รายละเอียด, failure taxonomy และ runtime exhaustion ที่ [`core.md`](core.md) §10)

config เก่า (`execution.mode`, `execution.allow_handoff`, `execution.allow_paid_fallback`,
`routing.strategy`, `model_routing`) โหลดได้แต่ไม่มีผล — `status` รายงาน `ignored keys: ...`;
`sta run --mode ...` error พร้อมบอกคำสั่งแทนที่

ดู surface ทั้งหมดที่ build นี้รับจริงด้วย `sta --help` และผล routing/fallback ที่บันทึกด้วย
`sta status <task-id>` / `sta audit <task-id>`
