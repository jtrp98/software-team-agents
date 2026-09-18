# Pipeline — workflow, task lifecycle, gates และ recovery

เอกสารนี้เป็น canonical home ของ pipeline ฝั่ง `sta`: การเลือก workflow, task lifecycle, human approval
gates และ recovery เส้นแบ่งสำคัญที่สุด:

- **Interactive** — `software-team-agents open` เปิด session จาก Knowledge workspace ไม่มี orchestrator
  คุม lifecycle
- **Orchestrated** — `sta run` / `sta bounded-run` เดิน workflow ตาม `workflows/*.yml` มี gate, ledger
  และ audit trail

## Workflow classification — right-sizing

Human เลือกประเภทงานผ่าน classification flags แล้ว orchestrator เดิน workflow ที่ right-size:

```bash
sta run --task-id T-1 --module demo --bug-fix --backend --autonomy edit \
  --backend-target sb-web-helper \
  --project-root C:\src\company-knowledge     # three-repo mode: project-root คือ Knowledge root
```

| flag | workflow | chain | ฐานหลักฐาน right-sizing |
|---|---|---|---|
| `--typo` | `typo.yml` (TRIVIAL) | engineer เท่านั้น ไม่มี QA | **Judgement** — P3 ไม่มีหมวด typo/copy |
| `--bug-fix` | `bugfix.yml` (SMALL) | engineer → QA (+security เมื่อ sensitive) | **Judgement retained; P3 insufficient** — bug ทุก attempt ไม่ผ่าน frozen oracle และ C-token ไม่ถูกรายงาน |
| `--incremental` | `incremental.yml` (MEDIUM) | — | **Judgement** — P3 ไม่ได้แยก incremental workflow |
| `--business-rule` | `business-rule.yml` (MEDIUM) | BA → SA → engineer → QA | **Judgement** — P3 ไม่ได้แยก business-rule workflow |
| `--new-feature` | `feature.yml` (LARGE_CRITICAL) | BA → SA → PM → test-planner → engineer → QA (full chain) | **Judgement retained; P3 insufficient** — feature ทุก attempt ไม่ผ่าน frozen oracle และ C-token ไม่ถูกรายงาน |
| `--schema` | `schema-change.yml` (LARGE_CRITICAL) | SA → test-planner → engineer → QA | **Judgement** — P3 ไม่ได้แยก schema-change workflow |
| `--deploy` | `deploy.yml` | + devops, gated | **Judgement** — P3 ไม่มี deploy task |
| (classifier) | `hotfix.yml`, `refactor.yml`, `security-fix.yml`, `triage.yml` | classifier เลือกตาม signal/priority | **Judgement retained; P3 insufficient** — refactor/investigation ไม่มี oracle pass/C-token; hotfix/security ไม่ถูกทดลอง |

`workflows/*.yml` เป็น generated output ของ classifier — `sta --check-workflows` ตรวจ byte-match
(ADR-007) flag เสริมได้แก่ `--sensitive`, `--backend`, `--frontend` — step ภายใน workflow ถูกเลือกด้วย
`when:` (เช่น `touchesBackend`) ตามที่ประกาศในไฟล์ workflow เอง

P3 ไม่ได้พิสูจน์ว่าหมวดใดชนะหรือแพ้ จึงไม่เปลี่ยน route และไม่สร้าง automatic bypass; ถ้าหลักฐานใน
อนาคตพบหมวดที่แพ้ ให้เสนอ `workflows/*.yml` ที่สั้นลงผ่านกลไกเดิม ไม่เพิ่ม decision axis ใน router

pipeline ที่มี design phase (`--new-feature`, `--schema`, `--business-rule`, `--incremental`) รัน
**`uxui-designer` ก่อน `frontend-engineer`** เสมอ; typo/bugfix/hotfix/refactor/security-fix ไม่มี uxui
step — frontend work level TRIVIAL/SMALL จึงไม่โดน UX-artifact gate

## Bounded run

`sta bounded-run` compile + freeze plan scope ใน transaction เดียว แล้วเดิน DAG ผ่าน
DEV → deterministic verification → checkpoint → coherent QA/repair; ไม่ push/merge/rollback —
คู่มือฉบับเต็มอยู่ที่ [`bounded-run.md`](bounded-run.md) (record ของ wave run เดิมที่ปลดไปแล้วอยู่ที่
[`bounded-wave-run.md`](bounded-wave-run.md))

## Human approval gates

gate สำคัญหยุดรอคนจริง:

- requirement interview (material unresolved business choice หรือ missing authority)
- schema confirmation
- UXUI sign-off (frontend work ที่มี design phase)
- QA ไม่ผ่าน — รอบ 1-2 วนกลับ engineer อัตโนมัติ; ครั้งที่ 3 หรือ Critical หยุดรอคน
- security finding Critical/Important
- deploy/migration จริง

การอนุมัติเป็น **record** (type/status/who/when) — reject คือ record ที่ block งาน ไม่ใช่ flag ·
pipeline แบบ orchestrated chain `qa-engineer` (ทุกงานที่แตะ code) และ `security` (sensitive/schema)
ให้อัตโนมัติ — ที่เป็น human gate คือ *คำตัดสิน* ของสองตัวนี้ ไม่ใช่การเรียกใช้

resolve gate ด้วย `sta approve <task-id> [--yes|--no]`; task ที่ parked (exit 4) รอ gate นี้อยู่

## Roles ใน pipeline

สิบเอ็ด role แต่ละตัวเป็นเจ้าของ artifact เดียว ไม่มีตัวใดเรียกตัวถัดไปได้ — ตาราง role/reads/writes
อยู่ที่ [`CLAUDE.md`](../CLAUDE.md) § Roles และเหตุผลเชิงลึกที่ [`pipeline-rationale.md`](pipeline-rationale.md)
role docs รายตัวอยู่ที่ [`roles/`](roles/) · lane approvals/signoffs (BA · SA · UXUI · DEV) ใช้
`sta roles ...` — ดู [`cli.md`](cli.md) § Roles

## Failure / recovery

Retry (รอบ owner จาก review.md) · Recover (ถอยไป stage ก่อนหน้าที่ task เคยผ่าน) · Rollback (กลับสู่
last verified state) · Escalate (ให้คนแก้) · Abort (หมด retry budget) — ประกาศใน
`escalation-policy.yaml` ตรวจด้วย `sta --check-escalation-policy`

## Design sources (uxui-designer)

`uxui-designer` เป็น **read-only consultant** — วิเคราะห์ design source แล้วผลิต draft `UX-*` +
`_docs/module/<name>/uxui/**` คนเท่านั้น approve/sign-off คำถามนอกหน้าที่ถูก route กลับอัตโนมัติ
(คุ้มค่าไหม → BA · ทำได้ไหม → SA; ไม่มี BA/SA ใน pipeline นั้น → BLOCKED fail-closed)

Design source เข้าถึง agent ได้ 3 ทาง (ห้าม scrape URL):

1. **Path A — handoff bundle**: คนวาง export/handoff จาก Claude Design ไว้ที่
   `knowledge/_sources/design/<module>/handoff/`
2. **Path B — export files**: คนวาง export file (HTML/MD) ที่ `knowledge/_sources/design/<module>/` —
   item ที่ derive บันทึก `sha256` ผูก freshness; ไฟล์เปลี่ยน = stale ทันที
3. **Path C — Claude Design via MCP (two-way, draft-only)**: official server, login ด้วย
   `/design-login` — ทิศ IN อ่าน project/files/comments เป็น draft, ทิศ OUT seed brief → mockup บน
   canvas · **allowlist fail-closed** frozen จาก live server — destructive/publishing tools refuse ถาวร ·
   output ทุกทิศยังเป็น draft ต้องมีคน sign-off (Path A/B เป็น fallback ได้เสมอ)

**Figma ผ่าน MCP แบบ read-only**: tool allowlist ปิด (ไม่มี write/Code-to-Canvas — enforce ซ้อน 4 ชั้น) ·
identity gate fail-closed (`get_me.email` ต้องตรง `figma_email` และ `figma_email` = `claude_email`) ·
**PAT (`FIGMA_PAT`) ห้ามเข้า repo/config** — env var หรือ OS keychain เท่านั้น ตั้ง identity ครั้งเดียวต่อ
เครื่อง: `sta configure identity --figma-email <email> --claude-email <email>`

## End-to-end example

```bash
# 0) ติดตั้ง (ครั้งเดียวต่อเครื่อง) — docs/getting-started.md
cd <framework-checkout> && npm --prefix orchestrator run build && npm link

# 1) เขียน requirement ใน Knowledge repo
git clone https://github.com/<org>/company-knowledge.git C:\src\company-knowledge
cd C:\src\company-knowledge
software-team-agents init
software-team-agents open                   # เปิด Claude Code จาก Knowledge workspace
#  ... draft knowledge item, แล้วบันทึก human acts:
sta roles review REQ-101 --as business-analyst
sta roles approve REQ-101 --by "Somchai"

# 2) (ครั้งเดียวต่อเครื่อง) bind machine เข้ากับ Knowledge root
sta configure knowledge-root C:\src\company-knowledge
sta doctor --project-root C:\src\company-knowledge

# 3) ทำงานโค้ด — Target เป็น checkout ล้วน (path ต่อเครื่องอยู่ที่ .workflow/targets.local.yaml)
software-team-agents open --runtime opencode # หรือเปิดด้วย OpenCode (bindings sync มาแล้ว)

# 4) รัน task ผ่าน pipeline (headless)
sta run --task-id T-7 --module demo --bug-fix --backend --autonomy edit \
  --backend-target my-product --project-root C:\src\company-knowledge
sta status T-7 --project-root C:\src\company-knowledge
sta audit T-7 --project-root C:\src\company-knowledge
```
