# Software Team Agents — Improvement Tasks

เอกสารนี้สรุปงานปรับปรุงระบบ multi-agent orchestration (software-team-agents) จาก
review เดิม แบ่งเป็น Phase ตามความสำคัญ (P0 → P4) แต่ละ task มี ID สำหรับอ้างอิงใน
checklist และใช้เป็น prompt/spec ให้ AI agent ทำงานต่อได้โดยตรง

---

## 🔴 P0 — Core Orchestration (ต้องปรับก่อน)

### T01 — สร้าง Orchestrator กลาง
**ปัญหา:** ตอนนี้ workflow เป็น `User → Agent → User → Agent → User` วนซ้ำ, orchestration
ผูกกับ Claude Code session เป็นหลัก ไม่มีตัวกลางที่ควบคุม flow จริง

**เป้าหมาย:** สร้าง Orchestrator ที่รับผิดชอบ:
- workflow execution
- state management
- routing ระหว่าง agent (BA, SA, PM, Engineer, …)
- retry logic
- approval gate
- dependency resolution
- failure handling
- agent selection

**Output:** โมดูล/โปรเซส orchestrator ที่ agent ทุกตัวเรียกผ่าน ไม่ใช่ agent คุยกันเอง

---

### T02 — ทำ State Machine กลาง (`.workflow/state.yaml`)
**ปัญหา:** state กระจายอยู่ใน `status.md`, `plan.md`, `review.md`, `security.md`,
`deploy.md` — ใช้ดีสำหรับอ่านโดยคน แต่ไม่ควรเป็น source of truth ของ runtime

**เป้าหมาย:** เพิ่มไฟล์ `.workflow/state.yaml` เป็น runtime state หลัก เช่น:
```yaml
phase: backend
status: failed
current_agent: backend-engineer
previous:
  agent: qa-engineer
  result: failed
next:
  agent: backend-engineer
retry:
  count: 1
  max: 2
```
Markdown (`status.md` ฯลฯ) เปลี่ยนบทบาทเป็น **view/documentation ที่ generate จาก state**
ไม่ใช่ source of truth อีกต่อไป (ดู T51)

---

### T03 — Agent Contract (machine-readable)
**ปัญหา:** กฎ input/output/permission ของแต่ละ agent กระจายอยู่ใน prompt/conventions
หลายจุด

**เป้าหมาย:** ทุก agent ต้องประกาศ contract เป็น YAML เช่น:
```yaml
agent:
  name: backend-engineer
input:
  required: [requirement, design, plan]
output:
  required: [code, tests, result]
constraints:
  - must_follow_design
  - no_schema_guessing
permissions:
  read: []
  write: []
```
เก็บไว้ใน `contracts/<agent-name>.yaml`

---

### T04 — แยก concept: Agent / Skill / Policy / Workflow / Orchestrator
**ปัญหา:** `.claude/` เป็นศูนย์กลางของทุกอย่าง (agent, conventions, hooks, scripts,
settings) ทำให้ผสมกันจนดูแลยาก

**เป้าหมาย:** แยก concept ให้ชัดเจน
- Agent = ใคร
- Skill = ทำอะไรได้
- Policy = ห้ามอะไร
- Workflow = ทำเมื่อไหร่
- Orchestrator = ใครทำต่อ

**โครงสร้างเป้าหมาย:**
```
software-team-agents/
├── .claude/
├── agents/
├── skills/
├── policies/
├── workflows/
├── contracts/
├── orchestrator/
└── runtime/
```

---

### T05 — Context Manager
**ปัญหา:** ใช้ `_docs/module/...` เป็นหลัก ซึ่งดี แต่เมื่อ project ใหญ่ agent ต้องอ่าน
context เยอะเกินจำเป็น

**เป้าหมาย:** เพิ่ม Context Manager ที่กรอง Requirement/Design/Plan/Code/Review/
Security/Project Rules → ส่งเฉพาะ "Relevant Context" ให้ agent แต่ละตัว แทนที่จะส่ง
ทุกอย่างให้ทุก agent

---

### T06 — Failure Classification (structured)
**ปัญหา:** QA ส่ง failure กลับไป Frontend/Backend/SA/BA ตามชนิดปัญหา แต่ยังไม่เป็น
structured data

**เป้าหมาย:** ทุก failure ต้องเป็น structured result เช่น:
```yaml
failure:
  category: implementation
  owner: backend-engineer
  severity: high
  retryable: true
  reason: API response mismatch
  affected: [BE-004]
  requires_human: false
```
แล้วให้ Orchestrator (T01) เป็นคนตัดสิน route ต่อ ไม่ใช่ agent ตัดสินเอง

---

### T07 — Retry / Recovery System
**ปัญหา:** ปัจจุบันมีแค่แนวคิด "retry QA สูงสุด 2 รอบ" แบบหลวมๆ

**เป้าหมาย:** สร้างระบบกลาง พร้อมแยกกลยุทธ์ชัดเจน:
```yaml
retry:
  max: 2
  current: 1
recovery:
  strategy: return_to_owner
```
แยก action เป็น 5 ประเภท: **Retry / Recover / Rollback / Escalate / Abort**
(ไม่ใช่แค่ "วน agent อีกรอบ")

---

### T08 — Human Approval เป็น First-class State
**ปัญหา:** มี human gate อยู่แล้ว (requirement, schema, QA failure บางกรณี, security
critical, production deploy) แต่ implement แบบ prompt behavior ไม่ใช่ state จริง

**เป้าหมาย:** เปลี่ยนเป็น state แบบ explicit:
```yaml
approval:
  required: true
  type: security-risk
  status: pending
```
เมื่อ status = `WAITING_FOR_APPROVAL` → Orchestrator **หยุดจริง** ไม่ทำงานต่อจนกว่าจะ
ได้รับการอนุมัติ

---

## 🟠 P1 — Architecture

### T09 — Workflow Definition แยกไฟล์
สร้าง `workflows/feature.yml`, `bugfix.yml`, `refactor.yml`, `hotfix.yml`,
`security-fix.yml` แทนการ hard-code pipeline ใน agent เช่น:
```yaml
workflow: feature
steps: [ba, sa, pm, backend, frontend, qa, security, devops]
```

### T10 — รองรับ Parallel Execution (DAG)
ตอนนี้บังคับ Backend → Frontend เสมอ (เพราะ frontend อ่าน contract จาก backend)
ควรเปลี่ยนเป็น DAG ที่ระบุ dependency จริง เพื่อให้ task ที่ไม่มี dependency กัน
รันขนานกันได้ (เช่น Backend Task A กับ Frontend Task B ที่ไม่ผูกกัน → QA พร้อมกัน)

### T11 — Dependency Graph ระดับ Task
เพิ่ม dependency graph ระดับ task (`Task A → Task B → Task C`) แทนการอิงแค่
Phase 1/2/3 ซึ่งหยาบเกินไปสำหรับ orchestration

### T12 — Agent Capability Registry
เพิ่ม field ให้ agent นอกจาก role เช่น:
```yaml
backend-engineer:
  languages: [csharp, typescript]
  frameworks: [dotnet, ef-core]
  database: [postgres]
  capabilities: [rest-api, grpc, testing]
```
เพื่อให้ orchestrator เลือก agent จาก capability ได้

### T13 — Stack Profile แยกตามเทคโนโลยี
แยกโครงสร้าง `stacks/dotnet/`, `stacks/node/`, `stacks/python/`, `stacks/java/`,
`stacks/frontend/` โดย stack เป้าหมายของโปรเจกต์นี้คือ: .NET 10, C#, EF Core,
PostgreSQL, gRPC, Next.js, React, TypeScript

### T14 — Project Profile (single source)
สร้างไฟล์ project profile เดียวที่ agent อ่านแล้วรู้ tech stack ทันที แทนการเดา:
```yaml
project:
  backend: {language: csharp, framework: dotnet-10}
  frontend: {framework: nextjs, language: typescript}
  database: {type: postgresql}
  api: [rest, grpc]
```

### T15 — Permission Model แบบละเอียด
ขยาย hook ป้องกัน write ปัจจุบันให้ระบุ path ชัดเจนต่อ agent เช่น:
```yaml
backend-engineer:
  write: [src/backend/**, tests/backend/**]
  deny: [infrastructure/**, production/**, database/migrations/**]
```

---

## 🟠 P1 — Documentation / Knowledge

### T16 — Decision Log (ADR)
เพิ่ม `decisions/ADR-001-database.md`, `ADR-002-authentication.md`,
`ADR-003-api-versioning.md` ฯลฯ เพื่อไม่ให้ agent ถามซ้ำเรื่องที่ตัดสินใจไปแล้ว

### T17 — Change Impact Analysis
เมื่อ `design.md` เปลี่ยน ระบบต้อง trace เองว่ากระทบ API → Backend → Frontend →
Tests ใดบ้าง ไม่ใช่ให้ agent discover เอง

### T18 — Versioning ของ Contract
เพิ่ม versioning ให้ design/contract (`design v1`, `design v2`) และให้ task ระบุ
`contract_version` ที่กำลังใช้งานอย่างชัดเจน

### T19 — Requirement Traceability
สร้าง trace chain: Requirement → Design → Task → Code → Test → QA เช่น:
```yaml
REQ-001:
  design: DES-001
  tasks: [BE-001, FE-001]
  tests: [TEST-001]
  status: verified
```

### T20 — Test Planner Agent (ก่อน implementation)
เพิ่ม agent "Test Strategy/Planner" ที่ทำงานก่อน coding ไม่ใช่ QA ตรวจหลังอย่างเดียว:
Requirement → Test Strategy → Implementation → QA

### T21 — Test Pyramid ตาม task type
กำหนดชัดว่า task แต่ละประเภทต้องมี Unit / Integration / API / E2E test ใดบ้าง
แทนที่จะให้ QA ตัดสินใจทุกครั้ง

---

## 🟠 P2 — Quality

### T22 — Static Analysis Gate
เพิ่ม automated gate ก่อนถึง QA: lint, format, typecheck, build, test,
security scan, dependency scan

### T23 — Security เป็น Continuous
เปลี่ยนจาก security เป็น phase เดียว (ก่อน deploy) เป็น check ต่อเนื่อง:
Design (security check) → Code (security scan) → QA → Pre-deploy (security review)

### T24 — Dependency Security
เพิ่ม `npm audit`, `dotnet list package --vulnerable`, SCA, secret scanning

### T25 — Secret Detection
Agent ต้องตรวจก่อนส่งงาน: `.env`, API keys, tokens, password, connection
strings, private keys

---

## 🟠 P2 — Observability

### T26 — Agent Execution Log
บันทึกทุก execution: Agent, Task, Start, End, Model, Tokens, Cost, Result

### T27 — Cost Tracking ต่อ feature
สรุปค่าใช้จ่ายต่อ agent ต่อ feature เช่น BA $0.20, Backend $1.20, … Total $3.55

### T28 — Token / Context Tracking
track context size, input/output tokens, cache hit, model ที่ใช้ — สำคัญมาก
ถ้าใช้ Claude Code ปริมาณมาก

### T29 — Agent Evaluation Benchmark
สร้าง benchmark ที่มี Task / Expected result / Actual result แล้ววัด accuracy,
rework, failure rate, cost, time

### T30 — Agent Quality Score
สรุป score ต่อ agent เช่น Success 91%, First-pass 76%, Rework 18%, Avg cost $0.83
แล้วใช้ข้อมูลจริงมาปรับ prompt

---

## 🟢 P2 — Developer Experience

### T31 — CLI สำหรับ Orchestrator
`agent run feature`, `agent status`, `agent approve`, `agent retry`,
`agent resume`, `agent pause`, `agent cancel`

### T32 — Dashboard
แสดงสถานะแต่ละ agent ต่อ feature แบบ real-time (✅ 🔄 ⏳)

### T33 — Resume หลัง Session ตาย
เมื่อ Agent crash → อ่าน state → หา current task → resume เอง โดยไม่ต้องให้ user
อธิบายใหม่

### T34 — Idempotency
รัน agent ซ้ำต้องไม่สร้าง migration/API/code ซ้ำ ต้องมี `task_id`,
`execution_id`, `status: completed` กำกับ

### T35 — Concurrency Lock
ป้องกัน agent สองตัวเขียนไฟล์เดียวกันพร้อมกัน ด้วย lock ระดับไฟล์

---

## 🟣 P3 — Architecture ขั้นสูง

### T36 — Event-driven Architecture
เปลี่ยนจาก `Agent → Agent` เป็น `Agent → Event → Orchestrator → Next Task`
เช่น `QA_PASSED`, `QA_FAILED`, `SECURITY_FAILED`, `APPROVAL_REQUIRED`,
`DEPLOY_COMPLETED`

### T37 — Event Store / Audit
เก็บ WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION ของทุก event เพื่อย้อนดูการตัดสินใจ
ของ AI ได้

### T38 — Dynamic Routing (classifier-based)
ให้ classifier เลือกปลายทางจากประเภทปัญหา: Implementation bug → Backend,
Contract bug → SA, Requirement bug → BA, Infrastructure bug → DevOps,
Test bug → QA

### T39 — Multi-Agent Review (Creator / Reviewer แยกกัน)
ขยายแนวคิด QA ที่มีอยู่แล้ว ให้งานสำคัญผ่าน Reviewer Agent แยกจาก Creator เสมอ
ไม่ให้ agent ตรวจงานตัวเอง

### T40 — Human Escalation Policy
กำหนด severity → policy ชัดเจน:
```yaml
severity:
  low: {autonomous: true}
  medium: {autonomous: true, max_retry: 2}
  high: {approval: true}
  critical: {approval: true, stop_pipeline: true}
```

---

## 🟣 P3 — Production

### T41 — Multi-project Support
รองรับหลาย project ภายใต้ workspace เดียว

### T42 — Multi-repository Support
orchestrate ข้าม repo ได้ (frontend repo / backend repo / infra repo)

### T43 — Environment Awareness
แยก local / dev / staging / production และ agent ต้องรู้ว่าอยู่ environment ไหน

### T44 — Deployment Approval (prepare vs execute)
แยก "prepare deployment" (devops เตรียม Dockerfile/CI/dry-run ได้) ออกจาก
"execute deployment" (ต้อง human approval เสมอ) — สอดคล้องกับ security
philosophy ปัจจุบันของ repo

### T45 — Rollback Strategy
ทุก deployment ต้องมี health check หลัง deploy → success หรือ failure → rollback

### T46 — Backup / Migration Safety
DB migration ต้องผ่าน: dry-run → backup → approval → execute → verify

### T47 — Disaster Recovery
ต้อง recover ได้เมื่อ Orchestrator crash, Claude API error, Agent timeout,
Database unavailable

---

## 🟣 P4 — ปรับ Repo โดยตรง

### T48 — ลดขนาด `.claude/`
เหลือแค่ `agents/`, `skills/`, `hooks/`, `settings.json` ส่วน workflow/state/
contracts/runtime/orchestrator ย้ายออกไปตามโครงสร้างใหม่ (ดู T04)

### T49 — แตก `conventions.md` เป็นหลาย Policy
```
policies/
├── coding.md
├── git.md
├── architecture.md
├── documentation.md
├── security.md
└── agent-boundaries.md
```

### T50 — เลิกใช้ Markdown เป็น Data Store หลัก
Markdown เหมาะกับ human/review/documentation แต่ไม่เหมาะกับ runtime state,
execution history, task queue, lock, agent status → ย้ายไป JSON/YAML/SQLite

### T51 — `status.md` เป็น Generated View
เปลี่ยนจาก agent เขียน `status.md` เอง เป็น generate จาก Runtime State อัตโนมัติ
เพื่อลด state mismatch

### T52 — `plan.md` เป็น Task Database
เปลี่ยนจาก checkbox-based เป็น structured task record เช่น:
```yaml
id: BE-001
status: in_progress
owner: backend-engineer
depends_on: [SA-001]
```

### T53 — Schema สำหรับเอกสารทุกชนิด
สร้าง `requirement.schema.json`, `design.schema.json`, `plan.schema.json`,
`review.schema.json`, `security.schema.json` เพื่อ validate

### T54 — CI สำหรับ Agent Framework เอง
ทุก PR ต้องตรวจ hook syntax, agent files, schema, workflow, policy, self-test

### T55 — Integration Test เต็ม pipeline
ต่อยอดจาก self-test เดิม (83 cases) เป็น integration test ครอบคลุม
Agent → Workflow → State → QA → Retry → Approval

### T56 — Failure Simulation
จำลอง QA fail, security critical, agent timeout, invalid schema, missing file,
API unavailable แล้วตรวจว่า orchestrator route ถูกต้องหรือไม่

### T57 — Prompt Versioning
เช่น `backend-engineer@v1`, `backend-engineer@v2` พร้อม log ว่า task ใช้
prompt version ไหน

### T58 — Model Routing
ไม่ใช้ model เดียวทุกงาน: simple task → cheap model, architecture → strong
model, code → strong coding model, review → different model

### T59 — Context Compression
เมื่อ document โต ให้ summarizer บีบอัด context แต่ต้องรักษา Decision, Contract,
Open Issue, Constraint ไว้เสมอ

### T60 — Knowledge Retrieval
ใช้ embeddings / vector DB / code search / symbol search เพื่อดึงเฉพาะ
relevant docs/code แทนการโหลด repo ทั้งหมดทุกครั้ง

---

## หมายเหตุการใช้งานร่วมกับ CHECKLIST.md
- ไฟล์นี้ (`TASKS.md`) คือ **spec ฉบับเต็ม** สำหรับ agent ที่ต้อง implement แต่ละ task
- ไฟล์ `CHECKLIST.md` คือ **tracking view** แบบ checkbox แบ่งตาม phase สำหรับติดตาม
  ความคืบหน้า — อัปเดตควบคู่กันเมื่อ task ไหนเสร็จ
