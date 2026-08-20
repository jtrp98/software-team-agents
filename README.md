# AgentClaude

ชุด subagent สำหรับ [Claude Code](https://claude.com/claude-code) ที่จำลอง pipeline การพัฒนาซอฟต์แวร์แบบครบวงจร — ตั้งแต่ไอเดียคลุมเครือไปจนถึงโค้ดที่ตรวจสอบแล้ว ตรวจความปลอดภัยแล้ว และ deploy แล้ว — โดยแบ่งเป็นด่านส่งต่องานกันเป็นทอดๆ แทนที่จะให้ agent ตัวเดียวทำทุกอย่างพร้อมกัน

มี 9 agent แต่ละตัวรับผิดชอบงานเดียว: **business-analyst → system-analyst → project-manager → backend-engineer → frontend-engineer → qa-engineer → security → devops** บวก agent **setup** ที่ scaffold โปรเจกต์ครั้งเดียวตอนเริ่ม ไม่มี agent ตัวไหนเรียก agent ตัวถัดไปเอง (ไม่มีตัวไหนถือ Agent tool) — ค่าเริ่มต้นคือ user ตัดสินใจส่งต่องานเองทุกครั้ง ส่วนโหมด autonomous ที่ user เปิดเป็นครั้งๆ ไปให้ session เดินหน้าเชื่อมงานเองได้ แต่จุดที่เสี่ยงที่สุด — ยืนยัน requirement, ยืนยัน schema, งานตรวจไม่ผ่าน, เจอช่องโหว่ร้ายแรง, deploy จริง — ต้องผ่านคนเสมอไม่ว่าโหมดไหน (ดูหัวข้อ [โหมด autonomous](#โหมด-autonomous--ทิ้งรันข้ามคืนได้))

## ทำไมต้องเป็น pipeline แทนที่จะใช้ agent เดียว

agent ตัวเดียวที่ถูกสั่งให้ "สร้างระบบ sales CRM" มักจะเดา requirement เอง คิด schema สดๆ ระหว่างทาง แล้วเขียนทั้งโค้ดและ test ในลมหายใจเดียวกัน — ผลคือถ้าสมมติฐานผิดตั้งแต่บรรทัดแรก มันจะกลายเป็นฐานรากของทุกอย่างที่ตามมาโดยไม่มีใครรู้ตัว การแบ่งงานเป็นด่านที่แต่ละด่านมีเจ้าของเดียวช่วยให้:

- requirement ถูกเขียนลงและยืนยันก่อนที่ใครจะไปออกแบบ schema ตามมัน
- schema ถูกยืนยันครั้งเดียวใน `design.md` แล้ว agent ทุกตัวหลังจากนั้นถือว่ามันเป็นสัญญา ไม่ใช่มานั่งเดาใหม่
- การตรวจสอบเป็นขั้นตอนแยกและมองแบบผู้ตรวจ — agent ที่เขียนโค้ดจะไม่ได้เป็นคนตัดสินเองว่าโค้ดตัวเองถูกต้อง
- ไม่มีอะไร deploy ได้โดยไม่ผ่าน QA ก่อน (และผ่าน security review ก่อนด้วย ถ้าเป็นงานที่อ่อนไหว)

ต้นทุนที่แลกมาคือขั้นตอนที่เยอะขึ้น `.claude/shared/conventions.md` §8 (Right-sizing) มีไว้แก้ปัญหานี้โดยเฉพาะ เพื่อให้งานเล็กๆ ไม่ต้องจ่ายราคาทั้ง pipeline — ดูรายละเอียดด้านล่าง

## Pipeline

```
setup (ครั้งเดียวต่อโปรเจกต์)
   ↓
business-analyst → system-analyst → project-manager → backend-engineer → frontend-engineer
                                                                  ↓
                                                            qa-engineer
                                                  ↓            ↓            ↓
                                         บั๊กในโค้ด        schema มีปัญหา   ทางตันเชิงธุรกิจ
                                                  ↓            ↓            ↓
                                    frontend/backend-engineer  system-analyst  business-analyst
                                                                  ↓
                                                security (phase ที่อ่อนไหว) → devops
```

| Agent | บทบาท | เป็นเจ้าของ |
|---|---|---|
| `setup` | scaffold โปรเจกต์ครั้งเดียว — framework, DB, `.env`, npm scripts | โครงโปรเจกต์ |
| `business-analyst` | สัมภาษณ์ user เขียนบันทึกว่าจะสร้างอะไร | `requirement.md` |
| `system-analyst` | เช็คความเป็นไปได้ ออกแบบ Prisma schema ที่ยืนยันแล้ว แบ่ง module | `design.md` |
| `project-manager` | แตก design ที่ยืนยันแล้วเป็น task list แบ่ง phase พร้อม tag | `plan.md` |
| `frontend-engineer` | ทำ task ที่ tag `[frontend]` ตาม schema ที่ยืนยันแล้ว | โค้ดแอป |
| `backend-engineer` | ทำ task ที่ tag `[backend]` ตาม schema ที่ยืนยันแล้ว | โค้ดแอป |
| `qa-engineer` | ตรวจงานที่เสร็จเทียบกับ requirement/design ส่งงานที่ไม่ผ่านกลับไปจุดที่ถูกต้อง | `review.md` + `review/phase-N.md` |
| `security` | ตรวจงานที่อ่อนไหวหาช่องโหว่ที่โจมตีได้จริง | `security.md` |
| `devops` | container, CI, migration, deploy — เฉพาะงานที่ QA ยอมรับแล้วเท่านั้น | `deploy.md` |

## เริ่มใช้งาน

1. คัดลอก `.claude/` และ `CLAUDE.md` ไปไว้ในโปรเจกต์ของคุณ (หรือ clone repo นี้เป็นจุดเริ่มต้นของโปรเจกต์เลยก็ได้)
2. บอกว่าอยากสร้างอะไร — พูดแบบ "อยากได้ระบบ sales CRM" ก็เพียงพอให้ `business-analyst` เริ่มทำงาน
3. ตอบคำถามที่มันถามเป็นชุด มันจะเขียน `_docs/module/<name>/requirement.md`
4. ส่งไฟล์นั้นให้ `system-analyst` ยืนยันความเป็นไปได้และ data model → ได้ `design.md`
5. ส่งต่อให้ `project-manager` แตกเป็น task list แบ่ง phase → ได้ `plan.md`
6. รัน `setup` ครั้งเดียวเพื่อ scaffold โปรเจกต์จริง (Next.js + Express + Prisma + Postgres) — ตอนนี้มันจะถามด้วยว่าจะใส่ test framework ไหม ค่าเริ่มต้นคือไม่ใส่ (อ่าน [ถ้าไม่ใส่ test จะไม่มีใครรันโค้ดเลยทั้ง pipeline](#ถ้าไม่ใส่-test-จะไม่มีใครรันโค้ดเลยทั้ง-pipeline) ก่อนตอบ)
7. ทำ Phase 1 ด้วย `backend-engineer` ก่อนแล้วค่อย `frontend-engineer` (ห้ามรันพร้อมกันในรอบเดียวกัน — frontend ต้องอ่าน contract จาก backend ที่สร้างจริง) แล้วตรวจด้วย `qa-engineer`
8. phase ไหนที่ `plan.md` ติดธง `🔒 Security gate` ไว้ ให้รัน `security` ก่อนส่งให้ `devops` — `devops` จะไม่ยอม deploy phase ที่ติดธงแต่ยังไม่ถูกตรวจอยู่แล้ว คุณไม่ต้องคอยจำเอง

ทุก agent จะบอกว่าอะไรพร้อมแล้วและควรส่งต่อให้ใคร — ค่าเริ่มต้น (โหมด manual) คือคุณเป็นคนสั่งเดินหน้าทุกครั้ง

### โหมด autonomous — ทิ้งรันข้ามคืนได้

ถ้าอยากให้ session เดินหน้าเชื่อมงานเองแทนที่จะรอคุณสั่งทีละสเตจ ให้บอกตรงๆ ตอนนั้น เช่น "รันข้ามคืนได้เลย" หรือ "เชื่อมต่อเนื่องไปเลยไม่ต้องถามทุกจุด" — เป็นการอนุญาตครั้งเดียวต่อรอบที่สั่ง ไม่ใช่ค่าคงที่ที่ติดไปทุก session หลังจากนั้น

agent เองยังเรียกกันเองไม่ได้เหมือนเดิม (ไม่มีตัวไหนถือ Agent tool) สิ่งที่เปลี่ยนคือ session ที่คุมภาพรวมจะเป็นคนกดต่อให้เองแทนที่จะรอคุณพิมพ์ชื่อ agent ถัดไป — แต่มี **5 จุดที่หยุดรอคนเสมอ ไม่ว่าจะสั่ง autonomous ไว้หรือไม่**:

1. `business-analyst` ทุกครั้งที่ถูกเรียก (ทั้งสัมภาษณ์เริ่มต้นและทางตันเชิงธุรกิจที่ถูกส่งมากลางทาง) — งานของมันคือถามคนสิ่งที่มันตอบเองไม่ได้ ไม่มีทางลัดให้ข้าม
2. `system-analyst` ตอนขอยืนยัน schema/feasibility — schema จะเป็น contract ได้ก็ต่อเมื่อมีคนยืนยันแล้วเท่านั้น
3. `qa-engineer` ทันทีที่ phase ไหนออกมา ⚠️ หรือ ❌ — จะให้วนแก้อัตโนมัติได้ไม่เกิน 2 รอบตามเพดานเดิม เกินนั้นหรือถ้าต้องส่งกลับ system-analyst/business-analyst ต้องหยุดรอคน (phase ที่ ✅ ครบ FULL round ไปต่อได้เองไม่ต้องถาม)
4. `security` เจอ 🔴 Critical หรือ 🟠 Important — ยอมรับความเสี่ยงด้านความปลอดภัยเป็นการตัดสินใจเชิงธุรกิจ ให้ agent ตัดสินเองไม่ได้ (🟡 Minor ไปต่อได้)
5. `devops` ก่อนสั่ง deploy/migrate จริง — เตรียมไฟล์ (Dockerfile, CI, dry-run) ทำอัตโนมัติได้ แต่การกดจริงไม่มีวันข้าม

นอกจาก 5 จุดนี้ ยังมีบางจุดที่หยุดเพราะ agent ตอบเองไม่ได้จริงๆ (เช่น `project-manager` เจอ sequencing ที่ต้องถามคุณ) ไม่ใช่เพราะโหมด แต่เพราะไม่มีคำตอบสำรองให้เดา

ต้องกดสั่งเองทีละ agent เสมอถ้าไม่มีเครื่องมือช่วย — ถ้าอยากให้โหมด autonomous นี้รันจริงแบบไม่ต้องนั่งเฝ้า ดูหัวข้อ [`orchestrator/` — ตัวขับเคลื่อนโหมด autonomous แบบรันจริง](#orchestrator--ตัวขับเคลื่อนโหมด-autonomous-แบบรันจริง) ด้านล่าง

## `orchestrator/` — ตัวขับเคลื่อนโหมด autonomous แบบรันจริง

`orchestrator/` เป็นแพ็กเกจ Node/TypeScript แยกต่างหากในรีโปนี้ (`npm install` แล้ว `npm test`/`npm run typecheck` ที่ `orchestrator/`) มีหน้าที่ **รันโหมด autonomous ข้างบนให้จริงแทนที่จะให้คุณกดสั่งเอง** — ไม่ใช่ pipeline คนละอันหรือ agent ตัวที่ 10 มันไม่มีวันแก้ไฟล์ `_docs/*` เองและไม่มีวันเรียก `.claude/agents/*.md` โดยตรง สิ่งที่มันทำคือ:

1. **จัดกลุ่ม state** — จำลอง state machine ของ task หนึ่งตัวตาม 12 state ใน `orchestrator/src/state/taskState.ts` (`CREATED` → ... → `DEPLOYED`, มี `QA_FAILED`/`SECURITY_FAILED`/`BLOCKED` เป็น branch ล้มเหลว) และ**จัด pipeline stage ให้เองจาก flag การจำแนกงาน** (`orchestrator/src/classification/taskClassifier.ts`) ตรงกับตาราง [Right-sizing](#right-sizing--ข้ามด่านได้สำหรับงานเล็ก) ด้านบนทุกแถว
2. **บังคับ 4 gate ตรงกับ 5 จุดที่ต้องรอคนข้างบน** (`orchestrator/src/gates/gatePolicy.ts`): ยืนยัน design ก่อนเข้า implementation, `qa-report.status` ต้อง PASS ก่อนไปต่อ, `security-report.overallStatus` ต้อง PASS ก่อนไปต่อ, และต้อง `humanApproved` ก่อน deploy จริง — ทั้งสี่ gate ไม่มี agent ตัวไหนตอบแทนคนได้ ต้องมีหลักฐานจริงเท่านั้น
3. **บังคับเพดาน retry เดียวกับ QA/security** (`orchestrator/src/retry/retryPolicy.ts`, `MAX_RETRY = 3`) — แก้ไม่ผ่านเกินรอบก็ถูกบังคับเข้า `BLOCKED` เหมือนกติกา "แก้ไม่ผ่านสองรอบให้ส่งกลับหาคุณ" ข้างบน
4. **รัน agent จริง** ผ่าน `orchestrator/src/agents/claudeCliExecutor.ts` — เรียก `claude -p --agent <role>` ในโฟลเดอร์โปรเจกต์จริง ซึ่ง `<role>` (`business-analyst`, `qa-engineer`, ...) resolve ไปที่ `.claude/agents/<role>.md` ไฟล์เดียวกับที่ agent list ข้างบนใช้ทุกประการ — orchestrator ไม่ได้ถือ prompt ของตัวเองซ้ำซ้อน แค่เป็นคนกด "รันตัวถัดไป" แทนคุณ แล้วอ่านผลจริงกลับมาตัดสินว่าจะไปต่อยังไง: `review.md`/`security.md` ที่ `qa-engineer`/`security` เขียนจริงถูกอ่านกลับมา parse เป็นหลักฐาน (`orchestrator/src/agents/moduleDocs.ts`, อ่านเครื่องหมาย ✅/⚠️/❌ กับ `(FULL)`/`(TARGETED)` และ 🔴/🟠/🟡 กับ 🔵/🟣/✅/⚪ ตรงตามอนุสัญญาที่อธิบายไว้ด้านบนทุกตัว — regex-based เหมือน `.claude/scripts/*.js` สองตัว ไม่ใช่ Markdown parser จริง) ก่อนตัดสินว่า gate ผ่านหรือไม่
5. **จำ state ข้าม process ได้จริง** — ทุกครั้งที่ task เปลี่ยน state มันเขียนลง `.workflow/state.db` (SQLite ไฟล์เดียว ไม่มี server) *ก่อน* จะบอกผลกลับมา แล้ว generate `.workflow/state.yaml` ให้คนอ่านคู่กันทุกครั้ง (`orchestrator/src/store/`) ปิด terminal กลางคันแล้วสั่ง `--resume` มันจะเดินต่อจาก stage เดิม ไม่รัน stage ที่จ่ายเงินไปแล้วซ้ำ และ**ไม่ถามซ้ำ approval ที่คุณตอบไปแล้ว** — `state.yaml` เป็น view อย่างเดียว แก้ไปก็ถูกเขียนทับ ตัวจริงคือ `state.db` เสมอ — และรูปร่างของมันเป็น contract จริงที่เครื่องมืออื่นอ่านได้ (`orchestrator/schemas/state-view.schema.json`, validate ด้วย ajv **ก่อน** เขียนไฟล์ทุกครั้ง ถ้าไม่ผ่านคือไม่เขียน ไม่ใช่เขียนไฟล์ที่ผิดสัญญาตัวเองทิ้งไว้)
6. **คุมลำดับ task หลายตัว** (`orchestrator/src/orchestrator/taskRegistry.ts`) — `--depends-on` ทำให้ task ที่ยังรอ dependency เปิดรันไม่ได้เลยจนกว่าตัวที่มันรอจะถึง `DEPLOYED` (ยังรันขนานไม่ได้ นั่นเป็นงาน DAG คนละส่วน)
7. **route failure จากข้อมูล ไม่ใช่จากที่ agent สั่ง** (`orchestrator/src/orchestrator/failure.ts`) — ถ้ารอบที่ fail ส่ง structured failure มาด้วย (category/owner/severity/retryable/requires_human) orchestrator เป็นคนเลือกเองว่าย้อนกลับไปหา engineer คนไหน หรือหยุดรอคน ถ้าเป็น contract gap ที่ไม่มีทางกลับไป `DESIGN` ได้จริง มันจะ `BLOCKED` แทนที่จะส่งกลับไปให้ engineer แก้สิ่งที่ไม่ใช่ความผิดตัวเอง

รันจริงจาก root ของโปรเจกต์เป้าหมาย (ไม่ใช่ root ของ `AgentClaude`):

```bash
cd orchestrator
npm install
npm run orchestrate -- --task-id T-1 --module sales-crm --new-feature --backend --frontend

# กลับมาทำต่อหลังปิด terminal หรือหลังตอบ N ไปก่อนหน้า
npm run orchestrate -- --task-id T-1 --module sales-crm --resume

# ดูว่ามี task อะไรค้างอยู่บ้าง (ไม่รัน agent เลย)
npm run orchestrate -- --list

# เช็คว่า contracts/*.yaml ยังตรงกับ registry ที่ orchestrator ใช้จริง (เหมาะกับ CI)
npm run orchestrate -- --check-contracts

# ให้ T-2 รอจน T-1 ถึง DEPLOYED ก่อนถึงจะเริ่มได้
npm run orchestrate -- --task-id T-2 --module sales-crm --incremental --backend --depends-on T-1
```

พอเจอจุดที่ 5 จุดข้างบนต้องรอคน มันจะหยุดถามตรงๆ ใน terminal เดียวกัน (`Approve DESIGN -> IMPLEMENTATION? [y/N]`) ไม่ใช่เดาให้เอง — ตอบ `y` แล้วมันเดินหน้าต่อในรันเดียวกัน ตอบ `N` หรือ Ctrl-C ได้เลย — state ถูกบันทึกไว้แล้ว กลับมาต่อด้วย `--resume` เมื่อไหร่ก็ได้

**ข้อจำกัดที่ควรรู้ก่อนใช้จริง:**
- **รันได้ทีละ task** — dependency บังคับ *ลำดับ* ได้แล้ว แต่ยังรัน task ที่ไม่เกี่ยวกันพร้อมกันไม่ได้ และยังไม่มี lock กันสอง process สั่งงาน task เดียวกันพร้อมกัน (SQLite กันไฟล์พังให้ แต่ไม่ได้กันสอง orchestrator แย่งกันสั่ง agent)
- **`.workflow/` ถูกสร้างที่ root ของโปรเจกต์เป้าหมาย** — `state.db` คือของจริง ส่วน `state.yaml` เป็น view ที่ถูกเขียนทับทุกครั้ง อย่าแก้ด้วยมือ และควรใส่ `.workflow/` ไว้ใน `.gitignore` ของโปรเจกต์นั้น
- **`--module` ต้องมีอยู่แล้ว** — orchestrator ไม่ได้ resolve module folder ให้แบบที่ agent จริงทำ (หนึ่ง folder → ใช้, หลาย folder → ถาม) ต้องระบุชื่อ module เองตรงๆ ทุกครั้ง
- **การอ่าน `review.md`/`security.md` กลับเป็น regex-based** เช่นเดียวกับ `.claude/scripts/` — เป็นตัวช่วยเชื่อม ไม่ใช่ตัวแทนการอ่านเอกสารจริงของคน ถ้า mode หรือ severity marker ที่มันหาไม่เจอ มันจะ fail-closed (บังคับ `TARGETED`/`FAIL`) แทนที่จะเดาว่า PASS

## เอา pipeline นี้ไปรวมกับโปรเจกต์ที่มีอยู่แล้ว

เอา pipeline ทั้งชุด (`.claude/` + `orchestrator/` + `CLAUDE.md` + `MERGE_GUIDE.md`) จาก repo นี้ไปวางเป็น **staging folder เดียว** ชื่อ `software-team-agents/` ไว้ที่ root ของ**โปรเจกต์ปลายทางจริง** (สมมติชื่อ `projectx`, repo คนละอันกับ `AgentClaude`) — ชื่อ folder นี้ตั้งตายตัวไว้ เอาไว้แยกของที่กำลังจะ merge ออกจากของเดิมใน `projectx` ให้ชัด `MERGE_GUIDE.md` อยู่ *ข้างใน* staging folder นี้เอง ไม่ใช่ที่ root ของ `projectx`. `orchestrator/` ไปด้วยเสมอ ไม่ใช่ของเสริม — ไม่งั้น `projectx` จะได้แค่ตัว agent แต่ไม่มีตัวขับเคลื่อนโหมด autonomous ผลลัพธ์หน้าตาแบบนี้:

```
projectx/                           ← โปรเจกต์ปลายทางจริง (cwd ตอนรัน merge)
├── software-team-agents/           ← staging folder: pipeline ที่จะเอาไป merge
│   ├── .claude/
│   ├── orchestrator/
│   ├── CLAUDE.md
│   └── MERGE_GUIDE.md
├── .claude/                        ← (ถ้ามีอยู่แล้ว) ของเดิมของ projectx เอง
├── orchestrator/                   ← (ถ้ามีอยู่แล้ว) ของเดิมของ projectx เอง
├── CLAUDE.md                       ← (ถ้ามีอยู่แล้ว) ของเดิมของ projectx เอง
└── ...ไฟล์อื่นของ projectx
```

ขั้นตอน — รันจาก root ของ `AgentClaude`:

```bash
mkdir -p <path-to-projectx>/software-team-agents
cp -r .claude <path-to-projectx>/software-team-agents/.claude
cp -r orchestrator <path-to-projectx>/software-team-agents/orchestrator
rm -rf <path-to-projectx>/software-team-agents/orchestrator/node_modules <path-to-projectx>/software-team-agents/orchestrator/dist
cp CLAUDE.md <path-to-projectx>/software-team-agents/CLAUDE.md
cp MERGE_GUIDE.md <path-to-projectx>/software-team-agents/MERGE_GUIDE.md
```

จากนั้น `cd <path-to-projectx>` (เข้าไปที่ root ของ `projectx`) แล้วบอก AI แค่ **"อ่าน `software-team-agents/MERGE_GUIDE.md` แล้ว merge pipeline เข้ากับโปรเจกต์นี้"** — ไม่ต้องบอกอะไรเพิ่ม ไม่ต้องชี้ path อื่น เพราะไฟล์เดียวที่ต้องอ่านคือ `MERGE_GUIDE.md` ตัวมันเองรู้อยู่แล้วว่า source คือ `software-team-agents/` ที่มันถูกวางอยู่ข้างใน และ target คือ root ของ `projectx`

AI จะ inventory ของเดิมใน `projectx` ก่อน (ถ้ายังไม่มี `.claude`/`CLAUDE.md` เลยก็แค่คัดลอกยกชุด ถ้ามีอยู่แล้วก็ merge แบบ additive ทีละไฟล์ตามตารางในไฟล์นั้น) — ของเดิมไม่หาย ไม่มีการ `git` ใดๆ ระหว่างทาง (กติกาเดิม §5 ยังคุมอยู่) ตรวจผลตาม checklist ท้ายไฟล์ก่อนใช้งานจริง อย่าลืมเช็ค [Stack ที่ใช้](#stack-ที่ใช้) ว่าตรงกับ `projectx` ไหม ถ้าไม่ตรงต้องแก้ `frontend-engineer.md`/`backend-engineer.md` ก่อนใช้งานจริง (ถ้า `projectx` แยก repo frontend/backend ออกจากกัน ไฟล์ `MERGE_GUIDE.md` จะถามก่อนว่าเป็นฝั่งไหนแล้วแก้แค่ไฟล์ที่เกี่ยวข้อง)

เสร็จแล้วลบ `software-team-agents/` (ทั้ง `.claude/`, `orchestrator/`, `CLAUDE.md`, `MERGE_GUIDE.md` ข้างใน) ออกจาก `projectx` ได้เลย — เป็นแค่ staging ใช้ครั้งเดียวตอน merge ไม่ใช่ส่วนหนึ่งของ pipeline ที่ต้องอยู่ถาวร

## โครงสร้างไฟล์

```
_docs/
├── status.md                    ← ดัชนีรวม: มี module อะไรบ้าง ไปถึงไหนแล้ว ใครควรทำต่อ
├── status-archive.md            ← (สร้างเมื่อจำเป็น) เนื้อหา status.md ที่ตกยุคแล้ว ย้ายมาทั้งดุ้น
└── module/
    └── sales-crm/
        ├── requirement.md       ← business-analyst
        ├── design.md            ← system-analyst
        ├── design-archive.md    ← (สร้างเมื่อจำเป็น) บันทึกถาม-ตอบของรอบ amend ที่ปิดแล้ว ย้ายออกจากส่วนที่ต้องอ่านทุกรอบของ design.md
        ├── plan.md               ← project-manager  (ติ๊ก checkbox + เพิ่มธง security: qa-engineer)
        ├── review.md            ← qa-engineer  (issue ที่ยังเปิด + รอบปัจจุบัน + งานที่ยังไม่ถูกรันจริง)
        ├── review/
        │   └── phase-N.md       ← qa-engineer  (ประวัติรอบที่ปิดแล้ว — เปิดอ่านเฉพาะเมื่อต้องการ)
        ├── security.md          ← security     (finding ที่ยังไม่ปิด รวมทุกรอบ + รอบปัจจุบัน)
        └── deploy.md            ← devops

.claude/
├── shared/
│   ├── conventions.md            ← กติกาที่ agent ทุกตัวใช้ร่วมกัน
│   └── multi-module-schema-scoping.md ← ขั้นตอนเทียบ schema.prisma กับ design.md เมื่อมีมากกว่า 1 module (อ่านเฉพาะตอนจำเป็น)
├── agents/*.md                  ← agent ทั้ง 9 ตัว
├── hooks/
│   ├── block-git.js              ← PreToolUse hook ที่บังคับกติกา "ห้ามใช้ git" จริง
│   ├── block-outside-repo.js     ← PreToolUse hook ที่บังคับ "ห้ามเขียนไฟล์นอก repo" จริง
│   ├── block-doc-rewrite.js      ← PreToolUse hook ที่บังคับให้ใช้ Edit (ไม่ใช่ Write) กับเอกสารเดิม
│   └── require-green-before-stop.js ← Stop hook: engineer ส่งงานต่อไม่ได้ถ้า typecheck/lint แดง
├── scripts/
│   ├── check-schema-contract.js  ← qa-engineer รัน: เทียบ schema.prisma กับ design.md ทุก module
│   └── check-status-sync.js      ← รันก่อนเชื่อ status.md: เทียบกับ checkbox จริงใน plan.md ทุก module
├── tests/
│   └── run.js                    ← self-test ของ hook/script ทั้งหมด (70 เคส ไม่ต้องติดตั้งอะไรเพิ่ม)
└── settings.json                ← ที่ต่อ hook ทั้งสี่ตัวเข้ากับ session (commit ไว้ ใช้ร่วมกันทั้ง repo)

contracts/                       ← contract ของ agent ทั้ง 9 ตัวแบบเครื่องอ่านได้ (`<agent>.yaml`) — input/output/permission/constraint
orchestrator/                    ← แพ็กเกจ Node/TS แยกต่างหาก: รันโหมด autonomous ให้จริงแทนคุณ (ดูหัวข้อด้านล่าง)
├── src/
│   ├── agents/claudeCliExecutor.ts  ← เรียก `claude -p --agent <role>` จริง ต่อกับ `.claude/agents/<role>.md`
│   ├── agents/moduleDocs.ts         ← อ่าน review.md/security.md จริงกลับมาเป็นหลักฐานให้ gate
│   ├── orchestrator/orchestrator.ts ← state machine + gate + retry ที่คุม pipeline stage ไหนรันต่อ (เขียน state ลง store ทุก transition)
│   ├── orchestrator/taskRegistry.ts ← task หลายตัว + dependency: task ที่ยังรอตัวอื่นอยู่ เปิดรันไม่ได้
│   ├── orchestrator/failure.ts      ← structured failure → orchestrator เป็นคนตัดสินว่า route กลับไปหาใคร
│   ├── store/sqliteStore.ts         ← state จริงใน `.workflow/state.db` (SQLite ไฟล์เดียว ไม่มี server)
│   ├── store/stateView.ts           ← generate `.workflow/state.yaml` ให้คนอ่าน (view อย่างเดียว เขียนทับทุกครั้ง)
│   ├── store/stateSchema.ts         ← โหลด JSON Schema + ajv, บังคับ validate ก่อนเขียน state.yaml
│   └── cli.ts                       ← `npm run orchestrate` entry point (`--resume`, `--list`, `--depends-on`)
├── schemas/state-view.schema.json ← contract ของ `.workflow/state.yaml` (JSON Schema draft-07)
├── schemas/agent-contract.schema.json ← contract ของ `contracts/<agent>.yaml`
│   (`src/agents/agentContract.ts` โหลด/validate และเทียบกับ registry ที่โค้ดใช้จริง)
└── package.json
```

ไม่มี *เอกสาร* ตัวไหนถูกเขียนที่ root ของ repo — แต่ละ module มีโฟลเดอร์ของตัวเองใต้ `_docs/module/` เพื่อไม่ให้ฟีเจอร์ที่ไม่เกี่ยวกันมาทับประวัติของกันและกัน (ส่วนไฟล์โปรเจกต์ที่ตามธรรมเนียมต้องอยู่ที่ root เป็นคนละเรื่อง — `setup` เขียน `package.json`, `.env`, `.env.example`, `.gitignore` ที่นั่น และ `devops` เขียนไฟล์ infra)

คำว่า "module" ถูกใช้กับสองอย่างที่ไม่เท่ากัน และเลือกผิดแล้วเสียหายคนละทาง: **module folder** คือหน่วยส่งมอบที่มีเอกสารครบชุดและเลข phase ของตัวเอง (มีแค่ `business-analyst` ที่สร้างได้) ส่วน **Modules** ใต้ `design.md` คือการจัดกลุ่มฟีเจอร์ภายในหน่วยส่งมอบเดียวกัน เกณฑ์ตัดสินคือ *งานนั้นมีบทสนทนาเชิงธุรกิจของตัวเองไหม* — ถ้าเป็นโปรดักต์เดิมที่ค่อยๆ สร้างเพิ่ม ก็คือ folder เดียวที่มีหลาย Module ข้างใน ไม่ว่ามันจะใหญ่แค่ไหน การแตก folder ไม่ใช่วิธีจัดการขนาดงาน

## กติกาที่ยึดร่วมกันทุก agent

เนื้อหาเต็มและเหตุผลอยู่ใน `.claude/shared/conventions.md`:

- **`backend-engineer` ต้องทำก่อน `frontend-engineer` เสมอในแต่ละ phase ห้ามรันพร้อมกัน** frontend ต้องอ่าน type/API call จากสิ่งที่ backend สร้างจริง ไม่ใช่เดาจาก `design.md` เฉยๆ — รันพร้อมกันแล้ว frontend ต้องเดา contract เอง ซึ่งเคยทำให้เกิด response-shape ไม่ตรงกันจริงมาแล้วจนต้องเสียรอบแก้เพิ่ม ข้อยกเว้นคือ task ในรอบเดียวกันที่ไม่มี API contract ร่วมกันเลย รันสลับลำดับได้ (`conventions.md` §6a)
- **ไม่มี agent ไหนเชื่อมไปตัวถัดไปเอง — เพราะไม่มีตัวไหนถือ Agent tool** ทุกรอบจบด้วยการบอกว่าอะไรพร้อมแล้วและใครควรหยิบไปทำต่อ ค่าเริ่มต้นคือหยุดรอคุณสั่ง ส่วนโหมด autonomous (คุณสั่งเป็นครั้งๆ ไป) ให้ session เดินหน้าต่อเองได้ แต่ 5 จุด (ดูหัวข้อ [โหมด autonomous](#โหมด-autonomous--ทิ้งรันข้ามคืนได้) ด้านบน) หยุดรอคนเสมอไม่ว่าโหมดไหน
- **ห้ามใช้ git เด็ดขาด** ไม่มี agent ไหนรัน `git init`/`add`/`commit`/`push` หรือแตะ `.git` — version control เป็นเรื่องของคุณคนเดียว และข้อนี้ไม่ได้ฝากไว้กับความเชื่อฟังของ agent — มันถูกบังคับด้วย hook จริง ดูหัวข้อ [กติกาที่บังคับด้วยโค้ด](#กติกาที่บังคับด้วยโค้ด-ไม่ใช่-prompt)
- **ไม่มี agent ไหนเขียนไฟล์นอก repo นี้** ทุกการเขียนต้อง resolve อยู่ใต้ root ของโปรเจกต์เสมอ — `_docs/module/<name>/`, โค้ดแอป, `.claude/...` เท่านั้น บังคับด้วย hook อีกตัวเช่นกัน ดูหัวข้อเดียวกัน
- **Data Model ใน `design.md` คือสัญญา** schema ถูกยืนยันกับคุณครั้งเดียว แล้วถูกนำไปใช้ตรงตัวเป๊ะๆ — ไม่มี agent ไหนคิดฟิลด์เองหรือเปลี่ยนชื่อเอง ถ้ามีช่องว่างต้องส่งกลับ `system-analyst` ห้ามด้นสดแก้เอง หลัง `setup` เขียน `schema.prisma` ตัวจริงแล้ว engineer จะทำงานจากไฟล์นั้น (มันคือสำเนาใช้งานของสัญญา และเป็นไฟล์ที่ query ต้องตรงด้วยจริงๆ) โดยมี `qa-engineer` เป็นตัวเดียวที่อ่านทั้งสองไฟล์แล้วเทียบทีละฟิลด์ให้เท่ากัน — ถ้าไม่ตรงกันเมื่อไหร่ `design.md` ชนะ แปลว่าโค้ดผิด และมีแค่ `setup` (ตอน scaffold) กับ `backend-engineer` (ตอนตามแก้ให้ตรงกับ design ที่ยืนยันแล้ว) เท่านั้นที่เขียน `schema.prisma` ได้ ถ้ามีมากกว่า 1 module folder **การเทียบต้องแยกตาม module** เพราะ `schema.prisma` มีไฟล์เดียวทั้งโปรเจกต์ แต่ `design.md` มีต่อ module — ขั้นตอนเต็มอยู่ใน `.claude/shared/multi-module-schema-scoping.md` (อ่านเฉพาะตอนมีมากกว่า 1 module เท่านั้น): ทุก model ใน design ของ module นั้นต้องมีใน schema และตรงเป๊ะเสมอ ส่วน model ที่มีใน schema แต่ไม่มีใน design ของ module นี้ ต้อง `Grep` หาก่อนว่า module อื่นเป็นเจ้าของหรือเปล่า — มีแต่ model ที่ไม่มี module ไหนประกาศเลยถึงจะนับว่าเป็นการด้นสดแก้ schema โปรเจกต์ที่มี module เดียวไม่ต้องอ่านไฟล์นี้เลย

- **engineer ไม่มีสิทธิ์ตัดสินกฎ — ทำตามที่เขียนไว้ หรือหยุดแล้วตีกลับ** `frontend-engineer`/`backend-engineer` ไม่มี `AskUserQuestion` โดยตั้งใจ เพราะกฎที่ตกลงกันในแชทกับ engineer คือกฎที่ไม่เคยลงไปอยู่ใน `requirement.md`/`design.md` แปลว่า phase ถัดไปและ session ถัดไปไม่มีทางเห็นมัน logic ที่ไม่ชัดจึงต้องตีกลับ `system-analyst` (ซึ่งส่งต่อ `business-analyst` ถ้ากลายเป็นคำถามเชิงธุรกิจ) และฝั่ง `system-analyst` มีเกณฑ์กำกับว่า contract section ต้องสมบูรณ์พอที่ engineer จะไม่ต้องตัดสินอะไรเลย — เคสไหนไม่ครอบคลุมต้องเขียนลง contract หรือระบุใน Open Questions ว่าอยู่นอก scope การไม่พูดถึงเลยไม่นับเป็นทั้งสองอย่าง
- **มีแค่ `security` เท่านั้นที่ปิด finding ของตัวเองได้** แต่ละ finding มีสถานะกำกับ (🔵 Open · 🟣 แก้แล้วรอตรวจซ้ำ · ✅ ตรวจซ้ำแล้ว · ⚪ ยอมรับความเสี่ยง) การที่ engineer แก้เสร็จเลื่อนได้แค่ถึง 🟣 เท่านั้น เพราะการตรวจของ `qa-engineer` เป็นการตรวจเชิงฟังก์ชันซึ่งมันประกาศเองว่าไม่ครอบคลุมด้านความปลอดภัย — `security` ต้องกลับมาตรวจซ้ำเองถึงจะปิดได้ และ `devops` บล็อกทั้ง 🔵 และ 🟣 เท่ากัน
- **ทำงานจากไฟล์จริง ไม่ใช่จากความจำ** สิ่งที่จำมาจากรอบก่อนหรือจากบทสรุปเป็นแค่สมมติฐาน ต้องเปิดไฟล์/โค้ดจริงยืนยันก่อนเสมอ ถ้าขัดกัน ไฟล์ชนะและความเข้าใจเดิมต้องถูกแก้ทันที — pipeline นี้มีความจำของตัวเองอยู่ในไฟล์แล้ว (`status.md`, `plan.md`, `design.md`, `review.md` พร้อม Change Log) การจำเองจึงเป็นแค่สำเนาที่แย่กว่าของสิ่งที่ track ไว้อย่างมีวินัยอยู่แล้ว (`conventions.md` §12)
- **มีแค่ `qa-engineer` เท่านั้นที่ติ๊กงานว่าเสร็จ** มันติ๊ก `[x]` ใน `plan.md` หลังตรวจโค้ดจริงแล้วเท่านั้น — ไม่มีการปั๊มตราให้ผ่านลอยๆ
- **แก้ไขเอกสารเดิม ไม่ใช่สร้างใหม่ทับ** เอกสารที่มีอยู่แล้วถูกอัปเดตทีละส่วนพร้อมลง Change Log ที่มีวันที่กำกับ ไม่มีการเขียนทับทั้งไฟล์ — ข้อนี้ก็ถูกบังคับด้วย hook จริงเช่นกัน (`block-doc-rewrite.js`) ดูหัวข้อ [กติกาที่บังคับด้วยโค้ด](#กติกาที่บังคับด้วยโค้ด-ไม่ใช่-prompt)
- **engineer ส่งงานต่อไม่ได้ถ้าโค้ดยังแดง** `typecheck`/`lint` ต้องรันผ่านก่อนที่ `frontend-engineer`/`backend-engineer` จะจบงานได้ — บังคับด้วย hook (`require-green-before-stop.js`) ไม่ใช่แค่ขอความร่วมมือ ข้อผิดพลาดที่จับได้ตรงนี้แก้ในบริบทเดิมได้เลย ส่วนข้อผิดพลาดแบบเดียวกันที่ไปโผล่ตอน `qa-engineer` ตรวจจะแพงกว่าเพราะต้องเปิด agent ใหม่สองรอบ
- **hook/script ทุกตัวมีการทดสอบตัวเอง** รัน `node .claude/tests/run.js` ทุกครั้งที่แก้ไฟล์ใต้ `.claude/hooks/` หรือ `.claude/scripts/` — hook ที่พิมพ์ผิดจน syntax error จะ "fail open" (ยังต่ออยู่ใน `settings.json` แต่ไม่บล็อกอะไรเลย) ซึ่งเคยเกิดขึ้นจริงมาแล้ว หน้าจอเขียวของ test suite นี้คือสิ่งเดียวที่ยืนยันว่า guard ทั้งหมดยังทำงานตามที่อ้าง
- **`review.md` ต้องเล็กอยู่เสมอ** มันเก็บแค่ `Open Issues — all phases`, รอบตรวจปัจจุบัน และ `Unverified Behaviour` ของ phase ที่ยังไม่ deploy รอบที่ปิดแล้วถูก `qa-engineer` ย้าย (ยกมาทั้งดุ้น ไม่ย่อ ไม่ตัด) ไปไว้ใน `review/phase-N.md` — เพราะทุกรอบของ engineer/`security`/`devops` อ่านไฟล์นี้เต็มๆ รายละเอียดของ phase ที่ปิดไปแล้วจึงเป็นต้นทุนที่ทั้ง pipeline ต้องจ่ายซ้ำโดยไม่ได้อะไรกลับมา ไฟล์ใน `review/` ไม่ถูกเปิดอ่านตอนเริ่มงานปกติ ข้อยกเว้นคือของสองอย่างที่ "อายุยืนกว่ารอบของตัวเอง" — item ที่ยังเปิดค้าง และ `Unverified Behaviour` — เพราะมีด่านถัดไป (engineer, `devops`) ที่ต้องอ่านมันหลังจากรอบที่สร้างมันหมดอายุไปแล้ว การ archive ของพวกนี้ตามกำหนดจะดูเรียบร้อยดีแต่เท่ากับปลดล็อก gate เงียบๆ
- **`status.md` ก็ต้องเล็กอยู่เสมอเหมือนกัน แต่หนักกว่า `review.md`** เพราะ `review.md` เป็นต้นทุนต่อการอ่านของ module เดียว ส่วน `status.md` ถูกอ่านเป็นด่านแรกของ*ทุก* module ทุกรอบ — แต่ละ module เก็บแค่ `Docs:` หนึ่งบรรทัด, ตารางรายเฟสสัญลักษณ์ปัจจุบัน, `**Now**:` และ `**Blocked on**:` เท่านั้น ไม่ใช่บันทึกไล่รอบว่าทำอะไรมาบ้าง — ส่วนที่เกินนั้น (เหตุผลของการตัดสินใจ, กลไกบั๊กที่แก้แล้ว, ผลตรวจรอบเก่า) อยู่ในเอกสารของ module นั้นอยู่แล้วซึ่งมีอำนาจกว่า **เงื่อนไขในการย้ายไม่ใช่ตัวเลขบรรทัดที่นับได้ แต่เป็นเชิงคุณภาพ**: ทันทีที่ section ของ module ไหนมีอะไรเกินกว่า 4 อย่างข้างต้น ก็ถือว่าบวมเกินแล้ว และไม่มี agent ตัวไหนถูกมอบหมายให้เช็คเรื่องนี้ตามรอบ — **ใครสังเกตเห็นก่อน**ระหว่างอ่าน `status.md` ในรอบนั้น เป็นคนย้ายเนื้อหาที่ตกยุคไปไว้ที่ `status-archive.md` แบบยกมาทั้งดุ้นเหมือนที่ `qa-engineer` archive `review.md` แล้วเหลือ pointer บรรทัดเดียวไว้แทน ถ้าไม่ย้าย ทุก module อื่นที่อ่าน `status.md` ต้องจ่ายต้นทุนนั้นไปด้วย ไม่ใช่แค่ module ที่บวม
- **อ่านเฉพาะส่วนที่ต้องใช้ ไม่ใช่ทั้งไฟล์** agent ทุกตัวเริ่มจาก context เปล่า การอ่านทั้งไฟล์จึงเป็นต้นทุนที่จ่ายใหม่ทุกครั้ง — `plan.md` อ่าน Plan Summary + phase ของตัวเอง + Sequencing Notes + Open Questions, `design.md` อ่าน Feature-by-Feature Feasibility, Risks และ Open Questions เสมอ (สามส่วนนี้เก็บการตัดสินใจที่ยืนยันแล้วและรายการ "ห้ามทำ") บวกส่วนสัญญาของ phase ตัวเองกับ module ของตัวเอง วิธีทำอยู่ใน `conventions.md` §10 ข้อยกเว้นมีโดยตั้งใจ: `project-manager` เป็นเจ้าของ `plan.md`, `system-analyst` เป็นเจ้าของ `design.md`, และ `qa-engineer` อ่าน Data Model เต็มทุกรอบ เพราะสามส่วนนี้ของ `design.md` เป็น mandatory read ทุกรอบเหมือนกัน `system-analyst` จึงต้องเล็กเก็บมันไว้แบบเดียวกัน แต่เงื่อนไขที่นี่เป็นเหตุการณ์ที่ชัดเจน ไม่ใช่การเช็คขนาด: **ทันทีที่รอบ amend ไหนปิดคำถามหนึ่งได้จริง** (กติกาที่ตอบคำถามนั้นถูกย้ายไปอยู่ใน Contract section/Data Model/`## Modules` แล้ว) บันทึกถาม-ตอบของรอบนั้นจะหมดหน้าที่ในฐานะ mandatory read ทันที และต้องถูกย้ายทั้งดุ้นไปไว้ที่ `design-archive.md` — งานนี้ผูกกับ `system-analyst` โดยเฉพาะ (ต่างจาก `status.md` ที่เป็น "ใครเห็นก่อน") และต้องทำ**เป็นส่วนหนึ่งของ amend รอบที่ปิดคำถามนั้นเลย** ไม่ใช่งาน cleanup แยกไปทำทีหลัง
- **ถ้าเอกสารบวมมาก่อนแล้วโดยไม่เคยถูก archive มาเลยสักรอบ** (ไม่ใช่กรณีที่ archive ทีละรอบแล้วมีอะไรหลุดไปนิดหน่อย) — ไม่มีกลไกไหนแบ่งย้อนหลังให้อัตโนมัติ agent ตัวไหนก็ตามที่รอบของตัวเองต้องจ่ายต้นทุนอ่านของบวมนี้ ทำ**รอบ catch-up ครั้งเดียว**แทนที่จะปล่อยไว้: เปิดไฟล์เต็มครั้งเดียว, ตัดสินว่าส่วนไหนปิดแล้วจริงตามกติกาของไฟล์นั้น (`review.md` = รอบที่ถูกแทนที่แล้วหรือ phase deploy ไปแล้ว, `design.md` = คำถามที่กติกาย้ายไป Contract section แล้ว, `status.md` = อะไรเกิน 4 หัวข้อ), ย้ายส่วนที่ปิดแล้วไปไฟล์ archive แบบยกทั้งดุ้นไม่สรุปไม่ตัด, เหลือ pointer บรรทัดเดียวไว้แทน หลังจากนั้นกติกาต่อรอบปกติ (agent เจ้าของไฟล์ทำต่อเนื่องเอง) ก็เพียงพอแล้ว ไม่ต้อง catch-up ซ้ำอีก — `conventions.md` §4 หัวข้อ "Catching up a document that grew bloated before it was ever archived" มีขั้นตอนเต็ม
- **ไม่มีอะไรถูก deploy โดยไม่ผ่านการตรวจ** `devops` จะปฏิเสธ deploy phase ที่ QA ยังไม่ยอมรับ, phase ที่รอบตรวจล่าสุดเป็นแบบ TARGETED, phase ที่ติดธง `🔒 Security gate` แต่ `security` ยังไม่ได้ตรวจ, หรือ phase ที่ยังมีช่องโหว่ระดับ Critical/Important ค้างอยู่ (อ่านจาก `Open Findings — all rounds` ซึ่งรวมทุกรอบ ไม่ใช่แค่รอบล่าสุด) เว้นแต่คุณจะสั่ง override เอง
- **phase ที่อ่อนไหวถูกติดธงเป็นลายลักษณ์อักษร ไม่ใช่ให้ใครนึกเอาเอง** `project-manager` ติด `🔒 Security gate` ที่หัว phase ตั้งแต่ตอนวางแผน ถ้ามันแตะ auth, ข้อมูลส่วนบุคคล, การเงิน, upload หรือ input จากภายนอก — `qa-engineer` เพิ่มธงที่ PM มองไม่เห็นตอนวางแผนได้ และ `devops` ใช้ธงนี้เป็น gate ไม่มีใครถอดธงออกได้นอกจากคุณ
- **แก้ไม่ผ่านสองรอบให้ส่งกลับหาคุณ ไม่ใช่วนส่งต่อ** หลัง re-check รอบที่สองของ item เดิมยังไม่ผ่าน `qa-engineer` จะหยุดวนแล้วรายงานคุณแทน — item ที่รอดจากการแก้สองรอบมักแปลว่า route ผิดตั้งแต่ต้น (เป็นคำถามเชิง design หรือ business) ไม่ใช่ implement ห่วย
- **ตัวเลขที่ไม่มีแหล่งที่มา ต้องถูกเขียนว่าเป็นสมมติฐาน** `business-analyst` ไม่มีเครื่องมือค้นเว็บโดยตั้งใจ ข้อมูลภายนอก (ตัวเลขตลาด กฎหมาย มาตรฐานอุตสาหกรรม) ต้องมาจากคุณพร้อมแหล่งที่มา แล้วถูกบันทึกในตาราง `## References` ของ `requirement.md` — ถ้าไม่มีใครมีแหล่งอ้างอิง มันจะถูกเขียนกำกับว่า `(สมมติฐาน — ยังไม่ยืนยัน)` และบอกให้คุณไปหาข้อมูลมาก่อน ด่านถัดไปก็ผูกกับเครื่องหมายนี้ด้วย: `system-analyst` ต้องเคลียร์กับคุณก่อน ถ้าตัวเลขที่ยังไม่ยืนยันจะไปเปลี่ยนคำตัดสินเรื่องความเป็นไปได้หรือ schema — ไม่ใช่หยิบไปใช้เงียบๆ แล้วปล่อยให้มันแข็งตัวกลายเป็น requirement ที่ทุกด่านถัดไปเชื่อว่ายืนยันแล้ว

## กติกาที่บังคับด้วยโค้ด ไม่ใช่ prompt

กติกาที่เหลือทั้งหมดในหน้านี้อยู่ในไฟล์ prompt ของ agent ซึ่งแปลว่ามันมีผลเท่าที่ agent จำได้และเชื่อฟัง — สำหรับเรื่องที่พลาดแล้วแก้คืนยาก อย่าง version control ของคุณ, ไฟล์นอกโปรเจกต์, การเขียนทับเอกสารเดิม, หรือการส่งงานที่โค้ดยังแดง แค่นั้นไม่พอ ตอนนี้มี `PreToolUse` hook สามตัวและ `Stop`/`SubagentStop` hook อีกหนึ่งตัวต่อไว้ใน `.claude/settings.json` ตรวจทุก tool call / ทุกครั้งที่ agent จะจบงานก่อนปล่อยให้ผ่านจริง

### `block-git.js` — ห้ามใช้ git

ตรวจ `Bash`/`Write`/`Edit`:

| | |
|---|---|
| **บล็อก** | คำสั่ง git ที่เปลี่ยนสถานะทั้งหมด (`init`, `add`, `commit`, `push`, `checkout`, `reset`, `rebase`, `merge`, `branch`, `tag`, `stash`, `clean`, `config` แบบเซ็ตค่า …) และการอ่าน/เขียน `.git/` ตรงๆ — รวมถึงเวลาซ่อนอยู่หลัง `&&`, `\|`, `sudo`, หรือ path เต็มอย่าง `"C:\Program Files\Git\bin\git.exe"` |
| **ปล่อยผ่าน** | คำสั่งอ่านอย่างเดียว (`status`, `log`, `diff`, `show`, `config --get`, `stash list`, `remote -v`) และการเขียนไฟล์ที่แค่เกี่ยวข้องกับ git อย่าง `.gitignore` หรือ `.github/workflows/*` ซึ่ง `setup`/`devops` ต้องเขียนอยู่แล้ว |

false positive คลาสเดียวที่เจอ: คำสั่งที่ *เนื้อหาข้อความ* มี `.git/` อยู่ (เช่น heredoc ที่เขียนสคริปต์ซึ่งพูดถึง git) จะโดนบล็อกไปด้วย ทางออกคือให้ agent ใช้ Write tool เขียนไฟล์แทน เพราะฝั่ง Write เช็คแค่ปลายทางไม่ได้เช็คเนื้อหา

### `block-outside-repo.js` — ห้ามเขียนไฟล์นอก repo

ตรวจ `Write`/`Edit`/`MultiEdit`/`NotebookEdit` — resolve path ปลายทางเทียบกับ root ของโปรเจกต์ (`$CLAUDE_PROJECT_DIR` หรือ cwd ตอน hook รัน) ถ้าหลุดออกนอก root ก็บล็อก ยกเว้น path ใต้โฟลเดอร์ scratchpad ของ Claude Code เอง (`...\AppData\Local\Temp\claude\...`) เพราะนั่นคือกลไกของตัว harness ไม่ใช่ agent หลุดขอบเขต

**ไม่ครอบคลุม `Bash`** โดยตั้งใจ — การไล่ตรวจทุก path ที่คำสั่ง shell อาจแตะ (temp file, npm cache, redirect) ให้ถูกต้องแทบเป็นไปไม่ได้ และการบล็อกผิดจะเสียหายมากกว่าการปล่อยผ่านบางเคส

### `block-doc-rewrite.js` — แก้เอกสารเดิมด้วย Edit เท่านั้น ห้าม Write ทับ

ตรวจ `Write` — ถ้าปลายทางเป็นหนึ่งในเอกสาร 6 ไฟล์ต่อ module (`requirement.md`, `design.md`, `plan.md`, `review.md`, `security.md`, `deploy.md`) **และไฟล์นั้นมีอยู่แล้ว** จะบล็อก `Write` ทับทันที — ต้องใช้ `Edit`/`MultiEdit` แก้เฉพาะส่วนที่เปลี่ยนแทน ถ้าไฟล์ยังไม่มี (สร้างครั้งแรก) `Write` ยังใช้ได้ตามปกติ hook นี้แยกแยะ "agent ไหนเรียก" ไม่ได้ — เช็คแค่ "ไฟล์นี้มีอยู่แล้วหรือยัง" ก็เพียงพอให้พฤติกรรมถูกต้องเองโดยไม่ต้องรู้ว่าใครเรียก

### `require-green-before-stop.js` — engineer ส่งงานต่อไม่ได้ถ้าโค้ดยังแดง

Wired เป็น `Stop`/`SubagentStop` hook (ไม่ใช่ `PreToolUse`) — รันตอน agent กำลังจะจบงาน ถ้ารอบนั้นแก้โค้ดแอปจริง จะรัน `typecheck`/`lint` (บวก script ตรวจ drift สองตัวด้านล่าง) ถ้าแดงจะบล็อกไม่ให้จบ บังคับให้แก้ในบริบทเดิมอย่างน้อยหนึ่งรอบก่อน — รอบถัดไปปล่อยผ่านเสมอ ไม่มีวันขังใครไว้ไม่ให้จบงาน งานที่ไม่แตะโค้ดแอป (เช่น `business-analyst`/`system-analyst`/`project-manager` หรือ `qa-engineer` ที่เขียนแค่ `review.md`) ไม่โดน hook นี้เลย

### `.claude/scripts/` — เครื่องมือเสริม ไม่ใช่ hook ไม่บล็อกอะไร

- **`check-schema-contract.js`** — `qa-engineer` รันผ่าน Bash เพื่อเทียบ `schema.prisma` กับ Data Model ใน `design.md` ของทุก module แบบ field-by-field พร้อมเช็คว่า model ที่ไม่มีใครประกาศเป็นการด้นสด (§7 ใน conventions.md)
- **`check-status-sync.js`** — เทียบ `status.md` กับจำนวน checkbox จริงใน `plan.md` ของทุก module หา `implemented`/`verified` ที่เขียนไว้ผิดจากของจริง

ทั้งสองเป็น regex-based parser ไม่ใช่ Prisma/Markdown parser จริง — ใช้เป็นตัวช่วยตรวจก่อน ไม่ใช่ตัวแทนการอ่านโค้ด/เอกสารจริง

### `.claude/tests/run.js` — self-test ของ hook/script ทั้งหมด

รัน `node .claude/tests/run.js` ทุกครั้งที่แก้ไฟล์ใต้ `.claude/hooks/` หรือ `.claude/scripts/` — 70 เคส ไม่มี dependency ต้องติดตั้งเพิ่ม เหตุผลที่ต้องรันจริงจัง: hook ที่ syntax error จะ exit 1 ซึ่ง `PreToolUse` มองว่าไม่ใช่การบล็อก (บล็อกต้อง exit 2) แปลว่า hook ที่พิมพ์ผิดจะ **fail open** — ยังต่ออยู่ใน `settings.json`, ดูเหมือนติดตั้งแล้ว แต่ไม่บังคับอะไรเลยเงียบๆ เคยเกิดขึ้นจริงมาแล้วระหว่างพัฒนา

### สิ่งที่ควรรู้ก่อนเอาไปใช้ (มีผลกับ hook ทั้งสี่ตัว)

- **ต้องมี Node** ในเครื่อง (โปรเจกต์นี้เป็น stack Node อยู่แล้ว) แต่ละ `PreToolUse` hook กินเวลา ~35ms ต่อ tool call ซึ่ง ~33ms ในนั้นคือค่าสตาร์ท process ของ Node เอง ไม่ใช่ตัว logic — สาม `PreToolUse` hook รันต่อกันจึงคูณสามคร่าวๆ
- **มีผลกับทุก session ใน repo นี้ รวม session หลักและคำสั่ง `!git` ที่คุณพิมพ์เอง** ถ้าคุณต้อง commit หรือเขียนไฟล์นอกโปรเจกต์ ให้ทำจาก terminal ปกตินอก Claude Code
- **ปิดได้ทีละตัวหรือทั้งหมด** ด้วยการลบ entry ที่ต้องการออกจาก `hooks.PreToolUse`/`hooks.Stop`/`hooks.SubagentStop` ใน `.claude/settings.json` — แต่ถ้าปิด กติกาที่เกี่ยวข้องจะกลับไปเป็นแค่ข้อความใน prompt เหมือนเดิม

## สองโหมดของการตรวจ — FULL กับ TARGETED

`qa-engineer` ตรวจได้สองแบบ และต้องบอกทุกครั้งว่ารอบนี้ใช้แบบไหน:

- **FULL** — ตรวจทุก task ใน phase ตั้งแต่ต้น เป็นค่าเริ่มต้น และเป็นแบบเดียวที่ปิด phase ได้ ใช้เมื่อตรวจ phase นั้นครั้งแรก เมื่อคุณสั่ง เมื่อบอกไม่ได้ว่าอะไรเปลี่ยนไปบ้างตั้งแต่รอบก่อน หรือเมื่อ phase กำลังจะถูกส่งให้ `devops` (ไม่รวม `security` — มันตรวจตัวโค้ดเองไม่ได้อาศัยความครอบคลุมของ QA) จบรอบด้วยการบันทึก **file manifest** (ไฟล์ที่ตรวจ + ขนาด + จำนวนบรรทัด) เพื่อให้รอบถัดไปรู้ได้เองว่าอะไรขยับ โดยไม่ต้องใช้ git และไม่ต้องเชื่อคำบอกเล่าของใคร
- **TARGETED** — ตรวจซ้ำเฉพาะจุดหลัง engineer แก้ item ที่เคยถูก flag ใช้ได้ต่อเมื่อรอบก่อนของ phase นั้นเป็น FULL, งานที่ทำหลังจากนั้นจำกัดอยู่แค่การแก้ที่ระบุไว้ และมี manifest จากรอบนั้น มีอยู่เพราะการตรวจซ้ำสองบรรทัดไม่ควรแพงเท่าตรวจยี่สิบ task — การตรวจซ้ำที่แพงเกินไปคือการตรวจซ้ำที่เงียบๆ แล้วไม่เกิดขึ้นจริง แต่ต้องเข้าใจตรงกันว่ามันประหยัดน้อยกว่าที่ฟังดู: เพราะทุก phase ที่จะ ship ต้องจบด้วย FULL อยู่ดี TARGETED จึงไม่ใช่วิธีหลบรอบเต็ม แต่เป็นวิธีทำให้ loop แก้-ตรวจซ้ำถูกลง**ระหว่างที่งานยังไม่นิ่ง** ถ้าเหลืออีกแก้เดียวจะจบ การรัน FULL เลยมักถูกกว่า

TARGETED ไม่ได้แปลว่า "ดูแค่จุดที่แก้แล้วจบ" — มันครอบคลุมทั้ง task อื่นใน phase ที่แตะไฟล์เดียวกัน, watchlist ของโค้ดที่ใช้ร่วมกัน (auth middleware, Prisma client, API client ฝั่ง frontend, layout/component กลาง), การเทียบ `schema.prisma` กับ Data Model เต็มทุกรอบ, typecheck/lint/build ทั้งโปรเจกต์ และการกวาดผิวทั้ง phase ว่า route/schema/component ยังต่อกันครบ สิ่งที่มันไม่ครอบคลุมต้องถูกเขียนบอกไว้ใน `review.md` ตรงๆ ไม่ปล่อยให้อ่านเหมือนรอบเต็ม

**phase ที่รอบล่าสุดเป็น TARGETED จะยัง deploy ไม่ได้** ต้องผ่าน FULL หนึ่งรอบก่อนเสมอ — จ่ายค่ารอบเต็มครั้งเดียวตรงนี้ แทนที่จะจ่ายทุกครั้งที่แก้ของเล็กๆ (ส่วน `security` ไม่ติด gate นี้ เพราะมันตรวจตัวโค้ดเองแยกจากการตรวจเชิงฟังก์ชัน)

## Right-sizing — ข้ามด่านได้สำหรับงานเล็ก

pipeline เต็มมีไว้สำหรับสร้างของใหม่ การรันครบทั้ง 9 ด่านเพื่อแก้ตัวหนังสือนิดเดียวคือความสิ้นเปลือง ไม่ใช่ความรอบคอบ:

| ลักษณะงาน | เริ่มที่ |
|---|---|
| แก้ข้อความ/สไตล์ หรือบั๊กที่ requirement + schema ชัดเจนอยู่แล้ว | `backend-engineer` (ถ้าแตะ API) → `frontend-engineer` → `qa-engineer` |
| เพิ่ม/แก้ฟิลด์-ตาราง-ความสัมพันธ์ | `system-analyst` (amend) → engineer → `qa-engineer` |
| เปลี่ยน business rule แต่ไม่กระทบ schema | `business-analyst` (amend) → `system-analyst` (amend) → engineer → `qa-engineer` |
| ฟีเจอร์/โมดูล/โปรเจกต์ใหม่ | `business-analyst` เริ่มเต็มสาย |

แต่การเปลี่ยน schema โดยข้าม `system-analyst` ไปเลยคือปัญหาที่ pipeline นี้ถูกสร้างมาเพื่อป้องกัน — right-sizing หมายถึงเลือกจุดเริ่มต้นให้เหมาะกับงาน ไม่ใช่ตัดขั้นตอนที่งานนั้นต้องการจริงๆ ทิ้งไป

## Stack ที่ใช้

กำหนดตายตัวไว้ใน `.claude/agents/frontend-engineer.md` / `backend-engineer.md` — agent ตัวอื่นทุกตัวอ่านจากสองไฟล์นี้แทนที่จะเก็บสำเนาไว้เอง:

- **Frontend**: Next.js (App Router) · TypeScript · Tailwind · Zustand
- **Backend**: Node + Express · PostgreSQL · Prisma · REST · JWT แบบเขียนเอง · Zod
- **Package manager**: npm
- **Tests**: opt-in — `setup` ถามครั้งเดียวว่าจะใส่ Vitest ไหม ค่าเริ่มต้นคือไม่ใส่ ส่วน `qa-engineer` รันทุก check ที่มีอยู่จริง (`typecheck`/`lint`/`build`/`test`) และต้องเขียนใน `review.md` ให้ชัดเมื่อโปรเจกต์ไม่มี automated test เพื่อไม่ให้ ✅ ถูกเข้าใจผิดว่าผ่านการทดสอบมาแล้ว

### ถ้าไม่ใส่ test จะไม่มีใครรันโค้ดเลยทั้ง pipeline

ข้อนี้ควรรู้ก่อนตอบคำถามของ `setup` เพราะมันไม่ชัดในตัวเอง: ถ้าไม่มี test framework การตรวจทั้งหมดคือการอ่านโค้ดบวก `typecheck`/`lint`/`build` และ `devops` เช็คแค่ health endpoint หลัง deploy — route ที่ typecheck ผ่าน lint ผ่าน build ผ่าน schema ตรงเป๊ะ แต่คำนวณผิด จะผ่านทุกด่าน เป็นการแลกที่สมเหตุสมผลสำหรับ prototype และเป็นการแลกที่แย่สำหรับงานที่แตะเงิน ข้อมูลการลงเวลา หรือสิทธิ์การเข้าถึง

สิ่งที่ pipeline ทำแทนคือทำให้มันมองเห็นได้ ไม่ใช่ปิดบัง: `qa-engineer` ต้องไล่ระบุเป็นข้อๆ ใน `## Unverified Behaviour — undeployed phases` ว่ากฎไหนบ้างที่มันได้แค่อ่าน ไม่เคยรัน (สูตรคำนวณ, state machine, กฎ matching, ตารางสิทธิ์) ไม่ใช่เขียนคำปฏิเสธความรับผิดชอบกว้างๆ แล้วจบ และ `devops` ต้องเอารายการนั้นมาให้คุณดู**ตอนกำลังจะ deploy** ไม่ใช่ปล่อยให้ฝังอยู่ในรอบตรวจเมื่อสัปดาห์ที่แล้ว

การเปลี่ยน stack คือการแก้ไขสองไฟล์นี้อย่างตั้งใจและยืนยันแล้ว ไม่ใช่สิ่งที่ agent ตัวไหนตัดสินใจเองได้

## Model และ effort ของแต่ละ agent

กำหนดไว้ใน frontmatter ของแต่ละไฟล์ (`model`, `effort`) ปรับให้โมเดลที่แพงกว่าไปอยู่จุดที่ความผิดพลาดส่งผลกระทบไกลที่สุด (`system-analyst`, `security`) ส่วนโมเดลที่ถูกกว่ารับงานปริมาณมากที่สุด (`frontend-engineer`, `backend-engineer`) ดูตารางเต็มพร้อมเหตุผลได้ใน `CLAUDE.md` หรือจะ override เป็นครั้งๆ ไปตอนเรียกงานก็ได้

จุดที่ควรรู้ไว้: `qa-engineer` เป็น sonnet + effort สูง ซึ่งเป็นการตัดสินใจที่มี leverage สูงสุดในตาราง เพราะเมื่อ test เป็น opt-in และส่วนใหญ่ไม่ได้ใส่ มันคือหลักประกันความถูกต้องเดียวของทั้งสายและไม่มีใครตรวจซ้ำมันอีก ถ้าวันไหนรู้สึกว่าการตรวจเริ่มหลุด นี่คือตัวแรกที่ควรอัปเป็น opus

## กลับมาดูโปรเจกต์เดิม

อ่าน `_docs/status.md` ก่อน — มันบอกว่ามี module อะไรบ้าง แต่ละตัวไปถึงไหนแล้ว agent ไหนควรทำต่อ และแต่ละ phase ผ่านการตรวจแบบไหนมา (`verified ✅ (FULL)` / `verified ⚠️ (TARGETED)`) จากนั้นเปิดเอกสารของ module นั้นตามลำดับ: `requirement.md` → `design.md` → `plan.md` → `review.md` (เริ่มที่ `Open Issues — all phases`) → `security.md` (เริ่มที่ `Open Findings — all rounds`) → `deploy.md`

`status.md` เป็นแค่ดัชนี ถ้ามันขัดกับเอกสารหรือโค้ดจริงเมื่อไหร่ เอกสารและโค้ดชนะเสมอ
