# AgentClaude

ชุด subagent สำหรับ [Claude Code](https://claude.com/claude-code) ที่จำลอง pipeline การพัฒนาซอฟต์แวร์แบบครบวงจร — ตั้งแต่ไอเดียคลุมเครือไปจนถึงโค้ดที่ตรวจสอบแล้ว ตรวจความปลอดภัยแล้ว และ deploy แล้ว — โดยแบ่งเป็นด่านส่งต่องานกันเป็นทอดๆ แทนที่จะให้ agent ตัวเดียวทำทุกอย่างพร้อมกัน

มี 9 agent แต่ละตัวรับผิดชอบงานเดียว: **business-analyst → system-analyst → project-manager → frontend-engineer / backend-engineer → qa-engineer → security → devops** บวก agent **setup** ที่ scaffold โปรเจกต์ครั้งเดียวตอนเริ่ม ไม่มี agent ตัวไหนเรียก agent ตัวถัดไปเอง — user เป็นคนตัดสินใจทุกการส่งต่องาน เพื่อไม่ให้อะไรถูกสร้าง ตรวจสอบ หรือ deploy โดยที่ user ไม่เห็น

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
business-analyst → system-analyst → project-manager → frontend-engineer / backend-engineer
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
| `qa-engineer` | ตรวจงานที่เสร็จเทียบกับ requirement/design ส่งงานที่ไม่ผ่านกลับไปจุดที่ถูกต้อง | `review.md` |
| `security` | ตรวจงานที่อ่อนไหวหาช่องโหว่ที่โจมตีได้จริง | `security.md` |
| `devops` | container, CI, migration, deploy — เฉพาะงานที่ QA ยอมรับแล้วเท่านั้น | `deploy.md` |

## เริ่มใช้งาน

1. คัดลอก `.claude/` และ `CLAUDE.md` ไปไว้ในโปรเจกต์ของคุณ (หรือ clone repo นี้เป็นจุดเริ่มต้นของโปรเจกต์เลยก็ได้)
2. บอกว่าอยากสร้างอะไร — พูดแบบ "อยากได้ระบบ sales CRM" ก็เพียงพอให้ `business-analyst` เริ่มทำงาน
3. ตอบคำถามที่มันถามเป็นชุด มันจะเขียน `_docs/module/<name>/requirement.md`
4. ส่งไฟล์นั้นให้ `system-analyst` ยืนยันความเป็นไปได้และ data model → ได้ `design.md`
5. ส่งต่อให้ `project-manager` แตกเป็น task list แบ่ง phase → ได้ `plan.md`
6. รัน `setup` ครั้งเดียวเพื่อ scaffold โปรเจกต์จริง (Next.js + Express + Prisma + Postgres)
7. ทำ Phase 1 ด้วย `frontend-engineer`/`backend-engineer` แล้วตรวจด้วย `qa-engineer`
8. ถ้าเป็น module ที่อ่อนไหว (auth, payment, ข้อมูลส่วนบุคคล, upload) ให้รัน `security` ก่อนให้ `devops` deploy

ทุก agent จะบอกว่าอะไรพร้อมแล้วและควรส่งต่อให้ใคร — ไม่มีตัวไหนเชื่อมงานให้เองอัตโนมัติ คุณเป็นคนตัดสินใจเดินหน้าทุกครั้ง

## โครงสร้างไฟล์

```
_docs/
├── status.md                    ← ดัชนีรวม: มี module อะไรบ้าง ไปถึงไหนแล้ว ใครควรทำต่อ
└── module/
    └── sales-crm/
        ├── requirement.md       ← business-analyst
        ├── design.md            ← system-analyst
        ├── plan.md               ← project-manager  (ติ๊ก checkbox: qa-engineer เท่านั้น)
        ├── review.md            ← qa-engineer
        ├── security.md          ← security
        └── deploy.md            ← devops

.claude/
├── shared/conventions.md        ← กติกาที่ agent ทุกตัวใช้ร่วมกัน
└── agents/*.md                  ← agent ทั้ง 9 ตัว
```

ไม่มีอะไรถูกเขียนที่ root ของ repo ยกเว้น `CLAUDE.md` แต่ละ module มีโฟลเดอร์ของตัวเองใต้ `_docs/module/` เพื่อไม่ให้ฟีเจอร์ที่ไม่เกี่ยวกันมาทับประวัติของกันและกัน

## กติกาที่ยึดร่วมกันทุก agent

เนื้อหาเต็มและเหตุผลอยู่ใน `.claude/shared/conventions.md`:

- **ไม่มี agent ไหนเชื่อมไปตัวถัดไปเอง** ทุกรอบจบด้วยการบอกว่าอะไรพร้อมแล้วและใครควรหยิบไปทำต่อ แล้วก็หยุด
- **ห้ามใช้ git เด็ดขาด** ไม่มี agent ไหนรัน `git init`/`add`/`commit`/`push` หรือแตะ `.git` — version control เป็นเรื่องของคุณคนเดียว
- **Data Model ใน `design.md` คือสัญญา** schema ถูกยืนยันกับคุณครั้งเดียว แล้วถูกนำไปใช้ตรงตัวเป๊ะๆ — ไม่มี agent ไหนคิดฟิลด์เองหรือเปลี่ยนชื่อเอง ถ้ามีช่องว่างต้องส่งกลับ `system-analyst` ห้ามด้นสดแก้เอง
- **มีแค่ `qa-engineer` เท่านั้นที่ติ๊กงานว่าเสร็จ** มันติ๊ก `[x]` ใน `plan.md` หลังตรวจโค้ดจริงแล้วเท่านั้น — ไม่มีการปั๊มตราให้ผ่านลอยๆ
- **แก้ไขเอกสารเดิม ไม่ใช่สร้างใหม่ทับ** เอกสารที่มีอยู่แล้วถูกอัปเดตทีละส่วนพร้อมลง Change Log ที่มีวันที่กำกับ ไม่มีการเขียนทับทั้งไฟล์
- **ไม่มีอะไรถูก deploy โดยไม่ผ่านการตรวจ** `devops` จะปฏิเสธ deploy phase ที่ QA ยังไม่ยอมรับ หรือ phase ที่ยังมีช่องโหว่ระดับ Critical/Important ค้างอยู่ เว้นแต่คุณจะสั่ง override เอง

## Right-sizing — ข้ามด่านได้สำหรับงานเล็ก

pipeline เต็มมีไว้สำหรับสร้างของใหม่ การรันครบทั้ง 9 ด่านเพื่อแก้ตัวหนังสือนิดเดียวคือความสิ้นเปลือง ไม่ใช่ความรอบคอบ:

| ลักษณะงาน | เริ่มที่ |
|---|---|
| แก้ข้อความ/สไตล์ หรือบั๊กที่ requirement + schema ชัดเจนอยู่แล้ว | `frontend-engineer`/`backend-engineer` → `qa-engineer` |
| เพิ่ม/แก้ฟิลด์-ตาราง-ความสัมพันธ์ | `system-analyst` (amend) → engineer → `qa-engineer` |
| เปลี่ยน business rule แต่ไม่กระทบ schema | `business-analyst` (amend) → `system-analyst` (amend) → engineer → `qa-engineer` |
| ฟีเจอร์/โมดูล/โปรเจกต์ใหม่ | `business-analyst` เริ่มเต็มสาย |

แต่การเปลี่ยน schema โดยข้าม `system-analyst` ไปเลยคือปัญหาที่ pipeline นี้ถูกสร้างมาเพื่อป้องกัน — right-sizing หมายถึงเลือกจุดเริ่มต้นให้เหมาะกับงาน ไม่ใช่ตัดขั้นตอนที่งานนั้นต้องการจริงๆ ทิ้งไป

## Stack ที่ใช้

กำหนดตายตัวไว้ใน `.claude/agents/frontend-engineer.md` / `backend-engineer.md` — agent ตัวอื่นทุกตัวอ่านจากสองไฟล์นี้แทนที่จะเก็บสำเนาไว้เอง:

- **Frontend**: Next.js (App Router) · TypeScript · Tailwind · Zustand
- **Backend**: Node + Express · PostgreSQL · Prisma · REST · JWT แบบเขียนเอง · Zod
- **Package manager**: npm
- **Tests**: ยังไม่ได้ตั้งค่าไว้โดย default

การเปลี่ยน stack คือการแก้ไขสองไฟล์นี้อย่างตั้งใจและยืนยันแล้ว ไม่ใช่สิ่งที่ agent ตัวไหนตัดสินใจเองได้

## Model และ effort ของแต่ละ agent

กำหนดไว้ใน frontmatter ของแต่ละไฟล์ (`model`, `effort`) ปรับให้โมเดลที่แพงกว่าไปอยู่จุดที่ความผิดพลาดส่งผลกระทบไกลที่สุด (`system-analyst`, `security`) ส่วนโมเดลที่ถูกกว่ารับงานปริมาณมากที่สุด (`frontend-engineer`, `backend-engineer`) ดูตารางเต็มพร้อมเหตุผลได้ใน `CLAUDE.md` หรือจะ override เป็นครั้งๆ ไปตอนเรียกงานก็ได้

## กลับมาดูโปรเจกต์เดิม

อ่าน `_docs/status.md` ก่อน — มันบอกว่ามี module อะไรบ้าง แต่ละตัวไปถึงไหนแล้ว และ agent ไหนควรทำต่อ จากนั้นเปิดเอกสารของ module นั้นตามลำดับ: `requirement.md` → `design.md` → `plan.md` → `review.md` → `security.md` → `deploy.md`
