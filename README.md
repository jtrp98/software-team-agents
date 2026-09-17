# software-team-agents

**Personal AI. Shared Knowledge. Common Process.**

Process/workflow layer + orchestrator CLI สำหรับทีมซอฟต์แวร์ ที่จัดระเบียบการทำงานร่วมกันระหว่าง Human กับ AI coding tools (Claude Code, Codex, OpenCode, Antigravity) — แต่ละคนใช้ AI/tool ของตัวเองได้ แต่ทั้งทีมทำงานบน Knowledge และ Process ชุดเดียวกัน

| ส่วน | หน้าที่ |
|---|---|
| Claude Code / Codex / OpenCode / Antigravity | execution runtime — เครื่องมือที่ลงมือทำงาน |
| **software-team-agents** (repo นี้) | process/workflow layer + orchestrator CLI — จัดว่าใครทำอะไร ต่อกันอย่างไร ตรวจอย่างไร |
| Knowledge | ความรู้ร่วมขององค์กร/project (git repo แยก) |
| Target | repository ของ product จริงที่ให้ AI เขียนโค้ด |
| Human | ผู้กำหนด intent/constraints และผู้ตัดสินใจในจุดสำคัญ |

ไม่ใช่ AI model และไม่ได้มาแทน runtime จริง — ทุก run ของ pipeline ยัง execute ผ่าน runner adapter ที่เลือก. `sta run` default เป็น **Single + Claude Code**; `software-team-agents open` เป็น interactive session ที่คนเลือก runtime โดยตรงและไม่ผ่าน V3 router (V10 ยุบ lane `ba`/`dev` แล้ว — คำสั่งเก่าถูกตัด ไม่มี alias)

> **ให้ AI ตั้งให้?** ชี้ assistant (Claude Code / Codex / OpenCode / Antigravity) ไปที่ [`prompt-setup.md`](prompt-setup.md) —
> playbook เดียวกันในรูปแบบที่ agent รันเอง (ดูหัวข้อ [Setup playbooks](#setup-playbooks-prompt-setupmd)).
> สำหรับการรีเฟรช/ปรับปรุง knowledge ตาม codebase จริง ให้ใช้ [`prompt-update-knowledge.md`](prompt-update-knowledge.md).

---

## Getting Started

README นี้เป็นเอกสารเจ้าของ installation (`TEAM_SETUP_V1.md` เหลือเป็น pointer มาที่นี่) Channel ที่ใช้งานจริงวันนี้คือ **linked checkout** (`npm link`) — package นี้ไม่เคย publish `.tgz` release จริง (`npm run release` เป็นแค่สคริปต์ packing) — รายละเอียดที่ [## Installation](#installation)

```bash
# 1. Install — link CLI ของ checkout นี้เข้า global (ครั้งเดียวต่อเครื่อง)
cd <framework-checkout>
npm --prefix orchestrator run build
npm link
```

```text
$ software-team-agents --version
1.0.0+4d181b1915f1
```

`<version>+<digest 12 hex>` — digest เปลี่ยนทุกครั้งที่ payload เปลี่ยน แม้ version string จะเท่าเดิม เพราะ
linked checkout ทำให้ content เปลี่ยนได้ทุก commit โดย version string ไม่ขยับ.

```bash
# 2. Knowledge repo — clone ครั้งเดียวต่อเครื่อง — ทุก role ทำงานจาก workspace เดียวนี้
git clone <your-knowledge-repo-url> <path>

# 3. Init workspace — cd เข้า Knowledge repo แล้วรัน
cd <knowledge-repo>
software-team-agents init
software-team-agents status
```

`status` real output จาก validation pair ของ cycle นี้ (Knowledge workspace, `schoolbright-knowledge`) —
sync state ตรงกับ working tree จริง ไม่ใช่ string ที่ค้าง:

```text
$ software-team-agents status
Workspace: Knowledge
Knowledge:
  C:\src\schoolbright-knowledge (id: schoolbright-knowledge)
Target (optional, read-only):
  C:\src\sb-web-student (via local-mapping)
Framework:
  <framework-checkout>
  installed version: 4.0.0
Sync:
  state: OUTDATED
  managed updates available (48):
    update: .claude/hooks/block-path-permissions.js
    update: .opencode/plugin/sta-guards.js
    run `software-team-agents sync` to apply these managed updates
  WARNING: installed Framework payload differs from the payload last synced at this same version
Claude: READY — 5 agent(s), Framework guards wired (8/8)
Codex: NOT READY — ... UNGUARDED — no Codex guard mechanism ...
OpenCode: READY — 5 binding(s) match 5 agent source(s); partial — ...
```

`status` บอกชื่อไฟล์ที่ค้างและคำสั่งแก้ตรงๆ เสมอ — ไม่ใช่แค่ "OUTDATED" เฉยๆ:

```bash
software-team-agents sync    # อัปเดต managed files ตาม state ที่ status รายงาน
```

```bash
# 4. ทำงาน
software-team-agents open    # เปิด session จาก Knowledge workspace (V10: lane เดียว)

# ใน interactive session สามารถสั่ง workflow slash commands:
/next                        # "ทำอะไรต่อ" — resolve module + phase และบอกขั้นตอนถัดไป
/status                      # ภาพรวม module, phase state และ blocker
/verify                      # ตรวจ deterministic gate แล้วเรียก qa-engineer
/changed                     # สรุปไฟล์ที่แก้ล่าสุดและผล deterministic gate
```

Guard coverage ต่าง runtime ต่าง — `codex`/`opencode` ไม่ใช่แค่ "support ต่ำกว่า" แต่คือ launch requirement จริง ([## Runtime ที่รองรับ](#runtime-ที่รองรับ)) Health check เดียวที่ต้องรู้: `software-team-agents status` ([## Ownership, health และ troubleshooting](#ownership-health-และ-troubleshooting)) — README ส่วนที่เหลือเป็น reference ไม่ใช่ walkthrough ตามลำดับ

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
  - `software-team-agents` — workspace CLI (v2): `init | sync | status | open`
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
policies/               ← กฎที่ทุก agent ใช้ร่วมกัน (coding/git/architecture/documentation/security/agent-boundaries/communication/data/ux)
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

Guard coverage per runtime is the same verdict the `open` preflight consults before a launch —
`codex`/`opencode` are not just lower-tier support, they are a **launch requirement**:
`software-team-agents open --runtime codex` refuses to start (`NOT READY — UNGUARDED`) unless you pass
`--allow-unguarded-runtime`, which then prints `[UNGUARDED SESSION — acknowledged]` on the launch line.

| Runtime | สถานะ | Guard coverage |
|---|---|---|
| **Claude Code** | ✅ **Supported** — implemented + verified (pipeline, guards, capability probe); the only V8 runtime certified for unattended Target writes | **enforced** — all six guards wired and verified (`block-git`, `block-outside-repo`, `block-path-permissions`, `block-doc-rewrite`, `block-secret-leak`, `require-green-before-stop`) |
| **Codex** | ⚠️ **Preview** — `software-team-agents open --runtime codex` เปิด interactive session ได้ และ `.codex/agents/*.toml` + skills mirror `.agents/skills/**` ถูก generate ครบ (skills invoke `$name` ได้จริงบน codex-cli 0.149) แต่ headless pipeline (`sta run`) วิ่งบน Claude Code เป็น default; `CodexAdapter` ฝั่ง orchestrator ยังเป็น implementation ที่ไม่เคย verify กับ install จริง; V8 จำกัดไว้ที่ analysis/proposal และ refuse unattended Target writes | **unguarded** — the payload ships no Codex hook wiring at all; a launch requires `--allow-unguarded-runtime` |
| **OpenCode** | 🧪 **Experimental** — bindings `.opencode/agent/*.md` + plugin `sta-guards.js` sync ครบ, commands mirror `.opencode/commands/**` generate ครบ (`/name` ผ่าน `opencode run --command`), `open --runtime opencode` เปิด session ได้, headless เลือกได้ด้วย `sta run --runtime opencode`; adapter/permission ผ่านการ spike พิสูจน์แล้วแต่ exit checks (typecheck/secret ตอนจบ run) ยังไม่มี in-band — รายงานเป็น GUARD GAP และให้ QA round เป็นตัวครอบ; V8 จำกัดไว้ที่ analysis/proposal และ partial guards ไม่ถือเป็น certification สำหรับ unattended Target writes | **partial** — `.opencode/plugin/sta-guards.js` enforces `block-outside-repo` + `block-path-permissions`, each binding's permission block enforces `block-git`; `block-doc-rewrite`, `block-secret-leak`, `require-green-before-stop` have no OpenCode mechanism. A workspace **missing the plugin** is `unguarded`, not merely partial (OpenCode's default posture is allow-all) |
| **Antigravity** | 🧪 **Experimental** — runtime id `antigravity`, binary `agy`; `sta run --runtime antigravity` และ `open --runtime antigravity` รับแล้ว. **Verify บน install จริง agy 1.1.27/Windows 11**: probe, headless `-p`, JSON envelope, token usage และ adapter round-trip เต็มรอบคืน `OK` พร้อม usage จริง. ไม่มี project agent store → role ถูก fold เข้า prompt; envelope ไม่มีช่อง cost → ไม่ claim `COST_REPORTING`; Target-write stages ยังถูกปฏิเสธ ไม่ใช่วิ่งแบบ unguarded | **unguarded** — deny path **มีจริงและ fail closed จริง** (hook คืน `deny` → block; hook ที่ load ไม่ขึ้น → block) แต่ agy อ่าน hooks **จาก `~/.gemini/config/hooks.json` ระดับเครื่องเท่านั้น** — `.agents/hooks.json` ใน workspace ไม่เคยถูกอ่านเลย (ทดสอบ 7 คอนฟิก ข้าม 2 version) → guard ที่ ship มากับ repo ไม่ enforce อะไรเลย |

Same verdict, three places: this table, `sta runtimes` (reads `RUNTIME_SUPPORT` directly), and
`software-team-agents --help`'s `--runtime` line — all three quote `guardSettings.ts`'s `codexCoverage()`/
`opencodeCoverageWithPlugin()`, so a coverage claim cannot drift from what preflight actually enforces
(`orchestrator/src/runtime/runtimeSupport.test.ts` pins it).

ข้อจำกัด: การรัน unattended ต้องใช้ `--autonomy edit` หรือ `full` (default `propose` ติด permission prompt ที่ไม่มีคนกดใน headless run)

### Runtime routing

`sta run` resolve **candidate เดียว** ยกเว้นเมื่อ operator ประกาศ `routing.order` ซึ่งทำงานที่ `level-4` (ดูด้านล่าง). interactive `software-team-agents open --runtime <claude|codex|opencode|antigravity>` ยังเป็น direct user choice และไม่ใช้ router.

| ลำดับ | ที่มาของ route | precedence ใน run log |
|---|---|---|
| 1 | `--runtime <id>` และ/หรือ `--model <name>` / `--effort <name>` ของ run นั้น | `level-1` |
| 2 | `routing.by_role.<role>` ใน `.sta/config.yaml` (`"runtime:model"` หรือ `{ runtime, model, effort }`) | `level-2` |
| 3 | default runner (`execution.runner` หรือ `claude-code`) หรือ `routing.order` (เมื่อตั้งค่า) | `level-4` |

ตารางนี้เลือก runtime/camp เท่านั้น หลังได้ camp แล้ว resolver กลางเลือก model/effort ด้วย precedence `operator model/effort → task Tier → role default Tier → runtime default` และบันทึก effective Tier/requested values/winner basis ใน route log — `model:`/`effort:` ใน role frontmatter เป็น generated output จาก `model-tiers.yaml` ไม่ใช่ authority แยก (`--check-bindings` จับ drift) รายละเอียดเต็มและ DEV override policy ที่ [`docs/tier-and-effort-run.md`](docs/tier-and-effort-run.md)

candidate ต้อง registered + available + มี capability ที่ stage ต้องใช้ (Target-write stage ต้องมี `PRE_TOOL_GUARD`; `business-analyst` ต้องมี `INTERACTIVE_PROMPTS`) — ขาด capability ถูกตัดออกเสมอ; ถ้าเป็น candidate เดียวจะ **refuse** พร้อมเหตุผล ถ้า route ที่เลือกรันไม่ได้ (unavailable / ต่ำกว่า supported โดยไม่ opt in / ขาด capability / runner คืน `UNAVAILABLE`-`ERROR`-`TIMEOUT`) → pipeline **STOP → Human** พร้อมเหตุผล (`fallback_count` = 0) — ไม่มีการสลับ runner เงียบ ๆ

**ข้อยกเว้นเดียว — `routing.order` (ลำดับ 3):** `UNAVAILABLE` hop ไป entry ถัดไป แต่ **`ERROR`/`TIMEOUT` ไม่ hop** (task failure ไม่ใช่ outage); ทุก hop เขียน `fallback_reason` และ +1 `fallback_count` หมดทุก entry = task หยุด · `--runtime`/`--model` (ลำดับ 1) และ `routing.by_role` (ลำดับ 2) ชนะขาด — ordering ไม่ถูกอ่านเลย · `routing.fallback_on` รับ `unavailable` ค่าเดียว (`error` ถูกปฏิเสธตอน load) · camp switch กลาง phase `🔒 Security gate` ทำ QA/security pass เดิมของ phase นั้นเป็นโมฆะ (`ADR-025` #4)

config เก่า (`execution.mode`, `execution.allow_handoff`, `execution.allow_paid_fallback`, `routing.strategy`, `model_routing`) โหลดได้แต่ไม่มีผล — `status` รายงาน `ignored keys: ...`; `sta run --mode ...` error พร้อมบอกคำสั่งแทนที่

V5 flags ที่ `sta run` รับจริง:

| Flag | ค่า/ผล |
|---|---|
| `--runtime <claude-code|codex|opencode|antigravity>` | เลือก runner สำหรับ run นี้ (precedence 1) |
| `--model <name>` | explicit model override สำหรับทุก stage ของ run นี้; runtime ปฏิเสธ model ที่มันใช้ไม่ได้ |
| `--effort <name>` | explicit effort override สำหรับทุก stage ของ run นี้; adapter ปฏิเสธ vocabulary/capability ที่มันใช้ไม่ได้ |
| `--no-qa-optimization` | กลับไปใช้ executor QA แบบก่อน optimization สำหรับ task นี้; ไม่ใช่ QA skip |
| `--no-deterministic-gate` | explicit escape hatch ปิด deterministic pre-check สำหรับ task นี้; default gate เปิด |
| `--token-budget <n>` | positive integer, post-hoc task token ceiling; ไม่ใช่ pre-spawn context cap |
| `--mode <single|auto|manual>` | **ถอดออกแล้ว** — error พร้อมชี้ไป `--runtime`/`--model`/`routing.by_role` |

ดู surface ทั้งหมดที่ build นี้รับจริงด้วย `sta --help`, runtime/support จริงด้วย `sta runtimes`, และผล routing/fallback ที่บันทึกด้วย `sta status <task-id>` / `sta audit <task-id>`.

## Setup playbooks (`prompt-setup.md`)

`prompt-setup.md` และ `prompt-update-knowledge.md` คือ playbook สำหรับ **AI coding assistant** ที่อ่านไฟล์ + รัน shell ได้ (runtime-agnostic):

- **`prompt-setup.md`** — ตั้ง/ซ่อม/ตรวจ workspace บนเครื่องนี้ + capture canonical knowledge ครั้งแรก Phase 0 inspect แบบ read-only แล้วให้เลือก 1 ใน 5 flow: **Set up the Knowledge workspace** / **Register a Target** / **Update** / **Inspect** / **Repair** · หลักการ: inspect ก่อนถาม · ใช้คำสั่งทางการเท่านั้น ไม่แก้ `.agent-team/` ด้วยมือ · safe by default — ไม่ลบอะไร, ไม่ `sync --force` จนกว่าคนพูดเอง, state-changing git ต้องโชว์คำสั่งก่อนและรอ confirm · จบด้วย Final Report + คำสั่งที่รันต่อได้
- **`prompt-update-knowledge.md`** — รีเฟรช canonical knowledge แบบ incremental ให้ตรงโค้ดจริง ตาม source priority: code > config/contracts > canonical knowledge > maintained docs > reference docs (ไม่แตะ reference docs)

**วิธีใช้:** สั่ง assistant "อ่าน `prompt-setup.md` แล้วตั้งให้ที" หรือ "อ่าน `prompt-update-knowledge.md` แล้วรีเฟรช knowledge ให้ที"

## Installation

Prerequisites: **Node.js >= 24** (Node 24 LTS เป็น baseline), **Git** + อย่างน้อยหนึ่ง runtime ที่จะใช้ — **Claude Code CLI** (default; login แล้ว) / **Codex CLI** / **OpenCode CLI ≥ 1.18** / **Antigravity CLI (agy)** (experimental) — ตรวจด้วย `node --version`, `claude --version`, `codex --version`, `opencode --version`, `agy --version`

มี channel เดียวที่ใช้งานจริงวันนี้: **linked checkout (`npm link`)** — package นี้ไม่เคย publish เป็น registry artifact หรือ `.tgz` release ที่แจกจริง (`npm run release` เป็นแค่สคริปต์ packing)

### ติดตั้งจาก linked checkout (`npm link`) — วิธีที่ใช้งานจริง

```bash
cd <framework-checkout>
npm --prefix orchestrator run build   # tsc -> orchestrator/dist
npm link                              # ผูก global `sta` / `software-team-agents` เข้ากับ checkout นี้
software-team-agents --version        # ยืนยัน — <package.json version>+<payload digest 12 ตัวแรก>
```

`npm link` ชี้ bin ทั้งสองตัวไปที่ checkout ตรง ๆ — แก้ source แล้ว rebuild รอบใหม่ มีผลทันทีไม่ต้อง reinstall `--version` พิมพ์ **version string + payload digest** เสมอ (เช่น `1.0.0+4d181b1915f1`) — digest ต่าง = payload ต่างจริง แม้ version string เท่ากัน (linked checkout เปลี่ยน payload ได้ทุก commit)

อัปเกรด — `git pull` แล้ว rebuild ใน checkout เดิม แล้ว sync แต่ละ workspace:

```bash
cd <framework-checkout> && git pull && npm --prefix orchestrator run build
cd my-project && software-team-agents sync
```

ถอนการติดตั้ง:

```bash
npm unlink -g software-team-agents
```

### ติดตั้งจาก `.tgz` — เมื่อไม่มี Framework checkout บนเครื่องนี้

ผู้ดูแล Framework รัน `npm run release` (typecheck → tests → build → `npm pack` → SHA-256 sidecar) แล้วแจก `release/<name>-<version>.tgz` + `.sha256` ที่ได้จริงจากรันนั้น — **อย่าเขียน version เจาะจงในเอกสาร เพราะมันเปลี่ยนทุก release**:

```bash
npm i -g ./software-team-agents-<version>.tgz   # <version> = ชื่อไฟล์ .tgz ที่ได้รับจริง
software-team-agents --version                  # version ต้องตรงกับชื่อไฟล์ (digest อาจต่างกันคนละ build)
```

อัปเกรด/ถอนการติดตั้งเหมือน linked checkout ด้านบน (`npm i -g` ทับด้วย `.tgz` ใหม่ / `npm uninstall -g software-team-agents`)

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
| `init` | detect ชนิด workspace (Knowledge markers → BA, app-source markers → DEV — label เท่านั้น ไม่มีผลตัดสินใด ๆ แล้ว, V10 TASK-021); สำหรับ DEV จะ resolve Target stack จากหลักฐานใน repo; จากนั้นบันทึก identity + role + profile ใน `.agent-team/config.yaml` แล้ว sync assets — idempotent, รันซ้ำได้ |
| `sync` | อัปเดต Framework-managed files ตาม installed version — ไฟล์ที่โดนแก้เอง**ไม่ถูก overwrite เงียบ ๆ** (report + recovery advice; `--force` = overwrite พร้อม backup) |
| `status` | workspace (Knowledge หรือ Target), roots (Target/Framework/Knowledge), installed vs synced version, sync state, conflicts, Claude/Codex/OpenCode/Antigravity readiness (`--json` machine-readable — คง field `role` เดิมสำหรับ legacy config) |
| `open` | preflight → launch runtime (`claude` default, `codex`/`opencode`/`antigravity` เมื่อ `--runtime`) จาก Knowledge workspace — binding เป็น context เท่านั้น ไม่เคย required (V10 TASK-026: `ba`/`dev` ถูกตัด — พิมพ์แล้ว CLI บอกคำสั่งแทนที่ ไม่ทำงาน) |

options ร่วม: `--target-root <path>` · `--role <name>` (retired — accepted and ignored, V10 TASK-026) · `--stack <name>` (init/sync: เมื่อ Target stack ambiguous หรือ unresolved) · `--force` · `--confirm-agents-pointer` (sync เท่านั้น) · `--no-auto-sync` (open) · `--runtime <claude|codex|opencode|antigravity>` (open) · `--json` (status)

สำหรับ workspace ที่ init อยู่ใน Target checkout: Harness ตรวจ project/lock files (root + หนึ่งระดับ ไม่ตาม symlink) แล้ว resolve profile ที่ ship อยู่ (`node`/`frontend`, `dotnet`, `python`, `java`) พร้อม package manager/commands/source roots/schema paths — script ที่ Target ประกาศเองชนะ profile defaults ถ้า ambiguous หรือ unresolved `init` เขียน **nothing** และพิมพ์คำสั่งแก้ `software-team-agents init --stack <name>` (AI/setup playbook ถามเลือก stack เฉพาะกรณีนั้น ไม่เลือกแทน Harness/คน) — profile family ที่เปลี่ยนภายหลังเป็น preflight STOP ไม่ใช่ silent rewrite

### Workspace เดียว — session เปิดจาก Knowledge workspace

V10 ยุบ lane `ba`/`dev` เหลือคำสั่งเดียว (V10 TASK-026 — คำสั่งเก่าถูกตัดถาวร ไม่มี alias: พิมพ์ `ba`/`dev` แล้ว CLI จับชื่อเพื่อบอกคำสั่งแทนที่เท่านั้น). Session เปิดจาก Knowledge workspace เสมอ — Target เป็น checkout ล้วน ผูกด้วย `targets.yaml` + `.workflow/targets.local.yaml`

```bash
cd company-knowledge
software-team-agents init      # detect workspace → sync payload ชุดเดียว
software-team-agents open      # preflight → launch runtime จาก Knowledge workspace
```

| | V10 workspace |
|---|---|
| Session cwd | Knowledge workspace (writable root เดียวของ session) |
| Target | read-only จาก interactive session (`STA_TARGET_WORK_ROOTS` ทุก target ที่ mapping ไว้, `access: read` — เขียน Target ต้องผ่าน orchestrated stage ที่มี `STA_ROLE` + packet scope) |
| Knowledge | workspace ของ session เอง — artifact ของแต่ละ role ตาม role contract |
| Sync payload | ชุดเดียว — prompts ครบทุก role + contracts/workflows/stacks/layout YAML + hooks + scripts + policies + `CLAUDE.md` (ไม่มี profile แยกตาม role อีกแล้ว, V10 TASK-020) |
| Write ที่อื่น | Framework/Target = DENY (Target ที่ bound ถูกปฏิเสธพร้อมชื่อ target) |

Write policy บังคับจริงผ่าน interactive launch: session ได้ writable root เดียวคือ workspace ตัวเอง (cwd + `STA_WRITABLE_WORK_ROOTS=[]`) — cross-repo writes hit `block-outside-repo` guard (fail-closed). สำหรับ orchestrated run executor ใส่เฉพาะ canonical Target write roots ที่ three-repo preflight resolve แล้ว

การ bind ของ V10 อยู่ฝั่ง Knowledge workspace เสมอ — `targets.yaml` (registry) + `.workflow/targets.local.yaml`
(mapping ต่อเครื่อง) ตามหัวข้อ [Multi-Target](#multi-target-และ-multi-machine) ด้านล่าง ส่วน `knowledge.path`
ใน `.agent-team/config.yaml` ของ Target checkout เป็น legacy config ที่ยังอ่านได้ (round-trip) แต่ไม่ใช่วิธี
ผูกใหม่ใด ๆ ใน V10:

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

### Workspace guardrails

`status` (และ `--check-workspace`) เตือนก่อนที่ไฟล์จะไปโผล่ผิด repo แทนที่จะให้คนสังเกตทีหลัง:

| WARNING | ตรวจอะไร | แก้ |
|---|---|---|
| Knowledge root bound but never initialized | `installation.yaml` ผูก Knowledge root ที่มี marker ครบ แต่ไม่เคยมี `.agent-team/config.yaml` ที่นั่น — payload ไม่มีอยู่เลยทั้งเครื่อง | `cd <knowledgeRoot> && software-team-agents init` (`status` พิมพ์คำสั่งนี้ตรงๆ) |
| Misplaced module docs (`--check-workspace`) | `_docs/module/**` หรือ Modules table ใน `_docs/status.md` อยู่ใน Target checkout (คัดจากชนิด workspace จริง — app markers หรือ legacy `role: dev` config) — ที่ถูกคือ Knowledge repo เท่านั้น | copy ไป `<knowledgeRoot>\_docs\module\<name>\`, merge status row, ลบของเดิม |

ทั้งสองรายการนี้เป็น warning ไม่ block การทำงาน — จุดประสงค์คือให้คน (หรือ AI ที่ทำงานแทนคน) เห็นก่อนเขียนไฟล์ผิดที่ ไม่ใช่หลังจากนั้น

### Ownership model

Instruction ownership มีสี่ precedence classes; `software-team-agents status --json` แสดงทุก path ใน
`instructionSurface[]` พร้อม `owner`, `precedence`, `frameworkContributionPresent` และ consequence เมื่อขาด:

| precedence | path class | กติกา |
|---|---|---|
| `framework-managed` | `.claude/agents/**`, `.codex/**`, `.opencode/**` | bytes มาจาก Framework/rendering และ track ใน manifest |
| `project-owned-with-framework-block` | root `CLAUDE.md`, root `AGENTS.md` | project prose เป็นของ project; sync แตะเฉพาะ `<!-- sta:bootstrap -->` … `<!-- /sta:bootstrap -->`, backup ก่อนเขียน และ preserve bytes นอก markers (`AGENTS.md` ที่ยังไม่มีได้ rendered pointer ไป `CLAUDE.md`) |
| `project-owned-merged` | `.claude/settings.json` | preserve project hooks/permissions/unknown keys แล้วเติมเฉพาะ Framework guard registrations ที่ขาด; ไฟล์นี้ไม่กลายเป็น manifest-managed |
| `project-owned-untouched` | `CLAUDE.local.md`, nested `AGENTS.md` | detect/report ได้แต่ sync ไม่แก้; nested instructions อาจมี precedence เหนือ root block ตาม runtime |

นอก instruction surface — **Machine-local** (ไม่ sync ไม่ commit): `.workflow/**`, `.agent-team/backups/**`, `installation.yaml` — `init` เขียน managed `.gitignore` block ให้เอง ลบ/regenerate ได้อิสระ

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
sta run      --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full] [--runtime claude-code|codex|opencode|antigravity]
sta bounded-run --module <name> (--all|--phase <n>|--task <id,...>) [--until next-gate|qa|done] [--dry-run] [--autonomy edit|full]   # bounded run (V8) — compile+freeze plan scope ใน transaction เดียว แล้วเดิน DAG ผ่าน DEV → deterministic verification → checkpoint → coherent QA/repair; ไม่ push/merge/rollback — คู่มือ: docs/bounded-run.md
sta bounded-run --resume <run-id> --module <name> [--dry-run]       # resume ระดับ run จาก ledger (ต่างจาก --resume ระดับ task); V7 --wave/--register-only/--resume-run ปลดแล้ว — docs/bounded-wave-run.md
sta resume   --task-id <id> --module <name>          # continue task ใน store
sta retry    --task-id <id> --module <name>          # same as resume
sta pause    --task-id <id>                          # freeze; run/resume/retry refuse
sta cancel   --task-id <id> [--reason <text>]        # ปิด task ถาวร
sta status   [<task-id>] [--watch]                   # ทุก task หรือ task เดียว
sta changed  [--project-root <path>] [--json]        # สรุปไฟล์ที่เปลี่ยนใน working tree และผล deterministic gate
sta report   [--output <path>] [--project-root <p>] [--module <m>] # สร้าง offline single-file HTML report (status, plan, review, working tree)
sta approve  <task-id> [--yes|--no]                  # resolve human gate ของ task
sta audit    <task-id> [--decisions]                 # WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail
sta qa-metrics [<task-id>] [--export-json <p>] [--baseline <p>]
sta context <role> [--module <name>] [--phase <n,n>] [--task <id> --packet] [--json]
sta projects                                     # status summary ทุก project ใน workspace.yaml
sta --list                                       # ทุก task + batch ที่รันพร้อมกันได้
```

option สำคัญ: `--frontend-target/--backend-target <id>` (immutable ต่อ task), `--phase <n,n>`, `--depends-on <id,id>`, `--env <local|dev|staging|production>`, `--state-db <path>`, `--token-budget <n>`, `--no-qa-optimization`, `--no-deterministic-gate`. `sta context --task <id> --packet` อ่าน latest validated V3 execution packet จาก Runtime State. ความหมายของ runtime-selection flags อยู่ในตารางด้านบน; ไม่มี user-facing `--qa-skip` ใน CLI นี้

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
- Reserved directories: `_sources/ _conflicts/ _bootstrap/ _human-input/ _roles/`

## Design sources & identities (uxui-designer)

`uxui-designer` (role ที่ 11) เป็น **read-only consultant** — วิเคราะห์ design source แล้วผลิต draft `UX-*` + `_docs/module/<name>/uxui/**` คนเท่านั้น approve/sign-off รันเฉพาะ pipeline ที่มี design phase (TRIVIAL/SMALL ไม่ถูก block ที่ UX-artifact gate · MEDIUM+ ต้องมี signed artifact · SA→DEV handoff บังคับทุก level) คำถามนอกหน้าที่ถูก route กลับอัตโนมัติ (คุ้มค่าไหม → BA · ทำได้ไหม → SA; ไม่มี BA/SA ใน pipeline นั้น → BLOCKED fail-closed)

Design source เข้าถึง agent ได้ 3 ทาง (ห้าม scrape URL):

1. **Path A — handoff bundle**: คนวาง export/handoff จาก Claude Design ไว้ที่ `knowledge/_sources/design/<module>/handoff/`
2. **Path B — export files**: คนวาง export file (HTML/MD) ที่ `knowledge/_sources/design/<module>/` — item ที่ derive บันทึก `sha256` ผูก freshness; ไฟล์เปลี่ยน = stale ทันที
3. **Path C — Claude Design via MCP (two-way, draft-only)**: official server (`https://api.anthropic.com/v1/design/mcp`, login ด้วย `/design-login`) — ทิศ IN อ่าน project/files/comments เป็น draft, ทิศ OUT seed brief → mockup บน canvas · **allowlist fail-closed** frozen จาก live server — destructive/publishing tools refuse ถาวร · output ทุกทิศยังเป็น draft ต้องมีคน sign-off (Path A/B เป็น fallback ได้เสมอ)

**Figma ผ่าน MCP แบบ read-only**: tool allowlist ปิด (ไม่มี write/Code-to-Canvas — enforce ซ้อน 4 ชั้น) · identity gate fail-closed (`get_me.email` ต้องตรง `figma_email` และ `figma_email` = `claude_email`) · **PAT (`FIGMA_PAT`) ห้ามเข้า repo/config** — env var หรือ OS keychain เท่านั้น ตั้ง identity ครั้งเดียวต่อเครื่อง: `sta configure identity --figma-email <email> --claude-email <email>`

## Guards และการตรวจสอบ

สิ่งที่ implementation บังคับใช้จริง (hook-level, ไม่ใช่แค่ prompt) — wire ผ่าน `.claude/settings.json`:

| Hook | Event | บังคับว่าอะไร |
|---|---|---|
| `block-git.js` | PreToolUse (Bash/Write/Edit) | state-changing git ถูก block (read-only ผ่าน) |
| `block-outside-repo.js` | PreToolUse | ทุก write resolve อยู่ใน writable roots เท่านั้น |
| `block-doc-rewrite.js` | PreToolUse (Write) | doc ที่มีอยู่ต้อง amend ไม่ regenerate |
| `block-path-permissions.js` | PreToolUse | เขียนได้เฉพาะ path ที่ `contracts/<role>.yaml` ให้ (role อ่านจาก `STA_ROLE`) + **Framework payload deny**: `contracts/**`, `workflows/**`, `stacks/**`, `layout.yaml`, `test-pyramid.yaml`, `escalation-policy.yaml` ถูก block เมื่อ `STA_ROLE` ถูกตั้ง — เปลี่ยนที่ Framework repo แล้ว sync; knowledge artifacts (requirement/design/test-plan/plan/`knowledge/**` ฯลฯ) ถูก deny ต่อ stage engineer/frontend/backend/devops (V10 TASK-012/021 — ไม่มี workspace-role rule แล้ว) |
| `require-green-before-stop.js` | Stop/SubagentStop | engineer ส่งงานต่อไม่ได้ถ้า typecheck/lint แดง |
| `block-secret-leak.js` | Stop/SubagentStop | ไฟล์ที่ run แก้ห้ามมี hardcoded secret (`.env.example` รวมด้วย) |

- **Guards ถูกเทสต์** — `node .claude/tests/run.js` (self-test ไม่มี dependencies) — guard ที่ syntax error ต้อง fail loud ไม่ใช่ fail open
- **Installed ≠ registered** — hook บน disk ยังไม่แปลว่า effective `.claude/settings.json` เรียกมัน — `status` แสดง `hooksRegistered/hooksInstalled`; `sta doctor` ตรวจ surface เดียวกัน · **`Guards wired` เป็น launch gate**: ขาดแม้หนึ่งรายการ = FAIL พร้อม `software-team-agents sync` (`.claude/settings.json` ใน `overrides` = รายงาน explicit user choice แทนการนับเป็น pass)
- **ฝั่ง OpenCode** — git deny เป็น declarative `permission.bash` globs ใน binding + plugin `sta-guards.js` (outside-root/path permissions); doc-rewrite/secret-leak/exit checks ยังไม่ in-band → `GUARD GAP` + QA round ครอบ
- **Validation flags** — `sta --check-*` 20 ตัว (registry เดียวใน `orchestrator/src/cli/checkers.ts`): ตรวจ contracts/layout/prompt-budget/workflows/bindings/profile/decisions/test-pyramid/review-separation/escalation-policy/workspace/repos/environments/doc-structure/doc-size/plan/knowledge/installation/roles/git-ownership · `--check-plan` ตรวจ `plan.md` เป็น dependency graph · `--check-workspace` ตรวจ `workspace.yaml` + misplaced-docs (Target checkout ที่มี `_docs/module/**` → รายงานพร้อม hint ปลายทาง) · `--check-git-ownership` ตรวจว่า git mutation อยู่ใน `orchestrator/src/git/` เท่านั้น
- **doctor** — `sta doctor [--project-root <path>]` รวม 9 checks แบบ read-only, exit 1 เมื่อมี FAIL พร้อม "Fix:" ทุกข้อ · **Audit trail** — `sta audit <task-id>` (`sta audit` และ `sta tokens` ใช้ run record เดียวกัน — `effort` คือ reasoning effort ของ agent/runtime ไม่ใช่ `qa_effort` ของ QA risk gate)
- **Backup/Rollback** — sync backup ที่ `.agent-team/backups/<ts>/`, legacy snapshot ที่ `.sta/backups/` — คืนได้ด้วย `sta rollback` / `sta list-backups`
- **Profile-aware static analysis** — `.claude/scripts/static-analysis-gate.js` อ่าน `stack.commands` ของ Target ที่ resolve แล้ว scan เฉพาะ source roots/extensions ที่ประกาศ; skip หมด = `unverified` (exit 2) — offline, ไม่ติดตั้ง toolchain

## Slash command shortcuts (Claude runtime)

`.claude/commands/*.md` คือ prompt shortcut ที่พิมพ์ได้ใน Claude Code — **35 ตัว** (31 thinking/analysis + 4 workflow) ทุกตัว import `@_shared/guardrails.md` (บังคับ output format, cap, cite file:line, ask-first) เป็น **prompt เท่านั้น** — ไม่แก้ runtime/hook (agent ยังโดน guards เดิมทุกตัว) · ship ผ่าน `init`/`sync` · `run.js` section 11 กัน drift (frontmatter/import/จำนวนไฟล์ = 35)

Workflow commands: `/next` ตอบ "ทำอะไรต่อ" (resolve module + phase + คำสั่งถัดไป) · `/status` matrix ทุก module/phase/blocker · `/verify` ตรวจ deterministic gate แล้วเรียก `qa-engineer` เฉพาะเมื่อ green · `/changed` change set + ผล gate — workspace เดียวของ V10 ได้ครบทั้ง 4 (payload ชุดเดียว, V10 TASK-020)

### Runtime mirrors ของ command ชุดเดียวกัน (generated — ห้าม hand-edit)

Source of truth คือ `.claude/commands/*.md` เสมอ — `init`/`sync` generate ให้ทุก runtime และ `sta --check-bindings` ตรวจ byte-match: OpenCode `.opencode/commands/<name>.md` (`/name` — inline guardrails) · Codex ≥ 0.117 `.agents/skills/<name>/SKILL.md` (`$name` — openai.yaml ปิด implicit invocation) · regenerate ใน Framework repo ด้วย `npm --prefix orchestrator run build && node scripts/regenerate-renderings.mjs`

## Version Management

- **Single source of truth**: `version` ใน root `package.json` → `npm run build:templates` stamp ลง `templates/manifest.json` (`framework_version`) → `software-team-agents --version`
- **Workspace records** last-synced version ใน `.agent-team/manifest.json` — เทียบกับ installed version ได้ sync state:
  - `UP_TO_DATE` — ตรงกัน
  - `OUTDATED` — minor/patch ต่าง → `software-team-agents sync` ได้เลย
  - `INCOMPATIBLE` — **major ต่าง** → ต้อง `sync --force` (cross-major jump ต้องตัดสินใจเอง ไม่ happen เงียบ ๆ) และ `open` preflight จะ fail ทันที
- **Current workspace upgrade flow**: ติดตั้ง `.tgz` ใหม่ → `software-team-agents status` → `software-team-agents sync` ต่อ workspace; locally modified managed files block จนกว่าจะ resolve หรือยืนยัน `--force` (backup ก่อนเขียน)
- **Legacy install (`.sta/`)**: `sta init`/`sta upgrade --mode legacy-project` error พร้อมชี้ให้รัน `software-team-agents init` ซึ่งแปลง workspace `.sta/`-only ไปเป็น `.agent-team/` โดยไม่เสียเนื้อหา แล้วตามด้วย `software-team-agents sync` · `sta migrate` สำหรับ breaking manifest schema change · `sta rollback [--backup <name>]`
- **Knowledge item schema v2**: `origin` ระบุแหล่ง current/desired evidence และ `target_ids: []` หมายถึง global; `--check-knowledge` ตรวจ shape, Target existence และ relation invariants ของรายการปัจจุบัน
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
| `layout.yaml`, `escalation-policy.yaml`, `test-pyramid.yaml` | Framework repo (+ sync ไปกับ payload ชุดเดียวของ workspace) | directory ownership / recovery policy / test levels |

Environment variables ที่ runtime ใช้: `STA_ROLE` (role ปัจจุบันสำหรับ path permissions), `STA_WRITABLE_WORK_ROOTS` (JSON array ของ path — interactive `open` ตั้ง `[]`; orchestrated Target-write stage ได้เฉพาะ canonical roots ของ task จาก three-repo preflight), `STA_TARGET_WORK_ROOTS` (JSON array `[{targetId, path, access}]` — แผนที่ access ของทุก Target ที่ invocation เห็น เพื่อให้ guard ระบุชื่อ Target ในข้อความ refusal; ตัวมันเอง**ไม่ใช่**การให้สิทธิ์เขียน — write grant มาจาก `STA_WRITABLE_WORK_ROOTS` เท่านั้น), และ `STA_KNOWLEDGE_ROOT` (read-only Knowledge context เมื่อ resolve ได้)

Runtime protocol ใช้ namespace `STA_*` เท่านั้นเพื่อไม่ผูก Framework เข้ากับ runtime ใด runtime
หนึ่ง การเปลี่ยน namespace นี้เป็น breaking change: หลังอัปเกรด Framework ต้องรัน
`software-team-agents sync` ให้ launchers, hooks และ generated bindings ทุก runtime รับ contract
ชุดเดียวกันก่อนเริ่ม session ใหม่

Config ทั้งหมดเป็น optional — config ที่มีเพียง `schema_version: 1` ก็ parse และ resolve เป็น default runner (`claude-code`) + frontmatter model; config ที่ไม่มี `routing.order` ทำงานเหมือนเดิมทุกประการ ตัวอย่าง config เต็ม (per-role route, `routing.order`, `allow_below_supported`, `qa`, `verification` — หมายเหตุ: `execution.mode`/`allow_handoff`/`routing.strategy`/`model_routing` โหลดได้แต่ไม่มีผล) อยู่ที่ [`docs/tier-and-effort-run.md`](docs/tier-and-effort-run.md)

### Context budget และ telemetry

`context_budget` เป็น optional — ไม่ตั้งหรือตั้งไม่ได้ resolve เป็น `mode: warn` เสมอ (วัด + รายงาน overflow แต่ไม่แก้ prompt ไม่ปฏิเสธ stage; `mode: reject` ต้อง opt in อย่างชัดเจน) ทุก run record มี `estimated_input_tokens` (deterministic จาก `context_chars`) และ `effort` ของ model/runner — แสดงใน `sta tokens` และใช้ใน `sta audit`; `effort` (reasoning effort) ไม่ใช่ `qa_effort` (ระดับงานของ QA risk gate)

### Tier ต่อ phase และ camp

[`model-tiers.yaml`](model-tiers.yaml) (human-owned) map Tier → model/effort ต่อ camp — cells ข้าม camp เป็น approximation ที่คนเลือก `plan.md` ใส่ optional phase-level `Tier T2–T6` ได้เฉพาะ implementation/QA phase (T1 reserved) camp ถูกเลือกตอนเริ่ม dev phase: explicit runtime/camp หรือ configured camp ชนะเสมอ; headless run ใช้ configured default โดยไม่ถาม stdin (การเลือก camp ไม่ใช่ automatic quota fallback) pyramid enforcement (`test-pyramid.yaml` ไม่ตั้ง `enforcement` = `warn`) และ QA `skip` เป็น **OFF by default**; deterministic gate ตรงข้าม — เปิด default, ปิดเฉพาะ task ด้วย `--no-deterministic-gate`

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

`fingerprint` เปลี่ยนเมื่อ project/lock/script evidence เปลี่ยน; `generated_hash` แยก deterministic output จาก block ที่คนแก้เอง — sync ไม่ rewrite block ที่คนแก้เงียบ ๆ และ profile-family change เป็น preflight STOP การเปลี่ยน stack เป็น human decision เสมอ นี่คือ authoritative home ของ Target adaptation; `CLAUDE.md` และ role prompts ชี้มาที่ block นี้โดยไม่ทำสำเนาค่า stack

## Workflow ตัวอย่าง End-to-End

```bash
# 0) ติดตั้ง (ครั้งเดียวต่อเครื่อง) — linked checkout เป็น channel จริง (ดู ## Installation)
cd <framework-checkout> && npm --prefix orchestrator run build && npm link

# 1) เขียน requirement ใน Knowledge repo
git clone https://github.com/<org>/company-knowledge.git C:\src\company-knowledge
cd C:\src\company-knowledge
software-team-agents init
software-team-agents open                   # เปิด Claude Code จาก Knowledge workspace
#  ... draft knowledge item, แล้วบันทึก human acts:
sta roles review REQ-101 --as business-analyst
sta roles approve REQ-101 --by "Somchai"

# 2) (ครั้งเดียวต่อเครื่อง) bind machine เข้ากับ Knowledge root + ลงทะเบียน Target
sta configure knowledge-root C:\src\company-knowledge
sta doctor --project-root C:\src\company-knowledge

# 3) ทำงานโค้ด — session เดิม จาก Knowledge workspace (Target เป็น checkout ล้วน)
#    Target path ต่อเครื่องอยู่ที่ .workflow/targets.local.yaml (V10 TASK-023)
software-team-agents open --runtime opencode # หรือเปิดด้วย OpenCode (bindings sync มาแล้ว)

# 4) รัน task ผ่าน pipeline (headless)
sta run --task-id T-7 --module demo --bug-fix --backend --autonomy edit \
  --backend-target my-product --project-root C:\src\company-knowledge
#   default runner: claude-code + frontmatter model ของแต่ละ role
#   --runtime codex|opencode เลือก runner ของ run นี้; ไม่มี execution mode และไม่มี handoff
sta status T-7 --project-root C:\src\company-knowledge
sta audit T-7 --project-root C:\src\company-knowledge

# 5) อัปเกรด framework เมื่อมี .tgz ใหม่
npm i -g ./software-team-agents-<version>.tgz
cd C:\src\my-product && software-team-agents status
software-team-agents sync
software-team-agents status                 # syncState: UP_TO_DATE
```

## Ownership, health และ troubleshooting

### Health check

คำสั่งเดียวที่ตอบ "ติดตั้งถูกไหม": **`software-team-agents status`** (`--json` machine-readable) อ่านจากบนลงล่าง — ทุกบรรทัดบอกวิธีแก้ตัวเองถ้าไม่ READY · `status` ไม่เขียนอะไรเลย รันซ้ำได้ทุกเมื่อ · `sta doctor` (รันใน workspace เอง) ให้ diagnostic ละเอียดกว่าพร้อมคำสั่งแก้ ไฟล์ไหน generated/authored/machine-local ดูตาราง [Ownership model](#ownership-model) หรืออ่านจาก `status --json` `instructionSurface[]` ตรง ๆ

### Troubleshooting

1. **requirement/design หลุดไปอยู่ใน Target** — `sta --check-workspace --project-root <target-repo>` ชี้ทุกไฟล์ที่หลงพร้อมปลายทาง; แก้: `cd <knowledge-root> && software-team-agents init` แล้ว copy ไฟล์กลับ Knowledge, ลบของเดิมจาก Target
2. **session ไม่เห็น Knowledge context** — V10 session เปิดได้ทั้งที่ไม่มี binding (workspace คือ Knowledge root เอง); ถ้าต้องการ context จาก root อื่น ตั้ง `knowledge.path` ใน `.agent-team/config.yaml` หรือ `sta configure knowledge-root <path>`
3. **conflict บนไฟล์ framework-managed** — `user-modified` (revert / claim เป็น `overrides` / `--force`) · `stale-modified` (ไฟล์ถูกถอดจาก template แล้วแต่ยังแก้ค้าง — ย้ายออกเอง) · `untracked-file` (ไฟล์ของโปรเจกต์บน path ที่ framework จะเขียน — ย้าย/rename เอง)
4. **`Claude`/`Codex`/`OpenCode`/`Antigravity` = NOT READY** — `software-team-agents sync` แล้ว `status` ซ้ำ (ข้อความบอกไฟล์ที่ขาดตรง ๆ) · `Codex: NOT READY` เป็นค่า default ที่ตั้งใจ — เปิดแบบตั้งใจด้วย `--allow-unguarded-runtime` เท่านั้น
5. **`/xxx` ไม่เจอ (Claude)** — `sync` แล้ว restart session (โหลด command list ตอนเริ่ม)
6. **`$xxx` ไม่เจอ (Codex)** — `sync` (reload เอง); ยังไม่เห็น → `sta --check-bindings`
7. **`/xxx` ไม่เจอ (OpenCode)** — `sync`; แก้เนื้อหาที่ source เดียว `.claude/commands/<name>.md` ห้าม hand-edit mirror
8. **Claude Design MCP ไม่ connect** — `claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp` + `/design-login` + ตรวจ identity gate; ไม่ผ่าน → ใช้ Path A/B แทนได้เสมอ

หลังแก้อาการใด — รัน `software-team-agents status` ซ้ำ ยืนยันว่าหายจริง

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

- Release gate: `npm run release:check` (root) รันทุก step ตามลำดับ release. V3 property gates สาม step แยกรันเดี่ยวได้เพื่อ debug: `npm run test:guardrails` (guardrail invariants หกข้อ), `npm run test:modes` (Single/Auto/Manual matrix บน mock runner), `npm run test:paid-fallback` (paid API ไปไม่ถึงเลย — ไม่ถูกสร้างหรือ offer เป็น runtime อีกต่อไป) — ไม่มี step ไหนต้อง login runner จริงหรือรัน dogfood
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
