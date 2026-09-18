# CLI Reference — สอง surface

โปรเจกต์นี้มี **CLI สองตัวจาก package เดียว** ต่างหน้าที่กันชัดเจน:

| surface | บทบาท | ใช้เมื่อ |
|---|---|---|
| `software-team-agents` | workspace CLI — ตั้ง/ตรวจ/ซ่อม workspace และเปิด interactive session | ติดตั้ง, ตรวจสุขภาพ, เริ่มงานแบบ interactive |
| `sta` | orchestrated pipeline CLI — task lifecycle, approvals, audit, routing, knowledge ops, diagnostics | รันงาน headless, ตรวจสอบ, จัดการ run |

ทั้งคู่มาจาก `orchestrator/dist/` ของ package `software-team-agents` เดียวกัน (`npm link` ผูกทั้งสอง bin)

---

## `software-team-agents` — workspace CLI

```
usage: software-team-agents <command> [options]

commands:
  init      detect ชนิด workspace แล้ว initialize Framework metadata + managed assets
  sync      bring Framework-managed files up to the installed Framework version
  status    show workspace, roots, versions, sync state, readiness
  open      preflight แล้ว launch runtime จาก Knowledge workspace นี้
  cleanup   ย้าย Framework payload ของ workspace เข้า backup แล้วเลิกจัดการ (V10)
            manifest-tracked files only, overrides คงอยู่, กู้คืนได้ด้วย sta rollback
```

options: `--target-root <path>` · `--role <name>` (retired — accepted and ignored) ·
`--stack <name>` (init/sync) · `--force` (sync/init — overwrite ไฟล์ที่แก้เอง, backup ก่อน) ·
`--confirm-agents-pointer` (sync) · `--no-auto-sync` (open) ·
`--runtime <claude|codex|opencode|antigravity>` (open) · `--allow-unguarded-runtime` (open) ·
`--dry-run` / `--yes` (cleanup) · `--json` (status) · `-h/--help` · `--version`

หมายเหตุ: `ba` และ `dev` เป็นคำสั่งที่ถูกปลดแล้ว (V10) — พิมพ์แล้ว CLI บอกคำสั่งแทนที่ (`open`)
เท่านั้น ไม่ทำงานและไม่มี alias

พฤติกรรมละเอียดของ init/sync/status/open/cleanup และโมเดล workspace อยู่ที่
[`workspaces.md`](workspaces.md) · การติดตั้งอยู่ที่ [`getting-started.md`](getting-started.md)

---

## `sta` — orchestrated pipeline CLI

### Task lifecycle

```bash
sta run      --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full] [--runtime claude-code|codex|opencode|antigravity]
sta bounded-run --module <name> (--all|--phase <n>|--task <id,...>) [--until next-gate|qa|done] [--dry-run] [--autonomy edit|full]   # คู่มือ: docs/bounded-run.md
sta bounded-run --resume <run-id> --module <name> [--dry-run]       # resume ระดับ run (ต่างจาก --resume ระดับ task)
sta resume   --task-id <id> --module <name>          # continue task ใน store
sta retry    --task-id <id> --module <name>          # same as resume
sta pause    --task-id <id>                          # freeze; run/resume/retry refuse
sta cancel   --task-id <id> [--reason <text>]        # ปิด task ถาวร
sta approve  <task-id> [--yes|--no]                  # resolve human gate ของ task
sta status   [<task-id>] [--watch]                   # ทุก task หรือ task เดียว
sta audit    <task-id> [--decisions]                 # WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail
```

exit codes ของ `run`/`retry`: `0` deployed · `1` blocked · `2` unknown gate · `3` rejected โดยคน ·
`4` parked — มี gate รอ `sta approve <task-id> --yes|--no`

### Observation / report

```bash
sta changed  [--project-root <path>] [--json]        # สรุปไฟล์ที่เปลี่ยนใน working tree และผล deterministic gate
sta report   [--output <path>] [--module <m>] [--project-root <p>] # offline single-file HTML report
sta qa-metrics [<task-id>] [--export-json <p>] [--baseline <p>] [--escaped-defects <n>]
sta tokens   [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <p>] [--baseline <p>]
sta projects [--workspace <path>]                    # status summary ทุก project ใน workspace.yaml
sta --list   [--project-root <path>]                 # ทุก task + batch ที่รันพร้อมกันได้
```

### Context และ knowledge

```bash
sta context <role> [--module <name>] [--phase <n,n>] [--task <id> --packet] [--views] [--json]
sta knowledge get <id>[,<id>...] [--lane <ba|sa|uxui|dev>] [--json]
sta knowledge reconcile --target <id> [--json]       # read-only current/desired evidence classifier
sta policy [<area>] [<section>] [--json]             # อ่าน policies/ เป็น section แทนทั้งไฟล์
```

### Roles / Knowledge lanes (BA · SA · UXUI · DEV)

```bash
sta roles                                        # ทุก lane ยืนตรงไหนของ module
sta roles review REQ-101 --as system-analyst     # draft → reviewed (พร้อม checklist)
sta roles approve REQ-101 --by "<ชื่อคน>"         # reviewed → approved (คนเท่านั้น)
sta roles signoff ba --by "<ชื่อคน>"              # ปิด gate ของ lane ตัวเอง [--reject] [--note]
sta roles ack sa REQ-101 --by "<ชื่อคน>"          # record ว่าคนใน lane เห็น item แล้ว
sta roles inbox [ba|sa|uxui|dev]                 # lane นี้มีอะไรต้องดู
sta roles impact REQ-101                         # lane ไหนจะโดนกระทบถ้าแก้ item นี้
sta roles context dev                            # lane นี้เห็นอะไรได้บ้าง
```

lane ที่มีจริง: `ba | sa | uxui | dev` — acknowledge/signoff เป็น human act บันทึกใน
`knowledge/_roles/**` (agent เขียนไฟล์นี้ไม่ได้ทุกกรณี) โมเดลเต็มอยู่ที่
[`knowledge/README.md`](../knowledge/README.md) § Role workspaces

### Install / machine config / diagnostics

```bash
sta init    --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>] [--force]
sta upgrade --mode <legacy-project|three-repo> [...]  # legacy `.sta/`-only workspace: error พร้อมชี้ไป software-team-agents init
sta migrate [--project-root <path>]                  # สำหรับ breaking manifest schema change
sta rollback [--backup <name>] / sta list-backups    # คืนจาก .sta/backups/ snapshots
sta configure knowledge-root <path>                  # machine-wide Knowledge binding
sta configure identity --figma-email <e> --claude-email <e>   # design accounts (emails only)
sta doctor [--project-root <path>]                   # read-only diagnostics, exit 1 เมื่อมี FAIL
sta runtimes                                         # runtime + support level จาก source of truth เดียวกับ docs/runtimes.md
```

### Classification flags (ให้ `sta run` / `sta bounded-run`)

| flag | ความหมาย |
|---|---|
| `--typo` | แก้ typo/copy เท่านั้น |
| `--bug-fix` | bug ที่ requirement + schema ชัดแล้ว |
| `--incremental` | feature ต่อยอดของเดิม |
| `--business-rule` | เปลี่ยน business rule ไม่แตะ schema |
| `--new-feature` | feature/module/project ใหม่ |
| `--schema` | เพิ่ม/แก้ field/table/relation |
| `--deploy` | production deploy/migration จริง |
| `--sensitive` / `--backend` / `--frontend` | step qualifier — step ใน workflow ถูกเลือกด้วย `when:` ตามที่ประกาศในไฟล์ workflow เอง |

flag เหล่านี้เลือก workflow ที่ right-size — ตารางและเหตุผลอยู่ที่ [`pipeline.md`](pipeline.md)

### Runtime/model flags (ให้ `sta run`)

| Flag | ค่า/ผล |
|---|---|
| `--runtime <claude-code|codex|opencode|antigravity>` | เลือก runner สำหรับ run นี้ (precedence สูงสุด) |
| `--model <name>` | explicit model override สำหรับทุก stage ของ run นี้; runtime ปฏิเสธ model ที่มันใช้ไม่ได้ |
| `--effort <name>` | explicit effort override สำหรับทุก stage ของ run นี้; adapter ปฏิเสธ vocabulary/capability ที่มันใช้ไม่ได้ |
| `--no-qa-optimization` | กลับไปใช้ executor QA แบบก่อน optimization สำหรับ task นี้; ไม่ใช่ QA skip |
| `--no-deterministic-gate` | explicit escape hatch ปิด deterministic pre-check สำหรับ task นี้; default gate เปิด |
| `--token-budget <n>` | positive integer, post-hoc task token ceiling; ไม่ใช่ pre-spawn context cap |
| `--mode <single|auto|manual>` | **ถอดออกแล้ว** — error พร้อมชี้ไป `--runtime`/`--model`/`routing.by_role` |

options เสริมของ run: `--frontend-target/--backend-target <id>` (immutable ต่อ task), `--phase <n,n>`,
`--depends-on <id,id>`, `--ad-hoc`, `--env <local|dev|staging|production>`, `--state-db <path>`,
`--project-root <path>` (three-repo mode: path คือ Knowledge root) — ไม่มี user-facing `--qa-skip`

### Validation flags (`sta --check-*`)

registry เดียวใน `orchestrator/src/cli/checkers.ts` — ตรวจความสม่ำเสมอของ repo แบบ read-only:

`--check-contracts` (contracts/*.yaml vs agent roster) · `--check-layout` (layout.yaml vs real dirs) ·
`--check-prompt-budget` (prompt floor) · `--check-workflows` (generated workflows byte-match classifier) ·
`--check-bindings` (generated renderings byte-match sources) · `--check-profile` (project.yaml + stacks/) ·
`--check-decisions` (ADR schema + cross-links) · `--check-test-pyramid` · `--check-review-separation` ·
`--check-escalation-policy` · `--check-workspace` (workspace.yaml + misplaced docs) · `--check-repos` ·
`--check-environments` · `--check-doc-structure` · `--check-doc-size` ·
`--check-plan` (plan.md เป็น dependency graph) · `--check-knowledge` · `--check-installation` ·
`--check-roles` · `--check-git-ownership` (git mutation อยู่ใน `orchestrator/src/git/` เท่านั้น) ·
`--build-templates <out-dir>` · `--version`

---

## Slash commands (Claude runtime)

`.claude/commands/*.md` คือ prompt shortcut ที่พิมพ์ได้ใน Claude Code — **35 ตัว** ทุกตัว import
`@_shared/guardrails.md` (บังคับ output format, cap, cite file:line, ask-first) เป็น **prompt เท่านั้น** —
ไม่แก้ runtime/hook (agent ยังโดน guards เดิมทุกตัว) · ship ผ่าน `init`/`sync`

Workflow commands: `/next` ตอบ "ทำอะไรต่อ" (resolve module + phase + คำสั่งถัดไป) · `/status` matrix ทุก
module/phase/blocker · `/verify` ตรวจ deterministic gate แล้วเรียก `qa-engineer` เฉพาะเมื่อ green ·
`/changed` change set + ผล gate — workspace เดียวของ V10 ได้ครบทั้ง 4

**Runtime mirrors ของ command ชุดเดียวกัน (generated — ห้าม hand-edit):** source of truth คือ
`.claude/commands/*.md` เสมอ — `init`/`sync` generate ให้ทุก runtime และ `sta --check-bindings` ตรวจ
byte-match: OpenCode `.opencode/commands/<name>.md` (`/name`) · Codex ≥ 0.117
`.agents/skills/<name>/SKILL.md` (`$name`) · regenerate ใน Framework repo ด้วย
`npm --prefix orchestrator run build && node scripts/regenerate-renderings.mjs`
