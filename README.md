# software-team-agents

**Personal AI. Shared Knowledge. Common Process.**

Process/workflow layer + orchestrator CLI สำหรับทีมซอฟต์แวร์ ที่จัดระเบียบการทำงานร่วมกันระหว่าง Human กับ AI coding tools (Claude Code, Codex) — แต่ละคนใช้ AI/tool ของตัวเองได้ แต่ทั้งทีมทำงานบน Knowledge และ Process ชุดเดียวกัน

| ส่วน | หน้าที่ |
|---|---|
| Claude Code / Codex | execution runtime — เครื่องมือที่ลงมือทำงาน |
| **software-team-agents** (repo นี้) | process/workflow layer + orchestrator CLI — จัดว่าใครทำอะไร ต่อกันอย่างไร ตรวจอย่างไร |
| Knowledge | ความรู้ร่วมขององค์กร/project (git repo แยก) |
| Target | repository ของ product จริงที่ให้ AI เขียนโค้ด |
| Human | ผู้กำหนด intent/constraints และผู้ตัดสินใจในจุดสำคัญ |

ไม่ใช่ AI model และไม่ได้มาแทน Claude Code หรือ Codex — ทุก run ของ pipeline ยัง executes ผ่าน runtime จริง (`claude -p --agent <role>`)

---

## Architecture: Three-Repo

แยกสามอย่างที่ lifecycle ต่างกันออกจากกัน:

| Repo | เก็บอะไร | Lifecycle |
|---|---|---|
| **Framework** (repo นี้) | orchestrator CLI, agent prompts, hooks, contracts, workflows, policies, stacks — pack เป็น npm package `software-team-agents` | อัปเดตโดยติดตั้ง `.tgz` version ใหม่ + `sync` |
| **Knowledge** (ต่อบริษัท) | `knowledge/`, `_docs/`, `decisions/`, `targets.yaml`, `knowledge-policy.yaml` | commit + merge ผ่าน git โดยทีม |
| **Target** (ต่อ product) | source code จริง + `.agent-team/` metadata | git flow ปกติของ project นั้น |

ผลที่ได้: คนที่ไม่แตะโค้ด (BA / SA / PM / test-planner) clone แค่ Knowledge repo — ไม่ต้อง clone Target และ framework internals ไม่ติดเข้า git history ของ repo ลูก

### อะไรถูก install / copy / generate

- **Global install** — `.tgz` ให้ CLI 2 ตัวจาก package เดียว:
  - `software-team-agents` — Target-first CLI (v2): `init | sync | status | dev | ba`
  - `sta` — V1 pipeline CLI: `run | status | approve | roles | doctor | ...`
- **Sync เป็น one-way เสมอ: Framework → Workspace** — ไม่มี Knowledge ⇄ Target content sync ไฟล์ที่ถูก sync track ใน manifest พร้อม sha256
- **Generated ที่เครื่อง** — `.codex/agents/<role>.toml` ถูก render จาก `.claude/agents/<role>.md` ตอน sync (ไม่ได้ ship มากับ payload)
- **Runtime state** — `.workflow/state.db` (SQLite) local, gitignored, ไม่ sync ข้ามเครื่อง

### โครงสร้าง Framework repo

```
orchestrator/           ← CLI + state store + knowledge engine (Node/TypeScript, vitest)
.claude/agents/*.md     ← agent prompts 10 roles
.claude/hooks/*.js      ← guards 6 ตัว (บังคับใช้กฎระดับ tool call)
.claude/scripts/*.js    ← status generator, schema-contract check, static-analysis gate
.claude/shared/         ← redirect ไป policies/ + scoping procedure
.claude/settings.json   ← wiring hooks ทุกตัว
.codex/agents/*.toml    ← Codex bindings (checked by --check-bindings)
contracts/*.yaml        ← read/write/deny path globs ต่อ role (machine-readable half ของ agent)
workflows/*.yml         ← 11 workflows: typo → feature/deploy (right-sizing)
policies/               ← กฎที่ทุก agent ใช้ร่วมกัน (coding/git/architecture/documentation/security/agent-boundaries)
stacks/                 ← stack profiles (node, frontend, dotnet, java, python)
templates/              ← build artifact — snapshot ของ framework payload + manifest.json (regenerate ด้วย npm run build:templates ห้าม hand-edit)
knowledge/              ← โครงสร้าง knowledge model (ดู knowledge/README.md)
layout.yaml             ← directory ownership declaration (checked by --check-layout)
escalation-policy.yaml  ← recovery policy (retry/recover/escalate)
test-pyramid.yaml       ← test level policy
project.yaml            ← stack profile ของ project นี้ (current vs target)
```

## Runtime ที่รองรับ

| Runtime | สถานะ |
|---|---|
| **Claude Code** | ✅ implemented + verified (pipeline, guards, capability probe) |
| **Codex** | ⚠️ partial — `software-team-agents dev\|ba --runtime codex` เปิด interactive session ได้ และ `.codex/agents/*.toml` ถูก generate ครบ แต่ headless pipeline (`sta run`) วิ่งบน Claude Code เป็น default; `CodexAdapter` ฝั่ง orchestrator ยังเป็น implementation ที่ไม่เคย verify กับ install จริง |

ข้อจำกัด: การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` (default `propose` ติด permission prompt ที่ไม่มีคนกดใน headless run)

## Installation

Prerequisites: **Node.js ≥ 20**, **Git**, **Claude Code CLI** (login แล้ว) — ตรวจด้วย `node --version`, `claude --version`

### ติดตั้งจาก `.tgz` (วิธีมาตรฐาน — internal distribution)

package เป็น `private`: ไม่ publish ขึ้น registry artifact เดียวคือไฟล์ `.tgz` + SHA-256 checksum ที่ได้จาก `npm run release` ฝั่ง framework ผู้รับไม่ต้อง clone Framework repo เลย:

```bash
# ติดตั้ง (ไฟล์ .tgz แจกกันภายในทีม พร้อมไฟล์ .sha256 สำหรับตรวจ integrity)
npm i -g ./software-team-agents-0.1.0.tgz
software-team-agents --version          # ต้องตรงกับ version ในชื่อไฟล์
```

อัปเกรด — ติดตั้ง `.tgz` version ใหม่ทับ แล้ว sync แต่ละ workspace ตาม:

```bash
npm i -g ./software-team-agents-0.2.0.tgz
cd my-project && software-team-agents sync
```

ถอนการติดตั้ง — ลบเฉพาะ CLI ไม่แตะ Knowledge/Target/project source ใด ๆ:

```bash
npm uninstall -g software-team-agents
```

> Framework developer: `npm run release` (typecheck → tests → build → pack → SHA-256) สร้าง `release/software-team-agents-x.y.z.tgz` version เดียวใน root `package.json` คือ single source ที่ตั้งชื่อ `.tgz`, stamp ลง `templates/manifest.json` และ report โดย `--version` · โหมดพัฒนาใช้ `npm link` แทนได้ (bin ชี้ build output — `npm run build` ก่อนใช้งาน)

### Development checkout

```bash
git clone <framework-repo>
cd software-team-agents/orchestrator
npm ci
npm run build            # tsc → dist/
npm run build:templates  # snapshot templates/ + manifest.json
```

เรียก CLI: `node orchestrator/dist/cli.js <command>` (V1) หรือ `node orchestrator/dist/targetcli/cli.js <command>` (v2)

## Quick Start — Target-first (`software-team-agents`)

ติดตั้ง framework เป็น CLI กลางครั้งเดียว แล้วทำงานจาก repo ของ project โดยไม่ต้อง cd เข้า Framework repo:

| command | ทำอะไร |
|---|---|
| `init` | detect ชนิด workspace (Knowledge markers → BA, app-source markers → DEV), บันทึก identity + role ใน `.agent-team/config.yaml` แล้ว sync managed assets — idempotent, รันซ้ำได้ |
| `sync` | อัปเดต Framework-managed files ตาม installed version — ไฟล์ที่โดนแก้เอง**ไม่ถูก overwrite เงียบ ๆ** (report + recovery advice; `--force` = overwrite พร้อม backup) |
| `status` | role, roots (Target/Framework/Knowledge), installed vs synced version, sync state, conflicts, Claude/Codex readiness (`--json` machine-readable) |
| `dev` | preflight → launch runtime (`claude` default, `codex` เมื่อ `--runtime codex`) จาก Target — Knowledge binding **required** |
| `ba` | preflight → launch runtime จาก Knowledge repo — Target **never required** |

options ร่วม: `--target-root <path>` · `--role <ba|dev>` (init: เมื่อ markers ambiguous) · `--force` · `--no-auto-sync` (dev/ba) · `--runtime <claude|codex>` (dev/ba) · `--json` (status)

### Role Workspace — BA ทำงานใน Knowledge, DEV ทำงานใน Target

CLI detect จาก cwd ว่าเป็น Knowledge repo (มี `knowledge/`, `targets.yaml`, `_docs/`) หรือ application repo (มี `package.json`, `*.csproj` ฯลฯ) — ambiguous/unrecognized ต้องระบุ `--role` ชัดเจน

```bash
# BA — clone แค่ Knowledge repo, ไม่ต้อง clone Target
cd company-knowledge
software-team-agents init      # detect เป็น BA workspace → sync เฉพาะ BA assets
software-team-agents ba        # preflight → launch runtime จาก knowledgeRoot

# DEV — clone Knowledge + Target
cd my-product
software-team-agents init      # detect เป็น DEV workspace → sync full payload
software-team-agents dev       # preflight (Knowledge required!) → launch จาก targetRoot
```

| | BA | DEV |
|---|---|---|
| Role Workspace | `knowledgeRoot` | `targetRoot` |
| Target | **NOT REQUIRED** | execution workspace (writable เท่านั้น) |
| Knowledge | workspace (writable) | read context (**required**) |
| Sync payload | BA agents (`business-analyst`, `system-analyst`, `project-manager`, `test-planner`) + hooks + scripts + policies + `CLAUDE.md` | full roster + contracts/workflows/stacks/layout YAML |
| Write ที่อื่น | Framework/Target = DENY | Framework/Knowledge = DENY |

Write policy บังคับจริงผ่าน launch: session ได้ writable root เดียวคือ Role Workspace ของตัวเอง (cwd + `AGENTCLAUDE_WRITABLE_WORK_ROOTS=[]`) — cross-repo writes hit `block-outside-repo` guard (fail-closed) DEV ไม่มี Knowledge binding = preflight fail พร้อมวิธีแก้ทันที

DEV bind Knowledge ได้ 2 ทาง — repo-relative (commit ไปกับ Target):

```yaml
# .agent-team/config.yaml (ไฟล์เดียวใน .agent-team/ ที่คน edit ได้)
schema_version: 1
target_id: my-product
role: dev
knowledge:
  path: ../company-knowledge   # relative จาก Target root
overrides: []                   # path ที่ประกาศที่นี่ sync จะไม่แตะอีก
```

หรือ machine-wide ผ่าน installation binding (ดูหัวข้อ V1): `sta configure knowledge-root <path>`

### Ownership model

- **Framework-managed** — เฉพาะ path ที่ record ใน `.agent-team/manifest.json`: `.claude/agents|hooks|scripts|shared`, `.claude/settings.json`, `CLAUDE.md`, `contracts/`, `workflows/`, `policies/`, `stacks/`, `layout.yaml`, `escalation-policy.yaml`, `test-pyramid.yaml` + `.codex/agents/*.toml` (generated)
- **Target-owned เสมอ** — `src/`, `tests/`, `package.json`, business logic, `knowledge/`, `_docs/`, `decisions/`, `.workflow/`, `.git`, `node_modules`, `.agent-team/` — guarded ที่ code level แม้ manifest corrupt sync ก็ปฏิเสธ
- **Sync rules** — disk == pristine → update (backup ก่อน) · disk != pristine → **conflict** (stop ทั้ง run) จนกว่าจะ revert / claim เป็น override / `--force` · managed file ที่ Framework เลิกใช้ถูก remove เฉพาะเมื่อ pristine · backup ทุกครั้งที่ overwrite/remove ที่ `.agent-team/backups/<timestamp>/`

## Workflow ของ pipeline (`sta`)

Human เลือกประเภทงานผ่าน classification flags แล้ว orchestrator เดิน workflow ที่ right-size:

```bash
sta run --task-id T-1 --module demo --bug-fix --backend --autonomy edit \
  --backend-target sb-web-helper \
  --project-root C:\src\company-knowledge     # three-repo mode: project-root คือ Knowledge root
```

| flag | workflow | chain |
|---|---|---|
| `--typo` | `typo.yml` (TRIVIAL) | engineer เท่านั้น ไม่มี QA |
| `--bug-fix` | `bugfix.yml` (SMALL) | engineer → QA (+security เมื่อ sensitive) |
| `--incremental` | `incremental.yml` (MEDIUM) | — |
| `--business-rule` | `business-rule.yml` (MEDIUM) | BA → SA → engineer → QA |
| `--new-feature` | `feature.yml` (LARGE_CRITICAL) | BA → SA → PM → test-planner → engineer → QA (full chain) |
| `--schema` | `schema-change.yml` (LARGE_CRITICAL) | SA → test-planner → engineer → QA |
| `--deploy` | `deploy.yml` | + devops, gated |
| (flags เสริม) | `hotfix.yml`, `refactor.yml`, `security-fix.yml`, `triage.yml` | classifier เลือกตาม signal/priority |

flag เสริมได้แก่ `--sensitive`, `--backend`, `--frontend` — step ภายใน workflow ถูกเลือกด้วย `when:` (เช่น `touchesBackend`) ตามที่ประกาศในไฟล์ workflow เอง

### Task lifecycle commands

```bash
sta run      --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full]
sta resume   --task-id <id> --module <name>          # continue task ใน store
sta retry    --task-id <id> --module <name>          # same as resume
sta pause    --task-id <id>                          # freeze; run/resume/retry refuse
sta cancel   --task-id <id> [--reason <text>]        # ปิด task ถาวร
sta status   [<task-id>] [--watch]                   # ทุก task หรือ task เดียว
sta approve  <task-id> [--yes|--no]                  # resolve human gate ของ task
sta audit    <task-id> [--decisions]                 # WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail
sta qa-metrics [<task-id>] [--export-json <p>] [--baseline <p>]
sta projects                                     # status summary ทุก project ใน workspace.yaml
sta --list                                       # ทุก task + batch ที่รันพร้อมกันได้
```

option สำคัญ: `--frontend-target/--backend-target <id>` (immutable ต่อ task), `--phase <n,n>`, `--depends-on <id,id>`, `--env <local|dev|staging|production>`, `--state-db <path>`

### Human approval gates

gate สำคัญหยุดรอคนจริง — requirement interview, schema confirmation, UXUI sign-off (frontend work), QA ไม่ผ่าน (รอบ 1-2 วนกลับ engineer อัตโนมัติ; ครั้งที่ 3 หรือ Critical หยุดรอคน), security finding Critical/Important, deploy/migration จริง การอนุมัติเป็น **record** (type/status/who/when) — reject คือ record ที่ block งาน ไม่ใช่ flag · pipeline แบบ orchestrated chain `qa-engineer` (ทุกงานที่แตะ code) และ `security` (sensitive/schema) ให้อัตโนมัติ — ที่เป็น human gate คือ *คำตัดสิน* ของสองตัวนี้ ไม่ใช่การเรียกใช้

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

lane ที่มีจริง: `ba | sa | uxui | dev` — acknowledge/signoff เป็น human act บันทึกใน `knowledge/_roles/**` (agent เขียนไฟล์นี้ไม่ได้ทุกกรณี)

### Failure / recovery

Retry (รอบ owner จาก review.md) · Recover (ถอยไป stage ก่อนหน้าที่ task เคยผ่าน) · Rollback (กลับสู่ last verified state) · Escalate (ให้คนแก้) · Abort (หมด retry budget) — ประกาศใน `escalation-policy.yaml`

## Multi-Target และ Multi-Machine

Logical identity ของ Target ไม่ผูกกับ physical path — แต่ละเครื่อง map path ของตัวเอง:

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

preflight ตรวจว่า origin remote ของ local checkout ตรงกับ `remote_url` canonical — ไม่ตรง = reject พร้อมเหตุผล

## Shared Knowledge (สรุป)

Knowledge ไม่ใช่ "AI memory" — เป็นข้อมูลร่วมของทีมที่มีโครงสร้างและ lifecycle รายละเอียดเต็มใน [`knowledge/README.md`](knowledge/README.md):

- **10 kinds หนึ่ง shape**: requirement (`REQ-`) · business-rule (`RULE-`) · domain (`DOM-`) · architecture (`DES-`) · api (`API-`) · db-schema (`DB-`) · decision (`ADR-`) · task (`BE-/FE-`) · test (`TEST-`) · ux-design (`UX-`)
- **หนึ่ง YAML file ต่อหนึ่ง fact** ภายใต้ `knowledge/<module>/<kind>/<ID>.yaml` — git merge ไม่ชนเว้นแต่สองคนแก้ item เดียวกัน `version` field คือกลไก concurrency
- **Relations 9 แบบ + legality matrix**: `refines/implements/verifies/references/depends-on/constrains/supersedes/conflicts-with/derived-from` — ผิดกฎ = report โดย `--check-knowledge`
- **Source/provenance/freshness** — ทุก item อ้าง `sources[]` freshness วัดจาก digest ของ source ก่อนอายุ: source เปลี่ยน = stale ทันที
- **Status**: `draft → reviewed → approved → deprecated` — approve ได้เฉพาะคน (`sta roles approve`)
- **Role-based context** — `knowledge-policy.yaml` กำหนด field ที่แต่ละ role เห็น (default: sensitive items ถูก redact สำหรับ devops/project-manager) และทุก result บอกด้วยว่าอะไรถูก withhold
- Reserved directories: `_sources/ _conflicts/ _bootstrap/ _human-input/ _adoption/ _roles/`

## Guards และการตรวจสอบ

สิ่งที่ implementation บังคับใช้จริง (hook-level, ไม่ใช่แค่ prompt) — wire ผ่าน `.claude/settings.json`:

| Hook | Event | บังคับว่าอะไร |
|---|---|---|
| `block-git.js` | PreToolUse (Bash/Write/Edit) | state-changing git ถูก block (read-only ผ่าน) |
| `block-outside-repo.js` | PreToolUse | ทุก write resolve อยู่ใน writable roots เท่านั้น |
| `block-doc-rewrite.js` | PreToolUse (Write) | doc ที่มีอยู่ต้อง amend ไม่ regenerate |
| `block-path-permissions.js` | PreToolUse | เขียนได้เฉพาะ path ที่ `contracts/<role>.yaml` ให้ (role อ่านจาก `AGENTCLAUDE_ROLE`) |
| `require-green-before-stop.js` | Stop/SubagentStop | engineer ส่งงานต่อไม่ได้ถ้า typecheck/lint แดง |
| `block-secret-leak.js` | Stop/SubagentStop | ไฟล์ที่ run แก้ห้ามมี hardcoded secret (`.env.example` รวมด้วย) |

- **Guards ถูกเทสต์** — `node .claude/tests/run.js` (self-test ไม่มี dependencies) — guard ที่ syntax error ต้อง fail loud ไม่ใช่ fail open
- **Validation flags** — `sta --check-*` 15 ตัว: `contracts, layout, workflows, profile, decisions, test-pyramid, review-separation, escalation-policy, workspace, repos, environments, doc-structure, knowledge, installation, roles` (+ `--check-bindings` มีใน CLI แต่ไม่ได้ wire ใน CI)
- **doctor** — `sta doctor --project-root <path>` รวม 9 checks แบบ read-only (installation, knowledge binding/schema, targets registry, local mappings, runtime adapter, state store, guard wiring) exit 1 เมื่อมี FAIL พร้อม "Fix:" ทุกข้อ
- **Audit trail** — `sta audit <task-id>`
- **Backup/Rollback** — v2 sync backup ที่ `.agent-team/backups/<ts>/`; V1 upgrade/migrate snapshot ที่ `.sta/backups/` คืนได้ด้วย `sta rollback` / `sta list-backups`

## Version Management

- **Single source of truth**: `version` ใน root `package.json` → `npm run build:templates` stamp ลง `templates/manifest.json` (`framework_version`) → `software-team-agents --version`
- **Workspace records** last-synced version ใน `.agent-team/manifest.json` — เทียบกับ installed version ได้ sync state:
  - `UP_TO_DATE` — ตรงกัน
  - `OUTDATED` — minor/patch ต่าง → `software-team-agents sync` ได้เลย
  - `INCOMPATIBLE` — **major ต่าง** → ต้อง `sync --force` (cross-major jump ต้องตัดสินใจเอง ไม่ happen เงียบ ๆ) และ `dev/ba` preflight จะ fail ทันที
- **Upgrade flow (v2)**: ติดตั้ง `.tgz` ใหม่ → `software-team-agents sync` ต่อ workspace (auto-sync ก่อน `dev/ba` เมื่อ plan ปลอด conflict)
- **Legacy install (`.sta/`)**: `sta upgrade --mode legacy-project --templates <dir>` (skip ไฟล์ที่ user แก้, restore ไฟล์ที่ถูกลบ, backup ก่อนเขียน) · `sta migrate` สำหรับ breaking manifest schema change · `sta rollback [--backup <name>]`
- **Knowledge item schema**: migration `1 → 2` (เพิ่ม `target_ids`) ผ่าน `sta knowledge-migrate <dry-run|copy|verify|cutover>` — cutover ต้อง `--confirm I_CONFIRM_MIGRATION`
- **ยังไม่มี**: publish ขึ้น npm registry, auto-update, lockfile/resolution ข้าม repo — distribution ผ่าน `.tgz` เท่านั้น

## Configuration Reference

| ไฟล์ | อยู่ที่ | keys สำคัญ |
|---|---|---|
| `installation.yaml` | `%LOCALAPPDATA%\software-team-agents\` (Windows) หรือ `~/.config/software-team-agents/` | `schema_version: 1`, `knowledge_root` (เขียนโดย `sta configure knowledge-root`) |
| `.agent-team/config.yaml` | Target/Knowledge workspace | `schema_version`, `target_id`, `registered_at`, `role` (`ba\|dev`), `knowledge.path`, `overrides[]` |
| `.agent-team/manifest.json` | generated, ห้าม hand-edit | `framework_version`, `files[]` (path + pristine sha256) |
| `targets.yaml` | Knowledge root | registry ของ Target: `target_id/name/remote_url/status` |
| `.workflow/targets.local.yaml` | Knowledge root (local) | map `target_id → path` |
| `knowledge-policy.yaml` | Knowledge root | field visibility ต่อ role + freshness thresholds |
| `project.yaml` | Framework repo | `current` (stack ที่ agents สร้างได้จริง) vs `target` (stack อนาคต — checked ต่างมาตรฐาน) |
| `layout.yaml`, `escalation-policy.yaml`, `test-pyramid.yaml` | Framework repo (+ synced ไป DEV workspace) | directory ownership / recovery policy / test levels |

Environment variables ที่ runtime ใช้: `AGENTCLAUDE_ROLE` (role ปัจจุบันสำหรับ path permissions), `AGENTCLAUDE_WRITABLE_WORK_ROOTS` (JSON array ของ writable roots — launcher ตั้ง `[]` เสมอ)

## Workflow ตัวอย่าง End-to-End

```bash
# 0) ติดตั้ง (ครั้งเดียวต่อเครื่อง)
npm i -g ./software-team-agents-0.1.0.tgz

# 1) BA — เขียน requirement ใน Knowledge repo
git clone https://github.com/<org>/company-knowledge.git C:\src\company-knowledge
cd C:\src\company-knowledge
software-team-agents init
software-team-agents ba                     # เปิด Claude Code จาก Knowledge workspace
#  ... draft knowledge item, แล้วบันทึก human acts:
sta roles review REQ-101 --as business-analyst
sta roles approve REQ-101 --by "Somchai"

# 2) (ครั้งเดียวต่อเครื่อง) bind machine เข้ากับ Knowledge root
sta configure knowledge-root C:\src\company-knowledge
sta doctor --project-root C:\src\company-knowledge

# 3) DEV — ทำงานใน Target repo
cd C:\src\my-product
#  bind Knowledge (ครั้งเดียว ต่อ repo — commit ไปกับ Target)
#    .agent-team/config.yaml → knowledge: { path: ../company-knowledge }
software-team-agents init
software-team-agents dev                    # preflight → Claude เปิดจาก Target

# 4) รัน task ผ่าน pipeline (headless)
sta run --task-id T-7 --module demo --bug-fix --backend --autonomy edit \
  --backend-target my-product --project-root C:\src\company-knowledge
sta status T-7 --project-root C:\src\company-knowledge
sta audit T-7 --project-root C:\src\company-knowledge

# 5) อัปเกรด framework เมื่อมี .tgz ใหม่
npm i -g ./software-team-agents-0.2.0.tgz
cd C:\src\my-product && software-team-agents sync
software-team-agents status                 # syncState: UP_TO_DATE
```

## Development / Contributing

```bash
cd orchestrator
npm ci
npm test                 # vitest
npm run typecheck
npm run build            # tsc → dist/
npm run build:templates  # snapshot templates/ + manifest.json
node ../.claude/tests/run.js   # hook/script self-test — ต้องเขียวเสมอถ้าแตะ hooks/scripts
```

- CI: [`.github/workflows/agent-framework-ci.yml`](.github/workflows/agent-framework-ci.yml) รัน self-test + typecheck + tests + 15 release-gate `--check-*` flag + template build/init check บนทุก PR และ push ไป master
- โครงสร้าง directory ถูกประกาศใน [`layout.yaml`](layout.yaml) และตรวจด้วย `--check-layout` — เพิ่ม folder ใหม่ต้องประกาศก่อน
- เอกสารกฎ: [`policies/`](policies/README.md) · machine-readable half ของ agent: [`contracts/`](contracts/) · pipeline detail: [`CLAUDE.md`](CLAUDE.md) · agent operating rules: [`AGENTS.md`](AGENTS.md) · knowledge model: [`knowledge/README.md`](knowledge/README.md)
- `templates/` เป็น build artifact — แก้ที่ root sources (`.claude/`, `contracts/`, ...) แล้ว regenerate เสมอ
- `planning/` เป็น working docs ภายใน (gitignored) ไม่ได้แถมมากับ repo ที่ clone

## ข้อจำกัด

- **Codex runtime partial** — interactive launch ผ่าน `--runtime codex` ได้ แต่ headless adapter ยังไม่เคย verify กับ install จริง UAT ครอบเฉพาะ Claude Code
- **Contract write-globs จำกัด** — pattern ปัจจุบันครอบ `src/lib/**`, `server/**`, `app/api/**`, `prisma/**` ฯลฯ app code นอก pattern นี้ engineer แก้ไม่ได้ (hook บล็อก) — ต้องปรับ contract ให้ตรงโครงสร้าง project จริงก่อนใช้
- **Unattended run ต้อง `--autonomy edit|full`** — default (`propose`) ติด permission prompt headless
- **Git เป็น transport เดียว** — knowledge history ต้องมี git ไม่มี real-time collaboration
- **Conflict detection เป็น heuristic** — จับ model/endpoint/term ซ้ำ ไม่ใช่ semantic contradiction
- **Automated tests ของ Target เป็น opt-in** — ไม่มี suite = QA ตรวจด้วยการอ่านโค้ด + static checks และรายงาน `Unverified Behaviour` ไว้ชัดเจน
- **ยังไม่มีไฟล์ LICENSE** — package เป็น `private` ใช้ภายในองค์กร
