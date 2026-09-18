# Guards — ขอบเขต, การบังคับใช้ และการวินิจฉัย

เอกสารนี้อธิบายว่าทำไม guards จึงมีอยู่ บังคับใช้อะไรบ้างในระดับ hook และวินิจฉัย readiness อย่างไร
coverage ราย runtime (enforced / partial / unguarded) อยู่ที่ [`runtimes.md`](runtimes.md) ตารางเดียว —
ไฟล์นี้ไม่ทำซ้ำ

## ทำไมต้องมี guards

กฎของ pipeline ไม่ได้พึ่ง prompt เพียงอย่างเดียว — สิ่งที่ implementation บังคับใช้จริงเป็นระดับ
tool call (hook) หลักการสำคัญ: **fail-closed** — guard ที่ syntax error ต้อง fail loud ไม่ใช่ fail open
(`PreToolUse` block เมื่อ exit 2; hook ที่ load ไม่ขึ้นก็ block เช่นกัน)

## Guards ฝั่ง Claude Code

wire ผ่าน `.claude/settings.json`:

| Hook | Event | บังคับว่าอะไร |
|---|---|---|
| `block-git.js` | PreToolUse (Bash/Write/Edit) | state-changing git ถูก block (read-only ผ่าน) |
| `block-outside-repo.js` | PreToolUse | ทุก write resolve อยู่ใน writable roots เท่านั้น |
| `block-doc-rewrite.js` | PreToolUse (Write) | doc ที่มีอยู่ต้อง amend ไม่ regenerate |
| `block-path-permissions.js` | PreToolUse | เขียนได้เฉพาะ path ที่ `contracts/<role>.yaml` ให้ (role อ่านจาก `STA_ROLE`) + **Framework payload deny**: `contracts/**`, `workflows/**`, `stacks/**`, `layout.yaml`, `test-pyramid.yaml`, `escalation-policy.yaml` ถูก block เมื่อ `STA_ROLE` ถูกตั้ง — เปลี่ยนที่ Framework repo แล้ว sync; knowledge artifacts (requirement/design/test-plan/plan/`knowledge/**` ฯลฯ) ถูก deny ต่อ stage engineer/frontend/backend/devops |
| `require-green-before-stop.js` | Stop/SubagentStop | engineer ส่งงานต่อไม่ได้ถ้า typecheck/lint แดง |
| `block-secret-leak.js` | Stop/SubagentStop | ไฟล์ที่ run แก้ห้ามมี hardcoded secret (`.env.example` รวมด้วย) |

writable boundary ของแต่ละ invocation มาจาก environment (`STA_WRITABLE_WORK_ROOTS` /
`STA_TARGET_WORK_ROOTS`) ไม่ใช่จากการตั้งค่าค้างในไฟล์ — ดู
[`architecture.md`](architecture.md) § Environment variables และ
[`workspaces.md`](workspaces.md) § Workspace เดียว

## Installed ≠ registered

hook บน disk ยังไม่แปลว่า effective `.claude/settings.json` เรียกมัน — `status` แสดง
`hooksRegistered`/`hooksInstalled`; `sta doctor` ตรวจ surface เดียวกัน · **`Guards wired` เป็น launch
gate**: ขาดแม้หนึ่งรายการ = FAIL พร้อม `software-team-agents sync` (`.claude/settings.json` ใน
`overrides` = รายงาน explicit user choice แทนการนับเป็น pass)

per-agent boundary (write/deny ต่อ role) เป็น **orchestrated-run guarantee**: interactive session ไม่มี
`STA_ROLE` จึงไม่มี per-role enforcement แต่ยังได้ floor ที่ห้ามข้ามทุกกรณี (`.git/`, `node_modules/`,
`.workflow/`, `dist/`, `knowledge/_roles/`) บวก workspace boundary — เหตุผลเต็มที่
[`pipeline-rationale.md`](pipeline-rationale.md)

## Guards ถูกเทสต์

`node .claude/tests/run.js` (self-test ไม่มี dependencies) — guard ที่ syntax error ต้อง fail loud
ไม่ใช่ fail open ถ้าแตะ hooks/scripts ต้องรันและต้องเขียว CI รันทุก PR

## Runtime-side notes

- **OpenCode** — git deny เป็น declarative `permission.bash` globs ใน binding + plugin `sta-guards.js`
  (outside-root/path permissions); doc-rewrite/secret-leak/exit checks ยังไม่ in-band → `GUARD GAP` +
  QA round ครอบ workspace ที่ขาด plugin = **unguarded** (OpenCode default posture คือ allow-all)
- **Codex / Antigravity** — ไม่มีกลไก hook ฝั่ง workspace (Antigravity อ่าน hooks เฉพาะระดับเครื่อง) →
  launch ต้อง `--allow-unguarded-runtime` — รายละเอียดที่ [`runtimes.md`](runtimes.md)

## Profile-aware static analysis

`.claude/scripts/static-analysis-gate.js` อ่าน `stack.commands` ของ Target ที่ resolve แล้ว scan เฉพาะ
source roots/extensions ที่ประกาศ — lint/format/typecheck/build/test ทุก package ที่ประกาศ script ใน
คำสั่งเดียว บวก `security_scan` + `dependency_scan` (offline, ไม่ติดตั้ง toolchain) skip หมด =
`unverified` (exit 2) — ไม่มี suite ไม่เท่ากับ pass

## Diagnostics

- **`software-team-agents status`** — บรรทัด `Claude: READY — ... Framework guards wired (n/n)` คือ
  readiness ของ guards; `--json` ให้ `hooksRegistered`/`hooksInstalled` เป็นข้อมูลดิบ
- **`sta doctor`** — รวม 9 checks แบบ read-only, exit 1 เมื่อมี FAIL พร้อม "Fix:" ทุกข้อ
- **Backup/Rollback** — sync backup ที่ `.agent-team/backups/<ts>/`, legacy snapshot ที่ `.sta/backups/`
  — คืนได้ด้วย `sta rollback` / `sta list-backups`

อาการที่พบจริงและวิธีแก้ รวมอยู่ที่ [`troubleshooting.md`](troubleshooting.md)
