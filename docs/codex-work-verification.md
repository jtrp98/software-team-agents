# Codex work — baseline และหลักฐานตรวจรับ

Workspace: `C:\src\AICode\software-team-agents-dev` · branch ที่อ่านได้: `dev/golf` · runtime ที่ทดลอง: `codex-cli 0.159.2`

## Baseline ขั้น 0

- Context ของ Codex session ต้นทางมีเนื้อ bootstrap ของ AGENTS.md เต็ม พร้อม pointer ไป CLAUDE.md ไม่ได้มีเนื้อ operating rules ของ CLAUDE.md มาใน context เริ่มต้น อ่านสองไฟล์จริงก่อนแก้โค้ดแล้ว
- ต้นทาง Desktop ไม่มีเครื่องมือแสดงรายการ slash commands จึงไม่ได้อ้างผล UI จาก context อย่างเดียว
- เปิด CLI session ใหม่ที่ framework แบบ read-only แล้วพิมพ์ `/work`: เมนูแสดงเพียง `/worktree` ไม่พบ work shortcut
- Instruction bootstrap ระบุว่า tool calls ใน interactive อาจ unguarded; ไม่ถือว่า hook payload เป็น enforcement และไม่แก้ Codex verdict ใน guardSettings.ts

## Prompts ที่พบจริง และทางใช้งานที่คนเลือก

| การทดลอง | ผลที่พบจริง |
|---|---|
| เพิ่ม project `.codex/prompts/work.md` แบบ inline และเปิด CLI ใหม่ | ไม่พบ work custom prompt ในเมนู |
| ติดตั้งตามคำสั่งใน docs/runtimes.md ไป `C:\Users\jabja\.codex\prompts\work.md` แล้วเปิดใหม่ | hash ตรงกับ rendering แต่ยังไม่พบ work custom prompt |
| Native `skills/list` ที่ framework และ Knowledge | พบ enabled repo skill `work` จาก `.agents/skills/work/SKILL.md` ทั้งสอง workspace |
| CLI ใหม่ที่ Knowledge: `/skills` → List skills → พิมพ์ work → เลือก | เมนูแสดง `work [Skill] The interactive work loop…`; ช่องพิมพ์แสดง `$work` |

[OpenAI custom prompts](https://learn.chatgpt.com/docs/custom-prompts) บอกว่า legacy custom prompts อยู่ใน Codex home และใช้ `/prompts:work`; deprecated แล้ว เอกสารนั้นไม่ใช่หลักฐานว่ารุ่นที่ติดตั้งบนเครื่องนี้ค้นพบ global prompts ได้ จึง **ไม่ได้สรุปว่า global-only discovery สำเร็จบน 0.159.2** และไม่อ้างว่ามี alias `/work`

ผู้ใช้ตอบชัดเจนว่า **ยอมรับ `$work` เป็นคำสั่งของ Codex** การตรวจรับข้อ 4 จึงใช้เกณฑ์นี้ การพบเมนูใน CLI ไม่ได้ certify UI ของ Desktop รุ่นอื่น

## ไฟล์ในงานนี้

| ไฟล์ | เปลี่ยนอะไร |
|---|---|
| `orchestrator/src/runtime/bindingGenerator.ts` | เพิ่ม renderCodexPrompt และ COMMAND_RENDERINGS สำหรับ .codex/prompts; inline guardrails และรักษา argument metadata; AGENTS pointer บอก Codex ให้ใช้ $work |
| `scripts/regenerate-renderings.mjs` | ระบุ prompt rendering ใหม่; loop กลางเดิมอ่าน COMMAND_RENDERINGS และสร้างไฟล์ได้จริง |
| `orchestrator/src/packaging/templateSources.ts` | บรรจุ .codex/prompts ใน template manifest |
| `orchestrator/src/targetcli/syncEngine.ts` | strip .md ตอนตรวจ stale command; packaged prompts ถูกสร้างผ่าน derived path เพียงครั้งเดียวและตาม runtime opt-in |
| `orchestrator/src/runtime/bindingGenerator.test.ts`, `orchestrator/src/packaging/templateSources.test.ts`, `orchestrator/src/targetcli/syncEngine.test.ts` | ตรวจ metadata/inline rules, packaged prompt, manifest uniqueness, sync ซ้ำ และ runtime opt-in |
| `.claude/commands/work.md` | ระบุว่า Codex interactive grant ไม่ได้ทำให้ writes enforced; ส่งงานเขียนผ่าน sta execute --runtime codex หรือ headless pipeline |
| `AGENTS.md`, `.agents/skills/work/SKILL.md`, `.opencode/commands/work.md` | regenerate จาก source เดียวกัน |
| `.codex/prompts/*.md` | 36 generated prompt renderings; work.md มี inline guardrails และไม่มี Claude @import |
| `docs/runtimes.md`, เอกสารนี้ | วิธีใช้ $work, legacy installation ที่คนสั่งเอง, ข้อจำกัด และหลักฐานจริง |

sync ไม่เขียน Codex home เอง; ไม่มี installer เงียบ ๆ การติดตั้ง global ครั้งนี้เป็นขั้นทดลองที่ขออนุญาตอย่างชัดเจนและไม่ทับไฟล์เดิม ไม่ใช้ sync/init/upgrade กับ Knowledge หรือ Target จริง

## ตรวจรับ 1–4

| ข้อ | คำสั่ง/หลักฐาน | ผล |
|---|---|---|
| 1 | `npm --prefix orchestrator run typecheck` หลังแก้ manifest overlap | PASS, exit 0 |
| 2 | `npm test` รอบสุดท้ายหลัง build และแก้ regression | PASS, exit 0; 279 files passed, 3 files skipped; 4,332 tests passed, 10 skipped (4,342 รวม) |
| 3 | `node scripts/regenerate-renderings.mjs` ตามด้วย `npm run build` | PASS, exit 0; 164 template files + manifest.json |
| 4 | Native skill selection + Codex app-server session ใหม่ที่ Knowledge + คำถามจริง | PASS ตามเกณฑ์ $work ที่ผู้ใช้ยอมรับ; อ่าน status.md สำเร็จ exit 0 |

การ rebuild เปิดเผย regression ของ cleanup: shipped prompt ถูกติดตามซ้ำใน workspace manifest แก้ที่ sync ให้มี derived path เดียวแล้ว ชุด regression sync/cleanup ผ่าน **40 tests**; ไม่แก้ cleanup ให้กลบ manifest ที่ผิด

หลักฐาน manifest ของ work.md: size 3474 bytes; SHA-256 `f0033badceaaec141ae43f5e830a2daca8dc1cbd208e1fa30e0385f7a7df9c84` ตรงกันทั้ง repo, templates และสำเนา global

### ขอบเขตและผลข้อ 4

- ใช้ `skills/list`/`thread/start`/`turn/start` ของ Codex ที่ติดตั้งจริง ส่ง native skill input ชื่อ work พร้อมคำถาม `$work มีงานค้างอะไรบ้างใน module timetableai`
- session `01a0f513-4686-7c22-a221-8ea8185ddee6`: cwd `C:\src\schoolbright-knowledge`, sandbox `readOnly`, networkAccess false, approvalPolicy on-request
- sandbox provisioning บนเครื่องนี้ล้มเหลวตอน shell read ครั้งแรก จึงใช้ **การอนุญาตคำสั่งอ่านเฉพาะครั้ง** ที่ผู้ใช้อนุญาตผ่าน tool approval: `Get-Content -LiteralPath 'C:/src/schoolbright-knowledge/_docs/status.md'` ไม่อนุญาตทั้ง session, ไม่แก้ execpolicy และไม่ใช้ bypass sandbox flag
- native command ครั้งถัดไป exit 0; output ตรงกับ status.md จริงทุกตัวอักษรหลัง normalize CRLF/LF และท้ายไฟล์ SHA-256 ของเนื้อ normalized: `e187154e0baa7b02a9d0726ac83524fedc24a8812d351c5ec835ef84223cad2a`
- transcript และ test harness เก็บเฉพาะใต้ framework: `.workflow/codex-command-probe/skill-session.json`, `.workflow/codex-command-probe/skill-probe.mjs` เป็น local evidence ที่ gitignore อยู่
- Knowledge skill ที่ใช้มีอยู่ก่อนแล้ว ไม่ sync หรือแก้ไฟล์ใน Knowledge เพื่อทดสอบ การอ่านสำเร็จนี้ไม่ใช่ certification ของ direct interactive writes หรือ unattended enforcement

คำตอบจากไฟล์จริง: timetableai อยู่ที่ **Phase 1 deploy**, Now คือ verified รอ devops deploy, **Blocked on: —**; Phase 1–2 รอ deploy, Phase 3 รอ security/deploy, Phase 4 รอ implementation/verification/deploy, Phase 5–6 รอ implementation/verification/security/deploy

## แถว Codex หลังซ่อม

| Runtime | Instruction | Work command | Hooks / write posture |
|---|---|---|---|
| Codex | ✅ AGENTS.md bootstrap + pointer → CLAUDE.md | ✅ $work native skill ตามที่ผู้ใช้ยอมรับ; /work alias ไม่ได้เพิ่ม | ⚠ compatibility payload; interactive unguarded; งานเขียนใช้ sta execute --runtime codex ที่มี native permission profile ต่อ run |
