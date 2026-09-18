# Troubleshooting — วินิจฉัยตามอาการ

คำสั่ง health หลักที่ต้องรู้มีตัวเดียว: **`software-team-agents status`** (`--json` machine-readable)
— read-only รันซ้ำได้ทุกเมื่อ ทุกบรรทัดบอกวิธีแก้ตัวเอง หลังแก้อาการใด รัน `status` ซ้ำยืนยันว่าหายจริง
`sta doctor` ให้ diagnostic ละเอียดกว่า (read-only, exit 1 เมื่อมี FAIL พร้อม "Fix:" ทุกข้อ)

แต่ละอาการ: อาการ → คำสั่งตรวจ → เหตุที่พบบ่อย → แก้อย่างไร

## Workspace และ binding

### 1. requirement/design หลุดไปอยู่ใน Target

- **ตรวจ:** `sta --check-workspace --project-root <target-repo>` — ชี้ทุกไฟล์ที่หลงพร้อมปลายทาง
- **เหตุ:** module docs (`_docs/module/**`, `_docs/status.md`) เขียนใน Target checkout — ที่ถูกคือ
  Knowledge repo เท่านั้น
- **แก้:** `cd <knowledge-root> && software-team-agents init` แล้ว copy ไฟล์กลับ Knowledge, ลบของเดิม
  จาก Target

### 2. Knowledge root ถูกผูกไว้แต่ไม่เคย init

- **อาการ:** `status` warning "Knowledge root bound but never initialized"
- **เหตุ:** `installation.yaml` ผูก Knowledge root ที่มี marker ครบ แต่ไม่เคยมี `.agent-team/config.yaml`
  ที่นั่น — payload ไม่มีอยู่เลยทั้งเครื่อง
- **แก้:** `cd <knowledgeRoot> && software-team-agents init` (`status` พิมพ์คำสั่งนี้ให้ตรง ๆ)

### 3. session ไม่เห็น Knowledge context

- **อาการ:** session เปิดแต่ไม่มี knowledge context
- **เหตุ:** V10 session เปิดได้ทั้งที่ไม่มี binding (workspace คือ Knowledge root เอง); context จาก root
  อื่นต้อง bind
- **แก้:** ตั้ง `knowledge.path` ใน `.agent-team/config.yaml` หรือ
  `sta configure knowledge-root <path>`

### 4. Target ถูก reject ตอน preflight (remote mismatch)

- **อาการ:** preflight refuse พร้อมเหตุผลเรื่อง remote
- **เหตุ:** origin remote ของ local checkout ไม่ตรงกับ `remote_url` canonical ใน `targets.yaml`
- **แก้:** แก้ remote ของ checkout (`git remote set-url`) หรือแก้ `remote_url` ใน `targets.yaml` ให้ตรง
  checkout จริง — mapping path ต่อเครื่องอยู่ที่ `.workflow/targets.local.yaml`
  (ดู [`workspaces.md`](workspaces.md) § Binding)

## Sync และ payload

### 5. Framework payload outdated

- **อาการ:** `status` รายงาน `OUTDATED` + รายชื่อ managed updates หรือ
  `INCOMPATIBLE` (major ต่าง)
- **แก้:** `software-team-agents sync` (`OUTDATED`) · major jump: ตัดสินใจเองแล้ว `sync --force`
  (backup ก่อนเขียนเสมอ) — จนกว่าจะ sync `open` preflight จะ fail

### 6. conflict บนไฟล์ framework-managed

- **ตรวจ:** `status` รายงาน conflict kind ตรง ๆ:
  - `user-modified` — ไฟล์ถูกแก้เอง: revert / claim เป็น `overrides` ใน `.agent-team/config.yaml` /
    ยืนยัน `--force`
  - `stale-modified` — ไฟล์ถูกถอดจาก template แล้วแต่ยังแก้ค้าง: ย้ายออกเอง
  - `untracked-file` — ไฟล์ของโปรเจกต์บน path ที่ framework จะเขียน: ย้าย/rename เอง
- **กู้คืน:** backup ทุกครั้งอยู่ที่ `.agent-team/backups/<ts>/` — `sta list-backups` / `sta rollback`

### 7. `status` เตือน installed payload ต่างจากที่ sync ค้าง

- **อาการ:** `WARNING: installed Framework payload differs from the payload last synced at this same
  version` + managed updates available
- **เหตุ:** linked checkout เปลี่ยน payload ได้ทุก commit แม้ version string เท่าเดิม (digest ต่าง)
- **แก้:** `software-team-agents sync` ตามที่ status บอก

## Runtime และ launch

### 8. `Claude`/`Codex`/`OpenCode`/`Antigravity` = NOT READY

- **ตรวจ:** ข้อความของ `status` บอกไฟล์ที่ขาดตรง ๆ
- **แก้:** `software-team-agents sync` แล้ว `status` ซ้ำ
- **`Codex: NOT READY` เป็นค่า default ที่ตั้งใจ** (unguarded) — เปิดแบบตั้งใจด้วย
  `--allow-unguarded-runtime` เท่านั้น — โมเดล coverage ที่ [`runtimes.md`](runtimes.md)

### 9. Guards wired ไม่ครบ

- **อาการ:** `Claude: READY` แต่ `guards wired (n/8)` ไม่เต็ม หรือ preflight FAIL เรื่อง guards
- **เหตุ:** hook ติดตั้งแล้วแต่ effective `.claude/settings.json` ไม่เรียกมัน (installed ≠ registered)
- **แก้:** `software-team-agents sync`; ถ้า intentionally override `.claude/settings.json` เอง
  status จะรายงานเป็น explicit user choice — รายละเอียดที่ [`guards.md`](guards.md)

### 10. Slash command / skill หาย

- **`/xxx` ไม่เจอ (Claude):** `sync` แล้ว restart session (โหลด command list ตอนเริ่ม)
- **`$xxx` ไม่เจอ (Codex):** `sync` (reload เอง); ยังไม่เห็น → `sta --check-bindings`
- **`/xxx` ไม่เจอ (OpenCode):** `sync`; แก้เนื้อหาที่ source เดียว `.claude/commands/<name>.md` —
  ห้าม hand-edit mirror

## Design integration

### 11. Claude Design MCP ไม่ connect

- **แก้:** `claude mcp add --scope user --transport http claude-design
  https://api.anthropic.com/v1/design/mcp` + `/design-login` + ตรวจ identity gate
  (`sta configure identity --figma-email <e> --claude-email <e>`)
- **fallback:** Path A/B (วาง export ไฟล์เอง) ใช้แทนได้เสมอ — ดู [`pipeline.md`](pipeline.md) § Design
  sources

## Bounded run

### 12. `sta bounded-run` refuse

- **ตรวจ:** อ่าน refusal — มันระบุสาเหตุและ remediation ที่ใช้ได้กับ Target นั้น (plan drift, gate ค้าง,
  dependency ยังไม่ checkpoint, working tree ไม่สะอาด, run อื่นค้าง ฯลฯ)
- **แก้:** ทำตาม remediation ที่พิมพ์ — อย่าเดา flag เพื่อบังคับผ่าน; คู่มือเต็มที่
  [`bounded-run.md`](bounded-run.md) § Precondition
