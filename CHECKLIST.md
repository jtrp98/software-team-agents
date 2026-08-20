# Checklist — Software Team Agents Improvement

รายละเอียดแต่ละ task ดูที่ `TASKS.md` (ID ตรงกัน เช่น T01)

สถานะปัจจุบันและบริบทสำหรับทำงานต่อ — รวมการตัดสินใจที่ทำไปแล้วและเหตุผล — อยู่ที่ `HANDOFF.md`

## 🔴 P0 — Core Orchestration (ทำก่อน — บล็อกงานอื่น)
- [x] T01 — สร้าง Orchestrator กลาง
- [x] T02 — ทำ State Machine กลาง (`.workflow/state.yaml`)
- [x] T03 — Agent Contract (machine-readable)
- [x] T04 — แยก concept Agent / Skill / Policy / Workflow / Orchestrator
- [x] T05 — Context Manager
- [x] T06 — Failure Classification (structured)
- [x] T07 — Retry / Recovery System
- [x] T08 — Human Approval เป็น First-class State

## 🟠 P1 — Architecture
- [x] T09 — Workflow Definition แยกไฟล์ (`workflows/*.yml`)
- [x] T10 — รองรับ Parallel Execution (DAG)
- [x] T11 — Dependency Graph ระดับ Task
- [x] T12 — Agent Capability Registry
- [x] T13 — Stack Profile แยกตามเทคโนโลยี
- [x] T14 — Project Profile (single source of truth)
- [x] T15 — Permission Model แบบละเอียด

## 🟠 P1 — Documentation / Knowledge
- [x] T16 — Decision Log (ADR)
- [x] T17 — Change Impact Analysis
- [x] T18 — Versioning ของ Contract
- [x] T19 — Requirement Traceability
- [x] T20 — Test Planner Agent
- [x] T21 — Test Pyramid ตาม task type

## 🟠 P2 — Quality
- [x] T22 — Static Analysis Gate
- [x] T23 — Security เป็น Continuous
- [x] T24 — Dependency Security
- [x] T25 — Secret Detection

## 🟠 P2 — Observability
- [x] T26 — Agent Execution Log
- [x] T27 — Cost Tracking ต่อ feature
- [x] T28 — Token / Context Tracking
- [x] T29 — Agent Evaluation Benchmark
- [x] T30 — Agent Quality Score

## 🟢 P2 — Developer Experience
- [x] T31 — CLI สำหรับ Orchestrator
- [x] T32 — Dashboard
- [x] T33 — Resume หลัง Session ตาย
- [x] T34 — Idempotency
- [x] T35 — Concurrency Lock

## 🟣 P3 — Architecture ขั้นสูง
- [ ] T36 — Event-driven Architecture
- [ ] T37 — Event Store / Audit
- [ ] T38 — Dynamic Routing (classifier-based)
- [ ] T39 — Multi-Agent Review (Creator/Reviewer แยกกัน)
- [ ] T40 — Human Escalation Policy

## 🟣 P3 — Production
- [ ] T41 — Multi-project Support
- [ ] T42 — Multi-repository Support
- [ ] T43 — Environment Awareness
- [ ] T44 — Deployment Approval (prepare vs execute)
- [ ] T45 — Rollback Strategy
- [ ] T46 — Backup / Migration Safety
- [ ] T47 — Disaster Recovery

## 🟣 P4 — ปรับ Repo โดยตรง
- [ ] T48 — ลดขนาด `.claude/`
- [ ] T49 — แตก `conventions.md` เป็นหลาย Policy
- [ ] T50 — เลิกใช้ Markdown เป็น Data Store หลัก
- [ ] T51 — `status.md` เป็น Generated View
- [ ] T52 — `plan.md` เป็น Task Database
- [ ] T53 — Schema สำหรับเอกสารทุกชนิด
- [ ] T54 — CI สำหรับ Agent Framework เอง
- [ ] T55 — Integration Test เต็ม pipeline
- [ ] T56 — Failure Simulation
- [ ] T57 — Prompt Versioning
- [ ] T58 — Model Routing
- [ ] T59 — Context Compression
- [ ] T60 — Knowledge Retrieval

---
**สรุปจำนวน:** 60 tasks — P0: 8 · P1: 13 · P2: 13 · P3: 12 · P4: 13
