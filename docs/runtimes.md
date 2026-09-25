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
- **partial** — native runtime guard บังคับได้บางส่วน; exit checks ที่ runtime ไม่บังคับเองจะถูก
  `ExitCheckRunner` กลางตรวจแบบ fail-closed หลัง process จบ
- **unguarded** — ไม่มี native pre-tool enforcement ที่เชื่อถือได้; การมีไฟล์ config อย่างเดียวไม่นับ
  เป็น enforcement

## ตาราง runtime

| Runtime | สถานะ | Guard coverage |
|---|---|---|
| **Claude Code** | ✅ **Supported** — implemented + verified (pipeline, guards, capability probe); certified for unattended Target writes | **enforced** — ครบทั้งหก (`block-git`, `block-outside-repo`, `block-path-permissions`, `block-doc-rewrite`, `block-secret-leak`, `require-green-before-stop`) |
| **Codex** | ✅ **Supported** — interactive และ headless adapter verify บน Codex 0.154.0/0.155.1 แล้ว; headless enforcement = per-run native permission profile (เขียนเฉพาะ path ที่ packet อนุญาต ปิด network บล็อก Git ด้วย execpolicy + OS deny) **live-verified ปลายทางจริง รอบสาม 2026-09-23** (deny นอก workspace / allow ใน workspace / read-only deny ทุก write / network ตายระดับ DNS) และ exit checks fail-closed จับ typecheck แดงหลัง process จบ; certified for unattended Target writes; **interactive session ยัง unguarded** — ต้อง `--allow-unguarded-runtime` และจำกัด analysis/proposal | **headless enforced / interactive unguarded** — adapter ใช้ native permission profile + isolated execpolicy โดยไม่พึ่ง project hook; `.codex/hooks.json` ยังเป็น compatibility payload สำหรับ interactive เท่านั้น (default trust ข้าม hooks, hook พัง fail-open — ไม่ถูก claim เป็น enforcement ฝั่ง headless); exit checks ใช้ `ExitCheckRunner` กลางหลัง process จบ |
| **OpenCode** | 🧪 **Experimental** — bindings + plugin `sta-guards.js` + commands mirror sync ครบ (`/name` ผ่าน `opencode run --command`), `open --runtime opencode` และ `sta run --runtime opencode` ใช้ได้; native exit hook ไม่มี แต่ `ExitCheckRunner` กลางตรวจ typecheck/lint และ secret แบบ fail-closed หลัง process จบ; V8 จำกัดไว้ที่ analysis/proposal | **partial** — plugin บังคับ `block-outside-repo` + `block-path-permissions`, permission block ของ binding บังคับ `block-git`; `block-doc-rewrite`, `block-secret-leak` และ `require-green-before-stop` ไม่มีกลไก native บน OpenCode workspace โดยสองตัวหลังมี runner กลางครอบ; **ที่ขาด plugin = unguarded** ไม่ใช่ partial (OpenCode default posture คือ allow-all) และ headless adapter **refuse run ก่อน spawn** เมื่อ plugin หาย (V13 TASK-014) |
| **Antigravity** | ✅ **Supported** — runtime id `antigravity`, binary `agy`; probe, headless `-p`, JSON envelope, token usage, adapter round-trip และ machine-global bridge hook (`~/.gemini/config/hooks.json`) verify บน install จริง (agy 1.2.7/Windows 11) แล้ว; headless guarded write ได้รับ certification สำหรับ unattended Target writes ผ่าน bridge hook; pipeline และ guards verified ครบถ้วน | **enforced via bridge hook** — deny path มีจริงและ fail closed จริง; agy อ่าน PreToolUse hooks จาก `~/.gemini/config/hooks.json` ระดับเครื่อง forward ไปหา `sta-guard.js` และ `block-git.js` บังคับ path permissions, block git state-changing และ universal floor ในตัว; exit checks ใช้ `ExitCheckRunner` กลางหลัง process จบ |
| **ZCode Desktop** | 🧪 **Experimental** — desktop interactive role-play runtime (คำตัดสิน V12): ผู้ใช้เปิด ZCode เองแล้ว AI เล่น role ของ pipeline จาก instructions/skills + `sta context`/`sta policy`; ไม่มี CLI ไม่มี headless — `sta run --runtime zcode` refuse ที่ registry และไม่มี launch path; guard wiring `.zcode/config.json` **UAT สดผ่านครบบน session จริง (2026-09-23, `planning/v12/evidence/zcode-uat/`)**; unattended Target writes ยัง refuse เสมอ | **partial** — payload sync แล้ว wire 4 PreToolUse guards + Stop pair; `block-path-permissions` อ่าน role จาก `STA_ROLE` หรือ `.workflow/session-role.json` ที่ประกาศผ่าน `software-team-agents session-role` — session ที่ประกาศ role ได้ per-role Target/Knowledge write bounds เหมือน orchestrated stage, session ที่ไม่ประกาศเหลือ floor เท่านั้น (read ยังเป็น instruction-level); Stop-hook โดน cap 3 continuations ต่อ session (GUARD GAP, QA round ครอบ); PostToolUse และ per-agent exit guards ไม่มี guard ที่ ship มา |

Same verdict, three places: ตารางนี้, `sta runtimes` (อ่าน `RUNTIME_SUPPORT` ตรง) และ
`software-team-agents --help`'s `--runtime` line — ทั้งสาม quote `guardSettings.ts`'s
`codexCoverage()`/`opencodeCoverageWithPlugin()` จึง claim coverage ไม่ได้หลุดจากสิ่งที่ preflight
enforce จริง (`orchestrator/src/runtime/runtimeSupport.test.ts` pin ไว้)

## Unattended runs

การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` — default (`propose`) ติด permission prompt
ที่ไม่มีคนกดใน headless run สิทธิ์เขียน Target แบบ unattended เป็นของ runtime ที่ได้รับ certification
(ดูตาราง — ปัจจุบันคือ Claude Code, Codex headless adapter และ Antigravity headless adapter)

### ตรวจสถานะ login ก่อน run ยาว

run ที่ยาวขึ้นคือ quota ที่เสียเปล่ามากขึ้นเมื่อ auth มีปัญหา — เช็คก่อนเริ่มด้วยคำสั่งที่ยืนยันแล้ว
บน install จริงของแต่ละ runtime:
| Runtime | คำสั่งเช็ค | หมายเหตุ |
|---|---|---|
| Claude Code | `claude auth status` | subcommand ยืนยันบน 2.1.278 (`claude auth --help`: login/logout/status) |
| Codex | `codex login status` · `codex doctor` | ยืนยันบน 0.154.0 — `login status` ตอบสถานะ (เช่น "Logged in using ChatGPT"); `doctor` วินิจฉัย config/auth/runtime ครบและ read-only |
| Antigravity (agy) | — ไม่มี subcommand เช็ค auth บน 1.2.7 | ปัญหา auth จะแสดงเป็น error/denied ตอน run เท่านั้น (ดู [`troubleshooting.md`](troubleshooting.md)) |
| ZCode | — ไม่มี CLI | ตรวจจากตัว app เท่านั้น |

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
