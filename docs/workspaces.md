# Workspaces — โมเดล workspace, binding และขอบเขตการเขียน

เอกสารนี้เป็น canonical home ของโมเดล workspace ฝั่ง `software-team-agents` (V10):
ชนิด workspace, การ bind Knowledge ↔ Target, ไฟล์ใดเป็นของใคร และ guardrail ที่เตือนก่อนเขียนผิดที่
สถาปัตยกรรมเบื้องหลัง (สาม repo + Runtime State) อยู่ที่ [`architecture.md`](architecture.md)

## Workspace เดียว — session เปิดจาก Knowledge workspace

V10 ยุบ lane `ba`/`dev` เหลือคำสั่งเดียว (V10 TASK-026 — คำสั่งเก่าถูกตัดถาวร ไม่มี alias:
พิมพ์ `ba`/`dev` แล้ว CLI จับชื่อเพื่อบอกคำสั่งแทนที่เท่านั้น) Session เปิดจาก Knowledge workspace
เสมอ — Target เป็น checkout ล้วน

| | V10 workspace |
|---|---|
| Session cwd | Knowledge workspace (writable root เดียวของ session) |
| Target | read-only จาก interactive session (`STA_TARGET_WORK_ROOTS` ครอบทุก Target ที่ mapping ไว้, `access: read` — เขียน Target ต้องผ่าน orchestrated stage ที่มี `STA_ROLE` + packet scope) |
| Knowledge | workspace ของ session เอง — artifact ของแต่ละ role ตาม role contract |
| Sync payload | ชุดเดียว — prompts ครบทุก role + contracts/workflows/stacks/layout YAML + hooks + scripts + policies + `CLAUDE.md` (ไม่มี profile แยกตาม role อีกแล้ว, V10 TASK-020) |
| Write ที่อื่น | Framework/Target = DENY (Target ที่ bound ถูกปฏิเสธพร้อมชื่อ target) |

Write policy บังคับจริงผ่าน interactive launch: session ได้ writable root เดียวคือ workspace ตัวเอง
(cwd + `STA_WRITABLE_WORK_ROOTS=[]`) — cross-repo writes hit `block-outside-repo` guard (fail-closed)
สำหรับ orchestrated run executor ใส่เฉพาะ canonical Target write roots ที่ three-repo preflight resolve แล้ว

## คำสั่งจัดการ workspace

| command | ทำอะไร |
|---|---|
| `init` | detect ชนิด workspace (Knowledge markers → BA, app-source markers → DEV — label เท่านั้น ไม่มีผลตัดสินใด ๆ แล้ว, V10 TASK-021); สำหรับ DEV จะ resolve Target stack จากหลักฐานใน repo; จากนั้นบันทึก identity + profile ใน `.agent-team/config.yaml` แล้ว sync assets — idempotent, รันซ้ำได้ |
| `sync` | อัปเดต Framework-managed files ตาม installed version — ไฟล์ที่โดนแก้เอง**ไม่ถูก overwrite เงียบ ๆ** (report + recovery advice; `--force` = overwrite พร้อม backup) |
| `status` | workspace, roots (Target/Framework/Knowledge), installed vs synced version, sync state, conflicts, Claude/Codex/OpenCode/Antigravity readiness (`--json` machine-readable — คง field `role` เดิมสำหรับ legacy config) |
| `open` | preflight → launch runtime (`claude` default, `codex`/`opencode`/`antigravity` เมื่อ `--runtime`) จาก Knowledge workspace — binding เป็น context เท่านั้น ไม่เคย required |
| `cleanup` | ย้าย Framework payload ของ workspace นี้เข้า backup แล้วเลิกจัดการ (V10) — เฉพาะ manifest-tracked files, overrides คงอยู่, กู้คืนได้ด้วย `sta rollback`; ใช้ `--dry-run` ดู plan ก่อน แล้ว `--yes` เป็นการยืนยันของคน |

options ร่วม: `--target-root <path>` · `--role <name>` (retired — accepted and ignored) ·
`--stack <name>` (init/sync: เมื่อ Target stack ambiguous หรือ unresolved) · `--force` ·
`--confirm-agents-pointer` (sync เท่านั้น) · `--no-auto-sync` (open) ·
`--runtime <claude|codex|opencode|antigravity>` (open) · `--allow-unguarded-runtime` (open) · `--json` (status)

### Target stack resolution

สำหรับ workspace ที่ init อยู่ใน Target checkout: Harness ตรวจ project/lock files (root + หนึ่งระดับ
ไม่ตาม symlink) แล้ว resolve profile ที่ ship อยู่ (`node`/`frontend`, `dotnet`, `python`, `java`)
พร้อม package manager/commands/source roots/schema paths — script ที่ Target ประกาศเองชนะ profile
defaults ถ้า ambiguous หรือ unresolved `init` เขียน **nothing** และพิมพ์คำสั่งแก้
`software-team-agents init --stack <name>` (AI/setup playbook ถามเลือก stack เฉพาะกรณีนั้น
ไม่เลือกแทน Harness/คน) — profile family ที่เปลี่ยนภายหลังเป็น preflight STOP ไม่ใช่ silent rewrite

รายละเอียด `stack:` block และ `fingerprint`/`generated_hash` อยู่ที่ [`architecture.md`](architecture.md) § Target-resolved stack

## Binding — Knowledge ↔ Target

การ bind ของ V10 อยู่ฝั่ง Knowledge workspace เสมอ ผ่านสองไฟล์:

`targets.yaml` (shared, อยู่ใน Knowledge root):

```yaml
schema_version: 1
targets:
  - target_id: sb-web-helper
    name: SB Web Helper
    remote_url: https://github.com/example/sb-web-helper.git   # credential-free, immutable
    status: active                                              # active | paused | retired
```

`.workflow/targets.local.yaml` (ใน Knowledge root, machine-local, **ไม่ commit**):

```yaml
schema_version: 1
targets:
  sb-web-helper:
    path: D:\src\sb-web-helper                # เครื่อง A (Windows)
    # path: /Users/b/projects/sb-web-helper   # เครื่อง B (macOS)
```

preflight ตรวจว่า origin remote ของ local checkout ตรงกับ `remote_url` canonical — ไม่ตรง = reject
พร้อมเหตุผล

ส่วน `knowledge.path` ใน `.agent-team/config.yaml` ของ Target checkout เป็น legacy config ที่ยังอ่านได้
(round-trip) แต่ไม่ใช่วิธีผูกใหม่ใด ๆ ใน V10:

```yaml
# .agent-team/config.yaml ใน Target checkout (legacy — อ่านได้ ไม่ตัดสินอะไร)
schema_version: 1
target_id: my-product
role: dev
knowledge:
  path: ../company-knowledge   # relative จาก Target root
overrides: []                   # path ที่ประกาศที่นี่ sync จะไม่แตะอีก
```

Machine-wide Knowledge binding (`sta configure knowledge-root <path>`) ยังใช้ได้เหมือนเดิมสำหรับ
`sta context`/`doctor` เมื่ออยู่นอก workspace

### Multi-Target scope ของ knowledge

Knowledge item ที่มี `target_ids: []` เป็น global; item ที่ระบุ Target จะเข้า retrieval/brief เฉพาะ
session ที่ bind Target นั้น และจำนวนที่ถูก scope ออกจะถูกรายงาน ใช้
`sta knowledge reconcile --target <id>` (`--json` ได้) เพื่อคำนวณ current/desired evidence ใหม่แบบ
read-only โดยไม่บันทึก verdict หรือแก้ repo ใด นิยาม authoritative ของ scope, origin, freshness และ
reconciliation อยู่ที่ [`knowledge/README.md`](../knowledge/README.md)

## Instruction ownership — ไฟล์ใดเป็นของใคร

Instruction ownership มีสี่ precedence classes; `software-team-agents status --json` แสดงทุก path ใน
`instructionSurface[]` พร้อม `owner`, `precedence`, `frameworkContributionPresent` และ consequence เมื่อขาด:

| precedence | path class | กติกา |
|---|---|---|
| `framework-managed` | `.claude/agents/**`, `.codex/**`, `.opencode/**` | bytes มาจาก Framework/rendering และ track ใน manifest |
| `project-owned-with-framework-block` | root `CLAUDE.md`, root `AGENTS.md` | project prose เป็นของ project; sync แตะเฉพาะ `<!-- sta:bootstrap -->` … `<!-- /sta:bootstrap -->`, backup ก่อนเขียน และ preserve bytes นอก markers (`AGENTS.md` ที่ยังไม่มีได้ rendered pointer ไป `CLAUDE.md`) |
| `project-owned-merged` | `.claude/settings.json` | preserve project hooks/permissions/unknown keys แล้วเติมเฉพาะ Framework guard registrations ที่ขาด; ไฟล์นี้ไม่กลายเป็น manifest-managed |
| `project-owned-untouched` | `CLAUDE.local.md`, nested `AGENTS.md` | detect/report ได้แต่ sync ไม่แก้; nested instructions อาจมี precedence เหนือ root block ตาม runtime |

นอก instruction surface — **Machine-local** (ไม่ sync ไม่ commit): `.workflow/**`,
`.agent-team/backups/**`, `installation.yaml` — `init` เขียน managed `.gitignore` block ให้เอง
ลบ/regenerate ได้อิสระ

Source code, tests, package metadata, `knowledge/`, `_docs/`, `decisions/`, `.workflow/`, `.git`,
`node_modules` และ `.agent-team/` ยังเป็น project-owned และ guard ปฏิเสธแม้ manifest เสีย สำหรับ
Framework-managed files: disk == pristine → update (backup ก่อน) · disk != pristine → **conflict** จนกว่า
จะ revert / claim เป็น `overrides` / ยืนยัน `--force` · retired file ถูก remove เฉพาะเมื่อ pristine
Marker ผิดรูป/ซ้ำเป็น blocking conflict และ `--force` จะไม่เดา `software-team-agents status` และ
`sta doctor` เป็น read-only audit ของ instruction surface เดียวกัน

## Workspace guardrails

`status` (และ `sta --check-workspace`) เตือนก่อนที่ไฟล์จะไปโผล่ผิด repo แทนที่จะให้คนสังเกตทีหลัง:

| WARNING | ตรวจอะไร | แก้ |
|---|---|---|
| Knowledge root bound but never initialized | `installation.yaml` ผูก Knowledge root ที่มี marker ครบ แต่ไม่เคยมี `.agent-team/config.yaml` ที่นั่น — payload ไม่มีอยู่เลยทั้งเครื่อง | `cd <knowledgeRoot> && software-team-agents init` (`status` พิมพ์คำสั่งนี้ตรงๆ) |
| Misplaced module docs (`--check-workspace`) | `_docs/module/**` หรือ Modules table ใน `_docs/status.md` อยู่ใน Target checkout (คัดจากชนิด workspace จริง — app markers หรือ legacy `role: dev` config) — ที่ถูกคือ Knowledge repo เท่านั้น | copy ไป `<knowledgeRoot>\_docs\module\<name>\`, merge status row, ลบของเดิม |

ทั้งสองรายการนี้เป็น warning ไม่ block การทำงาน — จุดประสงค์คือให้คน (หรือ AI ที่ทำงานแทนคน) เห็นก่อนเขียน
ไฟล์ผิดที่ ไม่ใช่หลังจากนั้น อาการอื่น ๆ ดู [`troubleshooting.md`](troubleshooting.md)
