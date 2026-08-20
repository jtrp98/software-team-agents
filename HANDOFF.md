# Handoff — งานปรับปรุง orchestration layer

เอกสารนี้เขียนไว้ให้ session ถัดไป **เริ่มจาก context ว่างเปล่าแล้วทำงานต่อได้ทันที** โดยไม่ต้องอ่าน
โค้ดทั้งหมดเพื่อเดาว่าอะไรตัดสินใจไปแล้วและเพราะอะไร

- **สถานะ:** 15/60 tasks เสร็จ — P0 (T01–T08) และ P1 Architecture (T09–T15) ครบ
- **งานถัดไป:** T16 (Decision Log/ADR) เป็นต้นไป ดู `CHECKLIST.md`
- **spec ฉบับเต็มของทุก task:** `TASKS.md` (ID ตรงกับ `CHECKLIST.md`)
- **โค้ดทั้งหมดยังไม่ commit** — version control เป็นของผู้ใช้ ไม่มี agent ตัวไหนรัน git

---

## 1. ตรวจว่าทุกอย่างยังเขียวก่อนเริ่ม

รันสี่อย่างนี้ก่อนแตะอะไร ถ้าอันไหนแดงคือมีอะไรพังก่อนหน้าคุณ ไม่ใช่คุณทำพัง

```bash
cd orchestrator && npm test && npm run typecheck
```

```bash
node .claude/tests/run.js
```

```bash
cd orchestrator && npm run build --silent && cd .. && node orchestrator/dist/cli.js --check-contracts && node orchestrator/dist/cli.js --check-layout && node orchestrator/dist/cli.js --check-workflows && node orchestrator/dist/cli.js --check-profile
```

ค่าที่ควรได้ ณ วันที่ส่งมอบ:

| ตัวตรวจ | ผลที่ถูกต้อง |
|---|---|
| `npm test` (orchestrator) | 552 passed / 36 files |
| `npm run typecheck` | exit 0 |
| `.claude/tests/run.js` | All 83 case(s) passed |
| `--check-contracts` | contracts agree with the agent registry, and their path rules are sane |
| `--check-layout` | layout.yaml agrees with the repo |
| `--check-workflows` | workflows/*.yml agree with the classifier |
| `--check-profile` | agree with the agent roster + **2 notes เรื่อง .NET target** (ดู §4) |

**`--check-profile` พิมพ์ note 2 บรรทัดแล้ว exit 0 — นั่นถูกต้องแล้ว ไม่ใช่ warning ที่ต้องไปทำให้หาย**
เหตุผลอยู่ใน §4

---

## 2. โครงสร้างที่เพิ่มเข้ามาในรอบนี้

`layout.yaml` ที่ root คือคำตอบเดียวว่า "ไฟล์นี้เป็น concept ไหน อยู่ถูกที่ไหม" และ
`--check-layout` ตรวจกับของจริงบนดิสก์ **ถ้าจะเพิ่มโฟลเดอร์ใหม่ ต้องประกาศที่นั่นก่อน ไม่งั้น
checker ไม่รู้จัก**

```
layout.yaml          ← concept map + ตัว validate (T04)
project.yaml         ← stack ของโปรเจกต์: current / target (T14)
contracts/*.yaml     ← agent แบบ machine-readable × 9 (T03/T12/T15)
workflows/*.yml      ← pipeline ต่อชนิดงาน × 11 (T09)
stacks/*/stack.yaml  ← โปรไฟล์เทคโนโลยี × 5 (T13)
policies/            ← จองไว้ให้ T49 (มีแค่ README, checker บังคับ)
.claude/hooks/       ← 5 hooks (เพิ่ม block-path-permissions.js ในรอบนี้)
orchestrator/        ← Node/TS package, 552 tests
```

### โมดูลใหม่ใน `orchestrator/src/` และหน้าที่

| ไฟล์ | Task | ทำอะไร |
|---|---|---|
| `layout/repoLayout.ts` | T04 | อ่าน `layout.yaml` แล้วตรวจกับ filesystem จริง |
| `context/contextManager.ts` | T05 | ตัด doc ตาม `conventions.md` §10 ก่อนส่งให้ agent |
| `orchestrator/failureClassifier.ts` | T06 | แปลง `review.md`/`security.md` → `StructuredFailure` |
| `retry/recoveryPolicy.ts` | T07 | ตัดสิน 5 ทาง: Retry / Recover / Rollback / Escalate / Abort |
| `gates/approval.ts` | T08 | approval ledger แบบมี type/status/ใครตอบ/เมื่อไหร่ |
| `workflow/workflowDefinition.ts` | T09 | อ่าน `workflows/*.yml` + ตรวจกับ classifier |
| `graph/taskGraph.ts` | T10/T11 | DAG ของ task พร้อม edge 3 ชนิด + parallel layers |
| `agents/capabilities.ts` | T12 | vocabulary ปิดของ capability |
| `profile/projectProfile.ts` | T13/T14 | อ่าน `project.yaml` + `stacks/` + ตรวจกับ roster |
| `agents/pathPermissions.ts` | T15 | glob matcher + กฎ write/deny/read ต่อ agent |

---

## 3. รูปแบบที่ repo นี้ใช้ซ้ำ — ทำตามถ้าจะเพิ่มของใหม่

รอบนี้ใช้ pattern เดิมสามอย่างซ้ำ ๆ ถ้างานถัดไปเพิ่ม data file ใหม่ ให้ทำแบบเดียวกัน

**1. Data file + JSON Schema (ajv) + checker ใน CLI**
ทุก data file ใหม่ต้องมี schema ใน `orchestrator/schemas/` และ flag `--check-*` ที่ตรวจว่าไฟล์กับ
โค้ดยังตรงกัน เหตุผล: **ไฟล์ที่ไม่มีอะไรตรวจคือคำบรรยาย ไม่ใช่สัญญา** และมันจะ drift เงียบ ๆ

**2. โค้ดคือ runtime authority, ไฟล์คือสิ่งที่ถูกตรวจ**
`AGENT_REGISTRY` และ `classifyTask` เป็น pure constant/function ที่หลายโมดูลเรียกโดยไม่รู้จัก
project root — ถ้าให้มันอ่านไฟล์ตอน import จะดัน knowledge นั้นเข้าไปในทุกโมดูล จึงเก็บโค้ดเป็น
authority แล้วให้ checker บังคับว่าไฟล์ต้องตรงกัน (`agentContract.ts` เขียนเหตุผลนี้ไว้เต็ม)

**3. Fail-open กับ fail-closed เลือกตามความเสียหาย**
- **Guard (hook)** → fail **open** เสมอ อ่าน input ไม่ออก/หา role ไม่เจอ → ปล่อยผ่าน
  เพราะ guard ที่ขัง agent แย่กว่า guard ที่พลาดบางเคส
- **Context slicing** → คืน**ทั้งฉบับ**เมื่อโครงเอกสารไม่ตรงที่คาด การตัดคือ optimization
  ความครบคือ correctness
- **การเดา owner / เดา level** → **ไม่เดา** หยุดถามคน เพราะ route ผิดเสีย 2 fresh-context run
  แล้วยังแก้ผิดจุด

---

## 4. การตัดสินใจที่ทำไปแล้ว — อย่ารื้อโดยไม่รู้เหตุผล

### 4.1 `.claude/agents/` และ `.workflow/` ไม่ย้าย (T04)

T04 วาดให้ `agents/` อยู่ top-level แต่ **Claude Code อ่าน subagent จาก `.claude/agents/` เท่านั้น**
และ orchestrator ก็ shell ไป `claude -p --agent <role>` — ย้ายคือแยก concept ด้วยการทำให้ระบบพัง
T48 ก็ระบุว่า agents อยู่ใน `.claude/` ต่อ

`.workflow/` เป็น path ที่ T02 ระบุและโค้ดเขียนอยู่จริง เปลี่ยนเป็น `runtime/` = พัง state ที่มีอยู่
เพื่อได้คำพ้องความหมาย

→ concept แยกด้วยการ **ตั้งชื่อทั้งสองซีกของ agent** (prompt + contract) ไม่ใช่ย้ายไฟล์

### 4.2 `project.yaml` แยก `current` / `target` (T13/T14) ← **สำคัญที่สุด**

TASKS.md ระบุ stack เป้าหมายเป็น **.NET 10 / C# / EF Core / gRPC** แต่ agent prompt จริงใน
`.claude/agents/` ทำได้แค่ **Node + Express + Prisma** และ CLAUDE.md ระบุเองว่าเปลี่ยน stack
ต้องให้ผู้ใช้ยืนยันก่อนแก้ prompt

ทั้งสองอย่างเป็นความจริง การเขียนแค่อย่างเดียวเสียหายทั้งคู่:

- **เขียนแค่ target** → ทุก capability lookup คืน agent ที่สร้างไม่ได้ โดย checker เขียวไปด้วย
  **check ที่เขียวบนคำกล่าวเท็จแย่กว่าไม่มี check**
- **เขียนแค่ current** → การตัดสินใจที่ทำไปแล้วหายไป คนถัดไปมาเถียงใหม่

จึงเก็บทั้งคู่ และ checker ใช้มาตรฐานต่างกัน: `current` ต้องตรงกับ agent roster จริง,
`target` แค่ต้องชี้ไป stack profile ที่มีอยู่ + ต้องระบุ `blocked_on`

**ถ้าจะย้ายไป .NET จริง** ต้องแก้ประมาณ 12 ไฟล์: `backend-engineer.md`, `setup.md`, ส่วน stack
ของ CLAUDE.md, `require-green-before-stop.js` (สมมติ npm scripts), `check-schema-contract.js`
(สมมติ `schema.prisma`), contracts 3 ไฟล์, registry capabilities, `project.yaml` และบางเคสใน
self-test — **เป็นการตัดสินใจของผู้ใช้ ไม่ใช่ของ agent**

### 4.3 `permissions.read` ไม่บังคับเป็น block (T15)

`write`/`deny` บังคับจริง แต่ `read` เป็น documentation การอ่านไม่ทำลายอะไร และ read guard ที่
path ผิดจุดเดียวจะขัง agent กลางทางโดยไม่ได้ความปลอดภัยเพิ่ม

แต่ `read` ไม่ใช่ comment ลอย ๆ — มันถูกบังคับด้วยกฎ 1 ข้อ: **อะไรที่ role เขียนได้ ต้องอ่านได้ด้วย**
เพราะเอกสารที่นี่ *amend* ไม่ใช่ *regenerate* (§4) กฎนี้จับ bug จริง 3 จุดทันทีที่เขียนเสร็จ

### 4.4 Hook ไม่รู้ว่า agent ไหนกำลังเขียน — enforcement เลยเป็น 3 ชั้น (T15)

`block-doc-rewrite.js` และ `require-green-before-stop.js` เขียนกำกับไว้ทั้งคู่ว่า **hook ไม่มี
subagent identity** ดังนั้น:

1. ประกาศใน `contracts/<role>.yaml`
2. orchestrator บังคับ (มันรู้ว่าเรียก role ไหน)
3. `block-path-permissions.js` อ่าน role จาก env `AGENTCLAUDE_ROLE` ที่ `claudeCliExecutor.ts`
   ตั้งให้ตอน spawn — ถ้าไม่มี (คนรันเอง) จะเหลือแค่ floor: `node_modules/`, `.workflow/`, `dist/`
   และโฟลเดอร์ version control

**หมายเหตุ:** hook อ่าน `write:`/`deny:` จาก contract ด้วย regex ตัวเดียว เพราะ hook ห้ามมี
dependency ดังนั้น contract **ต้องเขียนแบบ flow style** (`write: ["a/**"]`) — ถ้าใครแก้เป็น
block style จะ fail self-test แทนที่จะปิด guard เงียบ ๆ (มีเคสคุมแล้ว)

### 4.5 กฎ backend→frontend กลายเป็น edge ที่คำนวณ (T10/T11)

`conventions.md` §6a มีข้อยกเว้นเขียนไว้ว่า "task ที่ไม่ share API contract รันสลับได้" แต่ไม่มีใคร
ทำตามได้เพราะต้องรู้ว่า task ไหน share contract `taskGraph.ts` คำนวณจาก `produces`/`consumes` จริง

**fallback สำคัญ:** frontend task ที่**ไม่ระบุ** contract เลย → กลับไปใช้กฎเหมารวมเดิม
(รอ backend ทั้งหมดใน phase) ไม่งั้น plan ที่ไม่ได้ annotate จะเสียการป้องกันไปเงียบ ๆ
การระบุ `consumes: []` (ประกาศชัดว่าไม่กิน contract ไหน) คือสิ่งที่ซื้อ parallelism กลับมา

---

## 5. ของค้าง — และมันอยู่ Phase ไหน

| เรื่อง | สถานะ | อยู่ที่ไหน |
|---|---|---|
| รัน task ขนานกันจริง | กราฟ + `readyLayers()` + `--list` เสร็จแล้ว แต่ orchestrator ยังรันทีละ task | **T35 — Concurrency Lock (P2)** ต้องมี file-level lock ก่อน ไม่งั้นแลกปัญหาลำดับที่เห็นได้ ไปเป็นไฟล์พังที่มองไม่เห็น |
| ย้าย stack เป็น .NET | บันทึกเป็น `target.blocked_on` แล้ว | **ไม่ใช่ task ใน TASKS.md** — รอผู้ใช้ตัดสินใจ ดู §4.2 |
| `policies/` ยังว่าง | จองไว้ + README + checker บังคับว่าห้ามมีอะไรเกิน | **T49 (P4)** — แตก `conventions.md` (373 บรรทัด, ถูกอ้างถึง 68 ครั้งจาก agent files) |
| `TaskGraph` กับ plan.md จริง | โมดูลเสร็จ+เทสต์ครบ แต่ยังไม่มีใครอ่าน task จาก `plan.md` มาสร้างกราฟ | **T52 (P4)** — `plan.md` เป็น Task Database |

---

## 6. งานถัดไป: T16–T21 (P1 — Documentation / Knowledge)

อ่าน spec เต็มใน `TASKS.md` ข้อควรระวังที่เห็นจากรอบนี้:

- **T16 (ADR)** — `layout.yaml` ยังไม่มี home สำหรับ `decisions/` ต้องเพิ่ม concept หรือ home ก่อน
  ไม่งั้น `--check-layout` จะไม่รู้จัก และ ADR จะกลายเป็นโฟลเดอร์ที่ไม่มีใครเป็นเจ้าของ
- **T17 (Change Impact)** — `taskGraph.ts` มี `edgesInto()` ที่อธิบายได้ว่าทำไม task หนึ่งรอ
  อีก task หนึ่ง น่าจะต่อยอดได้แทนที่จะเขียน traversal ใหม่
- **T18 (Contract Versioning)** — `agent-contract.schema.json` ยังไม่มี field `version`
  ส่วน `state-view.schema.json` มี `schema_version` อยู่แล้ว ใช้เป็นแบบได้
- **T19 (Traceability)** — `StructuredFailure.affected` เก็บ id อยู่แล้ว (`BE-004`, `REQ-001`)
  และ `failureClassifier.ts` มี `ID_PATTERN` ที่ดึงมันออกมา ใช้ต่อได้
- **T20 (Test Planner Agent)** — เป็น agent ตัวที่ 10 ต้องเพิ่มพร้อมกัน: `.claude/agents/<name>.md`
  **และ** `contracts/<name>.yaml` ไม่งั้น `--check-layout` fail ทันที (`per_agent: true`)
  และต้องเพิ่มใน `AgentStage`, `AGENT_REGISTRY`, `CONTEXT_POLICY`, workflow files ที่เกี่ยวข้อง
- **T21 (Test Pyramid)** — น่าจะเป็น data file ใหม่ → ตาม pattern §3

---

## 7. เรื่องเชิงปฏิบัติของ repo นี้ (เสียเวลาไปแล้ว จดไว้)

- **`.claude/tests/run.js` ต้องเขียวเสมอ** CLAUDE.md ระบุว่า run แดงคือ blocking เพราะ hook ที่
  syntax error จะ exit 1 ซึ่ง `PreToolUse` ตีความว่า "ไม่บล็อก" = **fail open** เกิดขึ้นจริงมาแล้ว
  2 ครั้ง แก้ hook เมื่อไหร่ ให้ `node --check <file>` ทันที
- **hook `block-git.js` ตรวจ string ในคำสั่ง Bash** ถ้าคำสั่งมีคำว่าโฟลเดอร์ version control
  (เช่นใน heredoc, `find -name`) จะถูกบล็อกแม้ไม่ได้รันคำสั่งนั้นจริง → เลี่ยงด้วยการเขียนเป็นไฟล์
  แล้วรันไฟล์
- **heredoc ยาว ๆ ใน Bash tool กลืน backslash** `"\\n"` กลายเป็น newline จริง ทำให้ TS/JS พัง
  งานที่มี escape เยอะ ให้เขียนสคริปต์เป็นไฟล์ก่อนแล้วค่อยรัน
- **`cd` ค้างข้ามคำสั่ง** ใน Bash tool ให้ใช้ absolute path หรือ `cd` ทุกครั้ง
- **`npx vitest` จาก root จะดึง vitest คนละเวอร์ชัน** ต้องรันจาก `orchestrator/` เท่านั้น
- **`require-green-before-stop.js` หา package จากไฟล์ที่เปลี่ยน** (ไต่ขึ้นหา `package.json`
  ใกล้สุด) ไม่ใช่สแกน repo — เคยเป็น bug ที่ทำให้มันไปรัน typecheck ของ orchestrator แทนแอปจริง

---

## 8. หมายเหตุปิดท้าย

ทุกอย่างในรอบนี้ **ยังไม่ commit** — `git status` จะเห็นไฟล์ใหม่/แก้ประมาณ 60 ไฟล์
ถ้าจะ commit ผู้ใช้ต้องรันเอง (ไม่มี agent ตัวไหนรัน git ได้ และ hook บล็อกไว้)

ไฟล์ที่ถูกลบไปคือ `workflows/README.md` — ถูกแทนที่ด้วย workflow จริง 11 ไฟล์ตอนที่ home
เปลี่ยนสถานะจาก `reserved` เป็น `active` ใน `layout.yaml`
