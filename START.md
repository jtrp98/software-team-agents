# START — เปิด Claude หรือ Codex แล้วทำงานได้เลย

> ไฟล์นี้ทำหน้าที่สองอย่างพร้อมกัน:
> 1. **คู่มือฉบับลัด** สำหรับคนที่ไม่อยาก setup framework เอง
> 2. **Prompt แรก** — copy บล็อกใน §2 ไปวางตอนเปิด Claude Code หรือ Codex รอบแรก แล้ว AI จะถาม–จัดการให้จนพร้อมทำงาน
>
> สำหรับ setup แบบเต็ม (doctor ละเอียด, troubleshooting 9 ประเด็น) ดู [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md)

---

## 1. สามเส้นทาง — เลือกตามงาน (AI จะถามเองว่ามีของครบไหม)

| | ทาง A — repo ของตัวเอง | ทาง B — Knowledge ของทีม | ทาง C — Target repo (โค้ดจริง) |
|---|---|---|---|
| เหมาะกับ | dev โซโล มี project ของตัวเอง | ba / sa / uxui | dev / devops เขียนโค้ดกับ Target |
| ต้องมี | repo ของตัวเอง + package (.tgz) | Framework checkout + Knowledge repo | ทาง B + Target repo |
| setup | `init legacy-project` 1 คำสั่ง | `configure knowledge-root` 1 คำสั่ง | B + ลงทะเบียน/map Target |

- ใช้ได้หลายทางพร้อมกัน: dev ปกติ = B + C · คนเริ่มงานใหม่ที่ยังไม่มีอะไรเลย = AI ถามแล้วสร้างให้ทีละอย่าง

## 2. Prompt แรก (copy ไปวางใน Claude Code หรือ Codex)

```text
อ่านไฟล์ START.md ที่ root ของ repo นี้ แล้วทำตามส่วน "คำสั่งสำหรับ AI"
ฉันเป็น: <ba | sa | uxui | dev>
งานที่ต้องการวันนี้: <อธิบายสั้น ๆ>
```

(ไม่ต้องเดา path เอง — AI จะถามทีละข้อตาม §3)

## 3. คำสั่งสำหรับ AI — Claude / Codex (อ่านเมื่อถูกขอให้ทำตาม START.md)

### ขั้น 0 — ถามก่อน ห้ามเดา
ถามผู้ใช้: role, งานที่ต้องการ แล้วไล่ถามทีละรายการในขั้น 1 — **ทุกครั้งถามว่า "มีอยู่แล้วหรือยัง"**
- ตอบ "มีแล้ว" → ขอ **path** แล้ว validate ตามตาราง
- ตอบ "ยัง" → ทำตามคอลัมน์ "ยังไม่มี" ให้จนได้ path

### ขั้น 1 — เช็คของทีละชิ้น

| สิ่งที่ถาม | ใครต้องมี | ถ้า "ยังไม่มี" | ถ้า "มีแล้ว" (validate ที่ path ที่ผู้ใช้ใส่) |
|---|---|---|---|
| Framework checkout | B, C | ให้ผู้ใช้รันเอง: `git clone <url>` (agent รัน git ไม่ได้ — hook block) หรือใช้ไฟล์ .tgz จากทีมแทน | มองเห็น `orchestrator\dist\cli.js` + `.claude\agents\` หรือไม่ |
| Knowledge repo | B, C | ① ให้ผู้ใช้รันเอง: `git clone <knowledge-url> <path>` (หรือ `git init` ถ้าเริ่มใหม่) ② Claude รันให้: `init --mode three-repo --project-root <path>` | เป็น standalone git top-level (`<path>\.git` เป็น folder) + มี `knowledge\` หรือยังไม่มีอะไรก็ได้ (init ซ้ำได้ ไม่ทับของเดิม) |
| Target repo (dev เท่านั้น) | C | ให้ผู้ใช้รันเอง: `git clone <remote_url> <path>` — remote ต้องตรงกับ `targets.yaml` | origin URL ตรงกับ `remote_url` ใน targets.yaml (preflight ตรวจให้ตอน run) |
| ทาง A — repo ของตัวเอง | A | ผู้ใช้สร้าง folder/git เอง (agent แตะ git ไม่ได้) | มองเห็น repo ปกติ |

### ขั้น 2 — binding + validation (AI รันเองได้ผ่าน Bash)

```powershell
# ทาง A — ติดตั้ง agents+hooks ลง repo ของผู้ใช้
npm install <tgz>            # ถ้ายังไม่มี package ใน repo
node node_modules\software-team-agents\orchestrator\dist\cli.js init --mode legacy-project --templates node_modules\software-team-agents\templates --project-root <repo-path>

# ทาง B/C — ผูกเครื่องนี้กับ Knowledge root แล้วตรวจความพร้อม
node orchestrator\dist\cli.js configure knowledge-root <knowledge-path>
node orchestrator\dist\cli.js doctor --project-root <knowledge-path>
```

- doctor FAIL = หยุด รายงาน `Fix:` line ตามที่ระบบพิมพ์ แล้วทำซ้ำขั้น 2
- dev ที่ใช้ทาง C: ช่วยเขียน `targets.yaml` (identity) และ `.workflow\targets.local.yaml` (path เครื่องนี้)
  ใน Knowledge root — ต้องเปิด session พร้อม writable roots ก่อน (§5) · targets.local.yaml ห้าม commit

### ขั้น 3 — เริ่มงานตาม role (§4) ภายใต้กฎหักไม่ได้

- approve/signoff/ack เป็น**ของคน** — ทำผ่าน `sta roles ...` เท่านั้น agent ห้ามเขียนแทน (`knowledge/_roles/**` deny เสมอ)
- 5 จุดหยุดรอคน: requirement interview · schema confirmation · QA ไม่ผ่าน · security finding Critical/Important · deploy/migration จริง
- `qa-engineer` และ `security` ไม่ถูกเรียกอัตโนมัติ — ผู้ใช้เรียกเองทุกครั้ง
- วันที่ เอาจากผู้ใช้ · engineer ไม่ตัดสินกฎเอง — งง ส่งกลับ system-analyst (business → business-analyst)
- อ่าน `policies/*.md` + prompt ของ role ก่อนลงมือทุก session — Claude Code: `.claude/agents/<role>.md` · Codex: `.codex/agents/<role>.toml`
- จบทุกรอบด้วย "สิ่งที่พร้อมแล้ว / รอใครต่อ"

## 4. แต่ละ role เริ่มยังไง

| role | ทำอะไร | artifact | ใครปิดงาน |
|---|---|---|---|
| **ba** | interview → เขียน requirement เป็น knowledge item (`REQ-*`) | `knowledge/<module>/requirement/` | คน: `roles approve REQ-xxx --by "<ชื่อ>"` แล้ว `roles signoff ba --by "<ชื่อ>"` |
| **sa** | แปลง REQ → design/architecture (`DES-*`, `DB-*`, `API-*`) — schema ต้องยืนยันกับคนก่อน | `knowledge/<module>/architecture/` | คน: `roles signoff sa --by "<ชื่อ>"` |
| **uxui** | ออกแบบ UX/UI (`UX-*`) — frontend จะถูก block ถ้า ux-design ไม่ approved/current | `knowledge/<module>/ux-design/` | คน: `roles signoff uxui --by "<ชื่อ>"` |
| **dev** | implement ตาม design ที่ approved (`BE-*`/`FE-*`) ใน Target repo แล้ว qa-engineer ตรวจ | โค้ดใน Target repo | qa-engineer เท่านั้น (Status cell `verified`) |

ดูงานที่รอตัวเอง (จาก framework checkout):

```powershell
node orchestrator\dist\cli.js roles inbox <ba|sa|uxui|dev> --project-root <knowledge-path>
```

(คำสั่ง `roles *` เป็นคำสั่งของ**คน** ไม่ใช่ของ agent)

## 5. เปิด session ให้เขียนข้าม repo ได้ (ทาง B/C)

Guards block ทุก write ที่ออกนอก repo ที่เปิด session — ยกเว้น path ที่ประกาศชัดผ่าน env ตอนเปิด:

```powershell
$env:AGENTCLAUDE_WRITABLE_WORK_ROOTS = '["<knowledge-path>","<target-path>"]'
claude
```

- list นี้คือขอบเขตเขียนทั้งหมดของ session — ใส่เท่าที่จำเป็น
- `.workflow/**` และ `knowledge/_roles/**` ถูก deny เสมอ ไม่ว่าจะประกาศอะไร
- devops/deploy ยังโดน gate ของตัวเอง แม้ writable เปิด

## 6. ใช้ได้ทั้ง Claude Code และ Codex

ทุก flow ในไฟล์นี้ (ทาง A/B/C, prompt แรก, การถาม-ตอบ setup) ใช้ได้กับทั้งสอง runtime — เปิด `claude` หรือ `codex` ก็ได้ ตามถนัดของแต่ละคน

- **Claude Code** อ่าน `.claude/agents/*.md` + hooks ผ่าน `.claude/settings.json`
- **Codex** อ่าน [`AGENTS.md`](AGENTS.md) ที่ root เป็น project context · role prompts อยู่ที่ `.codex/agents/*.toml` · guards wired ผ่าน `.codex/hooks.json`

ข้อแตกต่างเล็กน้อยที่ควรรู้:

- `AGENTCLAUDE_WRITABLE_WORK_ROOTS` (§5) อ่านโดย hooks ฝั่ง Claude Code — ถ้าใช้ Codex และต้องเขียนหลาย repo ให้เปิด session ใน repo หลักที่ต้องเขียนมากที่สุด
- การรัน task ยาวผ่าน orchestrator (`sta run`) ปัจจุบันวิ่งบน Claude Code adapter (`codexAdapter` เตรียมไว้แล้ว แต่ยังไม่มีตัวเลือก runtime ระดับ CLI)

## 7. ข้อจำกัดที่ควรรู้ก่อนเริ่ม

- Session แบบ interactive นี้**ไม่มี state.db/retry/audit trail** ของ orchestrator — งานยาวทั้ง task ที่ต้องการ recovery/audit ให้รันผ่าน `orchestrator` CLI (ดู `TEAM_SETUP_V1.md` Step 6)
- การรัน task ผ่าน orchestrator ในโหมด three-repo: invocation ใน `TEAM_SETUP_V1.md` ตอนนี้อยู่ระหว่างการตรวจสอบ (release audit) — ใช้ตาม doc ล่าสุดใน repo และรายงานปัญหาที่เจอ
