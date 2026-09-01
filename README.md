# software-team-agents

**Personal AI. Shared Knowledge. Common Process.**

Process/workflow layer + orchestrator CLI สำหรับทีมซอฟต์แวร์ ที่จัดระเบียบการทำงานร่วมกันระหว่าง Human กับ AI coding tools (Claude Code, Codex, OpenCode) — แต่ละคนใช้ AI/tool ของตัวเองได้ แต่ทั้งทีมทำงานบน Knowledge และ Process ชุดเดียวกัน

| ส่วน | หน้าที่ |
|---|---|
| Claude Code / Codex / OpenCode | execution runtime — เครื่องมือที่ลงมือทำงาน |
| **software-team-agents** (repo นี้) | process/workflow layer + orchestrator CLI — จัดว่าใครทำอะไร ต่อกันอย่างไร ตรวจอย่างไร |
| Knowledge | ความรู้ร่วมขององค์กร/project (git repo แยก) |
| Target | repository ของ product จริงที่ให้ AI เขียนโค้ด |
| Human | ผู้กำหนด intent/constraints และผู้ตัดสินใจในจุดสำคัญ |

ไม่ใช่ AI model และไม่ได้มาแทน runtime จริง — ทุก run ของ pipeline ยัง execute ผ่าน runner adapter ที่เลือก. `sta run` default เป็น **Single + Claude Code**; `software-team-agents dev|ba` เป็น interactive lane ที่คนเลือก runtime โดยตรงและไม่ผ่าน V3 router

> **ตั้งทีมใหม่?** เดิน onboarding เต็มทีละขั้นที่ [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md) (Install → Bind →
> Init workspace → Validate → Ready + Troubleshooting) — README นี้เป็น reference, ไม่ใช่ walkthrough
>
> **ให้ AI ตั้งให้?** ชี้ assistant (Claude Code / Codex / OpenCode) ไปที่ [`prompt-setup.md`](prompt-setup.md) —
> playbook เดียวกันในรูปแบบที่ agent รันเอง (ดูหัวข้อ [Setup playbooks](#setup-playbooks-prompt-setupmd)).

---

## Architecture: Three-Repo + Local Runtime State

Three-Repo แยก repository สามประเภท และ V3 แยก **Local Runtime State** เป็น ownership domain ที่สี่เพราะ lifecycle/สิทธิ์ต่างจากทั้งสาม repo:

| Domain | เก็บอะไร | Lifecycle |
|---|---|---|
| **Framework** (repo นี้) | orchestrator CLI, agent prompts, hooks, contracts, workflows, policies, stacks — pack เป็น npm package `software-team-agents` | อัปเดตโดยติดตั้ง `.tgz` version ใหม่ + `sync` |
| **Knowledge** (ต่อบริษัท) | `knowledge/`, `_docs/`, `decisions/`, `targets.yaml`, `knowledge-policy.yaml` | commit + merge ผ่าน git โดยทีม |
| **Target** (ต่อ product) | source code จริง + `.agent-team/` metadata | git flow ปกติของ project นั้น |
| **Runtime State** (local ต่อเครื่อง/run) | `.workflow/state.db`, `.workflow/state.yaml`, `.workflow/packets/`, `.workflow/evidence/`, `.workflow/runs/` | สร้าง/ย้าย schema โดย orchestrator, bounded retention, gitignored; ห้าม classify เป็น Knowledge/Target และไม่ sync/commit |

ผลที่ได้: คนที่ไม่แตะโค้ด (BA / SA / PM / test-planner) clone แค่ Knowledge repo — ไม่ต้อง clone Target และ framework internals ไม่ติดเข้า git history ของ repo ลูก

### อะไรถูก install / copy / generate

- **Global install** — `.tgz` ให้ CLI 2 ตัวจาก package เดียว:
  - `software-team-agents` — Target-first CLI (v2): `init | sync | status | dev | ba`
  - `sta` — orchestrated pipeline CLI: `run | status | approve | roles | doctor | ...`
- **Sync เป็น one-way เสมอ: Framework → Workspace** — ไม่มี Knowledge ⇄ Target content sync ไฟล์ที่ถูก sync track ใน manifest พร้อม sha256
- **Generated ที่เครื่อง** — `.codex/agents/<role>.toml` และ `.opencode/agent/<role>.md` ถูก render จาก `.claude/agents/<role>.md` ตอน sync (ไม่ได้ ship มากับ payload); `.opencode/plugin/sta-guards.js` เป็น authored payload ที่ sync copy ให้ทุก workspace
- **Runtime State เป็น domain ที่สี่** — task state, execution packets, verification evidence และ runner output ใต้ `.workflow/` เป็น local/regenerable, gitignored และไม่ sync ข้ามเครื่อง; `.workflow/targets.local.yaml` เป็น machine-local Target mapping เช่นกัน

### โครงสร้าง Framework repo

```
orchestrator/           ← CLI + state store + knowledge engine (Node/TypeScript, vitest)
.claude/agents/*.md     ← agent prompts 11 roles
.claude/hooks/*.js      ← guards 6 ตัว (บังคับใช้กฎระดับ tool call)
.claude/scripts/*.js    ← status generator, schema-contract check, static-analysis gate
.claude/shared/         ← redirect ไป policies/ + scoping procedure
.claude/settings.json   ← wiring hooks ทุกตัว
.codex/agents/*.toml    ← Codex bindings (checked by --check-bindings)
.opencode/agent/*.md    ← OpenCode bindings (generated, checked by --check-bindings)
.opencode/plugin/       ← sta-guards.js — guards ฝั่ง OpenCode (tool.execute.before)
.claude/commands/*.md   ← slash command shortcuts 31 ตัว — source of truth (concept `command`)
.opencode/commands/*.md ← OpenCode rendering ของ commands (generated, checked by --check-bindings)
.agents/skills/*/       ← Codex Agent Skills rendering ของ commands (generated, checked by --check-bindings)
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

สถานะเป็นชุดปิด (`sta runtimes` อ่านจาก source of truth เดียวกัน — `orchestrator/src/runtime/runtimeSupport.ts`, test ตรวจว่าตารางนี้ตรงกับ record จริง): **Supported** = headless pipeline + guards verified บน install จริง · **Preview** = launch paths ใช้ได้, gap ที่เหลือถูกระบุชื่อและมี coverage · **Experimental** = spike-proven เท่านั้น · **Unsupported** = ไม่เสนอ

| Runtime | สถานะ |
|---|---|
| **Claude Code** | ✅ **Supported** — implemented + verified (pipeline, guards, capability probe) |
| **Codex** | ⚠️ **Preview** — `software-team-agents dev\|ba --runtime codex` เปิด interactive session ได้ และ `.codex/agents/*.toml` + skills mirror `.agents/skills/**` ถูก generate ครบ (skills invoke `$name` ได้จริงบน codex-cli 0.149 — spike T-CXC1) แต่ headless pipeline (`sta run`) วิ่งบน Claude Code เป็น default; `CodexAdapter` ฝั่ง orchestrator ยังเป็น implementation ที่ไม่เคย verify กับ install จริง |
| **OpenCode** | 🧪 **Experimental** (T-OC, planning/v2) — bindings `.opencode/agent/*.md` + plugin `sta-guards.js` sync ครบ, commands mirror `.opencode/commands/**` generate ครบ (`/name` ผ่าน `opencode run --command` — spike T-OCC1), `dev\|ba --runtime opencode` เปิด session ได้, headless เลือกได้ด้วย `sta run --runtime opencode`; adapter/permission ผ่านการ spike พิสูจน์แล้วแต่ exit checks (typecheck/secret ตอนจบ run) ยังไม่มี in-band — รายงานเป็น GUARD GAP และให้ QA round เป็นตัวครอบ |
| **Paid API** | 🧪 **Experimental** — fallback สำหรับ read-only/document stages ผ่าน official transport ที่ embedding host inject ให้เท่านั้น; ปิดโดย default, ไม่อ่าน credential เอง และไม่มี Target-write guard จึงถูกปฏิเสธก่อน API invocation |

ข้อจำกัด: การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` (default `propose` ติด permission prompt ที่ไม่มีคนกดใน headless run)

### Execution modes, routing และ fallback (V3)

`--mode <single|auto|manual>` ใช้กับ `sta run` เท่านั้น; interactive `software-team-agents dev|ba --runtime <claude|codex|opencode>` ยังเป็น direct user choice และไม่ใช้ router.

| Mode | พฤติกรรมจริง |
|---|---|
| `single` | **default**. ใช้ runner เดียวจาก `--runtime`, `execution.runner`, หรือ `claude-code` ตามลำดับ; ไม่ hand off |
| `auto` | opt-in ด้วย `--mode auto`, `execution.mode: auto`, หรือการประกาศ `routing.strategy`/`routing.order` โดยไม่กำหนด mode; เดิน candidate order เฉพาะเมื่อ runner คืน `UNAVAILABLE`. `ERROR`/`TIMEOUT` ไม่ trigger fallback |
| `manual` | opt-in; ต้องมี runner **และ model** ชัดเจนต่อ role ใน `routing.by_role` หรือ legacy `model_routing`. `--runtime` และ `--model` เป็น explicit per-run override; strict Manual ยังต้องมี route ที่ resolve ได้ |

Routing precedence ที่ implementation ใช้คือ `--runtime` → `routing.by_role` (เหนือ `model_routing`) → `routing.order`/`routing.strategy` → default `claude-code`; candidate ต้อง registered, available, มี capability ที่ stage ต้องใช้ และ automatic routing ไป runtime ต่ำกว่า `supported` ต้อง opt in ราย runtime ผ่าน `routing.allow_below_supported`. `--runtime <id>` โดยไม่มี `--mode` รักษา behavior เดิมด้วยการหมายถึง Single.

Auto fallback เดินต่อได้เฉพาะ candidate ที่ผ่าน guard/capability policy. Paid API ไม่ถูกสร้างเป็น usable transport เอง: embedding host ต้อง inject official authenticated transport และตั้ง `execution.allow_paid_fallback: true`; default คือ **`false`**. ถ้า requested runner ใช้ไม่ได้และไม่มี eligible candidate เหลือ (รวม paid fallback ที่ยังปิด) pipeline **STOP → Human** พร้อมเหตุผล — ไม่เลือก provider หรือจ่ายเงินเงียบ ๆ.

V3 flags ที่ `sta run` รับจริง:

| Flag | ค่า/ผล |
|---|---|
| `--mode <single|auto|manual>` | เลือก execution mode; default `single` |
| `--runtime <claude-code|codex|opencode|paid-api>` | เลือก runner; ถ้าไม่มี `--mode` จะบังคับ Single. `paid-api` ยังต้องเปิด config opt-in |
| `--no-qa-optimization` | กลับไปใช้ executor QA แบบก่อน optimization สำหรับ task นี้; ไม่ใช่ QA skip |
| `--no-deterministic-gate` | explicit escape hatch ปิด deterministic pre-check สำหรับ task นี้; default gate เปิด |
| `--token-budget <n>` | positive integer, post-hoc task token ceiling; ไม่ใช่ pre-spawn context cap |
| `--model <name>` | explicit model override สำหรับ run นี้ และทำให้ mode เป็น Single เมื่อไม่ได้ระบุ `--mode`; runtime ปฏิเสธ model ที่มันใช้ไม่ได้ |

ดู surface ทั้งหมดที่ build นี้รับจริงด้วย `sta --help`, runtime/support จริงด้วย `sta runtimes`, และผล routing/fallback ที่บันทึกด้วย `sta status <task-id>` / `sta audit <task-id>`.

สิ่งที่ V4 **ไม่เปลี่ยน**: routing ยังมี precedence เดิมห้าระดับ, runtime contracts ยังเป็น adapter contracts เดิม, และ ContextManager ยังเลือก context แบบ conservative เดิม (unknown section ถูกเก็บไว้).

## Setup playbooks (`prompt-setup.md`)

`prompt-setup.md` คือ playbook สำหรับ **AI coding assistant** (Claude Code / Codex / OpenCode หรือ agent ใด ๆ ที่อ่านไฟล์ + รัน shell ได้) ให้ตั้ง / ซ่อม / ตรวจ software-team-agents บนเครื่องหนึ่งเครื่องต่อ role เดียว — runtime-agnostic, สมมติแค่ file access + shell คู่ขนานกับ [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md) ซึ่งเป็นเวอร์ชันให้ **คน** เดินเองพร้อม Troubleshooting

**วิธีใช้:** ให้ assistant อ่านไฟล์นี้ — paste เนื้อหาเข้า session หรือสั่ง "อ่าน `prompt-setup.md` แล้วตั้งให้ที"

**สิ่งที่มันทำ:** Phase 0 inspect แบบ read-only (`software-team-agents status --json`, `--version`, `sta --check-workspace`) → สรุปสิ่งที่เจอ → ให้เลือก 1 ใน 7 flow:

| Flow | ใช้เมื่อ |
|---|---|
| **BA** | ตั้ง analysis workspace ใน Knowledge repo (Framework + Knowledge เท่านั้น, ไม่มี Target) |
| **DEV** | ตั้ง engineering workspace ใน Target repo + bind Knowledge เป็น read context |
| **QA** | เหมือน DEV แต่ derive ความต้องการจาก workflow definitions ก่อนถาม |
| **Add Target** | register Target เพิ่มในชุดที่มีอยู่ โดยไม่แตะของเดิม |
| **Update Setup** | re-inspect + `sync` หลัง Framework ขยับ/อัปเดต |
| **Inspect Setup** | รายงาน read-only ล้วน ไม่แก้อะไร |
| **Repair Setup** | repo ย้ายที่, sync ค้าง, remote ไม่ตรง, prompt หลุด workspace ผิด |

**หลักการที่ playbook บังคับตัวเอง:** inspect ก่อนถาม (ถามเฉพาะที่ตรวจไม่ได้) · ใช้คำสั่งทางการเท่านั้น (`init | sync | status`, `sta configure knowledge-root`) ไม่แก้ `.agent-team/` ด้วยมือ · safe by default — ไม่ลบอะไร, ไม่ `sync --force` จนกว่าคนจะพูดคำว่า "force" ต่อ step นั้น, ไม่แตะ Framework checkout · state-changing git (`git clone` / `git init` ตอน bootstrap Target ใหม่) ต้องโชว์คำสั่งก่อนและรอ confirm · จบด้วย Final Report + คำสั่งที่ผู้ใช้รันต่อได้

> `prompt-update-knowledge.md` **ไม่เกี่ยวกับ setup** — เป็นชื่อเดิมของ `prompt-reconcile-knowledge-layout.md` (จัด layout ไฟล์ใน Knowledge repo) เหลือเป็น pointer หนึ่ง release แล้วลบ ดูหัวข้อ [จัด Knowledge repo ที่โครงสร้างเพี้ยน](#จัด-knowledge-repo-ที่โครงสร้างเพี้ยน--playbook-prompt-reconcile-knowledge-layoutmd)

## Installation

Prerequisites: **Node.js ≥ 20**, **Git** + อย่างน้อยหนึ่ง runtime ที่จะใช้ — **Claude Code CLI** (default; login แล้ว) / **Codex CLI** / **OpenCode CLI ≥ 1.18** — ตรวจด้วย `node --version`, `claude --version`, `codex --version`, `opencode --version`

### ติดตั้งจาก `.tgz` (วิธีมาตรฐาน — internal distribution)

package เป็น `private`: ไม่ publish ขึ้น registry artifact เดียวคือไฟล์ `.tgz` + SHA-256 checksum ที่ได้จาก `npm run release` ฝั่ง framework ผู้รับไม่ต้อง clone Framework repo เลย:

```bash
# ติดตั้ง (ไฟล์ .tgz แจกกันภายในทีม พร้อมไฟล์ .sha256 สำหรับตรวจ integrity)
npm i -g ./software-team-agents-1.0.0-rc.1.tgz
software-team-agents --version          # ต้องตรงกับ version ในชื่อไฟล์
```

อัปเกรด — ติดตั้ง `.tgz` version ใหม่ทับ แล้ว sync แต่ละ workspace ตาม:

```bash
npm i -g ./software-team-agents-1.0.0-rc.1.tgz
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
| `init` | detect ชนิด workspace (Knowledge markers → BA, app-source markers → DEV); สำหรับ DEV จะ resolve Target stack จากหลักฐานใน repo; จากนั้นบันทึก identity + role + profile ใน `.agent-team/config.yaml` แล้ว sync assets — idempotent, รันซ้ำได้ |
| `sync` | อัปเดต Framework-managed files ตาม installed version — ไฟล์ที่โดนแก้เอง**ไม่ถูก overwrite เงียบ ๆ** (report + recovery advice; `--force` = overwrite พร้อม backup) |
| `status` | role, roots (Target/Framework/Knowledge), installed vs synced version, sync state, conflicts, Claude/Codex/OpenCode readiness (`--json` machine-readable) |
| `dev` | preflight → launch runtime (`claude` default, `codex`/`opencode` เมื่อ `--runtime`) จาก Target — Knowledge binding **required** |
| `ba` | preflight → launch runtime จาก Knowledge repo — Target **never required** |

options ร่วม: `--target-root <path>` · `--role <ba|dev>` (init: เมื่อ workspace markers ambiguous) · `--stack <name>` (init/sync: เมื่อ Target stack ambiguous หรือ unresolved) · `--force` · `--confirm-agents-pointer` (sync เท่านั้น) · `--no-auto-sync` (dev/ba) · `--runtime <claude|codex|opencode>` (dev/ba) · `--json` (status)

สำหรับ DEV, Harness ตรวจ project/lock files ที่ root และลึกลงไปหนึ่งระดับโดยไม่ตาม symlink แล้ว resolve
profile ที่ ship อยู่ (`node`/`frontend`, `dotnet`, `python`, `java`) พร้อม package manager, commands,
source roots และ schema paths. Script ที่ Target ประกาศเองชนะ profile defaults. ถ้าพบหลาย stack families หรือ
ไม่พบ profile ที่รองรับ `init` จะเขียน **nothing** และพิมพ์หลักฐานพร้อมคำสั่งแก้
`software-team-agents init --stack <name>`; AI/setup playbook ต้องถามตัวเลือกนี้เฉพาะกรณีนั้น ไม่ detect
หรือเลือก stack แทน Harness/คน. Profile family ที่เปลี่ยนภายหลังเป็น preflight STOP ไม่ใช่ silent rewrite.

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
| Sync payload | BA agents (`business-analyst`, `system-analyst`, `project-manager`, `test-planner`, `uxui-designer`) + hooks + scripts + policies + `CLAUDE.md` | engineer roster (`backend/frontend-engineer`, `qa-engineer`, `security`, `devops` — **ไม่มี BA-workspace prompts**, T-UX13) + contracts/workflows/stacks/layout YAML |
| Write ที่อื่น | Framework/Target = DENY | Framework/Knowledge = DENY |
| Knowledge-side artifacts (`_docs/module/*/requirement\|design\|test-plan.md`, `uxui/**`, `knowledge/**`) | ✅ เขียนได้ | **DENY ที่ hook** (T-UX13) — ต้องรันจาก Knowledge workspace |

Write policy บังคับจริงผ่าน interactive launch: session ได้ writable root เดียวคือ Role Workspace ของตัวเอง (cwd + `AGENTCLAUDE_WRITABLE_WORK_ROOTS=[]`) — cross-repo writes hit `block-outside-repo` guard (fail-closed) DEV ไม่มี Knowledge binding = preflight fail พร้อมวิธีแก้ทันที. สำหรับ orchestrated V3 run executor ใส่เฉพาะ canonical Target write roots ที่ three-repo preflight resolve แล้ว

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

### Workspace guardrails (planning/v2/workspace-guardrails-TASKS.md)

`status` (และ `--check-workspace`) เตือนก่อนที่ไฟล์จะไปโผล่ผิด repo แทนที่จะให้คนสังเกตทีหลัง — motivated
โดยเหตุการณ์จริงที่ requirement ถูกเขียนลง Target แทน Knowledge:

| WARNING | ตรวจอะไร | แก้ |
|---|---|---|
| Knowledge root bound but never initialized (T-WG1) | `installation.yaml` ผูก Knowledge root ที่มี marker ครบ แต่ไม่เคยมี `.agent-team/config.yaml` ที่นั่น — BA-workspace prompt ไม่มีอยู่เลยทั้งเครื่อง | `cd <knowledgeRoot> && software-team-agents init --role ba` (`status` พิมพ์คำสั่งนี้ตรงๆ) |
| Roster drift (T-WG2) | agent prompt ที่ชื่อเป็นของอีก workspace role (เช่น `business-analyst.md` ใน workspace `role: dev`) — ไม่มีทาง legitimate ไม่ว่าจะมาจากไหน | `software-team-agents sync --force` (backup ก่อนลบ; `sync` เฉยๆ report conflict ไม่ overwrite เงียบๆ) |
| Misplaced module docs (T-WG4, `--check-workspace`) | `_docs/module/**` หรือ Modules table ใน `_docs/status.md` อยู่ใน workspace `role: dev` — ที่ถูกคือ Knowledge repo เท่านั้น | copy ไป `<knowledgeRoot>\_docs\module\<name>\`, merge status row, ลบของเดิม |

ทั้งสามรายการนี้เป็น warning ไม่ block การทำงาน — จุดประสงค์คือให้คน (หรือ AI ที่ทำงานแทนคน) เห็นก่อนเขียนไฟล์ผิดที่
ไม่ใช่หลังจากนั้น รายละเอียด/root-cause analysis เต็มอยู่ที่ `planning/v2/workspace-guardrails-TASKS.md` (internal, gitignored)

### Ownership model

Instruction ownership มีสี่ precedence classes; `software-team-agents status --json` แสดงทุก path ใน
`instructionSurface[]` พร้อม `owner`, `precedence`, `frameworkContributionPresent` และ consequence เมื่อขาด:

| precedence | path class | กติกา |
|---|---|---|
| `framework-managed` | `.claude/agents/**`, `.codex/**`, `.opencode/**` | bytes มาจาก Framework/rendering และ track ใน manifest |
| `project-owned-with-framework-block` | root `CLAUDE.md`, root `AGENTS.md` | project prose เป็นของ project; sync แตะเฉพาะ `<!-- sta:bootstrap -->` … `<!-- /sta:bootstrap -->`, backup ก่อนเขียน และ preserve bytes นอก markers (`AGENTS.md` ที่ยังไม่มีได้ rendered pointer ไป `CLAUDE.md`) |
| `project-owned-merged` | `.claude/settings.json` | preserve project hooks/permissions/unknown keys แล้วเติมเฉพาะ Framework guard registrations ที่ขาด; ไฟล์นี้ไม่กลายเป็น manifest-managed |
| `project-owned-untouched` | `CLAUDE.local.md`, nested `AGENTS.md` | detect/report ได้แต่ sync ไม่แก้; nested instructions อาจมี precedence เหนือ root block ตาม runtime |

Source code, tests, package metadata, `knowledge/`, `_docs/`, `decisions/`, `.workflow/`, `.git`,
`node_modules` และ `.agent-team/` ยังเป็น project-owned และ guard ปฏิเสธแม้ manifest เสีย. สำหรับ
Framework-managed files: disk == pristine → update (backup ก่อน) · disk != pristine → **conflict** จนกว่า
จะ revert / claim เป็น `overrides` / ยืนยัน `--force` · retired file ถูก remove เฉพาะเมื่อ pristine. Marker
ผิดรูป/ซ้ำเป็น blocking conflict และ `--force` จะไม่เดา. `software-team-agents status` และ `sta doctor`
เป็น read-only audit ของ instruction surface เดียวกัน.

## Workflow ของ pipeline (`sta`)

Human เลือกประเภทงานผ่าน classification flags แล้ว orchestrator เดิน workflow ที่ right-size:

```bash
sta run --task-id T-1 --module demo --bug-fix --backend --autonomy edit \
  --backend-target sb-web-helper \
  --project-root C:\src\company-knowledge     # three-repo mode: project-root คือ Knowledge root
```

| flag | workflow | chain | ฐานหลักฐาน right-sizing |
|---|---|---|---|
| `--typo` | `typo.yml` (TRIVIAL) | engineer เท่าน ไม่มี QA | **Judgement** — P3 ไม่มีหมวด typo/copy |
| `--bug-fix` | `bugfix.yml` (SMALL) | engineer → QA (+security เมื่อ sensitive) | **Judgement retained; P3 insufficient** — bug ทุก attempt ไม่ผ่าน frozen oracle และ C-token ไม่ถูกรายงาน |
| `--incremental` | `incremental.yml` (MEDIUM) | — | **Judgement** — P3 ไม่ได้แยก incremental workflow |
| `--business-rule` | `business-rule.yml` (MEDIUM) | BA → SA → engineer → QA | **Judgement** — P3 ไม่ได้แยก business-rule workflow |
| `--new-feature` | `feature.yml` (LARGE_CRITICAL) | BA → SA → PM → test-planner → engineer → QA (full chain) | **Judgement retained; P3 insufficient** — feature ทุก attempt ไม่ผ่าน frozen oracle และ C-token ไม่ถูกรายงาน |
| `--schema` | `schema-change.yml` (LARGE_CRITICAL) | SA → test-planner → engineer → QA | **Judgement** — P3 ไม่ได้แยก schema-change workflow |
| `--deploy` | `deploy.yml` | + devops, gated | **Judgement** — P3 ไม่มี deploy task |
| (flags เสริม) | `hotfix.yml`, `refactor.yml`, `security-fix.yml`, `triage.yml` | classifier เลือกตาม signal/priority | **Judgement retained; P3 insufficient** — refactor/investigation ไม่มี oracle pass/C-token; hotfix/security ไม่ถูกทดลอง |

flag เสริมได้แก่ `--sensitive`, `--backend`, `--frontend` — step ภายใน workflow ถูกเลือกด้วย `when:` (เช่น `touchesBackend`) ตามที่ประกาศในไฟล์ workflow เอง

P3 ไม่ได้พิสูจน์ว่าหมวดใดชนะหรือแพ้ จึงไม่เปลี่ยน route และไม่สร้าง automatic bypass; ถ้าหลักฐานในอนาคตพบหมวดที่แพ้ ให้เสนอ `workflows/*.yml` ที่สั้นลงผ่านกลไกเดิม ไม่เพิ่ม decision axis ใน router

pipeline ที่มี design phase (`--new-feature`, `--schema`, `--business-rule`, `--incremental`) รัน **`uxui-designer` ก่อน `frontend-engineer`** เสมอ (T-UX11); typo/bugfix/hotfix/refactor/security-fix ไม่มี uxui step — frontend work level TRIVIAL/SMALL จึงไม่โดน UX-artifact gate (T-UX12)

### Task lifecycle commands

```bash
sta run      --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full] [--mode single|auto|manual] [--runtime claude-code|codex|opencode|paid-api]
sta resume   --task-id <id> --module <name>          # continue task ใน store
sta retry    --task-id <id> --module <name>          # same as resume
sta pause    --task-id <id>                          # freeze; run/resume/retry refuse
sta cancel   --task-id <id> [--reason <text>]        # ปิด task ถาวร
sta status   [<task-id>] [--watch]                   # ทุก task หรือ task เดียว
sta approve  <task-id> [--yes|--no]                  # resolve human gate ของ task
sta audit    <task-id> [--decisions]                 # WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail
sta qa-metrics [<task-id>] [--export-json <p>] [--baseline <p>]
sta context <role> [--module <name>] [--phase <n,n>] [--task <id> --packet] [--json]
sta projects                                     # status summary ทุก project ใน workspace.yaml
sta --list                                       # ทุก task + batch ที่รันพร้อมกันได้
```

option สำคัญ: `--frontend-target/--backend-target <id>` (immutable ต่อ task), `--phase <n,n>`, `--depends-on <id,id>`, `--env <local|dev|staging|production>`, `--state-db <path>`, `--token-budget <n>`, `--no-qa-optimization`, `--no-deterministic-gate`. `sta context --task <id> --packet` อ่าน latest validated V3 execution packet จาก Runtime State. ความหมายของ V3 execution flags อยู่ในตารางด้านบน; ไม่มี user-facing `--model` หรือ `--qa-skip` ใน CLI นี้

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

knowledge-visibility lane ที่มีจริง: `ba | sa | uxui | dev` — acknowledge/signoff เป็น human act บันทึกใน `knowledge/_roles/**` (agent เขียนไฟล์นี้ไม่ได้ทุกกรณี)

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

Knowledge item ที่มี `target_ids: []` เป็น global; item ที่ระบุ Target จะเข้า retrieval/brief เฉพาะ session
ที่ bind Target นั้น และจำนวนที่ถูก scope ออกจะถูกรายงาน. ใช้
`sta knowledge reconcile --target <id>` (`--json` ได้) เพื่อคำนวณ current/desired evidence ใหม่แบบ
read-only โดยไม่บันทึก verdict หรือแก้ repo ใด. นิยาม authoritative ของ scope, origin, freshness และ
reconciliation อยู่ที่ [`knowledge/README.md`](knowledge/README.md); หัวข้อนี้เป็น authoritative home ของ
Target registry, local mapping และพฤติกรรมหลาย Target เท่านั้น.

## Shared Knowledge (สรุป)

Knowledge ไม่ใช่ "AI memory" — เป็นข้อมูลร่วมของทีมที่มีโครงสร้างและ lifecycle รายละเอียดเต็มใน [`knowledge/README.md`](knowledge/README.md):

- **10 kinds หนึ่ง shape**: requirement (`REQ-`) · business-rule (`RULE-`) · domain (`DOM-`) · architecture (`DES-`) · api (`API-`) · db-schema (`DB-`) · decision (`ADR-`) · task (`BE-/FE-`) · test (`TEST-`) · ux-design (`UX-`)
- **หนึ่ง YAML file ต่อหนึ่ง fact** ภายใต้ `knowledge/<module>/<kind>/<ID>.yaml` — git merge ไม่ชนเว้นแต่สองคนแก้ item เดียวกัน `version` field คือกลไก concurrency
- **Relations 9 แบบ + legality matrix**: `refines/implements/verifies/references/depends-on/constrains/supersedes/conflicts-with/derived-from` — ผิดกฎ = report โดย `--check-knowledge`
- **Source/provenance/freshness** — ทุก item อ้าง `sources[]` freshness วัดจาก digest ของ source ก่อนอายุ: source เปลี่ยน = stale ทันที
- **Status**: `draft → reviewed → approved → deprecated` — approve ได้เฉพาะคน (`sta roles approve`)
- **Role/Target-based context** — `knowledge-policy.yaml` กำหนด field ที่แต่ละ role เห็น; `target_ids: []` เป็น global และรายการที่ scoped จะเข้า context เฉพาะ Target ปัจจุบัน พร้อมจำนวนที่ถูก exclude/fallback เมื่อ resolve Target ไม่ได้
- **Freshness + reconciliation** — brief แสดง verdict จาก `freshnessOf()` ภายใต้เพดาน 16,384 B; `sta knowledge reconcile --target <id>` คำนวณรายงาน current/desired แบบ read-only ทุกครั้งและไม่บันทึก verdict
- Reserved directories: `_sources/ _conflicts/ _bootstrap/ _human-input/ _adoption/ _roles/`

### จัด Knowledge repo ที่โครงสร้างเพี้ยน — playbook `prompt-reconcile-knowledge-layout.md`

ใช้เมื่อมี Knowledge repo **อยู่แล้ว** แต่ layout ไฟล์บนดิสก์ไม่ตรง canonical — มันมีมาก่อน Framework, โดนเครื่องมืออื่นแก้, หรือโตแบบ organic ก่อนมีกฎ module-folder (เช่น มี `_docs/<team-prefix>/module/**` ขนานกับ `_docs/module/**`, requirement dump แบบ `_docs/requirement/<domain>/**`, ไฟล์หลงใต้ `_docs/module/` ที่ไม่อยู่ในโฟลเดอร์ module ใด)

```
# ชี้ assistant (Claude Code / Codex / OpenCode) ไปที่ root ของ Knowledge repo แล้วสั่ง:
"อ่าน prompt-reconcile-knowledge-layout.md แล้ว reconcile โครงสร้าง repo นี้"
```

ผลลัพธ์: assistant ทำ inventory ทั้ง repo → จำแนกทุก path ที่ไม่ตรง canonical ลง 6 bucket (parallel tree / pre-module reference / stray files / out-of-framework / unrecognized `knowledge/**` / **right place แต่ format เก่า**) → รัน `sta --check-doc-structure` + `--check-plan` + `--check-knowledge` ต่อโมดูลเพื่อทำตาราง conformance (`plan.md` checkbox เก่า = `0 tasks / 0 waves` ไม่ผ่าน) → เสนอย้าย/route ทีละรายการพร้อม `mv`/`Edit` ที่จะรัน แล้วทำเฉพาะที่ยืนยัน · **ไม่ลบไฟล์ ไม่ bulk-move ไม่ regenerate doc** — doc ที่ format เก่าถูก route กลับไปให้ agent เจ้าของ reformat เอง

ขอบเขต — playbook นี้จัดแต่ layout ไฟล์ ไม่แตะเรื่องอื่น:

| อาการ | ใช้ |
|---|---|
| โครงสร้างโฟลเดอร์/ไฟล์ใน Knowledge repo ไม่ตรง canonical | `prompt-reconcile-knowledge-layout.md` |
| binding / sync / workspace ไม่ได้ register | `prompt-setup.md` (Inspect/Repair) — รันก่อน ถ้า `sta doctor` / `--check-workspace` แดง |
| หลักฐาน current/desired เทียบ Target จริง (implementation drift) | `sta knowledge reconcile --target <id>` |
| import legacy `.claude/` `docs/` `planning/` เข้า Knowledge ครั้งแรก | `sta adopt <plan\|start\|run\|approve\|validate>` |

> `prompt-update-knowledge.md` เป็นชื่อเดิมของ playbook นี้ — เหลือไว้เป็น pointer หนึ่ง release แล้วลบ

## Design sources & identities (uxui-designer)

`uxui-designer` (role ที่ 11) เป็น **read-only consultant** — วิเคราะห์ design source แล้วผลิต draft `UX-*` + `_docs/module/<name>/uxui/design.md` เสมอ คนเท่านั้น approve/sign-off (`sta roles signoff uxui`) และ frontend work level MEDIUM+ เริ่มไม่ได้จนกว่า gate นี้ current (ขอบเขตจริงดู bullet Right-sizing/Gate ข้ามงานเล็กด้านล่าง)

- **Right-sizing (T-UX11)**: uxui-designer รันเฉพาะ pipeline ที่มี design phase (feature / business-rule / schema-change / incremental); typo/bugfix/hotfix/refactor/security-fix ใช้ artifact เดิมที่ approved+signed ค้าง
- **UX gate ข้ามงานเล็ก (T-UX12)**: TRIVIAL/SMALL ไม่ถูก block ที่ UX-artifact precondition (pipeline ไม่ได้จัด uxui ให้อยู่แล้ว — "AI ออกแบบตรง"); MEDIUM+ และ level ไม่ทราบยังต้องมี signed artifact · SA→DEV handoff บังคับทุก level
- **Routing back (T-UX10)**: คำถามที่ไม่ใช่หน้าที่ uxui (คุ้มค่าไหม → BA · ทำได้ไหม → SA) ถูกรายงานเป็น structured failure แล้ว orchestrator route กลับอัตโนมัติ; ถ้า pipeline นั้นไม่มี BA/SA ให้ถาม → BLOCKED fail-closed

**Design source เข้าถึง agent ได้ 3 ทาง (ห้าม scrape URL):**

1. **Path A — handoff bundle**: คนวาง export/handoff จาก Claude Design ไว้ที่ `knowledge/_sources/design/<module>/handoff/`
2. **Path B — export files**: คนวาง export file (HTML/MD) ไว้ที่ `knowledge/_sources/design/<module>/` — item ที่ derive จะบันทึก `sha256` digest ผ่าน `digestOfSource()` เดียวกับ freshness model; ไฟล์เปลี่ยน = recommendation นั้น stale ทันที
3. **Path C — Claude Design via MCP (two-way, draft-only)**: เชื่อม official server (`https://api.anthropic.com/v1/design/mcp`, login ด้วย `/design-login`) — ทิศ IN อ่าน project/files/comments เป็น draft `UX-*`; ทิศ OUT seed brief → draft mockup บน canvas · **allowlist fail-closed** frozen จาก live server (READ 9 tools / WRITE เฉพาะ `copy_files, create_project, write_files`) — destructive/publishing/membership/chat tools ถูก refuse ถาวร (`orchestrator/src/integration/claudeDesignMcp.ts`); output ทุกทิศยังเป็น **draft** ต้องมีคน sign-off เหมือนเดิม · Path A/B ยังใช้ได้ครบเป็น fallback (offline/ไม่ login)

**Figma ผ่าน MCP แบบ read-only:**

- Tool allowlist: `get_me, get_metadata, get_code, get_screenshot, get_variable_defs` — ไม่มี write tool / Code-to-Canvas (enforce ซ้อนกัน 4 ชั้น: allowlist → PAT read scopes → contract deny → prompt rule)
- **Identity gate (fail closed)**: `get_me.email` ต้องตรงกับ `figma_email` ที่ declare; `figma_email` และ `claude_email` ต้องเป็นเมลเดียวกัน — preflight ของ stage `uxui-designer` จะ block run ถ้ายังไม่ declare หรือไม่ตรง
- **PAT (`FIGMA_PAT`) ไม่เข้า repo/config เด็ดขาด** — ใช้ environment variable หรือ OS keychain ของ runtime เท่านั้น; installation config เก็บเฉพาะ email

ตั้งค่า identities ครั้งเดียวต่อเครื่อง:

```bash
sta configure identity --figma-email <email> --claude-email <email>
```

## Guards และการตรวจสอบ

สิ่งที่ implementation บังคับใช้จริง (hook-level, ไม่ใช่แค่ prompt) — wire ผ่าน `.claude/settings.json`:

| Hook | Event | บังคับว่าอะไร |
|---|---|---|
| `block-git.js` | PreToolUse (Bash/Write/Edit) | state-changing git ถูก block (read-only ผ่าน) |
| `block-outside-repo.js` | PreToolUse | ทุก write resolve อยู่ใน writable roots เท่านั้น |
| `block-doc-rewrite.js` | PreToolUse (Write) | doc ที่มีอยู่ต้อง amend ไม่ regenerate |
| `block-path-permissions.js` | PreToolUse | เขียนได้เฉพาะ path ที่ `contracts/<role>.yaml` ให้ (role อ่านจาก `AGENTCLAUDE_ROLE`) + **workspace rule (T-UX13)**: workspace `role: dev` block การเขียน requirement/design/test-plan/uxui/knowledge แม้ไม่มี role env — ต้องรันจาก Knowledge workspace |
| `require-green-before-stop.js` | Stop/SubagentStop | engineer ส่งงานต่อไม่ได้ถ้า typecheck/lint แดง |
| `block-secret-leak.js` | Stop/SubagentStop | ไฟล์ที่ run แก้ห้ามมี hardcoded secret (`.env.example` รวมด้วย) |

- **Guards ถูกเทสต์** — `node .claude/tests/run.js` (self-test ไม่มี dependencies) — guard ที่ syntax error ต้อง fail loud ไม่ใช่ fail open
- **Installed ≠ registered** — hook script ที่มีอยู่บน disk ยังไม่แปลว่า effective `.claude/settings.json` เรียกมัน. `software-team-agents status`/`software-team-agents status --json` แสดง `hooksRegistered/hooksInstalled`; `sta doctor` ตรวจ surface เดียวกันแบบ read-only.
- **`Guards wired` เป็น launch gate** — preflight ของ `software-team-agents dev|ba` เทียบ Framework registrations ที่ติดตั้งกับ effective settings; ขาดแม้หนึ่งรายการ = FAIL พร้อม `software-team-agents sync`. ถ้า `.claude/settings.json` อยู่ใน `overrides`, gate รายงาน explicit user choice แทนการนับเป็น pass จาก wiring ที่ไม่มี.
- **ฝั่ง OpenCode** — git deny เป็น declarative `permission.bash` globs ใน binding เอง (specificity wins); outside-root/contract path guards มาจาก `sta-guards.js` plugin (auto-load, throw = deny) · doc-rewrite/secret-leak/exit checks **ยังไม่ enforce in-band** → adapter รายงาน unenforced + executor ตะโกน `GUARD GAP` ให้ QA round เป็นตัวครอบ
- **Validation flags** — `sta --check-*` 16 ตัว: `contracts, layout, workflows, profile, decisions, test-pyramid, review-separation, escalation-policy, workspace, repos, environments, doc-structure, plan, knowledge, installation, roles` (+ `--check-bindings` มีใน CLI แต่ไม่ได้ wire ใน CI). `--check-plan [--module <name>]` ตรวจตาราง task ของทุก `plan.md` เป็น dependency graph แบบ deterministic (duplicate id / dangling·self·duplicate dependency / cycle / owner·status ผิด / DES traceability / wave ordering) — pm-improvements T-PM1.3. `--check-workspace` ตรวจสองเรื่องที่ไม่เกี่ยวกัน: `workspace.yaml` (multi-project grouping, T41) และ misplaced-docs scan (T-WG4) — `role: dev` workspace ที่มี `_docs/module/**` หรือ Modules table ใน `status.md` โดนรายงานพร้อม hint ปลายทางใน Knowledge repo
- **doctor** — `sta doctor --project-root <path>` รวม 9 checks แบบ read-only (installation, knowledge binding/schema, targets registry, local mappings, runtime adapter, state store, guard wiring) exit 1 เมื่อมี FAIL พร้อม "Fix:" ทุกข้อ
- **Audit trail** — `sta audit <task-id>`

  `sta audit` และ `sta tokens` ใช้ run record เดียวกัน: `estimated_input_tokens` คือประมาณการจาก context, `effort` คือ reasoning effort ของ agent/runtime และต่างจาก `qa_effort` ของ QA risk gate.
- **Backup/Rollback** — role-aware sync backup ที่ `.agent-team/backups/<ts>/`; legacy upgrade/migrate snapshot ที่ `.sta/backups/` คืนได้ด้วย `sta rollback` / `sta list-backups`

- **Profile-aware static analysis** — `.claude/scripts/static-analysis-gate.js` reads the resolved Target's `stack.commands`, scans only its declared source roots/extensions, and reports `unverified` (exit 2) when every verification command is skipped. With no resolved profile, the legacy Node/package-script report remains unchanged. The gate is offline and never installs a toolchain.

## Slash command shortcuts (Claude runtime)

`.claude/commands/*.md` คือ prompt shortcut ที่พิมพ์ได้ใน Claude Code (`/critic`, `/checklist`, `/summarize`, …) —
**31 ตัว** คัดจาก catalog 50 ตัว (ตัดของส่วนตัว/marketing + `/rewrite` ที่ชนนโยบาย amend-don't-regenerate),
mapping ครบทุก role อยู่ที่ [`planning/v2/claude-commands-TASKS.md`](planning/v2/claude-commands-TASKS.md) §1.1

- **เป็น prompt เท่านั้น** — ไม่แก้ runtime/hook; agent ที่ถูกสั่งผ่าน command ยังโดน guards เดิมทุกตัว
- **Guardrails รวมไฟล์เดียว** — `@_shared/guardrails.md` ถูก import จากทุก command (บังคับ output format, cap, cite file:line, ask-first)
- **Ship ไป target project** ผ่าน `software-team-agents init`/`sync` (TEMPLATE_SOURCES มี `.claude/commands` เป็น concept `command` ใน layout.yaml)
- **กัน drift** — `node .claude/tests/run.js` section 11 ตรวจ frontmatter/import/forbidden-instructions/จำนวนไฟล์ = 31

### Runtime mirrors ของ command ชุดเดียวกัน (generated — ห้าม hand-edit)

Source of truth คือ `.claude/commands/*.md` เสมอ · `software-team-agents init`/`sync` generate ให้ทั้งสอง runtime เพิ่มอัตโนมัติ
และ `sta --check-bindings` ตรวจ byte-match ทุกไฟล์:

| Runtime | ไฟล์ | Invoke | Transform |
|---|---|---|---|
| Claude Code | `.claude/commands/<name>.md` | `/name` | source (guardrails ผ่าน `@_shared/` include) |
| OpenCode | `.opencode/commands/<name>.md` | `/name` | drop `argument-hint` · **inline guardrails 5 ข้อ** (OpenCode resolve `@file` จาก project root — spike T-OCC1) · body verbatim |
| Codex ≥ 0.117 | `.agents/skills/<name>/SKILL.md` (+ `agents/openai.yaml`) | `$name` / เมนู `/skills` | frontmatter `name`+`description` verbatim · drop `argument-hint` · inline guardrails · openai.yaml ปิด implicit invocation (คนพิมพ์เท่านั้น) |

Regenerate mirror ใน Framework repo เอง: `npm --prefix orchestrator run build && node scripts/regenerate-renderings.mjs`
(หรือแก้ที่ `.claude/**` แล้ว rerun gates — self-test sections 11b/11c ตรวจ content rules ของทั้งสองชุด mirror)

## Version Management

- **Single source of truth**: `version` ใน root `package.json` → `npm run build:templates` stamp ลง `templates/manifest.json` (`framework_version`) → `software-team-agents --version`
- **Workspace records** last-synced version ใน `.agent-team/manifest.json` — เทียบกับ installed version ได้ sync state:
  - `UP_TO_DATE` — ตรงกัน
  - `OUTDATED` — minor/patch ต่าง → `software-team-agents sync` ได้เลย
  - `INCOMPATIBLE` — **major ต่าง** → ต้อง `sync --force` (cross-major jump ต้องตัดสินใจเอง ไม่ happen เงียบ ๆ) และ `dev/ba` preflight จะ fail ทันที
- **Current workspace upgrade flow**: ติดตั้ง `.tgz` ใหม่ → `software-team-agents status` → `software-team-agents sync` ต่อ BA/DEV workspace; locally modified managed files block จนกว่าจะ resolve หรือยืนยัน `--force` (backup ก่อนเขียน)
- **Legacy install (`.sta/`)**: `sta upgrade --mode legacy-project --templates <dir>` (skip ไฟล์ที่ user แก้, restore ไฟล์ที่ถูกลบ, backup ก่อนเขียน) · `sta migrate` สำหรับ breaking manifest schema change · `sta rollback [--backup <name>]`
- **Knowledge item schema**: opt-in migration `1 → 2` เพิ่ม `origin` + `target_ids` ผ่าน `sta knowledge migrate-v2 --dry-run` แล้ว `sta knowledge migrate-v2`; ไม่เปลี่ยน body/payload/status/owner/version และรายงาน freshness sweep แรกเป็น baseline. คำสั่ง legacy `sta knowledge-migrate <dry-run|copy|verify|cutover>` ยังเป็น Three-Repo copy/cutover flow และ cutover ต้อง `--confirm I_CONFIRM_MIGRATION`
- **ยังไม่มี**: publish ขึ้น npm registry, auto-update, lockfile/resolution ข้าม repo — distribution ผ่าน `.tgz` เท่านั้น

## Configuration Reference

| ไฟล์ | อยู่ที่ | keys สำคัญ |
|---|---|---|
| `installation.yaml` | `%LOCALAPPDATA%\software-team-agents\` (Windows) หรือ `~/.config/software-team-agents/` | `schema_version: 1`, `knowledge_root` (เขียนโดย `sta configure knowledge-root`) |
| `.agent-team/config.yaml` | Target/Knowledge workspace | `schema_version`, `target_id`, `registered_at`, `role` (`ba\|dev`), `knowledge.path`, DEV `stack`, optional `execution`, `overrides[]` |
| `.agent-team/manifest.json` | generated, ห้าม hand-edit | `framework_version`, `files[]` (path + pristine sha256) |
| `.sta/config.yaml` | orchestrated/legacy project root | `schema_version: 1`, optional `execution`, `routing`, `qa`, `verification`, `token_budget`, `context_budget`; upgrade ไม่ rewrite ค่า project-owned นี้ |
| `targets.yaml` | Knowledge root | registry ของ Target: `target_id/name/remote_url/status` |
| `.workflow/targets.local.yaml` | Knowledge root (local) | map `target_id → path` |
| `knowledge-policy.yaml` | Knowledge root | field visibility ต่อ role + freshness thresholds |
| `project.yaml` | Framework repo | `current` (stack ที่ agents สร้างได้จริง) vs `target` (stack อนาคต — checked ต่างมาตรฐาน) |
| `layout.yaml`, `escalation-policy.yaml`, `test-pyramid.yaml` | Framework repo (+ synced ไป DEV workspace) | directory ownership / recovery policy / test levels |

Environment variables ที่ runtime ใช้: `AGENTCLAUDE_ROLE` (role ปัจจุบันสำหรับ path permissions), `AGENTCLAUDE_WRITABLE_WORK_ROOTS` (JSON array — interactive `dev|ba` ตั้ง `[]`; orchestrated Target-write stage ได้เฉพาะ canonical roots จาก three-repo preflight), และ `AGENTCLAUDE_KNOWLEDGE_ROOT` (read-only Knowledge context เมื่อ resolve ได้)

V3 config ทั้งหมดเป็น optional; config ก่อน V3 ที่มีเพียง `schema_version: 1` ยัง parse และ resolve เป็น Single/Claude Code. ตัวอย่างที่เปิด Auto โดยยังไม่เปิด paid fallback:

```yaml
schema_version: 1
execution:
  mode: auto
  runner: claude-code
  allow_handoff: true
  allow_paid_fallback: false
routing:
  strategy: subscription-first
  order: [claude-code, codex, opencode]
  allow_below_supported: [codex, opencode]
  by_role:
    backend-engineer:
      runtime: codex
      model: gpt-5
qa:
  strategy: risk-based
verification:
  baseline: [unit]
```

### Pre-spawn context budget และ telemetry (V4)

`context_budget` เป็น optional และ omission หรือ config ที่ใช้ไม่ได้จะ resolve เป็น `mode: warn` เสมอ จึงคง behaviour เดิมไว้: วัดและรายงาน overflow แต่ไม่แก้ prompt และไม่ปฏิเสธ stage. เลือก `mode: reject` ได้เฉพาะ project ที่ต้องการหยุดก่อน spawn เมื่อเกิน budget. `roles` และ `model_context_windows` เป็นเพดานหน่วย character; `max_context_estimated_tokens` เป็นเพดานประมาณการ input token เพิ่มเติม ไม่แทนที่ character threshold.

```yaml
context_budget:
  mode: warn                          # default; observation only
  roles:
    qa-engineer: 120000               # prompt characters
  model_context_windows:
    opus: 180000                      # prompt characters
  max_context_estimated_tokens: 45000 # approximate input-token ceiling
```

ทุก run record ใหม่มี `estimated_input_tokens` จาก `context_chars` แบบ deterministic และ `effort` ของ model/runner ที่เลือกไว้. ทั้งสอง field แสดงใน `sta tokens` และอยู่ในข้อมูลที่ `sta audit <task-id>` ใช้อธิบาย run. `effort` ไม่ใช่ `qa_effort`: ค่าแรกคือ reasoning effort ของ agent/runtime ส่วน `qa_effort` คือระดับงานของ QA risk gate.

### Tier ต่อ phase และ camp ที่เลือกตอนเริ่มงาน

รายการ `T-V4-CAST-003` ถึง `006` ship แล้ว: [`model-tiers.yaml`](model-tiers.yaml) เป็นตารางที่ human-owned ซึ่ง map Tier ไปยัง model/effort ของแต่ละ camp; cells ข้าม camp เป็น approximation ที่คนเลือก ไม่ใช่ claim ว่า model เท่ากัน. `plan.md` จึงใส่ optional phase-level `Tier` ได้เฉพาะ implementation และ QA phase (T2–T6; T1 reserved). มันไม่เก็บ runtime, model หรือ fallback ordering.

camp ถูกเลือกตอนเริ่ม dev phase: explicit runtime/camp หรือ configured camp ชนะเสมอ; ถ้าไม่มีทั้งคู่ prompt จะปรากฏเฉพาะ terminal ที่มี TTY และ headless run ใช้ configured default โดยไม่ถาม stdin. การเลือก camp นี้ไม่ใช่ automatic quota fallback และไม่มี camp question ตอนเขียน plan.

ค่าที่ **OFF by default** และ V3 ไม่เปิดให้เอง: Auto (config ว่าง resolve เป็น `single`; การเพิ่ม `routing.strategy`/`routing.order` ถือเป็น opt-in เช่นกัน) · pyramid enforcement (`test-pyramid.yaml` omitted `enforcement` = `warn`) · QA `skip` (production CLI ไม่มี flag/config เปิด; low-risk QA ยังเป็น `lightweight`) · paid fallback (`execution.allow_paid_fallback` default `false`). Deterministic gate ตรงข้ามกันคือเปิดโดย default และปิดเฉพาะ task ด้วย `--no-deterministic-gate`.

`context_budget.mode: warn` เป็นค่า default แบบ OFF-by-default สำหรับ enforcement: มันวัดและเตือนเท่านั้น; `reject` ต้อง opt in อย่างชัดเจน.

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

`fingerprint` เปลี่ยนเมื่อ project/lock/script evidence เปลี่ยน; `generated_hash` แยก deterministic output
จาก block ที่คนแก้เอง. Sync ไม่ rewrite block ที่คนแก้เงียบ ๆ และ profile-family change จะหยุดให้คน review.
การเปลี่ยน stack เป็น human decision เสมอ. นี่คือ authoritative home ของ Target adaptation; `CLAUDE.md`
และ role prompts ชี้มาที่ block นี้โดยไม่ทำสำเนาค่า stack.

## Workflow ตัวอย่าง End-to-End

```bash
# 0) ติดตั้ง (ครั้งเดียวต่อเครื่อง)
npm i -g ./software-team-agents-1.0.0-rc.1.tgz

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
software-team-agents dev --runtime opencode # หรือเปิดด้วย OpenCode (bindings sync มาแล้ว)

# 4) รัน task ผ่าน pipeline (headless)
sta run --task-id T-7 --module demo --bug-fix --backend --autonomy edit \
  --backend-target my-product --project-root C:\src\company-knowledge
#   default: --mode single + claude-code
#   --runtime codex|opencode โดยไม่มี --mode ยังหมายถึง Single; Auto ต้อง --mode auto
sta status T-7 --project-root C:\src\company-knowledge
sta audit T-7 --project-root C:\src\company-knowledge

# 5) อัปเกรด framework เมื่อมี .tgz ใหม่
npm i -g ./software-team-agents-<version>.tgz
cd C:\src\my-product && software-team-agents status
software-team-agents sync
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

- Release gate: `npm run release:check` (root) รันทุก step ตามลำดับ release. V3 property gates สาม step แยกรันเดี่ยวได้เพื่อ debug: `npm run test:guardrails` (guardrail invariants หกข้อ), `npm run test:modes` (Single/Auto/Manual matrix บน mock runner), `npm run test:paid-fallback` (paid API ไปไม่ถึงเมื่อ `allow_paid_fallback` เป็น false) — ไม่มี step ไหนต้อง login runner จริงหรือรัน dogfood
- Benchmark gate: `npm run test:benchmark` ตรวจ corpus/oracle ที่ frozen และ regenerate metric/run-ledger reports แบบ deterministic; ไม่ต้อง login runner และไม่เรียก live model
- **Internal V1 Stable** = P0 → P1 → P2 → P3 → P4 แต่ละ phase ถูก **executed and reported** พร้อม release gate สีเขียว; ไม่ได้แปลว่า P3 ให้ผล favourable. แม้ benchmark พบว่า harness ไม่ช่วยในบางหรือทุก category ก็ยังผ่าน milestone นี้ และเป็นผลลัพธ์เชิงลบที่ valid และ publish ได้
- CI: [`.github/workflows/agent-framework-ci.yml`](.github/workflows/agent-framework-ci.yml) รัน self-test + typecheck + tests + release-gate `--check-*` flags + template build/init check บนทุก PR และทุก push ไป `master` หรือ `release/**` (default branch `release/dev` รวมอยู่ — release path ไม่มีทาง bypass validation)
- โครงสร้าง directory ถูกประกาศใน [`layout.yaml`](layout.yaml) และตรวจด้วย `--check-layout` — เพิ่ม folder ใหม่ต้องประกาศก่อน
- เอกสารกฎ: [`policies/`](policies/README.md) · machine-readable half ของ agent: [`contracts/`](contracts/) · operating/pipeline rules: [`CLAUDE.md`](CLAUDE.md) · Codex root pointer: [`AGENTS.md`](AGENTS.md) · knowledge model: [`knowledge/README.md`](knowledge/README.md) · V1 contract (guarantees/non-goals): [`decisions/ADR-004-v1-contract.md`](decisions/ADR-004-v1-contract.md)
- `templates/` เป็น build artifact — แก้ที่ root sources (`.claude/`, `contracts/`, ...) แล้ว regenerate เสมอ
- `planning/` เป็น working docs ภายใน (gitignored) ไม่ได้แถมมากับ repo ที่ clone

## ข้อจำกัด

- **Codex runtime partial** — interactive launch ผ่าน `--runtime codex` ได้ แต่ headless adapter ยังไม่เคย verify กับ install จริง UAT ครอบเฉพาะ Claude Code
- **OpenCode runtime new (0.2.0)** — spike+UAT smoke บน 1.18.21 ผ่าน (probe, headless run, guards report) แต่ exit checks ไม่มี in-band (`GUARD GAP` + QA round คือ coverage), doc-rewrite/secret-leak hooks ยังไม่พอร์ตลง plugin, write/edit arg-shape บน opencode เวอร์ชันอื่นยังไม่เคย verify, full multi-stage pipeline ยังไม่เคย run จริงทั้ง chain
- **Contract write-globs จำกัด** — pattern ปัจจุบันครอบ `src/lib/**`, `server/**`, `app/api/**`, `prisma/**` ฯลฯ app code นอก pattern นี้ engineer แก้ไม่ได้ (hook บล็อก) — ต้องปรับ contract ให้ตรงโครงสร้าง project จริงก่อนใช้
- **Unattended run ต้อง `--autonomy edit|full`** — default (`propose`) ติด permission prompt headless
- **Git เป็น transport เดียว** — knowledge history ต้องมี git ไม่มี real-time collaboration
- **Conflict detection เป็น heuristic** — จับ model/endpoint/term ซ้ำ ไม่ใช่ semantic contradiction
- **Automated tests ของ Target เป็น opt-in** — ไม่มี suite = QA ตรวจด้วยการอ่านโค้ด + static checks และรายงาน `Unverified Behaviour` ไว้ชัดเจน
- **ยังไม่มีไฟล์ LICENSE** — package เป็น `private` ใช้ภายในองค์กร
