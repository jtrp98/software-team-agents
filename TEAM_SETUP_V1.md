# Team Setup — V1

> Onboarding flow สำหรับสมาชิกใหม่: Install → Bind → Init your workspace → Validate → Ready
> ทุกขั้นตอน reuse คำสั่งจริงของ `sta`/`software-team-agents` — ไม่มีขั้นไหนแก้ framework internals
> สถาปัตยกรรม Three-Repo (กฎการทำงานใน [`CLAUDE.md`](CLAUDE.md), รายละเอียดใน [`README.md`](README.md); [`AGENTS.md`](AGENTS.md) เป็น Codex pointer):

```
Framework repo (repo นี้)        Knowledge repo (ต่อบริษัท)              Target repo(s) (โค้ดจริง)
orchestrator / .claude /         knowledge/ _docs/module/**/            sb-web-helper ฯลฯ — real source code
contracts / workflows /          decisions/ targets.yaml
policies / templates/
```

**กฎที่ทั้งไฟล์นี้มีอยู่เพื่อบังคับ:** BA/SA/PM/QA ทำงานใน **Knowledge repo** เท่านั้น
(`business-analyst`, `system-analyst`, `project-manager`, `test-planner`, `uxui-designer` — "BA lane").
DEV/DevOps ทำงานใน **Target repo** เท่านั้น (backend/frontend engineer, qa, security, devops — "DEV lane").
ทั้งสองฝั่งอ่าน Knowledge ได้เสมอ (DEV อ่านแบบ read-only ผ่าน binding) แต่ requirement/design/plan
**เขียนที่ Knowledge repo เท่านั้น** — ไม่ใช่ Target. การเขียนผิดที่คือเหตุการณ์จริงที่ทำให้ไฟล์นี้ถูกเขียนใหม่
(ดู Troubleshooting #1 ด้านล่าง และ `planning/v2/workspace-guardrails-TASKS.md`).

---

## Step 0 — Prerequisites

| ต้องมี | ตรวจ |
|---|---|
| Node.js ≥ 20 | `node --version` |
| Git | `git --version` |
| Claude Code CLI (หรือ Codex/OpenCode) + login | `claude --version` |

## Step 1 — Install the Framework (once per machine)

```bash
npm install -g software-team-agents        # หรือ npm pack ที่ repo นี้ + npm i -g <tgz> ถ้ายังไม่ publish
sta --version
software-team-agents --version
```

ทั้งสองคำสั่งเป็น bin เดียวกันของ package นี้ (`sta` = orchestrator ทั้งชุด, `software-team-agents` =
Target-first / role-aware entry point ที่ทุก step ด้านล่างใช้).

## Step 2 — Get the Knowledge Repo (clone ครั้งเดียวต่อเครื่อง, ทุก role)

```bash
git clone <ทีมของคุณ>/knowledge-<company>.git C:\src\<company>-knowledge
```

BA/SA/PM/QA **แค่นี้พอ** — ไม่ต้อง clone Target repo เลย (ไม่แตะโค้ดแอป)
DEV/DevOps clone Target repo(s) เพิ่มใน Step 4

## Step 3 — Bind This Machine to the Knowledge Root (ครั้งเดียวต่อเครื่อง)

```bash
sta configure knowledge-root C:\src\<company>-knowledge
```

ตรวจ standalone-git/ไม่ใช่ linked worktree/ไม่ overlap กับ Framework หรือ Target อัตโนมัติ — ผิดจะ reject
พร้อมเหตุผลตรงตัว. Binding นี้เก็บนอก repo ใดๆ (`%LOCALAPPDATA%\software-team-agents\installation.yaml`
บน Windows, `~/.config/software-team-agents/installation.yaml` บน macOS/Linux) — ทุก workspace บนเครื่องนี้
ใช้ binding เดียวกัน.

## Step 4 — Initialize *Your* Role Workspace

**ทุก workspace ต้องรู้ตัวว่าเป็นฝั่งไหน** (`role: ba` หรือ `role: dev`) — บันทึกไว้ที่
`.agent-team/config.yaml` ของ workspace นั้นเอง, เขียนครั้งเดียวตอน `init`.

### BA lane (business-analyst / system-analyst / project-manager / test-planner / uxui-designer)

```bash
cd C:\src\<company>-knowledge
software-team-agents init --role ba
```

**ขั้นนี้บังคับ** ก่อนทำงานวิเคราะห์/เขียน doc ใดๆ ใน Knowledge repo แม้แต่ไฟล์เดียว — ถ้าไม่ init
`business-analyst`/`system-analyst` จะไม่มี prompt อยู่เลยในเครื่องนี้ (ดู Troubleshooting #1) และ
`software-team-agents status` จากทุก workspace ที่ผูกกับ Knowledge root นี้จะเตือนด้วย WARNING ตรงๆ.

### DEV lane (backend/frontend engineer, qa-engineer, security, devops)

**ถ้ายังไม่มี Target repo บนเครื่องนี้เลย — เลือกก่อนว่าอยู่กรณีไหน:**

- **มี Target repo อยู่แล้วบนเครื่อง** — ข้ามไปคำสั่งด้านล่างตรงๆ
- **มี remote repo แล้ว แต่ยังไม่ได้ clone มาเครื่องนี้** — clone เองก่อน (คำสั่งนี้เปลี่ยน state จริง
  ต้องรันเองด้วยมือ ไม่ใช่ AI assistant รันให้เฉยๆ ถ้าใช้ playbook แบบ AI-assisted ดู `prompt-setup.md`
  ซึ่งจะโชว์คำสั่งนี้ให้ยืนยันก่อนรันเสมอ):
  ```bash
  git clone <remote-url> C:\src\<your-target-repo>
  ```
- **ยังไม่มีอะไรเลย — โปรเจกต์ใหม่จริงๆ** — ตกลง path ที่จะใช้ แล้ว `git init` เอง (เปลี่ยน state เหมือนกัน,
  กฎเดียวกับข้างบน):
  ```bash
  git init C:\src\<your-target-repo>
  ```
  หลังจากนี้ยังไม่มี scaffolding อะไรเลย (ไม่มี `package.json`/`app/`/`prisma/`) — ต้องรัน `setup` agent
  ต่อทันทีหลัง Step 4/5 เสร็จ ก่อนเริ่มงานฟีเจอร์ใดๆ (ดู Step 6).

```bash
cd C:\src\<your-target-repo>
software-team-agents init --role dev
```

ถ้า repo นี้ยังไม่ผูก Knowledge — ให้ตั้ง `knowledge.path` ใน `.agent-team/config.yaml` (relative หรือ
absolute path ไปยัง Knowledge repo) หรือให้ Step 3's machine-wide binding พอ. `dev` session จะปฏิเสธ
launch ทันทีถ้าไม่มี Knowledge binding ที่ใช้ได้ — fail-closed พร้อมคำสั่งแก้ตรงตัว.

## Step 5 — Validate (ทุก role)

```bash
software-team-agents status
```

อ่านผลจากบนลงล่าง — ทุกบรรทัดบอกวิธีแก้ตัวเองถ้าไม่ READY:

- `Role:` / `Workspace:` — ยืนยันว่า workspace นี้ตรงกับสิ่งที่คุณตั้งใจทำงานจริง (BA เห็น "Knowledge", DEV เห็น "Target")
- `Knowledge:` (DEV เท่านั้น) — ต้องไม่ใช่ `NOT BOUND` หรือ `INVALID`
- `Sync:` — `state: UP_TO_DATE` (ไม่ใช่ `NOT_INITIALIZED`/`INCOMPATIBLE`); `conflicts: 0`
- `WARNING: Knowledge root bound ... has no .agent-team/config.yaml` — Knowledge root ผูกไว้แล้วแต่ยังไม่
  `init --role ba` ที่นั่น (ดู Troubleshooting #1) — รันคำสั่งที่ status พิมพ์ให้ตรงๆ
- `WARNING: roster drift` — มี agent prompt จากอีก lane ปนอยู่ใน workspace นี้ (ดู Troubleshooting #2)
- `Claude:`/`Codex:`/`OpenCode:` — ต้อง `READY` สำหรับ runtime ที่จะใช้จริง

`status` ไม่เขียนอะไรเลย — ปลอดภัยรันซ้ำได้ทุกเมื่อ

## Step 6 — Start Working

```bash
software-team-agents ba     # BA lane — launches from the Knowledge repo
software-team-agents dev    # DEV lane — launches from this Target
```

ทั้งสองคำสั่งรัน preflight ให้อัตโนมัติ (auto-sync ถ้าไม่มี conflict), แล้ว launch runtime (`claude` โดย
default; `--runtime codex|opencode` เลือกอย่างอื่นได้) จาก workspace ที่ถูกต้องให้เอง — cd เองไม่ต้องคิด.

---

## Troubleshooting

### 1. "requirement/design หลุดไปออกใน Target แทน Knowledge" (เหตุการณ์จริง — สาเหตุที่ไฟล์นี้ถูกเขียนใหม่)

**สัญญาณ:** พบ `_docs/module/<name>/` หรือ `_docs/status.md` ที่มีตาราง `## Modules` อยู่ใน Target repo
(repo ที่มี `role: dev`) — ที่ที่ถูกคือ Knowledge repo เท่านั้น.

**สาเหตุที่พบจริง (2026-08-24):** Knowledge root ถูก `configure knowledge-root` ไว้ถูกต้อง แต่ไม่เคยมีใคร
รัน `init --role ba` ที่นั่นเลย — ไม่มี BA-lane prompt (`business-analyst`, `system-analyst`, ...) อยู่บน
เครื่องนี้เลยแม้แต่ที่เดียว, และไม่มีอะไรเตือนเรื่องนี้จนกว่าจะสายไปแล้ว (session ที่เปิดตรงในเครื่องเป้าหมาย
เขียน `_docs/` ลง Target ได้เพราะ hook ไม่รู้จัก role ของ workspace ในตอนนั้น).

**ตรวจ:**

```bash
software-team-agents status --json | grep -i knowledgeBoundButUninitialized
software-team-agents status   # หรืออ่านบรรทัด WARNING ตรงๆ
node orchestrator/dist/cli.js --check-workspace --project-root <target-repo>
```

`--check-workspace` (T-WG4) จะรายงานทุกไฟล์ใต้ `_docs/module/**` ที่หลงอยู่ผิดที่ และ Modules table ที่หลง
อยู่ใน `status.md`, พร้อม path ปลายทางที่ถูกต้องใน Knowledge repo.

**แก้:**

1. `cd <knowledge-root> && software-team-agents init --role ba` (ปิด root cause — ทำครั้งเดียวต่อเครื่อง)
2. Copy ไฟล์ที่หลงจาก Target ไปยัง `<knowledgeRoot>\_docs\module\<name>\` ตรงๆ, merge แถวในตาราง `## Modules`
   ของ `_docs/status.md` ฝั่ง Knowledge (ใช้ `node .claude/scripts/generate-status.js` แทน hand-edit)
3. ยืนยันว่าคัดลอกครบ (diff ไฟล์ต้นทาง/ปลายทาง) แล้วค่อยลบของเดิมออกจาก Target
4. รัน `--check-workspace` ซ้ำ — ต้องไม่ flag อะไรอีก
5. `git rm`/commit ทั้งสอง repo แยกกัน

### 2. "status เตือน roster drift"

**สัญญาณ:** `status` พิมพ์ `WARNING: roster drift — agent prompt(s) from another lane found in this
workspace`.

**สาเหตุ:** มีคนคัดลอก agent prompt file ของอีก lane เข้ามาด้วยมือ (เช่น `business-analyst.md` ในโฟลเดอร์
DEV) — ไฟล์แบบนี้ไม่มีทางถูกต้องในเครื่องมือนี้ ไม่ว่าจะมาจากไหน.

**แก้:** `software-team-agents sync --force` — สำรองไฟล์เดิมไว้ที่ `.agent-team/backups/<timestamp>/` ก่อน
ลบเสมอ. `sync` ธรรมดา (ไม่ `--force`) จะปฏิเสธและรายงาน conflict แทนที่จะเขียนทับเงียบๆ.

### 3. `dev` ปฏิเสธ launch ด้วย "no Knowledge repository bound"

**แก้:** ตั้ง `knowledge.path` ใน `.agent-team/config.yaml` ของ Target repo นี้ (path ไปยัง Knowledge repo,
relative หรือ absolute ก็ได้) หรือรัน `sta configure knowledge-root <path>` ให้ผูกทั้งเครื่อง (Step 3)

### 4. `status`/`sync` รายงาน conflict บนไฟล์ที่ Framework จัดการ

**แก้:** อ่าน `detail`/recovery line ที่ error พิมพ์ให้ตรงๆ — มี 3 แบบ: `user-modified` (แก้แล้ว revert/claim
เป็น override/`--force`), `stale-modified` (ไฟล์เดิมถูกถอดจาก template แล้วแต่ยังมีการแก้ค้างอยู่ — ย้ายออก
เอง), `roster-drift` (ดู #2)

### 5. `Claude`/`Codex`/`OpenCode` = NOT READY

**แก้:** รัน `software-team-agents sync` แล้ว `status` ซ้ำ — ข้อความ NOT READY บอกไฟล์ที่ขาดตรงๆ (agent
prompts, `.claude/settings.json`, bindings)

### 6. พิมพ์ `/xxx` แล้วไม่เจอ (slash command หาย)

**เช็ค:**
1. `.claude/commands/<name>.md` มีอยู่ใน workspace นี้ไหม — ถ้าไม่มี รัน `software-team-agents sync`
   (ชุด command ship ผ่าน templates เหมือน `.claude/agents/`)
2. Restart session หลัง sync — Claude Code โหลดรายชื่อ command ตอนเริ่ม session
3. ชื่อต้องตรงไฟล์ (flat namespace) — ไฟล์ใน `_shared/` เป็น include ไม่ใช่ command
   (`/_shared/guardrails` type ได้แต่ไม่ใช่จุดประสงค์); ชื่อที่มีทั้งหมดดูที่
   [`planning/v2/claude-commands-TASKS.md`](planning/v2/claude-commands-TASKS.md) §1.1

### 7. `$xxx` ไม่เจอใน Codex (skills mirror หาย)

**เช็ค:**
1. `.agents/skills/<name>/SKILL.md` มีครบไหม — ถ้าไม่มี รัน `software-team-agents sync`
   (mirror เป็น generated file, `sta sync` generate จาก `.claude/commands/**` ให้ใหม่เสมอ)
2. Codex reload skills เองอัตโนมัติ (detect on change) — ไม่ต้อง restart; เมนูรวมอยู่ที่ `/skills`
3. Invoke แบบ explicit คือ `$<name>`; การ activate เองโดยโมเดลถูกปิดไว้ (`agents/openai.yaml`
   → `allow_implicit_invocation: false`) ตั้งใจ ไม่ใช่ bug
4. ยังไม่เห็น → `sta --check-bindings` — drift/orphan รายงานทีละไฟล์พร้อม fix

### 8. พิมพ์ `/xxx` ใน OpenCode แล้วไม่เจอ (commands mirror หาย)

**เช็ค:**
1. `.opencode/commands/<name>.md` มีครบ 31 ไฟล์ไหม — ถ้าไม่มี รัน `software-team-agents sync`
2. OpenCode auto-reload commands ทันที (ต่างจาก Claude ที่ต้อง restart session)
3. แก้เนื้อหา command ที่ source เดียวเสมอ: `.claude/commands/<name>.md` —
   ห้าม hand-edit `.opencode/commands/**` (generated; `--check-bindings` จับ byte-diff ได้)

### 9. Claude Design MCP ไม่ connect (uxui-designer Path C)

**อาการ:** uxui-designer run หรือ `/design-*` tool รายงาน MCP server ไม่พร้อม / tools หาย

**เช็ค/แก้:**
1. เพิ่ม server ครั้งเดียวต่อเครื่อง:
   `claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp`
2. Login: รัน `/design-login` ใน Claude Code — ต้องเห็น ✔ Connected; token หมดอายุ → login ซ้ำ
3. Identity gate (fail closed): email account ที่ login **ต้องตรง** `claude_email` ที่ declare
   (`sta configure identity --claude-email <email>`) — ไม่ตรง preflight block run
4. ยังไม่ผ่าน → ใช้ Path A/B (handoff/export files) แทนได้เสมอ — Path C เป็นช่องทางเสริม ไม่ใช่ dependency

### 10. Knowledge repo เดิม (มีอยู่ก่อน adopt Framework) มีโครงสร้างไฟล์ไม่ตรง canonical shape

**อาการ:** `_docs/`/`knowledge/` มีโฟลเดอร์/ไฟล์ที่ไม่ตรง `layout.yaml`/`CLAUDE.md` — เช่น module tree
ซ้อนกันสองชุด, ไฟล์ requirement เก่าที่ไม่ได้อยู่ใต้ module folder, ไฟล์แปลกใต้ `_docs/module/` โดยตรง,
หรือโฟลเดอร์ใต้ `knowledge/<module>/` ที่ `CLAUDE.md` ไม่ได้บันทึกไว้

**แก้:** binding/sync (Troubleshooting #1–4) เป็นคนละเรื่องกับสิ่งนี้ — ใช้
[`prompt-reconcile-knowledge-layout.md`](prompt-reconcile-knowledge-layout.md) ให้ AI assistant สแกน จัดหมวด และเสนอทางแก้
ทีละรายการ ไม่มีการลบ/ย้ายอะไรโดยไม่ถามก่อน

---

## Canonical References

- Pipeline detail (roles, gates, recovery, model tiers) → [`CLAUDE.md`](CLAUDE.md)
- Shared agent rules → [`policies/`](policies/README.md)
- Knowledge model → [`knowledge/README.md`](knowledge/README.md)
- Product overview & runtime support status → [`README.md`](README.md)
- Full command reference → `software-team-agents --help` / `sta --help`; operating rules → [`CLAUDE.md`](CLAUDE.md)
  `sta --help`
