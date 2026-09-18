# Documentation — ดัชนีตามงานที่ต้องทำ

เอกสารชุดนี้เป็นเอกสารสำหรับคนของ Framework repo (`docs/`) — ไม่ ship เข้า workspace
ความหมายเฉพาะทางของ `_docs/` (Knowledge-side module artifacts) อธิบายไว้ที่
[`architecture.md`](architecture.md) § Ownership domains

## เริ่มที่นี่

- ใหม่กับ STA → [`getting-started.md`](getting-started.md) — ติดตั้ง, init workspace, session แรก
- เข้าใจภาพรวม → [`architecture.md`](architecture.md) — Three-Repo + Runtime State, sync model,
  configuration reference

## Workspaces

- ตั้ง workspace / เข้าใจขอบเขตการเขียน → [`workspaces.md`](workspaces.md) — binding Knowledge ↔
  Target, instruction ownership, guardrails
- รีเฟรช knowledge ตามโค้ดจริง → playbook `prompt-update-knowledge.md` (root) — ดู
  [`architecture.md`](architecture.md) หรือ README § AI playbooks
- โมเดล Knowledge เชิงเทคนิค → [`../knowledge/README.md`](../knowledge/README.md) (canonical
  specification — kinds, relations, freshness, reconciliation, role lanes)

## Operate STA

- คำสั่งทั้งสอง surface → [`cli.md`](cli.md) — `software-team-agents` (workspace) + `sta` (pipeline)
- Pipeline / workflow / gates → [`pipeline.md`](pipeline.md)
- มาตรฐาน external ที่ agent แต่ละ role ทำงานเข้า → `policies/standards.md` §1–§10 — อ่านเป็น
  section ด้วย `sta policy standards <role>`; registry แม่ = `STANDARDS_MATRIX.md`
  (maintainer-facing — ไม่ ship ลง payload)
- Runtime support + routing → [`runtimes.md`](runtimes.md)
- Guards + การวินิจฉัย → [`guards.md`](guards.md)
- แก้ปัญหา → [`troubleshooting.md`](troubleshooting.md)

## Deep technical references

- Bounded execution → [`bounded-run.md`](bounded-run.md) (canonical bounded-run manual) ·
  [`bounded-wave-run.md`](bounded-wave-run.md) (record ของ wave run ที่ปลดแล้ว)
- Tier/effort operator manual → [`tier-and-effort-run.md`](tier-and-effort-run.md)
- Canonical PlanTask format → [`plan-task-v1.md`](plan-task-v1.md)
- Execution packet → [`execution-packet-v2.md`](execution-packet-v2.md)
- Design evidence format → [`design-evidence-v1.md`](design-evidence-v1.md)
- เหตุผลเชิงออกแบบ → [`pipeline-rationale.md`](pipeline-rationale.md) (ที่มาของ `CLAUDE.md`) ·
  [`rules-rationale.md`](rules-rationale.md) (28 กฎร่วม)
- Role rationale รายตัว → [`roles/`](roles/)
- Drift ที่ตั้งใจไว้ (non-blocking) → [`known-drifts.md`](known-drifts.md)
- ADR ทั้งหมด → [`../decisions/README.md`](../decisions/README.md)
