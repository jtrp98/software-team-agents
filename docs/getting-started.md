# Getting Started — ติดตั้งและเริ่มงานครั้งแรก

เอกสารนี้เป็น canonical home ของการติดตั้ง, upgrade, uninstall และการเริ่ม workspace แรก
README ย่อเรื่องนี้เป็น Quick Start โดยดึงบล็อกที่ทำเครื่องหมาย `readme:quick-start` จากไฟล์นี้
(แก้ที่ไฟล์นี้ที่เดียว แล้วรัน `npm run docs:sync` — อย่าแก้บล็อก generated ใน README ตรง ๆ)

## Prerequisites

- **Node.js >= 24** — ตรวจด้วย `node --version`
- **Git** — Knowledge และ Target เป็น git repo ทั้งคู่
- **อย่างน้อยหนึ่ง AI runtime CLI** ที่จะใช้งาน:
  - **Claude Code CLI** (default; login แล้ว) — `claude --version`
  - **Codex CLI** — `codex --version`
  - **OpenCode CLI >= 1.18** — `opencode --version`
  - **Antigravity CLI (`agy`)** (experimental) — `agy --version`

ระดับการรองรับและ guard coverage ต่างกันต่อ runtime — ดู [`runtimes.md`](runtimes.md)

## ติดตั้งจาก linked checkout (`npm link`) — channel ที่ใช้งานจริง

```bash
cd <framework-checkout>
npm --prefix orchestrator run build   # tsc -> orchestrator/dist
npm link                              # ผูก global `sta` / `software-team-agents` เข้ากับ checkout นี้
software-team-agents --version        # ยืนยัน
```

`npm link` ชี้ bin ทั้งสองตัวไปที่ checkout ตรง ๆ — แก้ source แล้ว rebuild รอบใหม่ มีผลทันที
ไม่ต้อง reinstall `--version` พิมพ์ **version string + payload digest** เสมอ (เช่น `4.0.0+4d181b1915f1`)
— digest ต่าง = payload ต่างจริง แม้ version string เท่ากัน (linked checkout เปลี่ยน payload ได้ทุก commit)

อัปเกรด — `git pull` แล้ว rebuild ใน checkout เดิม แล้ว sync แต่ละ workspace:

```bash
cd <framework-checkout> && git pull && npm --prefix orchestrator run build
cd <workspace> && software-team-agents sync
```

ถอนการติดตั้ง:

```bash
npm unlink -g software-team-agents
```

## ติดตั้งจาก `.tgz` — เมื่อไม่มี Framework checkout บนเครื่องนี้

ผู้ดูแล Framework รัน `npm run release` (typecheck → tests → build → `npm pack` → SHA-256 sidecar)
แล้วแจก `release/<name>-<version>.tgz` + `.sha256` ที่ได้จริงจากรันนั้น — **อย่าเขียน version เจาะจงในเอกสาร
เพราะมันเปลี่ยนทุก release**:

```bash
npm i -g ./software-team-agents-<version>.tgz   # <version> = ชื่อไฟล์ .tgz ที่ได้รับจริง
software-team-agents --version                  # version ต้องตรงกับชื่อไฟล์ (digest อาจต่างกันคนละ build)
```

อัปเกรด/ถอนการติดตั้งเหมือน linked checkout ด้านบน (`npm i -g` ทับด้วย `.tgz` ใหม่ /
`npm uninstall -g software-team-agents`)

ยังไม่มีการ publish ขึ้น npm registry — distribution ผ่าน linked checkout หรือ `.tgz` เท่านั้น

## Development checkout

สำหรับคนแก้ Framework เอง:

```bash
git clone <framework-repo>
cd software-team-agents/orchestrator
npm ci
npm run build            # tsc → dist/
npm run build:templates  # snapshot templates/ + manifest.json
```

เรียก CLI โดยไม่ต้อง link: `node orchestrator/dist/cli.js <command>` (`sta`) หรือ
`node orchestrator/dist/targetcli/cli.js <command>` (`software-team-agents`)
การพัฒนาและ CI ของ Framework repo เอง อยู่ที่ [`architecture.md`](architecture.md) § Development

## Quick Start

<!-- readme:quick-start:start -->
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
# (เครื่องที่มีหลาย named root: เพิ่ม --root <name>; --project-root <knowledge-root> ยังรับได้
#  แต่เป็น compatibility assertion กับ root ที่ installation เลือกแล้ว ไม่ใช่ selector)
```

ใน interactive session ใช้ workflow slash commands ได้: `/next` (ทำอะไรต่อ) ·
`/status` (ภาพรวม module/phase) · `/verify` (deterministic gate + qa-engineer) ·
`/changed` (สรุปไฟล์ที่แก้ + ผล gate)
<!-- readme:quick-start:end -->

## ตรวจว่าติดตั้งสำเร็จ

คำสั่งเดียวที่ตอบ "ติดตั้งถูกไหม": **`software-team-agents status`** (`--json` machine-readable)
— อ่านจากบนลงล่าง ทุกบรรทัดบอกวิธีแก้ตัวเองถ้าไม่ READY · ไม่เขียนอะไรเลย รันซ้ำได้ทุกเมื่อ
`sta doctor` ให้ diagnostic ละเอียดกว่าพร้อมคำสั่งแก้ (ดู [`troubleshooting.md`](troubleshooting.md))

สถานะ sync อ่านจาก `.agent-team/manifest.json` เทียบกับ installed version:
`UP_TO_DATE` (ตรงกัน) · `OUTDATED` (minor/patch ต่าง — `sync` ได้เลย) ·
`INCOMPATIBLE` (major ต่าง — ต้องตัดสินใจเองแล้ว `sync --force`; `open` preflight จะ fail จนกว่าจะ sync)

## Session แรก

`software-team-agents open` เปิด interactive session **จาก Knowledge workspace** เสมอ (V10 มี lane เดียว —
คำสั่ง `ba`/`dev` เก่าถูกตัด ไม่มี alias) Target เป็น read-only checkout ที่ผูกด้วย `targets.yaml` +
`.workflow/targets.local.yaml` — โมเดล workspace และขอบเขตการเขียนทั้งหมดอยู่ที่
[`workspaces.md`](workspaces.md)

งานแบบ orchestrated (headless) ใช้ `sta run` / `sta bounded-run` — ดู
[`pipeline.md`](pipeline.md)
