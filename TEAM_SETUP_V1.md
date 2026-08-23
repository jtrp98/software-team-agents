# Team Setup — V1 (T165)

> Onboarding flow สำหรับสมาชิกใหม่: ติดตั้ง → Configure → Validate → Ready
> **ทางลัดสำหรับคนที่ไม่อยาก setup เอง:** เปิด Claude แล้วทำงานได้เลยผ่าน [`START.md`](START.md)
> ทุกขั้น reuse คำสั่งที่มีอยู่ · config ผิด = fail-closed ทันที · ไม่ต้องแก้ framework internals
> ประกอบด้วย 3 repos ตาม Three-Repo Architecture (`planning/TASKS_V1_THREE_REPO.md`):

```
Framework repo (repo นี้)     Knowledge repo (ต่อบริษัท)      Target repo(s) (โค้ดจริง)
orchestrator/.claude/contracts   knowledge/ _docs/ targets.yaml        sb-web-helper ฯลฯ
```

---

## Step 0 — Prerequisites

| ต้องมี | ตรวจ |
|---|---|
| Node.js ≥ 20 | `node --version` |
| Git | `git --version` |
| Claude Code CLI + login | `claude --version` |

## Step 1 — Install Framework

```bash
cd <where you keep tools>
git clone https://github.com/<org>/software-team-agents.git
cd software-team-agents/orchestrator && npm ci && npm run build
npm run build:templates          # snapshot templates/ + manifest.json
```

> ทีมที่ไม่ clone repo ได้ ใช้ `npx software-team-agents init` จาก npm pack tarball แทนได้
> (`npm pack` ที่ root → ได้ .tgz → `npm i -g <tgz>`) — publish ขึ้น registry ยังไม่เปิด

## Step 2 — Get the Knowledge Repo (clone ครั้งเดียวต่อเครื่อง)

```bash
git clone https://github.com/jtrp98/knowledge-schoolbright.git C:\src\schoolbright-knowledge
```

BA / SA / PM / QA **แค่นี้พอ** — ไม่ต้อง clone Target repo (ไม่แตะโค้ด)
DEV/DevOps clone Target repo เพิ่มใน Step 4

## Step 3 — Bind This Machine to the Knowledge Root (ครั้งเดียวต่อเครื่อง)

```bash
node orchestrator/dist/cli.js configure knowledge-root C:\src\schoolbright-knowledge
# ✓ ตรวจ standalone-git/worktree/overlap อัตโนมัติ — ผิดจะ reject พร้อมเหตุผล
```

## Step 4 — Targets & Local Mappings (DEV เท่านั้น)

`targets.yaml` (shared, อยู่ใน knowledge repo) — ลงทะเบียน Target identity:

```yaml
schema_version: 1
targets:
  - target_id: sb-web-helper
    name: SB Web Helper
    remote_url: https://github.com/Jabjai-Corporation/sb-web-helper.git
    status: active
```

`.workflow/targets.local.yaml` (machine-local, **ไม่ commit**):

```yaml
schema_version: 1
targets:
  sb-web-helper:
    path: C:\src\sb-web-helper     # local checkout — ต้องเป็น standalone git top-level
```

## Step 5 — Validate (ทุกคน)

```bash
node orchestrator/dist/cli.js doctor --project-root C:\src\schoolbright-knowledge
```

- `✓` ทุกบรรทัด + `usable` → **Ready**
- `! WARNING` → ใช้ได้ แต่อ่าน Fix: line
- `✗ FAIL` → แก้ตาม Fix: line แล้วรันใหม่ (exit code ≠ 0 = CI จับได้)

## Step 6 — First Task (DEV)

```bash
node orchestrator/dist/cli.js run --task-id T-1 --module <module> \
  --bug-fix --backend --autonomy edit \
  --backend-target sb-web-helper --project-root C:\src\schoolbright-knowledge
node orchestrator/dist/cli.js status T-1 --project-root C:\src\schoolbright-knowledge
```

BA/SA ทำงานผ่าน `roles review/approve/signoff/ack` — ดู `UAT_KIT_V1.md` S1–S4 เป็นสคริปต์เดินจริง

---

## Troubleshooting (T167) — ครอบคลุม 9 ประเด็นบังคับของ T169

`sta doctor` จุดเดียวชี้ปัญหาพร้อม `Fix:` เสมอ · ตารางนี้คือรายละเอียดต่อ:

| # | ประเด็น | สัญญาณ | สาเหตุ | วิธีแก้ |
|---|---|---|---|---|
| 1 | **Knowledge missing** | `cannot read installation config` / doctor WARNING "skipped — no Knowledge root configured yet" | ยังไม่ configure, หรือ clone ยังไม่มี | Step 3 (`configure knowledge-root`) |
| 2 | **Invalid Knowledge schema** | doctor `✗ Knowledge schema ... first: <problem>` | YAML พัง/id-kind ไม่ตรง/v2 rule | `orchestrate --check-knowledge --project-root <knowledge root>` ดู list เต็ม แก้ไฟล์ที่ชี้ |
| 3 | **Target missing** | `Target registry (targets.yaml)` FAIL/WARNING | ไม่มี targets.yaml หรือ schema ผิด | สร้าง/แก้ตาม Step 4; หรือลบไฟล์ทิ้งเพื่อ legacy single-repo mode |
| 4 | **Local mapping missing** | `Target "X" has no local path mapping` / ENOENT targets.local.yaml | เครื่องใหม่ยังไม่ map | เพิ่ม entry ใน `.workflow/targets.local.yaml` (machine-local ไม่ commit) |
| 5 | **Identity mismatch** | `origin "..." expected canonical remote_url` | remote ของ local checkout ≠ remote_url ใน targets.yaml | `git -C <target> remote set-url origin <remote_url>` ให้ canonical ตรงกัน |
| 6 | **Preflight failure** | `✗ ... Preflight` หรือ task run throw TargetPreflightError | root overlap / retired target / binding ผิด | อ่าน reason — ทุก message ระบุ file/command ที่ต้องแก้; retired = reactivate ใน targets.yaml |
| 7 | **Workspace blocked** | frontend task ถูก block แม้ SA handoff ครบ | UX/UI gate: ขาด approved current `ux-design` artifact หรือ uxui sign-off ไม่ current | ให้ human uxui sign-off version ปัจจุบัน (`roles signoff uxui`) |
| 8 | **Migration failure** | `knowledge-migrate verify` FAIL + problems list | source drift / item invalid / hash mismatch | dry-run ซ้ำ → copy ทับ (transform idempotent จาก v1 source) → verify ใหม่ |
| 9 | **Cutover / rollback** | cutover throw "requires human confirmation" / อยากย้อน | gate T163 by design | ยืนยันด้วย `--confirm I_CONFIRM_MIGRATION`; ย้อน = `configure knowledge-root <root เดิม>` (source ไม่เคยถูกลบ) |

อาการเสริมที่เจอบ่อย:

- run/retry ค้างถาม permission → เพิ่ม `--autonomy edit/full`
- `You've hit your weekly limit` → quota Claude; task resume ได้หลัง reset

## Upgrading the Framework (T169)

**Framework เปลี่ยนอะไรได้:** `orchestrator/dist/**`, `.claude/**` (agents/hooks/settings), `contracts/`,
`workflows/`, `policies/`, `stacks/`, templates และ `orchestrator/schemas/**` ของ framework เอง —
ทั้งหมดถูก track ใน `.sta/manifest.json` พร้อม pristine hash

**ห้ามเปลี่ยน / ไม่มีวันแตะ:** `knowledge/**` (ทุก item), `_docs/**`, `decisions/**`,
`.workflow/targets.local.yaml`, `targets.yaml`, `knowledge-policy.yaml` และ state store
(`.workflow/state.db`) — ownership เป็นของ Knowledge/Target repos (T121/T153)

**Compatibility mode:** upgrade เลือกโดยชัดเจนผ่าน `--mode <legacy-project|three-repo>` —
ไม่มี silent fallback; mode ที่ install ไว้ตอน init คือโหมดที่ upgrade ทำงานบน (T154)

**Rollback:** ทุก upgrade/migrate snapshot เข้า `.sta/backups/<ts>/` ก่อนเขียน —

```bash
node orchestrator/dist/cli.js list-backups --project-root <root>
node orchestrator/dist/cli.js rollback [--backup <name>] --project-root <root>
```

restore ครบทั้งไฟล์ + manifest จาก snapshot เดียว (T97); migration แยก rollback อีกชั้น:
source repo ไม่เคยถูกแก้ ลบที่ destination แล้ว re-copy ได้เสมอ (§22.13/T164)
