# software-team-agents

**Personal AI. Shared Knowledge. Common Process.**

Process/workflow layer + orchestrator CLI สำหรับทีมซอฟต์แวร์ ที่จัดระเบียบการทำงานร่วมกันระหว่าง Human
กับ AI coding runtimes — แต่ละคนใช้ AI/tool ของตัวเองได้ (Claude Code, Codex, OpenCode, Antigravity —
ระดับการรองรับต่างกัน) แต่ทั้งทีมทำงานบน Knowledge และ Process ชุดเดียวกัน ไม่ใช่ AI model และไม่ได้มา
แทน runtime จริง — ทุก run ยัง execute ผ่าน runtime ที่เลือก

## How It Fits Together

```text
Human            ← intent, constraints, การตัดสินใจที่ gate สำคัญ
  ↓
software-team-agents   ← repo นี้: process/workflow layer + orchestrator (Framework)
  ↓
AI Runtime       ← Claude Code (default) / Codex / OpenCode / Antigravity
  ↓
Knowledge / Target  ← ความรู้ร่วมของทีม (git repo แยก) / repo ของ product จริงที่ AI เขียนโค้ด
```

| Domain | คืออะไร |
|---|---|
| **Framework** (repo นี้) | orchestrator CLI, agent prompts, hooks/guards, contracts, workflows, policies |
| **Knowledge** | git repo แยกต่อบริษัท — canonical knowledge, `_docs/`, decisions, Target registry |
| **Target** | repository ของ product จริงที่ให้ AI เขียนโค้ด (read-only จาก interactive session) |
| **Runtime State** | machine-local state ใต้ `.workflow/` — gitignored, ไม่ sync, ไม่ classify เป็น repo ใด |

ไม่ต้องเข้าใจลึกกว่านี้เพื่อเริ่มงาน — สถาปัตยกรรมเต็มอยู่ที่ [`docs/architecture.md`](docs/architecture.md)

## Two CLI Surfaces

| คำสั่ง | บทบาท |
|---|---|
| `software-team-agents` | workspace CLI — `init` / `sync` / `status` / `open` / `cleanup` · ติดตั้ง, health check, เปิด interactive session |
| `sta` | orchestrated pipeline CLI — `run` / `bounded-run` / task lifecycle / approvals / audit / knowledge ops · งาน headless + การจัดการระดับสูง |

อ้างอิงเต็มที่ [`docs/cli.md`](docs/cli.md) · runtime support รายตัวที่ [`docs/runtimes.md`](docs/runtimes.md)

## Quick Start

<!-- generated: docs/getting-started.md#quick-start — npm run docs:sync; do not edit by hand -->
Prerequisites: Node.js >= 24, Git และอย่างน้อยหนึ่ง runtime CLI (Claude Code เป็น default)

```bash
# 1. Install — link CLI ของ Framework checkout เข้า global (ครั้งเดียวต่อเครื่อง)
cd <framework-checkout>
npm --prefix orchestrator run build
npm link

# 2. Knowledge repo — clone ครั้งเดียวต่อเครื่อง — ทุก role ทำงานจาก workspace เดียวนี้
git clone <your-knowledge-repo-url> <path>

# 3. Init workspace — cd เข้า Knowledge repo แล้วรัน
cd <knowledge-repo>
software-team-agents init
software-team-agents status          # health check เดียวที่ต้องรู้ — ทุกบรรทัดบอกวิธีแก้เอง
software-team-agents sync            # ถ้า status รายงาน OUTDATED

# 4. เริ่มงาน
software-team-agents open            # interactive session จาก Knowledge workspace
# หรือ headless pipeline:
# sta run --task-id T-1 --module <module> --bug-fix --autonomy edit
# (เครื่องที่มีหลาย named Knowledge root: เลือกด้วย --root <name>; ดู docs/cli.md)
```

ใน interactive session ใช้ workflow slash commands ได้: `/next` (ทำอะไรต่อ) ·
`/status` (ภาพรวม module/phase) · `/verify` (deterministic gate + qa-engineer) ·
`/changed` (สรุปไฟล์ที่แก้ + ผล gate)
<!-- generated:end -->

รายละเอียดครบ (upgrade, uninstall, `.tgz`, development checkout) ที่
[`docs/getting-started.md`](docs/getting-started.md)

## การทำงาน: interactive vs orchestrated

- **Interactive** — `software-team-agents open` เปิด session จาก Knowledge workspace (V10 มี lane เดียว —
  Target เป็น read-only checkout ที่ bind ผ่าน `targets.yaml`) งานเอกสาร/analysis ทั้งหมดเกิดที่ Knowledge
- **Orchestrated** — `sta run --task-id <id> --module <name> <classification flags>` เดิน workflow ที่
  right-size (typo → feature/deploy) ผ่าน engineer/QA จนถึง gate ของคน — engineer stage เขียน Target
  ตาม packet scope เท่านั้น

BA/SA/PM/test-planner ทำงานจาก Knowledge workspace เสมอ (ไม่ต้อง clone Target) — โมเดล workspace ที่
[`docs/workspaces.md`](docs/workspaces.md) · pipeline ที่ [`docs/pipeline.md`](docs/pipeline.md)

## AI-Assisted Setup

ให้ AI coding assistant ตั้งให้แทน — ชี้ไฟล์ playbook ให้มันอ่าน (runtime-agnostic):

- [`prompt-setup.md`](prompt-setup.md) — ตั้ง/ซ่อม/ตรวจ workspace บนเครื่องนี้ + capture canonical
  knowledge ครั้งแรก (inspect ก่อนถาม · safe by default)
- [`prompt-update-knowledge.md`](prompt-update-knowledge.md) — รีเฟรช canonical knowledge แบบ
  incremental ให้ตรงโค้ดจริง

สั่ง assistant ว่า "อ่าน `prompt-setup.md` แล้วตั้งให้ที" — playbook เหล่านี้เป็น AI playbooks
ไม่ใช่คู่มือคน (คู่มือคนอยู่ที่ [`docs/getting-started.md`](docs/getting-started.md))

## Documentation

| ต้องการอะไร | อ่านที่ |
|---|---|
| ติดตั้ง / upgrade / uninstall | [`docs/getting-started.md`](docs/getting-started.md) |
| โมเดล workspace, binding, ขอบเขตการเขียน | [`docs/workspaces.md`](docs/workspaces.md) |
| CLI reference ทั้งสอง surface | [`docs/cli.md`](docs/cli.md) |
| Runtime support + guard coverage + routing | [`docs/runtimes.md`](docs/runtimes.md) |
| Pipeline, workflow, approval gates | [`docs/pipeline.md`](docs/pipeline.md) |
| Guards + การวินิจฉัย | [`docs/guards.md`](docs/guards.md) |
| สถาปัตยกรรม + configuration reference | [`docs/architecture.md`](docs/architecture.md) |
| Knowledge model (canonical) | [`knowledge/README.md`](knowledge/README.md) |
| แก้ปัญหา | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| ดัชนีเอกสารทั้งหมด (รวม deep technical refs) | [`docs/README.md`](docs/README.md) |

พัฒนา Framework repo นี้ → [`docs/architecture.md`](docs/architecture.md) § Development ·
ข้อจำกัดปัจจุบัน (Codex/OpenCode runtime, contract write-globs, ฯลฯ) →
[`docs/architecture.md`](docs/architecture.md) § ข้อจำกัด
