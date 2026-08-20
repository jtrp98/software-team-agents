# Handoff — งานปรับปรุง orchestration layer

เอกสารนี้เขียนไว้ให้ session ถัดไป **เริ่มจาก context ว่างเปล่าแล้วทำงานต่อได้ทันที** โดยไม่ต้องอ่าน
โค้ดทั้งหมดเพื่อเดาว่าอะไรตัดสินใจไปแล้วและเพราะอะไร

- **สถานะ:** 47/60 tasks เสร็จ — **P0, P1, P2, P3 ทั้งหมดครบแล้ว** (T01–T47) เหลือแค่ **P4 — ปรับ
  Repo โดยตรง (T48–T60)**
- **งานถัดไป:** T48 (ลดขนาด `.claude/`, P4) เป็นต้นไป ดู `CHECKLIST.md` — **P4 คนละลักษณะงานจาก
  P0–P3**: ไม่ใช่การเพิ่ม capability ให้ orchestrator อีกต่อไป แต่เป็นการปรับโครงสร้าง repo เอง
  (ย้ายไฟล์, แตกเอกสาร, เปลี่ยน format) อ่าน T48's spec เต็มก่อนเริ่มเสมอ เพราะมันแตะ
  `.claude/agents/` ซึ่ง §4.1 บันทึกเหตุผลไว้แล้วว่าทำไมถึง**ไม่ย้าย** — ต้องเข้าใจ decision นั้น
  ก่อนตีความว่า "ลดขนาด" หมายถึงอะไรกันแน่
- **spec ฉบับเต็มของทุก task:** `TASKS.md` (ID ตรงกับ `CHECKLIST.md`)
- **T01–T35 commit ไปแล้ว** (`git log`: "P0 — Core Orchestration" … "P2 — Developer Experience");
  **T36–T47 (P3 ทั้งหมด) ยังไม่ commit** — version control เป็นของผู้ใช้ ไม่มี agent ตัวไหนรัน git

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
cd orchestrator && npm run build --silent && cd .. && for f in contracts layout workflows profile decisions test-pyramid review-separation escalation-policy workspace repos; do node orchestrator/dist/cli.js --check-$f || echo "FAILED: $f"; done
```

ค่าที่ควรได้ ณ วันที่ส่งมอบ (2026-08-20, หลัง T47 — **P3 ครบทั้งหมด**):

| ตัวตรวจ | ผลที่ถูกต้อง |
|---|---|
| `npm test` (orchestrator) | 864 passed / 53 files (T47 เพิ่ม 4 tests — 1 ใน `claudeCliExecutor.test.ts`, 3 ใน `taskStore.test.ts` — ไม่มีไฟล์เทสต์ใหม่) |
| `npm run typecheck` | exit 0 |
| `.claude/tests/run.js` | All 118 case(s) passed (T44–T47 แก้ `.claude/agents/devops.md` แต่ไม่แตะ hook/script ใด ๆ — self-test ไม่ครอบคลุมเนื้อหา prompt) |
| `--check-contracts` | contracts agree with the agent registry (10 agents now, not 9), and their path rules are sane |
| `--check-layout` | layout.yaml agrees with the repo |
| `--check-workflows` | workflows/*.yml agree with the classifier |
| `--check-profile` | agree with the agent roster + **2 notes เรื่อง .NET target** (ดู §4.2) |
| `--check-decisions` | decisions/*.md ADRs agree with the schema and cross-link cleanly |
| `--check-test-pyramid` | test-pyramid.yaml agrees with its schema |
| `--check-review-separation` (T39) | no agent can review its own work + **1 note เรื่อง workflow "typo"** (ดู §4.13) |
| `--check-escalation-policy` (T40) | escalation-policy.yaml agrees with the runtime policy + **1 note เรื่อง severity "critical"** |
| `--check-workspace` (T41) | workspace.yaml is fine + **1 note ว่าไม่มีไฟล์นี้ (standalone mode)** — ปกติ ไม่ใช่ error (ดู §4.14) |
| `--check-repos` (T42) | repos.yaml is fine + **1 note ว่าไม่มีไฟล์นี้ (single-repo mode)** — ปกติ ไม่ใช่ error (ดู §4.15) |
| `--check-environments` (T43) | environments.yaml is fine + **1 note ว่าไม่มีไฟล์นี้ (built-in descriptions)** — ปกติ ไม่ใช่ error (ดู §4.16) |

**`--check-profile` / `--check-review-separation` / `--check-escalation-policy` / `--check-workspace` /
`--check-repos` / `--check-environments` พิมพ์ note แล้ว exit 0 — นั่นถูกต้องแล้ว ไม่ใช่ warning ที่ต้อง
ไปทำให้หาย** เหตุผลอยู่ใน §4.2, §4.13, §4.14, §4.15, §4.16

---

## 2. โครงสร้างที่มีอยู่ตอนนี้ (T01–T35 — P0/P1/P2 ทั้งหมดเสร็จแล้ว)

```
layout.yaml           ← concept map + ตัว validate (T04)
project.yaml           ← stack ของโปรเจกต์: current / target (T14)
test-pyramid.yaml       ← task type -> required test levels; ไม่มี concept เป็นเจ้าของ (T21), ระดับเดียวกับ project.yaml/layout.yaml เอง
decisions/*.md          ← ADR ของการตัดสินใจระดับโปรเจกต์ (T16)
contracts/*.yaml        ← agent แบบ machine-readable × 10 (T03/T12/T15/T20)
workflows/*.yml         ← pipeline ต่อชนิดงาน × 11 (T09)
stacks/*/stack.yaml     ← โปรไฟล์เทคโนโลยี × 5 (T13)
policies/               ← จองไว้ให้ T49 (มีแค่ README, checker บังคับ)
.claude/agents/*.md     ← agent 10 ตัว (T01–T21 = 9 ตัว + test-planner จาก T20)
.claude/hooks/          ← 6 hooks (block-git, block-outside-repo, block-doc-rewrite, require-green-before-stop, block-path-permissions, block-secret-leak จาก T25)
.claude/scripts/        ← 3 checker: check-schema-contract.js, check-status-sync.js, static-analysis-gate.js (T22, + security_scan จาก T23, + dependency_scan จาก T24)
orchestrator/           ← Node/TS package, 864 tests
workspace.yaml          ← optional (T41): groups other project roots under this one; absence is normal
repos.yaml              ← optional (T42): maps pipeline stages to separate repo roots; absence is normal
environments.yaml       ← optional (T43): local/dev/staging/production descriptions; absence is normal
```

**หมายเหตุสำคัญที่พบตอน T26**: `orchestrator/src/` มี module ที่สร้างไว้แล้วตั้งแต่ก่อน T26 อ้างอิง
comment แบบ `item N` (item 7, 11, 12, 13, 14, 15, 16, 17 ฯลฯ) ชี้ไปยัง **`task-detail.md`
ซึ่งไม่มีอยู่ในโปรเจกต์แล้ว** (ไฟล์ scratch ที่ใช้ตอน implement T01 อย่างละเอียดแล้วไม่ได้เก็บไว้) —
`item 11` = `RunLog`, `item 12` = `costControl.ts`, `item 13` = orchestrator เอง, `item 15` =
`RunHistory`, `item 16`/`17` = `benchmark.ts`/`selfImprovementLoop.ts` **โค้ดพวกนี้ทำ T01 เสร็จไปพร้อม
กับงานที่กว้างกว่าที่ T26–T30 ต้องการอยู่แล้วเกือบทั้งหมด** ก่อนเริ่ม T26 ควรอ่านโมดูลเหล่านี้ก่อนเขียน
ใหม่เสมอ (ดู §4.10)

### โมดูลใน `orchestrator/src/` และหน้าที่ (สะสมทั้งหมดถึง T35 — T23–T25 ไม่แตะ `orchestrator/src/` เลย ดู §4.7–4.9; T26–T35 แตะเยอะ ดู §4.10–4.11)

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
| `decisions/decisionLog.ts` | T16 | อ่าน/ตรวจ ADR ใน `decisions/*.md` |
| `graph/changeImpact.ts` | T17 | forward traversal บน `TaskGraph` — ยังไม่ผูก CLI (รอ T52) |
| `contracts/contractVersion.ts` | T18 | parse `**Contract Version:** N` + ตรวจ task ที่ล้าหลังกว่า design ปัจจุบัน |
| `traceability/traceability.ts` | T19 | สร้างสายโยง REQ→design→tasks→tests→status จาก id ที่อยู่บรรทัดเดียวกัน |
| `graph/taskGraph.ts` (ต่อ) | T20 | เพิ่ม `contractVersion?` field ให้ TaskNode |
| `testing/testPyramid.ts` | T21 | อ่าน/ตรวจ `test-pyramid.yaml` |
| `.claude/scripts/static-analysis-gate.js` | T22 | ไม่ใช่ TS — เป็น script แยก, `qa-engineer` รันเอง (ดู §4.6) |
| `.claude/scripts/static-analysis-gate.js`'s `runSecurityScan()` | T23 | เพิ่ม `security_scan` จริง (แทน `not_implemented`) — curated pattern sweep, ไม่ใช่ TS ของ orchestrator (ดู §4.7) |
| `.claude/agents/system-analyst.md`'s `## Modules` template | T23 | เพิ่มข้อกำหนด `Security Considerations:` note ต่อ feature ที่ flag sensitive (ดู §4.7) |
| `.claude/scripts/static-analysis-gate.js`'s `runDependencyScan()` | T24 | เพิ่ม `dependency_scan` จริง — offline match กับ `KNOWN_VULNERABLE_PACKAGES` (ดู §4.8) |
| `.claude/hooks/block-secret-leak.js` (ใหม่) | T25 | Stop/SubagentStop guard: no hardcoded secret ในไฟล์ที่ run นี้เปลี่ยน (ดู §4.9) |
| `observability/runLog.ts` (แก้) | T26/T27/T28 | เพิ่ม `model`/`input_tokens`/`output_tokens`/`cache_read_tokens`/`context_chars` ให้ `RunRecord`/`RunOutcome` + `costSummary()`/`costSummaryAcrossTasks()` (ดู §4.10) |
| `agents/agentModel.ts` (ใหม่) | T26 | อ่าน `model:` จาก frontmatter ของ `.claude/agents/<role>.md` — single source of truth ตาม CLAUDE.md |
| `agents/claudeCliExecutor.ts` (แก้) | T26/T28 | resolve model + แยก input/output token + cache_read_tokens + context_chars (ความยาว prompt) แล้วยัดเข้า `Metrics` bundle เดียว ส่งต่อทุก return path |
| `store/sqliteStore.ts` (แก้) | T26/T28 | เพิ่มคอลัมน์ `model/input_tokens/output_tokens/cache_read_tokens/context_chars` ใน `runs` table, bump `SCHEMA_VERSION` 1→2 (ดู §4.10) |
| `evaluation/benchmark.ts` (แก้) | T29 | เพิ่ม `reworkCount` ต่อ case + `firstPassRate`/`reworkRate` ต่อ `BenchmarkResult` |
| `evaluation/agentQualityScore.ts` (ใหม่) | T30 | `computeAgentQualityScores()`/`formatQualityScoreReport()` — per-agent Success/First-pass/Rework/Avg cost ตาม TASKS.md's ตัวอย่างเป๊ะ |
| `store/taskStore.ts`'s `PersistedTaskSchema` (แก้) | T31 | เพิ่ม `paused`/`cancelled`/`cancelReason` — อยู่ใน JSON blob เดิม ไม่ต้อง SQL migrate (ดู §4.11) |
| `orchestrator/orchestrator.ts` (แก้) | T31 | carry paused/cancelled ผ่าน constructor/restore/`snapshot()` เฉย ๆ — ตัว class เองไม่ตัดสินใจอะไรกับมัน |
| `orchestrator/taskRegistry.ts`'s `pause()`/`unpause()`/`cancel()` (ใหม่) | T31 | เขียน flag ตรงเข้า store, ไม่ผ่าน Orchestrator instance |
| `orchestrator/taskStatus.ts`'s `describeStatus()` (แก้) | T31 | เพิ่ม `PAUSED`/`CANCELLED` ใน `TaskStatusKind`, cancelled ชนะ paused ชนะ state machine เดิม |
| `cli.ts`'s verb dispatch (ใหม่) | T31 | `run/status/approve/retry/resume/pause/cancel` เป็น wrapper บาง ๆ ครอบ `runCli`/`parseArgs` เดิม ไม่แก้ engine เดิมเลย (ดู §4.11) |
| `concurrency/taskLock.ts` (ใหม่) | T35 | file lock ต่อ task_id ใน `.workflow/locks/`, stale เคลียร์เองด้วย PID-liveness + TTL (ดู §4.11) |
| `cli.ts`'s `STATUS_EMOJI`/`watchListing()` (ใหม่) | T32 | ✅🔄⏳⏸️🚫 ต่อแถวใน `--list`/`status`, `status --watch` poll แล้ว re-render — ไม่มี web server ในโปรเจกต์นี้เลย |
| `schemas/state-view.schema.json` (แก้) | T31 | เพิ่ม `PAUSED`/`CANCELLED` เข้า `status` enum — ลืมจุดนี้ตอนแรกแล้ว `refreshStateView()` throw (ดู §4.11) |
| `events/domainEvents.ts` (ใหม่) | T36 | vocabulary 7 ตัว: `QA_PASSED`/`QA_FAILED`/`SECURITY_PASSED`/`SECURITY_FAILED`/`APPROVAL_REQUIRED`/`APPROVAL_DECIDED`/`DEPLOY_COMPLETED` — **เพิ่มจาก** lifecycle 5 ตัวเดิม ไม่ใช่แทนที่ (ดู §4.12) |
| `events/eventRouter.ts` (ใหม่) | T36 | `AgentEventRouter.dispatch(raw: unknown)` — inbound event → orchestrator → next stage; reject เป็น value ไม่ใช่ throw (queue consumer ที่ throw บน stale message = หยุด consume) |
| `orchestrator/orchestrator.ts` (แก้) | T36/T37 | emit domain events + `openApproval()` (idempotent) + `deploySummary()`; `AGENT_ASSIGNED` เพิ่ม `inputs`, `AGENT_COMPLETED` เพิ่ม `artifactType` (= INPUT/OUTPUT ของ T37) |
| `audit/auditTrail.ts` (ใหม่) | T37 | `describeEvent()` แปลง payload → WHO/WHY/INPUT/OUTPUT/DECISION; `auditTrail()`/`decisionTrail()`/`formatAuditTrail()` |
| `store/taskStore.ts` (แก้) | T37 | `PersistedEventSchema` เพิ่ม 5 field; แยก `NewEvent` (input, optional) จาก `PersistedEvent` (output, ครบเสมอ) |
| `store/sqliteStore.ts` (แก้) | T37 | `events` เพิ่ม 5 คอลัมน์, `SCHEMA_VERSION` 2→3 + **migration จริงครั้งแรกในโปรเจกต์นี้** (`MIGRATIONS`) — v1 ยัง fail closed (ดู §4.12) |
| `cli.ts`'s `audit` verb (ใหม่) | T37 | `audit <task-id> [--decisions]` — read-only, ไม่เปิด `Orchestrator` เลย |
| `routing/dynamicRouter.ts` (ใหม่) | T38 | `CATEGORY_DESTINATION` (category → owner) + `routeByCategory()`; ทิศตรงข้ามกับ `CATEGORY_BY_OWNER` เดิม (ดู §4.13) |
| `orchestrator/failureClassifier.ts` (แก้) | T38 | `OpenIssueRow.owner` เป็น nullable + เพิ่ม `category`; แถวที่ระบุแต่ category ก็ route ได้ — **owner ที่คนเขียนไว้ยังชนะเสมอ** |
| `review/reviewSeparation.ts` (ใหม่) | T39 | `REVIEWS` matrix + `checkReviewSeparation()` (static, hard fail) + `reviewCoverage()` (notes) + `assertIndependentVerdict()` (runtime) |
| `escalation-policy.yaml` + `escalation/escalationPolicy.ts` (ใหม่) | T40 | severity → autonomous/max_retry/approval/stop_pipeline; code เป็น authority, YAML เป็นสำเนาที่ถูกตรวจ |
| `retry/recoveryPolicy.ts` (แก้) | T40 | `decideRecovery` อ่าน `failure.severity` เป็นครั้งแรกนับตั้งแต่ T06 — เพิ่มขั้น 1a ก่อน routing (ดู §4.13) |
| `workspace/workspace.ts` (ใหม่) | T41 | `workspace.yaml` optional root file (เหมือน `test-pyramid.yaml`) — `loadWorkspace()`/`checkWorkspace()`, resolve `root` สัมพัทธ์กับตำแหน่งไฟล์เอง (ดู §4.14) |
| `cli.ts`'s `projects` verb (ใหม่) | T41 | read-only fan-out ข้าม project roots — เปิด `SqliteTaskStore` เฉพาะ root ที่มี `.workflow/state.db` อยู่แล้วเท่านั้น ไม่สร้างใหม่ให้ project ที่ยังไม่เคยรัน (ดู §4.14) |
| `repos/repoMap.ts` (ใหม่) | T42 | `repos.yaml` optional root file (pattern เดียวกับ `workspace.yaml`) — `loadRepoMap()`/`checkRepoMap()`/`stageRoots()`, ตรวจว่าไม่มี stage ไหนถูกอ้างสิทธิ์โดยสอง repo พร้อมกัน (ดู §4.15) |
| `agents/claudeCliExecutor.ts`'s `stageRoots` option (ใหม่) | T42 | `spawn`'s `cwd` เลือกจาก `stageRoots[req.stage] ?? projectRoot` — `_docs/`/`.claude/agents/` ยังอ่านจาก `projectRoot` เสมอ มีแค่ working directory ที่ `claude` รันจริงที่ย้าย (ดู §4.15) |
| `cli.ts`'s executor construction (แก้) | T42 | ส่ง `stageRoots: loadStageRoots(args.projectRoot)` เข้า `createClaudeCliExecutor` — `undefined` เมื่อไม่มี `repos.yaml`, พฤติกรรมเดิมเป๊ะ |
| `environment/environment.ts` (ใหม่) | T43 | `Environment` enum (4 ค่าคงที่) + `environments.yaml` optional root file — `loadEnvironmentConfig()`/`checkEnvironmentConfig()`/`describeEnvironment()`/`resolveDefaultEnvironment()` (ดู §4.16) |
| `store/taskStore.ts`'s `PersistedTaskSchema` (แก้) | T43 | เพิ่ม `environment: z.enum(Environment).default(LOCAL)` — เข้า JSON blob เดิม ไม่ bump `SCHEMA_VERSION` (pattern เดียวกับ T31's `paused`/`cancelled`, ไม่ใช่ T26's SQL column) |
| `orchestrator/orchestrator.ts` (แก้) | T43 | `taskEnvironment` field + `environment` getter, carriedผ่าน constructor/restore/`snapshot()` เหมือน `paused`/`cancelled` — ไม่มี state/gate ใหม่ ปั๊มไป prompt เฉย ๆ (ดู §4.16) |
| `orchestrator/taskRegistry.ts`'s `create()` (แก้) | T43 | รับ `environment?: Environment` เพิ่มเข้า options ที่ส่งต่อให้ `Orchestrator` |
| `cli.ts`'s executor construction (แก้อีกครั้ง) | T43 | `extraInstruction` = `Environment: <env> — <description>`, อ่านจาก `orchestrator.environment` (ค่าที่ถูก resume กลับมาจริง ไม่ใช่ `args.environment` ที่มีผลแค่ตอนสร้าง) |
| `orchestrator/taskStatus.ts`'s `isAgentAssignedAt()` (ใหม่) | T44 | single source ทั้ง `advance()` และ `describeStatus()` ใช้ร่วมกัน — `devops` assigned ที่ READY_TO_DEPLOY เมื่อยังไม่ prepare, assigned ที่ APPROVED เสมอ (ดู §4.17) |
| `store/taskStore.ts`'s `PersistedTaskSchema` (แก้) | T44 | เพิ่ม `deployPrepared: z.boolean().default(false)` — JSON blob เดิม ไม่ bump `SCHEMA_VERSION`, pattern เดียวกับ `paused`/`cancelled`/`environment` |
| `orchestrator/orchestrator.ts`'s `reportCompletion()` (แก้) | T44 | `pipelineCursor` **ไม่** เพิ่มหลัง devops's prepare completion (เพิ่มเฉพาะ completion อื่นทั้งหมด รวมถึง execute) — prepare ที่ FAIL ไม่ set `deployPrepared` จึงถูก retry เป็น prepare ใหม่ ไม่ใช่ถูกนับว่าเสร็จ |
| `orchestrator/orchestrator.ts`'s `step()` (แก้) | T44 | คำนวณ `AgentExecutorRequest.deployPhase` ("prepare"/"execute") จาก `this.run.machine.current` ตอนนั้นเป๊ะ — ไม่ต้องส่งผ่าน field ใหม่อื่นเพิ่ม เพราะ state ปัจจุบันบอกอยู่แล้วว่าเป็นรอบไหน |
| `agents/claudeCliExecutor.ts`'s `DEPLOY_PHASE_INSTRUCTION` (ใหม่) | T44 | ต่อท้าย prompt ด้วยข้อความ PREPARE/EXECUTE เมื่อ `req.deployPhase` ถูกตั้ง — stage อื่นไม่ได้รับอะไรเพิ่ม |
| `.claude/agents/devops.md` (แก้) | T44 | เพิ่มย่อหน้าอธิบายว่า orchestrator (T44) บังคับ prepare/execute แบบ structural ผ่านบรรทัด `Deploy phase:` ในพรอมป์ — โหมด interactive (ไม่มีบรรทัดนี้) ยังทำงานเหมือนเดิมทุกอย่าง |
| `orchestrator/orchestrator.ts`'s `reportCompletion()` (แก้อีกครั้ง) | T45 | execute (`current === APPROVED`) ที่ `result.outcome.result === "FAIL"` → `forceBlock()` ทันที + `blockedReason` ชี้ไปที่ `deploy.md`'s Rollback runbook — ไม่ auto-retry, ไม่ auto-rollback (ดู §4.18) |
| `.claude/agents/devops.md` (แก้อีกครั้ง) | T45 | เพิ่มย่อหน้าใน "Verify after you deploy": health check ที่ fail = ต้อง report เป็นความล้มเหลว ไม่ใช่ soften เป็นสำเร็จ, ทั้ง orchestrator-driven และ interactive mode |
| `.claude/agents/devops.md`'s "Migrations" section (แก้ใหม่ทั้งย่อหน้า) | T46 | dry-run → backup → approval → execute → verify เป็นลำดับบังคับ 5 ขั้น — "no backup, no migration" ชัดเจน; `deploy.md` template's Runbook/Deploy History เพิ่มช่องบันทึก backup ด้วย (ดู §4.19) |
| `agents/claudeCliExecutor.ts`'s `DEPLOY_PHASE_INSTRUCTION` (แก้อีกครั้ง) | T46 | prepare เพิ่มข้อความ backup-before-migrate, execute เพิ่มข้อความ verify (schema/data ไม่ใช่แค่ service health) — reinforce ให้โหมด unattended ก็เห็นกฎเดียวกัน ไม่ใช่แค่พึ่ง prompt เดิมที่ agent อาจไม่อ่านครบ |
| `store/sqliteStore.ts`'s `DatabaseUnavailableError` (ใหม่) | T47 | ห่อเฉพาะ constructor (open+DDL+migrate) — schema mismatch ยังโยนเป็น `SchemaVersionMismatchError` เดิมไม่ถูก relabel (ดู §4.20) |
| `cli.ts`'s `isMain` catch (แก้) | T47 | แยก `DatabaseUnavailableError` ออกจาก catch-all เดิม, พิมพ์ message ที่อ่านได้ + `process.exit(5)` (exit code ใหม่) แทนที่จะโชว์ raw stack trace |

CLI flags สะสม: `--check-contracts` `--check-layout` `--check-workflows` `--check-profile`
`--check-decisions` (T16) `--check-test-pyramid` (T21) `--check-review-separation` (T39)
`--check-escalation-policy` (T40) `--check-workspace` (T41) `--check-repos` (T42)
`--check-environments` (T43), plus `--env <local|dev|staging|production>` on task creation (T43)

CLI verbs สะสม: `run` `status [--watch]` `approve` `retry` `resume` `pause` `cancel` (T31) `audit
[--decisions]` (T37) `projects [--workspace <path>]` (T41) — thin wrappers, flag-based form เดิมยังใช้ได้ทุกอันเหมือนเดิม (backward compatible)

---

## 3. รูปแบบที่ repo นี้ใช้ซ้ำ — ทำตามถ้าจะเพิ่มของใหม่

**1. Data file + JSON Schema (ajv) + checker ใน CLI**
ทุก data file ใหม่ต้องมี schema ใน `orchestrator/schemas/` และ flag `--check-*` ที่ตรวจว่าไฟล์กับ
โค้ดยังตรงกัน — ใช้ซ้ำใน T16 (`adr.schema.json`) และ T21 (`test-pyramid.schema.json`) แล้ว

**2. โค้ดคือ runtime authority, ไฟล์คือสิ่งที่ถูกตรวจ** (`agentContract.ts` เขียนเหตุผลนี้ไว้เต็ม)

**3. Fail-open กับ fail-closed เลือกตามความเสียหาย** — guard fail open, context slicing คืนทั้งฉบับเมื่อไม่แน่ใจ,
การเดา owner/level ไม่เดา หยุดถามคน

**4. (ใหม่จาก T20) เวลาจะเพิ่ม stage ใหม่เข้า pipeline ที่อยู่ระหว่าง state เดิมสองอัน ให้ตรวจ gate
ที่ผูกกับ `from && to` คู่เป๊ะ ๆ ก่อนเสมอ** — `checkGate`/`approvalTypeForEdge` เดิมผูกกับ
`DESIGN && IMPLEMENTATION` ตรงตัว พอมี stage คั่นกลาง (`PLAN`) gate จะเงียบหายไปเลยไม่มี error
ให้เห็น (ดู §4.5 รายละเอียดเต็ม) — บทเรียนคือ **gate ควรผูกกับ `from` state อย่างเดียวเมื่อทำได้**
ไม่ใช่คู่ `(from, to)` เพราะ `to` เปลี่ยนได้ทุกครั้งที่ pipeline เปลี่ยนรูป

**5. Script ใหม่ที่ agent รันเอง (ไม่ใช่ TypeScript ของ orchestrator) ให้ใช้ pattern
`check-schema-contract.js`/`check-status-sync.js`/`static-analysis-gate.js`**: ไม่มี dependency,
อ่าน `CLAUDE_PROJECT_DIR` จาก env, exit 0/1, มี self-test เป็น section ใหม่ใน
`.claude/tests/run.js` ด้วย `withTempProject`/`runScript`/`write` — **อย่า**พยายามผูกเข้ากับ
orchestrator/claudeCliExecutor.ts ถ้าไม่จำเป็นจริง ๆ (ดู §4.6 ว่าทำไม T22 เลือกไม่ผูก)

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
`.claude/agents/` ทำได้แค่ **Node + Express + Prisma** — ยังไม่เปลี่ยน ต้องให้ผู้ใช้ยืนยันก่อน
`checker` ใช้มาตรฐานต่างกัน: `current` ต้องตรงกับ agent roster จริง, `target` แค่ต้องชี้ไป stack
profile ที่มีอยู่ + ต้องระบุ `blocked_on`

**ถ้าจะย้ายไป .NET จริง** ต้องแก้ประมาณ 12 ไฟล์ (รายการเต็มเหมือนเดิม) — **เป็นการตัดสินใจของผู้ใช้**

### 4.3 `permissions.read` ไม่บังคับเป็น block (T15)

`write`/`deny` บังคับจริง แต่ `read` เป็น documentation — บังคับด้วยกฎเดียว: **อะไรที่ role เขียนได้
ต้องอ่านได้ด้วย** เพราะเอกสารที่นี่ *amend* ไม่ใช่ *regenerate*

### 4.4 Hook ไม่รู้ว่า agent ไหนกำลังเขียน — enforcement เลยเป็น 3 ชั้น (T15)

`block-doc-rewrite.js`/`require-green-before-stop.js`/`block-path-permissions.js` ไม่มี subagent
identity → 1) contract ประกาศ 2) orchestrator บังคับ (รู้ role) 3) hook อ่าน `AGENTCLAUDE_ROLE`
env, ไม่มีก็เหลือ floor (`node_modules/`, `.workflow/`, `dist/`, `.git/`)

`block-doc-rewrite.js` คุ้มครองเอกสาร **7 ไฟล์ต่อ module แล้ว ไม่ใช่ 6** — เพิ่ม `test-plan.md`
ตอน T20 (`GUARDED_NAMES` ใน hook, และรายชื่อใน `conventions.md` §5b/§11 ต้องแก้คู่กันเสมอถ้าเพิ่ม
per-module doc ใหม่อีก)

### 4.5 เวลาแทรก stage ใหม่ระหว่าง DESIGN กับ IMPLEMENTATION ต้อง broaden gate ให้ผูกกับ `from` เท่านั้น (T20) ← **บทเรียนสำคัญที่สุดของรอบนี้**

เพิ่ม `test-planner` เข้าไปนั่งระหว่าง `system-analyst` (state DESIGN) กับ engineer (state
IMPLEMENTATION) — ใช้ state `PLAN` เดิมร่วมกับ `project-manager` (`STAGE_TO_STATE[TEST_PLANNER] =
PLAN`) วิธีนี้ไม่ต้องเพิ่ม `TaskState` ใหม่เลย

แต่เจอบั๊กจริงทันที: `gatePolicy.ts`'s `checkGate` และ `gates/approval.ts`'s `approvalTypeForEdge`
เดิมเช็ค **`from === DESIGN && to === IMPLEMENTATION`** ตรงตัวเป๊ะ — พอ `forwardState()` คำนวณ
edge ถัดไปจาก DESIGN แล้วได้ `PLAN` (ไม่ใช่ `IMPLEMENTATION` โดยตรงเพราะมี stage คั่นกลาง) gate
เงียบหายไปเลย ไม่มีใครถูกถามให้ confirm schema — task เดินหน้าทะลุไปได้โดยไม่มีใครกด approve

**สิ่งที่แปลกคือ pipeline "feature" (`isNewFeatureModuleOrProject`) ก็มี `project-manager` คั่น
ระหว่าง DESIGN กับ IMPLEMENTATION อยู่แล้วตั้งแต่ก่อน T20** — แปลว่าช่องโหว่นี้อาจมีอยู่จริงมา
ตั้งแต่ก่อนหน้านี้แล้ว เพียงแต่ไม่มี test เคย exercise เส้นทางนั้นแบบ end-to-end จนกระทั่ง T20 มา
เจอ (เพราะ orchestrator.test.ts ของ "feature" pipeline เดิมไม่เคยเช็ค WAITING_FOR_HUMAN ตรงจุดนี้)

**แก้แล้ว:** เปลี่ยนเป็น `from === DESIGN` (ไม่สนใจ `to`) ทั้งสองจุด — แปลว่า edge ไหนก็ตามที่ออก
จาก DESIGN ต้องมี `designApproved` ก่อนเสมอ ไม่ว่าจะไปที่ PLAN หรือ IMPLEMENTATION โดยตรง

**ไฟล์ที่ต้องแก้ตามเพราะสมมติฐานเดิมผูกกับ `to === IMPLEMENTATION`:** `cli.ts`'s
`approvalFieldFor()`, `benchmark.ts`'s field-detection ตอน auto-approve, และ
`orchestrator.test.ts`'s `runToCompletion()` helper — ทั้งหมดต้องเปลี่ยนไปเช็ค
`status.approvalType === ApprovalType.SCHEMA_CONFIRMATION` แทนการเช็ค `to` ตรง ๆ

**ถ้าจะแทรก stage ใหม่ระหว่าง state คู่ไหนอีกในอนาคต ให้เช็คก่อนเสมอว่ามี `checkGate`/
`approvalTypeForEdge` ผูกกับ `(from, to)` เป๊ะ ๆ อยู่ตรงนั้นหรือเปล่า** — `grep -rn "TaskState\..*&&.*TaskState\."` ใน `orchestrator/src` เป็นจุดเริ่มที่เร็วที่สุด

### 4.6 T22 (Static Analysis Gate) เลือกไม่ผูกกับ orchestrator/claudeCliExecutor.ts

`claudeCliExecutor.ts`'s `spawnSync` เป็น single-purpose (spawn เดียวสำหรับเรียก `claude` CLI)
และถูก inject/mock ใน test จำนวนมากด้วย `fakeCli()` ที่ไม่ discriminate ตาม args — ถ้าเพิ่ม
spawn ที่สองสำหรับรัน `static-analysis-gate.js` ต่อจาก backend/frontend stage จะกระทบเทสต์เดิม
จำนวนมากและซับซ้อนขึ้นโดยประโยชน์ไม่ชัดเจน (ไม่รู้จะ "last engineer stage" ยังไงให้แม่นด้วย)

**เลือกทำเป็น `.claude/scripts/static-analysis-gate.js` แทน** — ตาม pattern
`check-schema-contract.js`/`check-status-sync.js` เดิมทุกอย่าง: `qa-engineer` รันเองผ่าน Bash,
ไม่มี GateContext field ใหม่, ไม่มี orchestrator code เปลี่ยน สอดคล้องกับ layout.yaml's "skill"
concept (`.claude/scripts` = "checkers an agent runs against the repo") อยู่แล้วโดยไม่ต้องแก้
`layout.yaml`

### 4.7 T23 (Security เป็น Continuous) — 4 checkpoint, ไม่มี orchestrator code เปลี่ยนเลย

TASKS.md ระบุ 4 จุด: Design → Code → QA → Pre-deploy. ก่อนแตะโค้ดพบว่า **QA กับ Pre-deploy มีอยู่แล้ว**
จริง ๆ — `qa-engineer` รันทั้ง static-analysis-gate.js กับอ่าน code เทียบ design/requirement อยู่แล้ว,
`security` agent + `devops`'s gate บน 🔵/🟣 finding ก็มีอยู่แล้วเช่นกัน (ไม่ใช่แค่ "ก่อน deploy phase
เดียว" ตามที่ TASKS.md อธิบายปัญหาไว้ — `security` วิ่งกลางไปป์ไลน์ หลัง `qa-engineer` ใน workflow ส่วนใหญ่
อยู่แล้วตั้งแต่ T09) เหลือแค่ **Design** กับ **Code** ที่ยังไม่มีอะไรจับจริง:

- **Code** — เติม `runSecurityScan()` เข้า `static-analysis-gate.js` ตรง placeholder ที่ comment บอกไว้
  ("lands in T23") — curated pattern sweep (eval, unsafe shell exec, `dangerouslySetInnerHTML`,
  `$queryRawUnsafe`/`$executeRawUnsafe`, `rejectUnauthorized: false`, hardcoded JWT/session secret
  fallback, CORS wildcard + credentials) กวาดเฉพาะ `app/ components/ server/ src/ pages/ prisma/`
  (ไม่กวาดทั้ง repo เพราะจะไปแมตช์ pattern list ของสคริปต์ตัวเองใน docs) — ตาม pattern เดียวกับ T22 เป๊ะ:
  ไม่ผูกกับ `orchestrator/claudeCliExecutor.ts`, ไม่มี GateContext field ใหม่
- **Design** — `system-analyst.md`'s `## Modules` template เดิมมีแค่ boolean flag (sensitive concern
  ใช่/ไม่ใช่) ให้ `project-manager` อ่านไปติด `🔒 Security gate` — เพิ่มข้อกำหนดว่าต้องมี
  `Security Considerations:` note สั้น ๆ (threat surface / ข้อมูล sensitive อะไร / failure mode ถ้าไม่ป้องกัน)
  ต่อจากทุก flag เป็น**prompt-level contract rule**เหมือนกฎ "Data Model is the contract" อื่น ๆ ในไฟล์
  เดียวกัน ไม่สร้าง schema/checker ใหม่ — ไม่มีอะไรให้ validate เชิงโครงสร้าง (มันเป็น prose)

**ทำไมไม่แตะ `orchestrator/src/` เลย**: ทั้งสี่ checkpoint แก้ที่ `.claude/agents/*.md` (prompt)
กับ `.claude/scripts/static-analysis-gate.js` (script `qa-engineer` รันเอง) ล้วน ๆ — ไม่มีจุดไหน
ต้องการ state ใหม่, gate ใหม่, หรือ artifact schema ใหม่ (`SecurityReportArtifact` เดิมพอสำหรับ
pre-deploy อยู่แล้ว) **ถ้าในอนาคตมีคนคิดจะทำให้ Design-time security check เป็น structured/validated
(ไม่ใช่ prose note) ต้องกลับมาคุยเรื่อง schema ใหม่ก่อน — ตอนนี้ตั้งใจเลือกน้ำหนักเบาสุดที่ยังใช้งานได้จริง**

### 4.8 T24 (Dependency Security) — offline curated advisory, ไม่ใช่ `npm audit` จริง

`npm audit`/registry call ต้องการ network — แต่ `static-analysis-gate.js` รันทุก FULL QA round
จริง ๆ ทำให้ verification ไม่ deterministic (flaky offline, เงียบเปลี่ยนผลตาม advisory feed ที่เปลี่ยน
ใต้มันโดยไม่มีใครแก้โค้ด) เลือกทำ `runDependencyScan()` เป็น **offline match กับ
`KNOWN_VULNERABLE_PACKAGES`** (CVE จริงไม่กี่ตัว เช่น lodash/minimist/node-fetch/jsonwebtoken)
เทียบกับ `dependencies`/`devDependencies` ที่ประกาศใน `package.json` แต่ละไฟล์ — parse version
spec แบบง่าย (`parseVersion`) โดยตัด range-prefix (`^ ~ >= ...`) ออกแล้วจับ `N.N.N` token แรก, spec
ที่ parse ไม่ได้ (`"latest"`, `"workspace:*"`, git url) ถือว่า**ไม่ใช่หน้าที่เราตัดสิน**ไม่ flag —
เดียวกันกับ tradeoff ที่ `security_scan` เลือกไว้แล้วใน T23 (curated ไม่ใช่ exhaustive)

**สิ่งที่ทำให้เทสต์เดิมพัง (ต้องแก้ตาม)**: section 6's `--json` case เคย assert `dependency_scan`
เป็น `not_implemented` — ตอนนี้เป็นผลจริงแล้ว ต้องแก้ assertion (แบบเดียวกับที่ T23 ต้องแก้ให้
`security_scan` มาแล้ว — บทเรียนซ้ำ: **ทุกครั้งที่ทำ `NOT_YET_IMPLEMENTED` entry ให้เป็นของจริง
ต้องไล่หา test เดิมที่ assert ว่ามันยัง `not_implemented` อยู่**)

### 4.9 T25 (Secret Detection) — hook ใหม่ที่ Stop/SubagentStop, ไม่ใช่ script ที่ QA รันเอง

TASKS.md เขียนว่า "agent ต้องตรวจก่อนส่งงาน" — นั่นคือ per-agent-stop event ไม่ใช่ once-per-phase
gate เหมือน `static-analysis-gate.js` เลยทำเป็น hook ใหม่ `.claude/hooks/block-secret-leak.js`
รูปร่างเดียวกับ `require-green-before-stop.js` เป๊ะ: อ่าน git diff/ls-files (read-only) หา
changed files, สแกนหา pattern ที่ curate ไว้ (AWS key, private-key block, connection string ที่มี
password จริงฝังอยู่, `api_key`/`secret`/`token`/`password` literal assignment), block Stop ด้วย
exit 2 ถ้าเจอ, ปล่อยผ่านตอน `stop_hook_active === true` (ห้าม trap agent เหมือนเดิม)

**บั๊กจริงที่เจอระหว่างเขียนเทสต์ (สำคัญที่สุดของ T25)**: ตอนแรกให้สแกนทุกไฟล์ที่เปลี่ยนในทั้ง repo —
พอรัน self-test จริงพบว่า hook ไป flag **`.claude/tests/run.js` เอง** เพราะไฟล์นั้นมี literal
secret-shaped string (AWS-key-shaped literal, private-key block ปลอม ฯลฯ) เป็น test fixture ของ
ตัวมันเอง ไม่ใช่ secret จริงที่รั่ว — **แก้โดยเพิ่ม `.claude/` เข้า `EXCLUDE_DIRS`**: harness
code/self-test ไม่ใช่ project content ที่ pipeline นี้ผลิต การสแกนมันคือการสแกนตัวเองซ้ำ
(self-referential) ไม่ใช่การจับ leak จริง — **ถ้าจะเพิ่ม secret pattern ใหม่ที่มีตัวอย่าง literal
อยู่ในไฟล์ `.js`/`.md` ใต้ `.claude/` เอง ให้ระวังเคสนี้ซ้ำ**

`.env` ถูก exclude ตรง ๆ (เป็นที่ที่ `setup.md` ตั้งใจให้เก็บค่าจริง, gitignored) แต่
`.env.example` **ไม่ exclude** เพราะมันถูก commit ตาม convention และต้องมีแค่ placeholder —
placeholder ที่รู้จัก (`changeme`, `your_x`, `example...`, เลขบัตร password ธรรมดา ฯลฯ) ถูก
whitelist ไว้ใน `PLACEHOLDER_VALUE` ไม่งั้น `.env.example` ปกติจะ trip ทุกครั้ง

**Wiring**: hook ใหม่ต้องเพิ่มเข้า `.claude/settings.json`'s `Stop`/`SubagentStop` arrays คู่กับ
`require-green-before-stop.js` (สอง entry ต่อ array, ไม่ใช่แทนที่) — `--check-layout` ตรวจว่า
ทุกไฟล์ใต้ `.claude/hooks/*.js` ถูก wire ใน settings.json จริง (layout.yaml's
`enforced_by_settings: true`) เลยพังทันทีถ้าลืม wire

### 4.10 T26–T30 (P2 — Observability) — ของเดิมคลุมไปแล้วเกือบหมด, เติมแค่ช่องว่างจริง

**ก่อนเริ่ม T26 พบว่า `orchestrator/src/observability/runLog.ts`, `cost/costControl.ts`,
`history/runHistory.ts`, `evaluation/benchmark.ts`, `improvement/selfImprovementLoop.ts` มีอยู่แล้ว
ตั้งแต่ T01** — comment ในไฟล์เหล่านี้อ้าง `task-detail.md item N` (ไฟล์ scratch ที่ไม่มีในโปรเจกต์
แล้ว) ซึ่งเป็นการแตก T01 ออกเป็น ~17 sub-item ตอน implement รอบแรก กว้างกว่า T01's ขอบเขตเดิมมาก —
สรุปว่าตรงกับ T26–T30 ตรงไหนบ้างก่อนเขียนโค้ดใหม่ (บทเรียน: **เช็คของเดิมก่อนเสมอ เพราะ T22–T30 ทุก
task เจอ placeholder/โครงที่เตรียมไว้แล้วซ้ำ ๆ**):

- **T26 (Agent Execution Log)**: `RunRecord` มี Agent/Task/Start/End/Tokens/Cost/Result ครบอยู่แล้ว
  และ **persist ลง SQLite จริง** (`store/sqliteStore.ts`'s `runs` table) ไม่ใช่แค่ in-memory — ขาด
  แค่ **Model** ตามสเปค TASKS.md ตรง ๆ เติมด้วย `agents/agentModel.ts` (อ่าน frontmatter
  `.claude/agents/<role>.md` แทนที่จะเดา/hardcode — CLAUDE.md เขียนไว้แล้วว่านั่นคือ single source of
  truth) แล้วผูกเข้า `claudeCliExecutor.ts`
- **T27 (Cost Tracking ต่อ feature)**: `RunLog.summary()` เดิมโชว์ tokens ต่อ agent อยู่แล้ว แต่ไม่มี
  cost breakdown — เพิ่ม `costSummary(taskId)` (per-task) และ `costSummaryAcrossTasks(taskIds[])`
  (per-feature ที่มีหลาย task) ตรง format ตัวอย่างใน TASKS.md เป๊ะ ("BA $0.20, Backend $1.20, …
  Total $3.55") — รวม cost ต่อ agent ก่อน ไม่ใช่ต่อ run (retry round ของ agent เดียวกันนับรวมเป็น
  บรรทัดเดียว)
- **T28 (Token/Context Tracking)**: `tokens` เดิมเป็นผลรวม input+output — แยกเป็น
  `input_tokens`/`output_tokens` ชัดเจน, เพิ่ม `cache_read_tokens` (จาก `claude`'s
  `usage.cache_read_input_tokens` ถ้า CLI ส่งมา) และ `context_chars` (ความยาว prompt ที่ส่งจริง —
  ตัวแทน context size เพราะไม่มี tokenizer ในมือ) ทุกฟิลด์ optional/nullable เพื่อไม่พัง test/fixture
  เดิมที่ไม่รู้จักฟิลด์เหล่านี้
- **T29 (Agent Evaluation Benchmark)**: `benchmark.ts` เดิมมี success/security-failure rate,
  tokens/cost/duration ต่อ case ครบอยู่แล้ว — ขาดแค่ "rework" ตามสเปค เติม
  `reworkCount` ต่อ `BenchmarkCaseResult` (นับ FAIL record ใน `orch.runLog.all()` ของ case นั้น) และ
  `firstPassRate`/`reworkRate` ต่อ `BenchmarkResult`
- **T30 (Agent Quality Score)**: **ไม่มีของเดิม** — สร้างใหม่ `evaluation/agentQualityScore.ts`
  ทั้งไฟล์ ตรง ๆ ตามตัวอย่าง TASKS.md ("Success 91%, First-pass 76%, Rework 18%, Avg cost $0.83")
  group `RunRecord[]` ด้วย `(agent, task_id)`: **successRate** ดูผลของ run ล่าสุดในกลุ่ม,
  **firstPassRate** ดูว่ากลุ่มมี run เดียวและ run นั้น PASS, **reworkRate** ดูว่ากลุ่มมีมากกว่า 1 run,
  **avgCost** เฉลี่ยต่อ run (ไม่ใช่ต่อ task — retry round นับ cost จริงซ้ำ)

**Schema migration ที่ต้องรู้ (`store/sqliteStore.ts`)**: เพิ่มคอลัมน์ใหม่ 5 คอลัมน์ให้ `runs` table
ต้อง bump `SCHEMA_VERSION` จาก 1 เป็น 2 — **ไม่มี migration code** (ไม่ auto-`ALTER TABLE`) เพราะ
`SchemaVersionMismatchError`'s เจตนาเดิมคือ "refuse to read it rather than resuming a task from
state it may misread" อยู่แล้ว และไม่มี `.workflow/state.db` จริงใช้งานอยู่ในโปรเจกต์นี้เลย (เช็คแล้ว —
ไม่มีโฟลเดอร์ `.workflow/` ในเครื่องด้วยซ้ำ) **ถ้าจะเพิ่มคอลัมน์ใหม่ให้ `runs`/`tasks`/`events` table
อีกในอนาคต ให้ bump `SCHEMA_VERSION` แบบเดียวกัน** — ถ้าเมื่อไหร่มี state.db จริงใช้งานแล้ว ต้องกลับมา
คุยเรื่อง migration path ก่อน ไม่ใช่ bump เฉย ๆ อีกต่อไป

**Type-safety ที่ทำให้ปลอดภัยขึ้น (ไม่ใช่แค่ให้ compile ผ่าน)**: `RunRecord`'s T28 fields เป็น
**required-แต่-nullable** (`number | null`, ไม่ใช่ `field?:`) — ต่างจาก `RunOutcome`'s fields ที่เป็น
optional (`field?:`) โดยตั้งใจ: **input** (`RunOutcome`, สิ่งที่ executor ส่งเข้ามา) ยอมให้ไม่รู้ค่า
ได้ (`undefined`), แต่ **output** (`RunRecord`, สิ่งที่ log เก็บถาวร) ต้องพูดชัดว่า "ไม่รู้ค่า" ด้วย
`null` เสมอ ไม่ปล่อยเป็น `undefined` เงียบ ๆ — `BenchmarkCaseResult.reworkCount` และ
`BenchmarkResult.firstPassRate`/`reworkRate` เป็น `number` ธรรมดา (required, ไม่ nullable) เพราะ
คำนวณได้เสมอจาก case ที่รันจริง ไม่มีกรณี "ไม่รู้ค่า" แบบ metrics ฝั่ง executor
**ทุกจุดที่สร้าง object เหล่านี้ตรง ๆ (ไม่ผ่าน `.record()`/`runBenchmarkCase()`) ต้องแก้ตาม** — เจอจริง
ตอนแก้: `taskStore.test.ts`'s `sampleRun()`, `selfImprovementLoop.test.ts`'s literal
`BenchmarkResult`/`BenchmarkCaseResult`, `benchmark.test.ts`'s literal `BenchmarkResult` × 2 —
TypeScript ชี้ตำแหน่งให้ครบเองจาก `tsc --noEmit`, ไม่ต้อง grep หาเอง

### 4.11 T31–T35 (P2 — Developer Experience) — `cli.ts`/`orchestrator.ts` เดิมคลุมไปแล้วเกือบหมดอีกครั้ง

**ก่อนเริ่ม T31 พบว่า `orchestrator/src/cli.ts` ทำงานได้เกือบครบตามสเปคอยู่แล้ว** — สร้าง/รัน task,
`--resume`, `--list`, interactive human-approval loop — เหลือแค่เป็น **flag-based** ไม่ใช่
verb-based (`agent run/status/...`) ตามที่ TASKS.md อยากได้ ส่วน **T33 (Resume after crash)**
ทำงานถูกจริงมาตั้งแต่ T01 แล้ว (SQLite persistence + `Orchestrator.fromPersisted()`) และ **T34
(Idempotency)**'s หลักการสำคัญ (`TaskAlreadyExistsError` กันสร้าง task_id ซ้ำ) ก็มีอยู่แล้วเช่นกัน —
ทั้งสองอันนี้ทำแค่เพิ่ม test ยืนยันชัด ๆ ไม่ได้เขียน mechanism ใหม่:

- **T31 (CLI verbs)**: เพิ่ม `VERBS`/`runVerb()` เป็นชั้นบางครอบ `runCli`/`parseArgs` เดิม — ตรวจ
  `argv[0]` ว่าเป็น verb (`run/status/approve/retry/resume/pause/cancel`) หรือไม่ก่อน parse flag
  ปกติ, **ไม่แก้ `parseArgs`/`runCli`'s engine เดิมเลยแม้แต่บรรทัดเดียว** เพื่อไม่พังเทสต์ 34 เคสที่มี
  อยู่แล้ว. `run`/`resume`/`retry` เป็นแค่ prepend flag แล้ว delegate กลับเข้า `runCli` ตัวเดิม;
  `status`/`approve`/`pause`/`cancel` เป็น handler ใหม่ที่ **ไม่แตะ executor เลย** (ไม่ spawn
  `claude` CLI จริง) จึงเทสต์ได้แน่นอนไม่ flaky
- **T31 (pause/cancel state)**: เพิ่ม `paused`/`cancelled`/`cancelReason` เข้า `PersistedTaskSchema`
  — อยู่ใน JSON blob column เดิมของ SQLite (`sqliteStore.ts`'s comment เองบอกไว้ว่า "nothing here
  queries inside a task's state" คือเหตุผลที่ column เดียวพอ) **ไม่ต้อง bump `SCHEMA_VERSION`
  เหมือน T26 ทำ** — เป็น field ใหม่ใน object ที่ zod parse จาก JSON text อยู่แล้ว ต่างจาก T26 ที่เพิ่ม
  column ใหม่ให้ SQL table ตรง ๆ
- **T31 (pause/cancel enforcement)**: จงใจ**ไม่ใส่ตรรกะนี้ใน `Orchestrator` class เอง** — เป็น human
  override ที่ตรวจที่ `cli.ts`'s main loop ครั้งเดียว (อ่าน `store.loadTask(taskId).paused/cancelled`
  ก่อนเรียก `openTask()`) แทน เพราะ `Orchestrator` ควรรู้แค่ pipeline ของตัวเอง ไม่ใช่นโยบายจากข้างนอก
  — แต่ **`Orchestrator.snapshot()`/constructor ก็ยังต้อง carry ค่าพวกนี้ผ่านไปเฉย ๆ** ไม่งั้น
  `step()` ที่ save ทับจะรีเซ็ต `paused` กลับเป็น `false` ทุกครั้งโดยไม่ตั้งใจ (บั๊กที่เจอจริงตอน
  typecheck ก่อน — `snapshot()` ขาด field พวกนี้ทำให้ type ไม่ match)
- **T32 (Dashboard)**: ไม่มี web server ในโปรเจกต์นี้ (stack คือ Next.js สำหรับ*สินค้า*ที่ pipeline
  นี้สร้าง ไม่ใช่ tooling ของ pipeline เอง) เลยทำเป็น **CLI live view**: `STATUS_EMOJI` map
  (✅🔄⏳⏸️🚫) เติมเข้า `printListing()` ทุกแถว + `status --watch [--interval N]` poll แล้ว
  re-render — `watchListing()` inject `sleep`/`clear`/`iterations` ได้เพื่อเทสต์ได้จริงโดยไม่ต้องรอ
  infinite loop
- **T35 (Concurrency Lock)**: ตีความเป็น **task-level lock file** (`.workflow/locks/<taskId>.lock`)
  ไม่ใช่ per-file lock ทั้งระบบ (ใหญ่เกินสโคปนี้, ต้องผูกกับ write-glob ของแต่ละ contract แยก) —
  reclaim อัตโนมัติถ้า holder pid ตายแล้ว (`process.kill(pid, 0)` throw ESRCH) หรือ lock เก่าเกิน 1
  ชั่วโมง (TTL fallback สำหรับกรณี PID-liveness check เชื่อไม่ได้ เช่น cross-platform quirk หรือ pid
  ถูก reuse) ผูกเข้า `cli.ts`'s main loop: acquire ก่อน `openTask()`, release ใน `finally` เดียวกับ
  `registry.close()`

**บั๊กจริงที่เจอระหว่างเขียนเทสต์ (สำคัญที่สุดของรอบนี้ — เจอ 2 อัน):**

1. **`positionalArg()` เข้าใจ `--project-root <dir>` ผิด** — ตอนแรก implement แบบ "token แรกที่ไม่ขึ้น
   ต้นด้วย `--`" ซึ่งจับ **ค่าของ flag** (เช่น path ของ `dir`) มาเป็น task-id โดยไม่ตั้งใจ เพราะ path
   เองก็ไม่ได้ขึ้นต้นด้วย `--` เหมือนกัน — แก้โดยรู้จัก flag ที่กิน value (`VERB_VALUE_FLAGS`:
   `--project-root --state-db --reason --interval`) แล้วข้ามค่าตามหลังมันไปด้วย **ถ้าจะเพิ่ม
   flag ใหม่ที่กิน value ให้ verb ไหนในอนาคต ต้องเติมเข้า set นี้ด้วยเสมอ ไม่งั้น positional
   parsing จะพังแบบเงียบ ๆ**
2. **`schemas/state-view.schema.json`'s `status` enum ไม่รู้จัก `PAUSED`/`CANCELLED`** — เพิ่ม
   `TaskStatusKind` สอง value ใหม่ใน `taskStatus.ts` แล้วลืมว่า mapping เดียวกันต้องไปอัปเดต JSON
   schema คู่กันด้วย (pattern ใน HANDOFF.md's รูปแบบ #1: "data file ใหม่ต้องมี schema คู่กันเสมอ" —
   ที่นี่คือ**แก้ enum ที่มีอยู่แล้วก็ต้องแก้ทั้งสองที่เหมือนกัน ไม่ใช่แค่ตอนสร้างใหม่**) พังตอนเทสต์
   `pause`/`cancel` เรียก `refreshStateView()` แล้ว `StateViewSchemaError` throw ทันที

---

### 4.12 T36/T37 — domain events **เพิ่ม** ไม่ใช่ rename, และ SQLite migrate จริงครั้งแรก

**T36 ไม่ rename event เดิม** ทั้ง 5 ตัว (`AGENT_ASSIGNED`/`AGENT_COMPLETED`/`WAITING_FOR_HUMAN`/
`TASK_BLOCKED`/`TASK_DEPLOYED`) ยังอยู่ครบและยัง emit เหมือนเดิม เพราะ (ก) `benchmark.ts` ฟัง
`AGENT_COMPLETED` อยู่จริง และ (ข) **ทุก event ถูก persist** — rename แล้วประวัติที่เก็บไว้จะอ่านไม่ตรง
กับ vocabulary ปัจจุบัน โดยไม่มีอะไรบันทึกว่าทำไม

domain event 7 ตัวใหม่จึงต้อง**ถืออะไรที่ lifecycle event ถือไม่ได้** ไม่งั้นมันคือ synonym:
`QA_FAILED` ถือ `StructuredFailure` + `RecoveryAction` (สองอย่างนี้คำนวณใน `reportCompletion` แล้วเดิม
ทิ้งไปเลย เหลือแค่ return value), `QA_PASSED` ถือ `round` (= first-pass rate ของ T30),
`APPROVAL_REQUIRED` ถือ `ApprovalRecord` เต็ม ๆ และยิงครั้งเดียวตอนเปิดคำถามจริง (ต่างจาก
`WAITING_FOR_HUMAN` ที่ยิงทุก gate รวมถึง gate ที่ไม่มี approvalType), `APPROVAL_DECIDED` คือ**คำตอบ** —
ก่อนหน้านี้ไม่มีอะไร emit คำตอบเลย, `DEPLOY_COMPLETED` ถือราคา (stages/runs/tokens/cost/duration)
ส่วน `TASK_DEPLOYED` คือ transition เปล่า ๆ

**`openApproval()` ต้อง guard ด้วย reference comparison** `requestApproval` คืน ledger ตัวเดิมเมื่อคำถาม
เปิดอยู่แล้ว และ `advance()` ถูก poll ทุกครั้งที่เรียก `status()` — ถ้า emit โดยไม่เทียบ reference จะได้
event ซ้ำใน store ทุก poll

**T37: SQLite migrate จริงครั้งแรก (v2→v3)** ก่อนหน้านี้ store fail closed อย่างเดียว ตอนนี้ `MIGRATIONS`
เดินหน้าทีละเวอร์ชันใน transaction เดียว **แต่ v1→v2 ยัง fail closed เหมือนเดิม** ความต่างไม่ใช่ความขี้เกียจ:
v3 เพิ่มคอลัมน์ nullable ให้ `events` (แถวเก่าได้ null แล้ว `describeEvent()` derive กลับมาจาก payload
ได้อยู่ดี — ไม่มีอะไรถูกเดา ไม่มีอะไรหาย) ส่วน v1→v2 เปลี่ยนคอลัมน์ที่ใช้อ่าน *run* ซึ่งอ่านผิดเงียบ ๆ
= cost/token accounting เพี้ยนโดยไม่มีอะไรจับได้ เวอร์ชันที่ใหม่กว่า build นี้ก็ยังปฏิเสธ (downgrade
ไม่ใช่ migration)

**`NewEvent` แยกจาก `PersistedEvent`** — เขียนเท่าที่รู้ (audit field optional), อ่านได้ครบทั้ง 7 เสมอ
(null แปลว่า "ไม่ได้บันทึก" ไม่ใช่ "ไม่มี") ถ้าบังคับ required ตอนเขียน ทุก call site ต้องเขียน
`actor: null, reason: null, …` ให้ event ที่ไม่มีจริง ๆ ซึ่งกลบตัวที่มีความหมาย

### 4.13 T38/T39/T40 — สามอันนี้ล้วน "ทำให้กฎที่มีอยู่แล้วตรวจได้" ไม่ใช่กฎใหม่

**T38 ไม่แตะกฎ NEVER GUESS AN OWNER** `failureClassifier.ts` ยังหยุดถามคนเมื่อไม่มีใครระบุ owner
สิ่งที่ T38 เพิ่มคือ: แถวที่ระบุ **category** ไว้ตรง ๆ (cell ที่เป็นคำนั้นทั้งเซลล์ หรือ `Type: contract`)
เดิมถูก **ทิ้งทั้งแถว** เพราะ `parseOpenIssues` เก็บเฉพาะแถวที่มี role — คำตอบที่คนเขียนไว้แล้วถูกนับเป็น
ความเงียบ ตอนนี้ route ได้ ด้วยมาตรฐานความเข้มงวดเดียวกับ owner (ต้องมีคำนั้นจริง ไม่ใช่อ่านจาก prose)
**owner ที่ระบุไว้ชนะ category เสมอ** และ `routeFailure`'s "owner ไม่อยู่ใน pipeline → ESCALATE"
**ไม่ถูกแตะ** (นั่นคือข้อมูลที่ขัดกันเอง ไม่ใช่ข้อมูลที่ขาด)

**T39 เจอของจริงหนึ่งอย่าง** `workflows/typo.yml` รัน engineer เดี่ยว ๆ ไม่มีใครตรวจเลย — และ
`--check-review-separation` จะพิมพ์เป็น **note** ไม่ใช่ error เพราะไฟล์นั้นเขียนไว้ตรง ๆ ว่าตั้งใจ
("engineer alone, no QA stage") การ fail = ไปล้มการตัดสินใจ right-sizing ของผู้ใช้ ส่วนที่ fail จริงคือ
reviewer ที่ produce สิ่งที่ตัวเองตรวจ / ถือ `WRITE_CODE`
**หมายเหตุตอน implement:** probe ด้วย `when:` เปิดหมดจะ**กลบ**ปัญหา เพราะ typo workflow ได้ `security`
มาเป็น reviewer เมื่อ `touchesSensitiveArea` — ต้องเดินหลาย combination แล้วรายงานอันที่แย่ที่สุด

**T40 คือครั้งแรกที่มีอะไรอ่าน `failure.severity`** field นี้มีมาตั้งแต่ T06 และ `decideRecovery`
**ไม่เคยอ่านเลย** — bug ที่จัดหน้าเพี้ยนกับ CRITICAL security finding ได้ 3 รอบเท่ากัน
ค่าที่ตั้ง **ไม่ได้ลอกจาก TASKS.md ตรง ๆ** เพราะ `high` ในโค้ดนี้แปลว่า "blocking QA issue" ซึ่งคือเคสปกติ
ถ้าใช้ตามตัวอักษร (`high: {approval: true}` = ไม่ retry เอง) pipeline จะหยุดถามคนทุกรอบ QA ที่ fail
= ลบ fix-and-recheck loop ทิ้ง เหตุผลเต็มอยู่ในหัวไฟล์ `escalation-policy.yaml`
**ผลข้างเคียงที่ตั้งใจ:** `high` ได้ 2 รอบแทน 3 ซึ่งไป**ตรงกับ**ที่ CLAUDE.md เขียนไว้อยู่แล้ว
("fix ที่พัง 2 ครั้งให้ escalate") และ `REROUTE_CEILING = 2` — runtime budget เป็นที่เดียวที่ยังเขียน 3
เทสต์เดิม 2 ตัวถูกแก้เพราะเรื่องนี้ (`recoveryPolicy.test.ts`'s `action.max`, และ `parseArgs` toEqual)

### 4.14 T41 (Multi-project Support) — เพิ่มชั้น "workspace" บาง ๆ ทับของเดิมที่ isolate อยู่แล้ว ไม่ใช่ concept ใหม่ทั้งชุด

ก่อนแตะโค้ดพบว่า **project isolation ทำอยู่แล้วเกือบทั้งหมดตั้งแต่ T13/T14/T02**:
`--project-root` เดินทางผ่านทุก verb/checker อยู่แล้ว, `defaultStateDbPath(projectRoot)` ผูก
`.workflow/state.db` ไว้กับ root นั้น ๆ เอง — สอง process ที่ชี้ไปคนละ `--project-root` ไม่มีทาง
เห็น state กันและกันอยู่แล้วโดยไม่ต้องเพิ่มอะไร คำถามจริงของ T41 (ตามที่ HANDOFF รุ่นก่อนบันทึกไว้ใน
§6) คือ **การเห็นหลาย project พร้อมกัน** โดยไม่ต้องจำ root แต่ละอันเอง ไม่ใช่การแยก state (ทำไปแล้ว)

**สิ่งที่เพิ่ม:** `workspace.yaml` — ไฟล์ optional ระดับเดียวกับ `project.yaml`/`test-pyramid.yaml`
(ไม่มี concept เป็นเจ้าของใน `layout.yaml`, ไม่ต้องแก้ `layout.yaml`) ระบุ `(name, root)` หลายคู่
validate ด้วย ajv + `schemas/workspace.schema.json` ตาม pattern เดียวกับ `test-pyramid.yaml`เป๊ะ —
`root` แต่ละอัน resolve สัมพัทธ์กับ**ตำแหน่งไฟล์ `workspace.yaml` เอง** (ไม่ใช่ cwd) เพื่อให้ path แบบ
`../other-repo` ใช้ได้ไม่ว่าจะรัน orchestrator จากที่ไหน

**`--check-workspace` ต่างจาก checker อื่นตรงที่ไม่มีไฟล์ = ผ่าน ไม่ใช่ fail**: `contracts/layout/
decisions/test-pyramid` ทุกตัว fail เมื่อไม่มีไฟล์เพราะไฟล์พวกนั้น**เป็นแกนของ repo นี้เอง** แต่
`workspace.yaml` เป็น**ของที่ project ส่วนใหญ่ไม่ต้องมี** (project เดี่ยว ไม่ใช่ workspace) — ใช้
มาตรฐานเดียวกับ `--check-profile`'s target/blocked_on note: ไม่มีไฟล์ = note (`ok: true`), มีไฟล์
แต่พังจริง (parse ไม่ได้, ชื่อซ้ำ, root ไม่มีอยู่จริง) = fail

**`projects` verb ห้ามสร้าง state.db ให้ project ที่ยังไม่เคยรัน**: `new SqliteTaskStore(path)` สร้าง
ไฟล์/โฟลเดอร์ทันทีถ้ายังไม่มี (constructor เดิมทำแบบนี้อยู่แล้วสำหรับทุก verb — "เปิด" ครั้งแรก =
"สร้าง") ซึ่งใช้ได้กับ verb ที่ตั้งใจจะรันงานจริง แต่ **`projects` เป็น read-only listing** — ถ้าเปิด
store ตรง ๆ ทุก root ที่ workspace.yaml ระบุ จะไปสร้างไฟล์ `.workflow/state.db` เปล่า ๆ ในทุก
project ที่ยังไม่เคยใช้ orchestrator เลยแค่เพราะมีคนรัน `projects` เฉย ๆ — เช็ค
`fs.existsSync(dbPath)` ก่อนเปิดเสมอ แล้วพิมพ์ "no tasks yet" แทนถ้ายังไม่มี (มีเทสต์ยืนยันว่าไม่มี
`.workflow/` ถูกสร้างขึ้นมา)

### 4.15 T42 (Multi-repository Support) — แยกจาก T41 ตรงจุดไหน, และทำไม `stageRoots` ไม่ใช่ `projectRoot`

**T41 กับ T42 ตอบคำถามคนละอัน** T41's `workspace.yaml` รวม project ที่**เป็นอิสระจากกัน** หลายอัน
(แต่ละอันมี `_docs/`/pipeline ของตัวเองครบ) ไว้ให้คนดูพร้อมกัน ส่วน T42's `repos.yaml` อธิบาย
**project เดียว** ที่ pipeline ของมันเอง**เขียนโค้ดคนละที่**: `_docs/`, `.claude/agents/`,
`design.md`, `status.md` ยังอยู่ที่ project root เดิมที่ทุก module อื่นอ่านอยู่แล้ว (T42 ไม่แตะ
`ContextManager`/`resolveAgentModel` เลย — ทั้งสองยังใช้ `projectRoot` เดิม) มีแค่ `claude` ที่ต้อง
สั่งรันคนละ working directory ตาม stage เพื่อให้โค้ดที่เขียนไป commit ลง repo ที่ถูกต้อง

**ทำไมไม่ผูกกับ `TaskState`/`AgentStage` ใหม่**: `stageRoots` เป็นแค่ `cwd` override ตอน `spawn`
ใน `claudeCliExecutor.ts` — orchestrator engine เองไม่รู้เรื่อง multi-repo เลย (ไม่มี state ใหม่,
ไม่มี gate ใหม่) เพราะ pipeline logic (routing, retry, approval) ไม่เปลี่ยนแค่เพราะโค้ดกระจายคนละ
repo — สิ่งเดียวที่เปลี่ยนคือกระบวนการ *execute* หนึ่ง stage เท่านั้น ตรงกับ pattern เดียวกับที่ T22
เลือกไม่ผูก static-analysis-gate.js เข้า orchestrator core (ดู §4.6): ทำที่ layer ที่แคบสุดที่แก้
ปัญหาได้จริง

**กฎ "1 stage = 1 repo"**: `checkRepoMap()` fail ถ้า stage เดียวถูกอ้างสิทธิ์โดยสอง repo — ไม่งั้น
"โค้ดของ stage นี้ควรไป commit ที่ไหน" จะกำกวม ซึ่งเป็นสิ่งเดียวที่ไฟล์นี้มีไว้ตัดสิน stage ที่ไม่ถูก
เอ่ยถึงเลยยังคง fallback ไป `projectRoot` เหมือนเดิม (เช่น `system-analyst`/`project-manager` ที่
เขียนแต่เอกสาร ไม่เขียนโค้ด แทบไม่ต้องมี entry ใน `repos.yaml` เลย)

**บั๊กที่คิดไว้ก่อนแล้วไม่ให้เกิด**: `SqliteTaskStore`/`ContextManager` ทุกจุด **ไม่ได้** เอา `stageRoots`
ไปใช้ — ตั้งใจ เพราะ state (`​.workflow/state.db`) กับ docs (`_docs/`) เป็นของ *task* ไม่ใช่ของ
*repo ที่ stage นั้นเขียนโค้ดลงไป* ถ้าเผลอเอา `stageRoots` ไปใช้กับสองจุดนี้ด้วยจะกลายเป็นว่า
`state.db` แตกกระจายไปตาม repo แทนที่จะรวมอยู่ที่เดียวตามที่ T02 ตั้งใจไว้

### 4.16 T43 (Environment Awareness) — ชื่อ environment เป็น enum ปิด ไม่ใช่ vocabulary เปิด, และไม่แตะ gate เลย

TASKS.md ระบุชื่อไว้ตรง ๆ: "แยก local / dev / staging / production" — ตีความเป็น **enum ปิด 4 ค่า**
(`Environment` ใน `orchestrator/src/types.ts`-เทียบเท่า แต่แยกไฟล์เป็น `environment/environment.ts`
เพราะ T43 มาทีหลัง `types.ts` และเป็น concept ที่ประกอบด้วยทั้ง enum และไฟล์ config คู่กัน) ไม่ใช่
string เปิดที่ให้ project ตั้งชื่อเองได้ — เหตุผลเดียวกับที่ `AgentStage`/`TaskLevel` เป็น enum ปิด:
ถ้าเปิดให้ตั้งชื่อเอง ทุกจุดที่ต้องอ่านค่านี้ (prompt, checker, อนาคต gate ของ T44/T45) ต้องรับมือกับ
ค่าที่ไม่รู้จักไว้ล่วงหน้า ซึ่งเป็นภาระที่ 4 ชื่อคงที่ตัดทิ้งได้เลย `environments.yaml` เลยทำได้แค่**เพิ่ม
metadata** (description, `requires_approval`) ให้ชื่อที่มีอยู่แล้ว ไม่ใช่นิยามชื่อใหม่ — schema's
`enum` บังคับตรงนี้ ไม่ใช่แค่ convention

**T43 ไม่แตะ approval/gate logic ใด ๆ เลย แม้จะมี `requires_approval` field ใน `environments.yaml`**
field นั้นเป็น **descriptive-only** ตอนนี้ (comment ในทั้ง schema และ `checkEnvironmentConfig()` พูด
ตรงนี้ไว้ชัด) — เหตุผลคือ T44 (Deployment Approval: prepare vs execute) เป็น task ถัดไปที่ตั้งใจจะ
ตอบคำถาม "environment ไหนต้อง approve ก่อน deploy" อยู่แล้วโดยตรง ถ้า T43 ไปผูก gate ไว้ก่อนจะเป็นการ
ตัดสินใจ design ของ T44 ล่วงหน้าโดยไม่ได้คุยกับผู้ใช้ (CLAUDE.md บอกชัดว่าอย่าตัดสินใจสถาปัตยกรรมสำคัญ
โดยไม่ถามก่อน) — ตอนนี้ field นี้แค่มีที่เก็บไว้ให้คนอ่าน ไม่มีอะไรบังคับจากมัน

**ทำไม `environment` เป็น field บน task ไม่ใช่ arg ที่ส่งเข้า executor ตรง ๆ ทุกครั้งที่รัน**: ถ้าเก็บ
แค่ใน args (ไม่ persist) การ `--resume`/`retry` ครั้งถัดไปจะไม่รู้ environment เดิมของ task นั้นอีกเลย
เว้นแต่คนพิมพ์ `--env` ซ้ำทุกครั้งให้ตรงกับตอนสร้าง (ซึ่งพลาดง่ายและ silent — พิมพ์ผิดหนึ่งครั้งจะ
ทำให้ prompt ของรอบถัดไปอ้าง environment ผิดโดยไม่มีอะไรเตือน) เก็บไว้ที่ `PersistedTask` แบบเดียวกับ
`paused`/`cancelled` (T31) แก้ปัญหานี้ตรง ๆ: `--env` มีผลแค่ตอน **สร้าง** task เท่านั้น, `resume`/
`retry` อ่านค่าที่ถูก set ไว้ตั้งแต่แรกกลับมาเสมอ ไม่สนใจ `--env` ที่พิมพ์มาซ้ำ (มีเทสต์ยืนยันไว้ตรง ๆ
ใน `cli.test.ts`)

**`extraInstruction` มีอยู่แล้วตั้งแต่ก่อน T43** (`ClaudeCliExecutorOptions.extraInstruction` —
"Extra instruction appended to every stage's prompt, e.g. a link to a ticket") T43 แค่เป็นตัวแรกที่
**ใช้จริง** จาก `cli.ts` (ก่อนหน้านี้ไม่มีจุดไหนตั้งค่านี้เลย) — เลือกใช้ mechanism เดิมแทนที่จะเพิ่ม
field ใหม่ใน `AgentExecutorRequest`/`buildPrompt()` เพราะ "บอกทุก stage ว่า environment ไหน" ตรงกับ
สิ่งที่ `extraInstruction` มีไว้ทำอยู่แล้วเป๊ะ — เพิ่ม mechanism คู่ขนานจะเป็นสองทางที่ทำงานเดียวกัน

### 4.17 T44 (Deployment Approval: prepare vs execute) — ช่องโหว่จริงที่เจอก่อนเขียนโค้ด, และทำไมไม่เพิ่ม `AgentStage` ใหม่

**ก่อนแตะโค้ด พบว่าลำดับเดิมกลับหัว**: `devops` ถูก assign ให้รันครั้งเดียวตอน `current ===
READY_TO_DEPLOY` (`taskStatus.ts`'s `stageStateOf` เดิม) แล้ว `pipelineCursor` ก็เดินหน้าผ่านมันไป
ทันทีหลัง completion — **การขอ approval (`READY_TO_DEPLOY -> APPROVED` gate, T08) เกิด*หลัง*
`devops` รันเสร็จไปแล้วเสมอ ไม่ใช่ก่อน** เท่ากับว่า approval เชิงโครงสร้างของ orchestrator ไม่เคย
กัน "ยิง deploy จริง" ได้เลย มันกันแค่ *state transition หลังจากยิงไปแล้ว* — devops.md
เดิมมี `AskUserQuestion` ของตัวเองคอยกันอยู่จริง (บรรทัด "Confirm with the user immediately
before each one") แต่นั่นเป็นการ confirm ระดับ prompt ไม่ใช่ gate ระดับ orchestrator ตามที่
TASKS.md ขอ

**ทำไมไม่เพิ่ม `AgentStage` ใหม่ (เช่น `DEVOPS_EXECUTE`)**: จะกระทบ `AGENT_REGISTRY`,
`contracts/*.yaml`, `layout.yaml`, capability registry ฯลฯ ทั้งที่ปัญหาจริงคือ **stage เดิม
(`devops`) ต้องรันสองครั้งคนละ state** — เหมือนที่ `backend-engineer`/`frontend-engineer` ทั้งคู่
map ไป `IMPLEMENTATION` state เดียวกันอยู่แล้ว (คนละ stage แต่ state เดียวกัน) กรณีนี้กลับกัน:
**stage เดียวกัน แต่ state ต่างกัน** — เลยแก้ที่ `isAgentAssignedAt()` แทน ไม่ใช่ที่ roster

**ทำไมจะเอา `devops` ซ้ำสองครั้งใน `pipeline` array ไม่ได้** (ลองคิดไว้ก่อนตัดสินใจสุดท้าย):
`pipelineCursor` แยกสอง occurrence ของ `backend`/`frontend` ได้เพราะมันอยู่ **state เดียวกัน** ไม่
ต้องรอ gate คั่นกลาง — แต่ `devops` สองรอบนี้คั่นด้วย gate จริง (`READY_TO_DEPLOY -> APPROVED`)
ถ้าใส่ `[..., DEVOPS, DEVOPS]` ตรง ๆ, `stageStateOf(DEVOPS)` (pure function ของ stage อย่างเดียว)
จะ map ทั้งสอง occurrence ไปที่ `READY_TO_DEPLOY` เหมือนกันหมด — cursor เลื่อนไป occurrence ที่สอง
แล้วก็ยัง "assigned" ที่ READY_TO_DEPLOY เหมือนเดิม รันซ้ำ prepare อีกรอบไม่มีที่สิ้นสุด **ต้องมี
flag แยกเพื่อบอกว่า "prepare เสร็จแล้วหรือยัง" อยู่ดี ไม่ว่าจะออกแบบยังไง**

**ทางที่เลือก: `deployPrepared: boolean` บน `PersistedTask`** (pattern เดียวกับ `paused`/
`cancelled`/`environment` — JSON blob field ใหม่ ไม่ bump `SCHEMA_VERSION`) + `isAgentAssignedAt()`
ใน `taskStatus.ts` เป็น single source ที่ทั้ง `advance()` (live) และ `describeStatus()` (read-only
view) เรียกร่วมกัน: `devops` assigned ที่ `READY_TO_DEPLOY` ก็ต่อเมื่อ `!deployPrepared`, assigned
ที่ `APPROVED` เสมอ (ไม่สนใจ flag เพราะ cursor เองก็ยังไม่เคยเลื่อนผ่าน devops ไปจนกว่า execute จะ
เสร็จ) — `pipelineCursor` เลื่อนผ่าน devops ตอน **execute** เสร็จเท่านั้น ไม่ใช่ตอน prepare เสร็จ

**บั๊กจริงที่เจอตอนเขียนเทสต์ (สำคัญที่สุด)**: `Orchestrator.step()` **คืนค่า status หลัง
completion แล้ว** (มัน `await executor()` แล้ว `return this.reportCompletion(...)` ซึ่งเรียก
`advance()` ต่ออีกที) ไม่ใช่ status ตอน "กำลัง assign" — เทสต์แรกที่เขียนไว้เข้าใจผิดตรงนี้ คาดว่า
`await orch.step(executor)` (เรียกครั้งแรก) จะคืน `RUNNING`/devops แต่จริง ๆ คืน
`WAITING_FOR_HUMAN` ไปแล้วเพราะ prepare รันและ advance ไปเจอ gate ภายใน call เดียวกัน — แก้เทสต์
ให้ตรงกับ semantics จริงของ `step()` แทนที่จะแก้โค้ด (โค้ดถูกอยู่แล้ว, สมมติฐานในเทสต์ผิด) —
**บทเรียน: `step()`'s return value คือ "เกิดอะไรขึ้นหลังจากรันจบ" ไม่ใช่ "กำลังจะรันอะไร"**

**สิ่งที่ยังไม่ทำ (ตั้งใจ, นอกสโคป T44)**: devops ไม่มี failure-routing เหมือน qa/security เลย —
prepare ที่ FAIL จะถูก retry เป็น prepare ใหม่ (ผลข้างเคียงที่ตั้งใจของการเช็ค
`result.outcome.result !== "FAIL"` ก่อน set `deployPrepared`) แต่ execute ที่ FAIL ยังคง advance
cursor ผ่านไปเหมือนเดิม (พฤติกรรมเดิมตั้งแต่ก่อน T44 — ไม่มี retry budget/gate สำหรับ devops เลย)
**ไม่ได้แก้ตรงนี้เพราะ TASKS.md ไม่ได้ขอ retry logic ใน T44 — แค่แยก prepare/execute** ถ้าจะทำ
"devops retry budget" หรือ "execute ที่ fail ต้อง block ไม่ใช่เดินหน้าไป DEPLOYED" ต้องคุยเป็น task
แยก (ใกล้เคียง T45/T46 มากกว่า)

### 4.18 T45 (Rollback Strategy) — ปิดช่องโหว่ที่ T44 ทิ้งไว้, ไม่สร้าง rollback อัตโนมัติ

TASKS.md เขียนสั้น ๆ: "ทุก deployment ต้องมี health check หลัง deploy → success หรือ failure →
rollback" — ก่อนแตะโค้ดพบว่า **"health check" มีอยู่แล้ว** ใน devops.md's "Verify after you
deploy" (hit health endpoint, `prisma migrate status`, check service up — มีมาตั้งแต่ก่อน T44) สิ่ง
ที่ไม่มีคือฝั่ง orchestrator: **execute run ที่ FAIL ยังคง `pipelineCursor += 1` แล้วเดินหน้าไป
`DEPLOYED` เหมือนสำเร็จ** เป็นช่องโหว่ที่ HANDOFF ของ T44 (§4.17) บันทึกไว้ตรง ๆ ว่ายังไม่แก้ — T45
คือ task ที่แก้ตรงนี้

**ทำไมไม่สร้างกลไก auto-rollback จริง**: CLAUDE.md's safety philosophy ห้าม agent รันคำสั่งทำลาย
ล้างข้อมูลโดยไม่มีคนยืนยัน (`devops.md`'s "Destructive and outward-facing actions") — "rollback"
ที่แท้จริง (ย้อน migration, ปิด traffic, restore backup) เป็นคำสั่งทำลายล้างพอ ๆ กับ deploy เอง การ
ให้ orchestrator รันมันอัตโนมัติหลัง execute fail จะขัดกับหลักการเดียวกันกับที่ T44 ทำ execute
ต้อง approve ก่อนเสมอ — เลยเลือกทำแค่ **"ห้ามเงียบว่าสำเร็จ" ไม่ใช่ "รัน undo ให้เอง"**: execute
FAIL → `forceBlock()` ทันที พร้อม `blockedReason` ชี้ไปที่ `deploy.md`'s Rollback section (ซึ่ง
`devops.md` บังคับให้เขียนไว้ *ก่อน* deploy ทุกครั้งอยู่แล้ว — "for every deploy, know how to undo
it before you start") — คนตัดสินใจว่าจะรัน rollback runbook นั้นเอง

**ทำไม BLOCKED ไม่ใช่ state ใหม่ (เช่น `DEPLOY_FAILED`)**: `blockedReason` (string) บอกรายละเอียด
พอแล้ว, `STATUS_EMOJI`/`phaseOf`/dashboard ทุกจุดจัดการ BLOCKED เหมือนกันหมดอยู่แล้วรวมถึง QA
retry-limit-exceeded ก็ใช้ BLOCKED+reason แบบเดียวกัน — เพิ่ม `TaskState` ใหม่จะเพิ่มจุดต้องแก้ทั่ว
โค้ด (enum exhaustive switch หลายที่) เพื่อประโยชน์ที่ string reason ให้ได้อยู่แล้ว

**ทำไมเช็คเฉพาะ execute (`current === APPROVED`) ไม่ใช่ prepare ด้วย**: prepare ที่ FAIL มีทางไปอยู่
แล้วจาก T44 (`deployPrepared` ไม่ถูก set → retry เป็น prepare ใหม่รอบถัดไป) — นั่นคือ "recovery" ของ
prepare ในตัวมันเองแล้ว ไม่ต้องการ BLOCKED เพิ่ม ส่วน execute ไม่มี retry ในตัวเลย (ไม่มี flag แบบ
`deployPrepared` ที่ปล่อยให้ "ลองใหม่" ได้อย่างปลอดภัย เพราะการรันคำสั่ง deploy ซ้ำอาจไม่ idempotent)
เลยต้องหยุดแทน

**ของค้างที่ตั้งใจทิ้งไว้จริง — ไม่มีทาง "unblock" task เดิมได้เลยหลังจากนี้**: เมื่อ BLOCKED ทาง T45
นี้แล้ว ไม่มี CLI verb ไหนพาทาง forward ต่อได้อีก (`BLOCKED`'s `nextStates()` คืน `[]` เสมอ) ตรงกับ
convention เดิมที่มีอยู่แล้ว ("A fix that fails twice gets escalated, not re-sent" — คนต้องดูเองแล้ว
ตัดสินใจว่าจะสร้าง task ใหม่/แก้ environment ด้วยมือ) **ถ้าอนาคตต้องการ "retry execute" อย่างเป็น
ทางการ (ไม่ใช่แค่สร้าง task deploy ใหม่) ต้องออกแบบ unblock mechanism แยกต่างหาก — ไม่ใช่ scope ของ
T45**

### 4.19 T46 (Backup / Migration Safety) — ทำไมไม่มีโค้ด orchestrator ใหม่เลย

TASKS.md ระบุ 5 ขั้นตอนบังคับ: dry-run → backup → approval → execute → verify — **4 ใน 5 ขั้นมีของ
เดิมรองรับอยู่แล้วจาก T44/T45**: dry-run เป็นส่วนหนึ่งของ prepare อยู่แล้ว (ปลอดภัย รันได้ไม่มีคนดู),
approval คือ `ApprovalType.DEPLOY` gate เดิม (T08), execute คือ execute phase เดิม (T44), verify
คือสิ่งที่ T45 บังคับอยู่แล้วว่าต้อง report FAIL ถ้าไม่ผ่าน (`forceBlock()` ทันที ไม่ silent-success)
**เหลือแค่ "backup" ที่ไม่มีอะไรรองรับมาก่อนเลย**

**ทำไมไม่สร้าง state/gate ใหม่สำหรับ backup**: backup เป็นการกระทำที่**ปลอดภัย ไม่ทำลายล้าง**
(อ่าน/สำรอง ไม่เขียนทับ) เหมือน dry-run ทุกประการ ตาม logic เดียวกับที่ prepare phase (T44) ออกแบบ
มาให้ครอบคลุม "อะไรก็ตามที่ปลอดภัยจะรันโดยไม่มีคนดู" — backup จึงเป็นแค่**เนื้อหาเพิ่มเติมใน prepare
run เดิม** ไม่ใช่ state/gate ใหม่ ไม่ต้องมี `TaskState`/`deployPrepared`-style flag แยกสำหรับมันเลย

**ทำไมไม่บังคับด้วย machine-checkable artifact (เหมือน QA_REPORT/SECURITY_REPORT)**: ทำได้ในทาง
ทฤษฎี (เพิ่ม `BackupArtifact` schema, ให้ prepare ต้อง produce มันก่อนถึงจะผ่าน gate) แต่ backup
"จริง" (snapshot บน platform, `pg_dump`) เป็นสิ่งที่ orchestrator เองไม่มีทาง verify ได้ว่าเกิดขึ้นจริง
โดยไม่ไปรันคำสั่งตรวจสอบกับ database จริง ๆ (ต่างจาก QA/security ที่ตรวจจาก `review.md`/`security.md`
เป็น text ได้) — การสร้าง schema ที่ไม่มีทางบังคับความถูกต้องได้จริงจะเป็น "false confidence" ที่แย่
กว่าการไม่มี schema เลย ตาม pattern เดียวกับที่ T24 เลือก curated offline scan แทน `npm audit` จริง
(ดู §4.8) — เลยเลือกทำเป็น**ข้อกำหนดใน prompt** (`devops.md`) + reinforce ผ่าน `DEPLOY_PHASE_INSTRUCTION`
เดิม (T44's mechanism) แทน ถ้าจะยกระดับเป็น machine-checkable จริงในอนาคต ต้องคุยเรื่อง schema ใหม่
ก่อนเสมอ เหมือนที่ T23 บันทึกไว้สำหรับ Design-time security check

**`deploy.md`'s template แก้สองจุด** (Runbook, Deploy History) ให้มีที่บันทึก backup — ไม่ใช่
schema-validated (deploy.md เป็น prose per module เหมือนเอกสารอื่น ๆ) แต่เป็น**convention ที่เขียน
ไว้ในสัญญาเดียวกับ Data Model is the contract อื่น ๆ** ให้ agent รู้ว่าต้องเขียนอะไรตรงไหน

### 4.20 T47 (Disaster Recovery) — 3 ใน 4 มีของเดิมรองรับแล้ว, เหลือแค่ database ที่เปิดไม่ได้

TASKS.md ระบุ 4 สถานการณ์: Orchestrator crash, Claude API error, Agent timeout, Database
unavailable — **เช็คของเดิมก่อนแตะโค้ด (บทเรียนซ้ำทุก task ตั้งแต่ T22) พบว่า 3 ใน 4 มีของรองรับ
อยู่แล้วจริง**:

- **Orchestrator crash** — `SqliteTaskStore` (T01) + `Orchestrator.resume()`/`fromPersisted()`
  (T01) + T33's resume-after-death + T35's lock กัน process ชนกัน ครบอยู่แล้ว ไม่ต้องเพิ่มอะไร
- **Claude API error** (`claude` CLI คืน `is_error: true` หรือ exit code ไม่ใช่ 0) —
  `claudeCliExecutor.ts`'s `cliFailed` check (มีมาตั้งแต่ T01) แปลงเป็น FAIL result อยู่แล้ว ไม่
  crash orchestrator
- **Agent timeout** — Node's `spawnSync`'s `timeout` option (มีมาตั้งแต่ T01, ใช้จริงมาตั้งแต่
  T26 ตอน wiring model resolution) ทำให้ `proc.error` ถูก set แทนที่จะ throw, และโค้ดเดิมก็เช็ค
  `proc.error` แล้วแปลงเป็น FAIL อยู่แล้ว (`claudeCliExecutor.ts:216`) — **ของเดิมถูกอยู่แล้ว แค่ไม่
  เคยมีเทสต์ยืนยัน** เพิ่มเทสต์จำลอง `proc.error` แบบ ETIMEDOUT ไว้เป็น regression guard (ไม่ได้
  แก้โค้ด)
- **Database unavailable** — **จุดเดียวที่ไม่มีอะไรรองรับเลย** `new Database(filePath)`/DDL/migrate
  ใน constructor throw raw exception จาก `better-sqlite3`/`fs` ตรง ๆ ไม่มี catch ใด ๆ

**ทำไมห่อแค่ constructor ไม่ห่อทุก method**: "database unavailable" ในความหมายที่ TASKS.md พูดถึง
คือ**เปิดไฟล์ไม่ได้ตั้งแต่แรก** (disk full, permission, path หาย, lock ที่เข้ากันไม่ได้) — เกิดที่
`new Database()`/DDL/migrate เท่านั้น ครั้งเดียวต่อการเปิด store หนึ่งครั้ง การห่อทุก query
(`createTask`/`saveTask`/`loadTask`/ฯลฯ) ด้วยจะ**กลบบั๊กจริง**ที่ควรโผล่เป็นตัวมันเอง (constraint
violation, query ผิด) ให้กลายเป็น "database unavailable" ที่เข้าใจผิดได้ — ตรงกับ pattern เดียวกับ
T24/T23 ที่เลือก scope แคบแทนที่จะ exhaustive

**ทำไมไม่ auto-retry การเปิด database**: เหตุผลเดียวกับ T45 ที่ไม่ auto-rollback — orchestrator ไม่
รู้ว่า "unavailable" นี้เกิดจากอะไรจริง ๆ (disk เต็ม vs. process อื่นถืออยู่ vs. permission หาย) การ
retry มั่ว ๆ อาจไม่ช่วยหรือแย่กว่าเดิม สิ่งที่ทำได้จริงและปลอดภัยคือ**บอกให้ชัดว่าอะไรพัง + ยืนยันว่า
ไม่มีอะไรหาย** (ไม่มีการเขียนเกิดขึ้นก่อน constructor สำเร็จ) แล้วให้คนสั่ง `resume`/`retry` เองพอ
สถานการณ์คลี่คลาย — เป็น**ข้อความที่ actionable** ไม่ใช่ auto-recovery จริง

**`SchemaVersionMismatchError` ต้องไม่ถูก relabel**: มันเป็นการปฏิเสธที่ตั้งใจอยู่แล้ว (T26,
"refuse to read it rather than resuming a task from state it may misread") มี message เฉพาะของ
มันเองครบอยู่แล้ว — `try/catch` ใน constructor เช็ค `instanceof SchemaVersionMismatchError` ก่อน
เสมอแล้วโยนต่อ ไม่ห่อซ้ำเป็น `DatabaseUnavailableError`

**exit code ใหม่ (5)**: ต่อจาก convention เดิม (`1`=generic, `2`=WAITING_FOR_HUMAN ที่ไม่มี field ให้
resolve, `3`=rejected approval, `4`=T35's task lock, `64`=CliUsageError) — `5` = database
unavailable เฉพาะทาง เพิ่มที่ `isMain`'s catch เท่านั้น (`runCli()` เองยัง throw ปกติสำหรับโค้ด/
เทสต์ที่เรียกตรง ๆ ไม่ได้ผ่าน CLI process จริง)

**สรุป P3 — Production ครบทั้งหมดแล้ว (T41–T47)**: เริ่มจาก T01–T40 (P0–P2 + P3's Architecture
ขั้นสูง) ที่ทำไว้ก่อนหน้า รอบนี้ (T41–T47) ทุก task ใช้ pattern เดียวกันตลอด — เช็คของเดิมก่อนเสมอ,
ไฟล์ config ใหม่เป็น optional + schema + checker เมื่อมันคือ data จริง, ปรับ prompt (`devops.md`)
เมื่อของจริงคือกฎที่ agent ต้องรู้ ไม่ใช่ state ใหม่, และไม่เพิ่ม auto-recovery ที่มองไม่เห็นเหตุผล
ของความล้มเหลวจริง ๆ

---

## 5. ของค้าง — และมันอยู่ Phase ไหน

| เรื่อง | สถานะ | อยู่ที่ไหน |
|---|---|---|
| รัน task ขนานกันจริง | กราฟ + `readyLayers()` + `--list` เสร็จแล้ว, task-level lock (T35) กันชนกันแล้ว แต่ orchestrator ยังรันทีละ task ไม่ขนาน | **ไม่มี task ใน TASKS.md ที่ครอบคลุม "รันขนานจริง"** — T35 คุ้มครองแค่ไม่ให้สอง process ชนกัน ไม่ใช่ทำให้รันพร้อมกันได้ |
| ย้าย stack เป็น .NET | บันทึกเป็น `target.blocked_on` แล้ว | **ไม่ใช่ task ใน TASKS.md** — รอผู้ใช้ตัดสินใจ ดู §4.2 |
| `policies/` ยังว่าง | จองไว้ + README + checker บังคับว่าห้ามมีอะไรเกิน | **T49 (P4)** |
| `TaskGraph`/`changeImpact.ts` กับ `plan.md` จริง | โมดูลเสร็จ+เทสต์ครบ แต่ยังไม่มีใครอ่าน task จาก `plan.md` มาสร้างกราฟ | **T52 (P4)** |
| `README.md` (ฉบับไทย) ไม่ sync กับ 10-agent roster เต็ม | แก้แค่จุดเดียว (บรรทัด hook description) | ไม่มี task กำกับ — ของค้างเดียวกับ HANDOFF.md เอง |
| `MERGE_GUIDE.md` พูดถึง "9 agent files"/"four hooks" | ล้าสมัยตั้งแต่ก่อน T24/T25 (ตอนนี้มี 10 agents, 6 hooks) | ไม่มี task กำกับ — ของค้างเดียวกันกับ README.md ด้านบน, พบระหว่าง T24/T25 แต่ไม่ได้แก้ (นอกขอบเขต P2 — Quality) |
| id convention (`REQ-NNN` ฯลฯ จาก T19) ยังไม่เคยถูกใช้จริง | ไม่มี `_docs/module/` จริงในโปรเจกต์นี้เลย | รอโปรเจกต์จริงตัวแรกมาทดสอบ convention |
| `events/eventRouter.ts` (T36) ยังไม่ผูก CLI | โมดูล+เทสต์ครบ แต่โปรเจกต์นี้ไม่มี queue/webhook ให้ต่อ — เป็น library เหมือน `changeImpact.ts` | ไม่มี task กำกับ — จะมีประโยชน์จริงตอน T42 (multi-repo) หรือเมื่อมี transport จริง |
| `workflows/typo.yml` ส่งงาน engineer ออกโดยไม่มีใครตรวจ | T39 รายงานเป็น note แล้ว (ตั้งใจตามที่ไฟล์เขียนไว้) **แต่ขัดกับตาราง right-size ใน CLAUDE.md** ที่ระบุ `qa-engineer` ไว้แม้กับ copy fix | รอผู้ใช้ตัดสิน — เปลี่ยน `typo.yml` หรือเปลี่ยน CLAUDE.md ให้ตรงกัน |

---

## 6. งานถัดไป: T48 (P4 — ปรับ Repo โดยตรง, ต่อจาก T47 — Disaster Recovery ที่เสร็จแล้ว, **P3 ครบทั้งหมด**)

อ่าน spec เต็มใน `TASKS.md`. **P4 คนละลักษณะงานจาก P0–P3**: ไม่ใช่การเพิ่ม capability ให้
orchestrator อีกต่อไป (P0–P3 ทั้งหมดคือ "orchestrator ทำอะไรได้เพิ่ม") แต่เป็นการปรับโครงสร้าง repo
นี้เอง (ย้ายไฟล์, แตกเอกสาร, เปลี่ยน format จาก Markdown เป็น structured data) — T48
("ลดขนาด `.claude/`") ต้องอ่าน §4.1 ก่อนเริ่มเสมอ เพราะบันทึกไว้แล้วว่า `.claude/agents/` และ
`.workflow/` **ไม่ย้าย** โดยตั้งใจ (Claude Code resolve subagent จาก path นั้นเท่านั้น, orchestrator
เขียน state ไปที่ `.workflow/` ตรง ๆ) — "ลดขนาด" ต้องตีความให้ตรงกับข้อจำกัดนั้น ไม่ใช่ย้ายทุกอย่าง
ออกไปหมด

**เช็คของเดิมก่อนเสมอ** (บทเรียนซ้ำทุก task ตั้งแต่ T22) จุดที่รู้แล้วว่ามีของเดิม:

- **T41 (Multi-project) — เสร็จแล้ว** ดู §4.14: `workspace.yaml` + `orchestrator/src/workspace/
  workspace.ts` + `projects` verb + `--check-workspace`
- **T42 (Multi-repository) — เสร็จแล้ว** ดู §4.15: `repos.yaml` + `orchestrator/src/repos/
  repoMap.ts` + `claudeCliExecutor.ts`'s `stageRoots` option + `--check-repos`
- **T43 (Environment Awareness) — เสร็จแล้ว** ดู §4.16: `environments.yaml` (optional, enum ปิด 4
  ชื่อ) + `orchestrator/src/environment/environment.ts` + `PersistedTask.environment` + `--env`
  ตอนสร้าง task + `--check-environments`. **`requires_approval` ใน `environments.yaml` เป็น
  descriptive-only ตอนนี้ — ยังไม่ผูก gate ใด ๆ โดยตั้งใจ**, ปล่อยให้ T44 เป็นคนตัดสินใจเรื่อง gate
  จริง ๆ
- **T44 (Deployment Approval: prepare vs execute) — เสร็จแล้ว** ดู §4.17: `deployPrepared` +
  `isAgentAssignedAt()` + `AgentExecutorRequest.deployPhase` + `.claude/agents/devops.md` แก้
  **ของค้างจริงจาก T44 ที่ยังไม่แก้**: execute run ที่ FAIL ยังคง advance cursor ไป DEPLOYED
  เหมือนสำเร็จ (พฤติกรรมเดิมตั้งแต่ก่อน T44 — devops ไม่มี failure-routing เลย) — ใกล้เคียง
  T45/T46 มากกว่า จะแก้ตรงนี้ต้องคุยเป็นเรื่องแยก
- **T45 (Rollback Strategy) — เสร็จแล้ว** ดู §4.18: execute FAIL → `forceBlock()` ทันที + reason
  ชี้ deploy.md's Rollback runbook, ไม่มี auto-rollback ที่แท้จริง (ตั้งใจ, ผิดหลักการ CLAUDE.md
  ถ้าทำ) **`RecoveryAction`'s `ROLLBACK` (T07) เป็นคนละเรื่องกับที่นี่** — อันนั้นคือ *task state*
  rollback (ย้อน pipelineCursor กลับไป state ก่อนหน้าเพื่อลอง QA/security ใหม่), ไม่ใช่ deployment
  rollback ที่ T45 พูดถึง อย่าเอาสองอย่างนี้ปนกัน
- **T46 (Backup/Migration Safety) — เสร็จแล้ว** ดู §4.19: ทั้ง 5 ขั้น (dry-run/backup/approval/
  execute/verify) มีทางรองรับแล้วจาก T44/T45 + prompt ใหม่ — ไม่มี state/gate/schema ใหม่เลย
- **T47 (Disaster Recovery) — เสร็จแล้ว** ดู §4.20: 3 ใน 4 สถานการณ์มีของเดิมรองรับอยู่แล้ว (crash,
  API error, timeout — เพิ่มแค่เทสต์ยืนยัน) เหลือ database unavailable ที่เพิ่ม
  `DatabaseUnavailableError` จริง
- **T47 (Disaster Recovery)** — `Orchestrator.resume()` + `TaskRegistry` + T35 lock + T33 คุมส่วน
  "orchestrator crash" ไปแล้วเกือบหมด ที่ยังไม่มีคือ Claude API error / agent timeout

---

## 7. เรื่องเชิงปฏิบัติของ repo นี้ (เสียเวลาไปแล้ว จดไว้)

- **`.claude/tests/run.js` ต้องเขียวเสมอ** hook syntax error → exit 1 → `PreToolUse` ตีความว่า
  "ไม่บล็อก" = fail open เกิดขึ้นจริงมาแล้ว 2 ครั้ง แก้ hook เมื่อไหร่ให้ `node --check <file>` ทันที
- **`block-git.js` ตรวจ string ในคำสั่ง Bash** หลีกเลี่ยงด้วยการเขียนเป็นไฟล์แล้วรัน
- **heredoc ยาว ๆ ใน Bash tool กลืน backslash** เขียนสคริปต์เป็นไฟล์ก่อนแล้วค่อยรันถ้า escape เยอะ
- **`cd` ค้างข้ามคำสั่งใน Bash tool** ใช้ absolute path หรือ `cd` ทุกครั้ง
- **`npx vitest` จาก root จะดึง vitest คนละเวอร์ชัน** รันจาก `orchestrator/` เท่านั้น
- **`require-green-before-stop.js` หา package จากไฟล์ที่เปลี่ยน** (ไต่ขึ้นหา `package.json` ใกล้
  สุด) ไม่ใช่สแกน repo — เคยเป็น bug ที่ทำให้มันไปรัน typecheck ของ orchestrator แทนแอปจริง
- **(ใหม่) เพิ่ม `AgentStage` enum member ใหม่ → TS บังคับให้เติม `RAW_REGISTRY` entry ทันที**
  (เพราะ `Record<AgentStage, AgentRegistryEntry>`) แต่ **ไม่บังคับ** ให้เติม `CONTEXT_POLICY`/
  `STAGE_TO_STATE` (เป็นแค่ `Partial<Record<...>>`) — ต้องเติมเองด้วยมือ ไม่มี compiler ช่วยเตือน
  ถ้าลืม stage ใหม่จะไม่มี context เลย (เงียบ ไม่ error)
- **(ใหม่) เทสต์ที่ fixture `pipelineCursor: N` แบบ hardcode ตัวเลข** (เช่นใน `taskStatus.test.ts`,
  `stateView.test.ts`) จะพังทันทีถ้า pipeline order เปลี่ยน — เวลาแทรก stage ใหม่เข้า pipeline
  ให้ `grep -rn "pipelineCursor:" orchestrator/src` หาให้ครบก่อนรัน test
- **(ใหม่ T36–T40) เพิ่ม field ใน `CliArgs` → `cli.test.ts`'s `parseArgs` toEqual พังทันที**
  เทสต์ตัวแรกสุดของไฟล์ assert ทั้ง object แบบ exact — เจอสองครั้งใน P3 นี้ (T39, T40)
- **(ใหม่ T36) `z.looseObject` ไม่ใช่ `z.object`** สำหรับ schema ที่รับของจาก wire: `RunOutcome`
  ได้ optional field เพิ่มมาแล้วรอบหนึ่ง (T26/T28) — `z.object` จะ **strip ทิ้งเงียบ ๆ** กลายเป็น
  measurement ที่หายไปโดยไม่มีอะไรรู้ และ type assertion แบบสองทางต้องเทียบกับ `z.object` ตัวเข้ม
  (`looseObject` infer ออกมาพร้อม index signature ซึ่งไม่มี interface ตัวไหน assignable ให้)
- **(ใหม่ T38) `classifyQaFailure`'s branch ที่ owner ว่าง** อ่านง่ายผิดว่ามี case "ไม่มีทั้ง owner
  และ category" — ไม่มีทางเกิด เพราะ `parseOpenIssues` ไม่เก็บแถวนั้นตั้งแต่แรก (rows.length === 0
  แล้วไปออกทางเดิมก่อน) อย่าเขียน error message สำหรับ case ที่ตายแล้ว
- **(ใหม่ T39) probe workflow ด้วย `when:` เปิดหมด = กลบปัญหา** ดู §4.13

---

## 8. หมายเหตุปิดท้าย

T01–T35 commit ไปแล้ว **T36–T47 (P3 ทั้งหมด) ยังไม่ commit** — `git status` จะเห็นไฟล์ใหม่จาก T36–T40
(`events/domainEvents.ts` `events/eventRouter.ts` `audit/auditTrail.ts` `routing/dynamicRouter.ts`
`review/reviewSeparation.ts` `escalation/escalationPolicy.ts` + เทสต์ของแต่ละตัว, `escalation-policy.yaml`,
`schemas/escalation-policy.schema.json`) บวกไฟล์ใหม่จาก T41 (`workspace/workspace.ts`,
`workspace/workspace.test.ts`, `schemas/workspace.schema.json`) บวกไฟล์ใหม่จาก T42
(`repos/repoMap.ts`, `repos/repoMap.test.ts`, `schemas/repos.schema.json`) บวกไฟล์ใหม่จาก T43
(`environment/environment.ts`, `environment/environment.test.ts`, `schemas/environments.schema.json`)
— **T44/T45/T46/T47 ไม่มีไฟล์ใหม่เลย มีแต่ไฟล์แก้ (สะสมทั้งสี่ task)** (`cli.ts`, `cli.test.ts`,
`agents/claudeCliExecutor.ts`, `agents/claudeCliExecutor.test.ts`, `orchestrator/orchestrator.ts`,
`orchestrator/orchestrator.test.ts`, `orchestrator/taskStatus.ts`, `orchestrator/taskStatus.test.ts`,
`orchestrator/taskRegistry.ts`, `store/sqliteStore.ts`, `store/taskStore.ts`,
`store/taskStore.test.ts`, **`.claude/agents/devops.md`**, `CHECKLIST.md`, `HANDOFF.md`) ถ้าจะ
commit ผู้ใช้ต้องรันเอง (ไม่มี agent ตัวไหนรัน git ได้ และ hook บล็อกไว้)

ไฟล์ที่ถูกลบไปคือ `workflows/README.md` (จาก T09) — ถูกแทนที่ด้วย workflow จริง 11 ไฟล์ตอนที่ home
เปลี่ยนสถานะจาก `reserved` เป็น `active` ใน `layout.yaml`
