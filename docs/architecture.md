# Architecture — Three-Repo + Local Runtime State

เอกสารนี้เป็น canonical home ของโมเดลระบบ: ownership domains, สิ่งที่ถูก install/copy/generate,
โครงสร้าง Framework repo, configuration reference และ version management

## Ownership domains

Three-Repo แยก repository สามประเภท และระบบแยก **Local Runtime State** เป็น ownership domain ที่สี่
เพราะ lifecycle/สิทธิ์ต่างจากทั้งสาม repo:

| Domain | เก็บอะไร | Lifecycle |
|---|---|---|
| **Framework** (repo นี้) | orchestrator CLI, agent prompts, hooks, contracts, workflows, policies, stacks — pack เป็น npm package `software-team-agents` | อัปเดตโดยติดตั้ง version ใหม่ + `sync` |
| **Knowledge** (ต่อบริษัท) | `knowledge/`, `_docs/`, `decisions/`, `targets.yaml`, `knowledge-policy.yaml` | commit + merge ผ่าน git โดยทีม |
| **Target** (ต่อ product) | source code จริง + `.agent-team/` metadata | git flow ปกติของ project นั้น |
| **Runtime State** (local ต่อเครื่อง/run) | `.workflow/state.db`, `.workflow/state.yaml`, `.workflow/packets/`, `.workflow/evidence/`, `.workflow/runs/` | สร้าง/ย้าย schema โดย orchestrator, bounded retention, gitignored; ห้าม classify เป็น Knowledge/Target และไม่ sync/commit |

ผลที่ได้: คนที่ไม่แตะโค้ด (BA / SA / PM / test-planner) clone แค่ Knowledge repo — ไม่ต้อง clone Target
และ framework internals ไม่ติดเข้า git history ของ repo ลูก

หมายเหตุศัพท์: `_docs/` มีความหมายเฉพาะทาง Knowledge-side (module requirements/designs/test plans/
status/UXUI artifacts) — ส่วนเอกสารสำหรับคนของ Framework repo อยู่ที่ `docs/` เท่านั้น (ADR-024)

## อะไรถูก install / copy / generate

- **Global install** — package เดียวให้ CLI สองตัว:
  - `software-team-agents` — workspace CLI: `init | sync | status | open | cleanup`
  - `sta` — orchestrated pipeline CLI: `run | bounded-run | status | approve | audit | ...`
    (อ้างอิงเต็มที่ [`cli.md`](cli.md))
- **Sync เป็น one-way เสมอ: Framework → Workspace** — ไม่มี Knowledge ⇄ Target content sync ไฟล์ที่ถูก
  sync track ใน manifest พร้อม sha256
- **Generated ที่เครื่อง** — `.codex/agents/<role>.toml` และ `.opencode/agent/<role>.md` ถูก render จาก
  `.claude/agents/<role>.md` ตอน sync (ไม่ได้ ship มากับ payload); `.opencode/plugin/sta-guards.js`
  เป็น authored payload ที่ sync copy ให้ทุก workspace
- **Runtime State เป็น domain ที่สี่** — task state, execution packets, verification evidence และ runner
  output ใต้ `.workflow/` เป็น local/regenerable, gitignored และไม่ sync ข้ามเครื่อง;
  `.workflow/targets.local.yaml` เป็น machine-local Target mapping เช่นกัน

## โครงสร้าง Framework repo

```
orchestrator/           ← CLI + state store + knowledge engine (Node/TypeScript, vitest)
.claude/agents/*.md     ← agent prompts 11 roles
.claude/hooks/*.js      ← guards 6 ตัว (บังคับใช้กฎระดับ tool call — docs/guards.md)
.claude/scripts/*.js    ← status generator, schema-contract check, static-analysis gate
.claude/shared/         ← redirect ไป policies/ + scoping procedure
.claude/settings.json   ← wiring hooks ทุกตัว
.claude/commands/*.md   ← slash command shortcuts 35 ตัว — source of truth (concept `command`)
.codex/agents/*.toml    ← Codex bindings (generated, checked by --check-bindings)
.opencode/agent/*.md    ← OpenCode bindings (generated, checked by --check-bindings)
.opencode/plugin/       ← sta-guards.js — guards ฝั่ง OpenCode (tool.execute.before)
.opencode/commands/*.md ← OpenCode rendering ของ commands (generated, checked by --check-bindings)
.agents/skills/*/       ← Codex Agent Skills rendering ของ commands (generated, checked by --check-bindings)
contracts/*.yaml        ← read/write/deny path globs ต่อ role (machine-readable half ของ agent)
workflows/*.yml         ← 11 workflows: typo → feature/deploy (right-sizing, generated — ADR-007)
policies/               ← กฎที่ทุก agent ใช้ร่วมกัน (coding/git/architecture/documentation/security/agent-boundaries/communication/data/ux)
stacks/                 ← stack profiles (node, frontend, dotnet, java, python)
templates/              ← build artifact — snapshot ของ framework payload + manifest.json (regenerate ด้วย npm run build:templates ห้าม hand-edit)
docs/                   ← เอกสารสำหรับคนของ Framework repo (ไฟล์ชุดนี้) — ไม่ ship เข้า workspace
knowledge/              ← โครงสร้าง knowledge model (ดู knowledge/README.md)
layout.yaml             ← directory ownership declaration (checked by --check-layout)
escalation-policy.yaml  ← recovery policy (retry/recover/escalate)
test-pyramid.yaml       ← test level policy
project.yaml            ← stack profile ของ project นี้ (current vs target)
```

`layout.yaml` ประกาศ concept ใดเป็นเจ้าของ directory ใด — Agent (ใคร) · Skill (ทำอะไรได้) · Policy
(ห้ามอะไร) · Workflow (ทำเมื่อไหร่) · Orchestrator (ใครทำต่อ) — ตรวจกับ filesystem จริงด้วย
`sta --check-layout` เพิ่ม folder ใหม่ต้องประกาศก่อน

## Sync model

- disk == pristine → update (backup ก่อนที่ `.agent-team/backups/<ts>/`)
- disk != pristine → **conflict** จนกว่าจะ revert / claim เป็น `overrides` / ยืนยัน `--force`
- retired file ถูก remove เฉพาะเมื่อ pristine; marker ผิดรูป/ซ้ำเป็น blocking conflict (`--force` ไม่เดา)
- legacy snapshot อยู่ที่ `.sta/backups/` — คืนด้วย `sta rollback` / `sta list-backups`

instruction ownership ราย path class (framework-managed / project-owned-with-framework-block /
project-owned-merged / project-owned-untouched / machine-local) อยู่ที่
[`workspaces.md`](workspaces.md) § Instruction ownership

## Version Management

- **Single source of truth**: `version` ใน root `package.json` → `npm run build:templates` stamp ลง
  `templates/manifest.json` (`framework_version`) → `software-team-agents --version`
  (พิมพ์ `version+digest` — digest ตรง payload จริง)
- **Workspace records** last-synced version ใน `.agent-team/manifest.json` — เทียบกับ installed version
  ได้ sync state: `UP_TO_DATE` / `OUTDATED` (`sync` ได้เลย) / `INCOMPATIBLE` (major ต่าง — ต้อง
  `sync --force` หลังตัดสินใจ; `open` preflight fail จนกว่าจะ sync)
- **Upgrade flow**: ติดตั้ง version ใหม่ → `software-team-agents status` → `software-team-agents sync`
  ต่อ workspace; locally modified managed files block จนกว่าจะ resolve หรือยืนยัน `--force`
- **Legacy install (`.sta/`)**: `sta init`/`sta upgrade --mode legacy-project` error พร้อมชี้ให้รัน
  `software-team-agents init` ซึ่งแปลง workspace `.sta/`-only ไปเป็น `.agent-team/` โดยไม่เสียเนื้อหา ·
  `sta migrate` สำหรับ breaking manifest schema change
- **ยังไม่มี**: publish ขึ้น npm registry, auto-update, lockfile/resolution ข้าม repo

## Configuration Reference

| ไฟล์ | อยู่ที่ | keys สำคัญ |
|---|---|---|
| `installation.yaml` | `%LOCALAPPDATA%\software-team-agents\` (Windows) หรือ `~/.config/software-team-agents/` | `schema_version: 1` (scalar `knowledge_root` — อ่านต่อได้โดยไม่ถูกแก้) หรือ `2` (`knowledge_roots` map + `default_root`, `knowledge_root` เป็น compatibility alias — เขียนโดย `sta configure knowledge-root [--root]/default-root`) |
| `.agent-team/config.yaml` | Target/Knowledge workspace | `schema_version`, `target_id`, `registered_at`, `role` (legacy — read-only), `knowledge.path` (legacy), DEV `stack`, optional `execution`, `overrides[]` |
| `.agent-team/manifest.json` | generated, ห้าม hand-edit | `framework_version`, `files[]` (path + pristine sha256) |
| `.sta/config.yaml` | orchestrated/legacy project root | `schema_version: 1`, optional `execution`, `routing`, `qa`, `verification`, `token_budget`, `context_budget`; upgrade ไม่ rewrite ค่า project-owned นี้ |
| `targets.yaml` | Knowledge root | registry ของ Target: `target_id/name/remote_url/status` (+ v2: `ownership_state` `owned\|released`, `repository_aliases` — canonical coordinates); canonical repository หนึ่งรายการมีเจ้าของได้ root เดียวต่อเครื่อง — บังคับที่ register/preflight และตรวจใน `sta doctor` |
| `.workflow/targets.local.yaml` | Knowledge root (local) | map `target_id → path` + `remote_host_aliases` (machine-local SSH host mapping) |
| `knowledge-policy.yaml` | Knowledge root | field visibility ต่อ role + freshness thresholds |
| `model-tiers.yaml` | Framework repo (human-owned) | map Tier → model/effort ต่อ camp + role defaults |
| `project.yaml` | Framework repo | `current` (stack ที่ agents สร้างได้จริง) vs `target` (stack อนาคต — checked ต่างมาตรฐาน) |
| `layout.yaml`, `escalation-policy.yaml`, `test-pyramid.yaml` | Framework repo (+ sync ไปกับ payload ชุดเดียวของ workspace) | directory ownership / recovery policy / test levels |

Config ทั้งหมดเป็น optional — config ที่มีเพียง `schema_version: 1` ก็ parse และ resolve เป็น default
runner (`claude-code`) + frontmatter model; config ที่ไม่มี `routing.order` ทำงานเหมือนเดิมทุกประการ
ตัวอย่าง config เต็ม (per-role route, `routing.order`, `allow_below_supported`, `qa`, `verification`)
อยู่ที่ [`tier-and-effort-run.md`](tier-and-effort-run.md)

### Environment variables

Runtime protocol ใช้ namespace `STA_*` เท่านั้นเพื่อไม่ผูก Framework เข้ากับ runtime ใด runtime หนึ่ง:

- `STA_ROLE` — role ปัจจุบันสำหรับ path permissions
- `STA_WRITABLE_WORK_ROOTS` — JSON array ของ path — interactive `open` ตั้ง `[]`; orchestrated
  Target-write stage ได้เฉพาะ canonical roots ของ task จาก three-repo preflight
- `STA_TARGET_WORK_ROOTS` — JSON array `[{targetId, path, access}]` — แผนที่ access ของทุก Target ที่
  invocation เห็น เพื่อให้ guard ระบุชื่อ Target ในข้อความ refusal; ตัวมันเอง**ไม่ใช่**การให้สิทธิ์เขียน —
  write grant มาจาก `STA_WRITABLE_WORK_ROOTS` เท่านั้น
- `STA_KNOWLEDGE_ROOT` — read-only Knowledge context เมื่อ resolve ได้; launcher เป็นผู้ resolve +
  realpath แล้ว set ก่อน runtime เริ่ม — session หนึ่งเห็นค่าเดียว (หนึ่ง session = หนึ่ง root)
- `STA_KNOWLEDGE_ROOT_NAME` — ชื่อของ root ที่ launcher เลือก (managed-session selection marker; V11) —
  set คู่กับ `STA_KNOWLEDGE_ROOT` เสมอ; guard hook ใช้ marker นี้แยก managed session ออกจาก unbound shell
  และ deny managed invocation ที่ selection ไม่ครบก่อนตัดสิน permission ใด (hook ไม่อ่าน installation
  เอง — กัน TOCTOU); generated content (`knowledge-root.md`, bootstrap block) เป็น root-neutral —
  ไม่ฝัง path หรือรายชื่อ root, selection จริงดูจาก `sta context`/`status`

การเปลี่ยน namespace นี้เป็น breaking change: หลังอัปเกรด Framework ต้องรัน `software-team-agents sync`
ให้ launchers, hooks และ generated bindings ทุก runtime รับ contract ชุดเดียวกันก่อนเริ่ม session ใหม่

### Context budget และ telemetry

`context_budget` เป็น optional — ไม่ตั้งหรือตั้งไม่ได้ resolve เป็น `mode: warn` เสมอ (วัด + รายงาน
overflow แต่ไม่แก้ prompt ไม่ปฏิเสธ stage; `mode: reject` ต้อง opt in อย่างชัดเจน) ทุก run record มี
`estimated_input_tokens` (deterministic จาก `context_chars`) และ `effort` ของ model/runner — แสดงใน
`sta tokens` และใช้ใน `sta audit`; `effort` (reasoning effort) ไม่ใช่ `qa_effort` (ระดับงานของ QA risk
gate)

### Tier ต่อ phase และ camp

[`model-tiers.yaml`](../model-tiers.yaml) (human-owned) map Tier → model/effort ต่อ camp — cells ข้าม
camp เป็น approximation ที่คนเลือก `plan.md` ใส่ optional phase-level `Tier T2–T6` ได้เฉพาะ
implementation/QA phase (T1 reserved) camp ถูกเลือกตอนเริ่ม dev phase: explicit runtime/camp หรือ
configured camp ชนะเสมอ; headless run ใช้ configured default โดยไม่ถาม stdin (การเลือก camp ไม่ใช่
automatic quota fallback) pyramid enforcement (`test-pyramid.yaml` ไม่ตั้ง `enforcement` = `warn`) และ
QA `skip` เป็น **OFF by default**; deterministic gate ตรงข้าม — เปิด default, ปิดเฉพาะ task ด้วย
`--no-deterministic-gate` operator manual ที่ [`tier-and-effort-run.md`](tier-and-effort-run.md)

### Target-resolved stack

`stack:` เป็น Target-resolved configuration ที่ engineer prompts และ verification gate ใช้ร่วมกัน ไม่ใช่
Framework-wide default:

```yaml
stack:
  profile: dotnet
  package_manager: nuget
  commands:
    install: dotnet restore
    build: dotnet build
    test: dotnet test
    lint: dotnet format --verify-no-changes
    typecheck: dotnet build
  schema_paths: []
  source_roots: ['.']
  detected_at: <ISO timestamp>
  fingerprint: sha256:<evidence digest>
  generated_hash: sha256:<detector-owned fields digest>
```

`fingerprint` เปลี่ยนเมื่อ project/lock/script evidence เปลี่ยน; `generated_hash` แยก deterministic
output จาก block ที่คนแก้เอง — sync ไม่ rewrite block ที่คนแก้เงียบ ๆ และ profile-family change เป็น
preflight STOP การเปลี่ยน stack เป็น human decision เสมอ

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

- Release gate: `npm run release:check` (root) รันทุก step ตามลำดับ release V3 property gates แยกรัน
  เดี่ยวได้เพื่อ debug: `npm run test:guardrails`, `npm run test:modes`, `npm run test:paid-fallback`
  — ไม่มี step ไหนต้อง login runner จริง
- Benchmark gate: `npm run test:benchmark` ตรวจ corpus/oracle ที่ frozen และ regenerate
  metric/run-ledger reports แบบ deterministic; ไม่เรียก live model
- CI: [`.github/workflows/agent-framework-ci.yml`](../.github/workflows/agent-framework-ci.yml) รัน
  self-test + typecheck + tests + release-gate `--check-*` flags + template build/init check + docs
  sync check บนทุก PR และทุก push ไป `master` หรือ `release/**`
- `templates/` เป็น build artifact — แก้ที่ root sources (`.claude/`, `contracts/`, ...) แล้ว regenerate
  เสมอ
- `planning/` เป็น working docs ภายใน (gitignored) ไม่ได้แถมมากับ repo ที่ clone
- เอกสารกฎ: [`policies/`](../policies/README.md) · machine-readable half ของ agent:
  [`contracts/`](../contracts/) · operating rules สำหรับ agent: [`CLAUDE.md`](../CLAUDE.md) ·
  Codex root pointer: [`AGENTS.md`](../AGENTS.md) · knowledge model:
  [`knowledge/README.md`](../knowledge/README.md) · V1 contract (guarantees/non-goals):
  [ADR-004](../decisions/ADR-004-v1-contract.md)

## ข้อจำกัด (current)

- **Codex runtime partial** — interactive launch ผ่าน `--runtime codex` ได้ แต่ headless adapter ยังไม่
  เคย verify กับ install จริง UAT ครอบเฉพาะ Claude Code
- **OpenCode runtime** — spike+UAT smoke ผ่าน แต่ exit checks ไม่มี in-band (`GUARD GAP` + QA round คือ
  coverage), doc-rewrite/secret-leak hooks ยังไม่พอร์ตลง plugin
- **Contract write-globs จำกัด** — pattern ปัจจุบันครอบ `src/lib/**`, `server/**`, `app/api/**`,
  `prisma/**` ฯลฯ app code นอก pattern นี้ engineer แก้ไม่ได้ (hook บล็อก) — ต้องปรับ contract ให้ตรง
  โครงสร้าง project จริงก่อนใช้
- **Unattended run ต้อง `--autonomy edit|full`** — default (`propose`) ติด permission prompt headless
- **Git เป็น transport เดียว** — knowledge history ต้องมี git ไม่มี real-time collaboration
- **Conflict detection เป็น heuristic** — จับ model/endpoint/term ซ้ำ ไม่ใช่ semantic contradiction
- **Automated tests ของ Target เป็น opt-in** — ไม่มี suite = QA ตรวจด้วยการอ่านโค้ด + static checks
  และรายงาน `Unverified Behaviour` ไว้ชัดเจน
- **ยังไม่มีไฟล์ LICENSE** — package เป็น `private` ใช้ภายในองค์กร
