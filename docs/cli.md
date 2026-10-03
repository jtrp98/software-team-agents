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

options: `--target-root <path>` · `--root <name>` (init/sync/status/open — อ่าน named Knowledge root จาก `installation.yaml`; ไม่ส่ง = default) · `--role <name>` (retired — accepted and ignored) ·
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

### Direct execution (ไม่ต้องมี workflow, module หรือ role) — คู่มือ: [`execution.md`](execution.md)

```bash
sta execute --runtime <claude-code|codex|antigravity|zcode|opencode> --task <text> [--workspace <dir>] [--role <persona>] [--write] [--write-path <glob>]... [--no-delegate] [--action <side-effect>]... [--max-depth <n>] [--max-runs <n>]
sta execute resume  <run-id> [--context <text>]      # รันต่อหลัง approval / partial
sta execute approve <run-id> --request <id> (--yes|--no) --by <name>   # relay คำตอบของคนสำหรับ side effect ที่ประกาศไว้
sta execute show    <run-id>                         # run tree ทั้งต้น
```

พิมพ์ผล JSON เสมอ; exit `0` completed · `1` failed · `3` needs_approval · `4` partial. เรียกจากข้างใน run
(`STA_RUN_ID` อยู่ใน env) = run ลูกของ run นั้น

### Task lifecycle

```bash
sta run      --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full] [--runtime claude-code|codex|opencode|antigravity] [--root <name>]
sta bounded-run --module <name> (--all|--phase <n>|--task <id,...>) [--until next-gate|qa|done] [--dry-run] [--autonomy edit|full] [--root <name>]   # คู่มือ: docs/bounded-run.md
sta bounded-run --resume <run-id> --module <name> [--dry-run]       # resume ระดับ run (ต่างจาก --resume ระดับ task) — ใช้ root ที่ freeze ไว้ใน run
sta resume   --task-id <id> --module <name> [--root <name>]          # continue task ใน store; --root ต้องตรง root ที่ freeze ไว้
sta retry    --task-id <id> --module <name> [--root <name>]          # same as resume
sta pause    --task-id <id>                          # freeze; run/resume/retry refuse
sta cancel   --task-id <id> [--reason <text>]        # ปิด task ถาวร
sta approve  <task-id> --request <request-id> [--yes|--no --chat-conversation-id <id> --chat-message-id <id> (--chat-actor-id <id>|--chat-actor-unavailable) --chat-text <text>]   # resolve human gate ผ่าน Controller chat relay — bare `--yes/--no` ไม่มี chat reference ถูกปฏิเสธ
sta status   [<task-id>] [--watch]                   # ทุก task หรือ task เดียว
sta audit    <task-id> [--decisions]                 # WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail
```

exit codes ของ `run`/`retry`: `0` deployed · `1` blocked · `2` unknown gate · `3` rejected โดยคน ·
`4` parked — มี gate รอ human decision ที่ Controller แสดงใน bubble chat แล้ว relay ผ่าน `sta approve`/`sta roles`

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
sta context <role> [--module <name>] [--phase <n,n>] [--task <id> --packet] [--views] [--json] [--root <name>]
sta knowledge get <id>[,<id>...] [--lane <ba|sa|uxui|dev>] [--json]
sta knowledge reconcile --target <id> [--json]       # read-only current/desired evidence classifier
sta policy [<area>] [<section>] [--json]             # อ่าน policies/ เป็น section แทนทั้งไฟล์
```

### Roles / Knowledge lanes (BA · SA · UXUI · DEV)

```bash
sta roles                                        # ทุก lane ยืนตรงไหนของ module (+ lane request ที่ pending)
sta roles signoff ba --module <name>             # เปิด lane request → Controller แสดงใน bubble chat (chat-relay) → exit 4 รอคำตอบ
sta roles signoff ba --module <name> --request <request-id> [--yes|--no --chat-conversation-id <id> --chat-message-id <id> (--chat-actor-id <id>|--chat-actor-unavailable) --chat-text <text>]   # relay คำตอบเดิมของ Human พร้อม chat reference → บันทึก decision
sta roles ack sa [REQ-101,...] --module <name> [--request <request-id>]   # คนใน lane ผู้รับยืนยันว่าเห็น version เหล่านี้แล้ว
sta roles inbox [ba|sa|uxui|dev]                 # lane นี้มีอะไรต้องดู
sta roles impact REQ-101                         # lane ไหนจะโดนกระทบถ้าแก้ item นี้
sta roles context dev                            # lane นี้เห็นอะไรได้บ้าง
```

lane ที่มีจริง: `ba | sa | uxui | dev` — sign-off และ ack เป็น human decision แยกกันสองครั้ง
(V13 TASK-028) ผ่าน trusted channel เดียวกับ `sta approve` และบันทึกใน lane ledger ของ
STA state DB เท่านั้น: gate type ต่อ lane (`ba-signoff`, `sa-signoff`, `uxui-signoff`, `dev-signoff`,
`ba-ack`, `sa-ack`, `uxui-ack`, `dev-ack`). ช่องทางตัดสินเดียวคือ **Controller chat relay** (V13 TASK-027,
`req.md` §25): STA เปิด pending request แล้ว Controller แสดงใน bubble chat — request ID, gate type, scope,
item versions/digests และข้อความที่ต้องตอบ (บรรทัดแรก `approve <request-id>` หรือ `reject <request-id>`);
คำตอบเดิมของ Human ถูก relay กลับพร้อม conversation/message ID และ actor (`--chat-actor-id`) หรือแจ้งชัดว่า
host ไม่เปิดเผย actor (`--chat-actor-unavailable`); STA ตรวจ pending, scope, replay และ item version ก่อนบันทึก
— แต่ STA ตรวจความแท้ของ actor/message เองไม่ได้ (เป็นคำรับรองของ Controller ซึ่ง Human ยอมรับความเสี่ยงนี้
แล้วอย่างชัดเจน) และไม่มี fallback channel; sign-off ทำให้ item
ของ lane เป็น approved ด้วย (ไม่มี `roles approve` แยก) และผูก `{id, version, digest}` — item เปลี่ยน =
stale. ไม่มีคำตอบที่ผูกกับ request ถูกต้อง = request ค้าง pending (exit 4/5). `--by`, ไฟล์ `knowledge/_roles/**` และ `status: approved`
ในไฟล์ item ไม่ใช่ authority; `roles review`/`roles approve` ถูกปฏิเสธ. โมเดลเต็มอยู่ที่
[`knowledge/README.md`](../knowledge/README.md) § Role workspaces

### STA Core — service, work runs — คู่มือ: [`core.md`](core.md)

```bash
sta setup-machine --root C:\src [--language th|en] [--intent-provider gemini|offline] [--intent-model <id>] [--intent-key-stdin]
                  [--commander-order a,b,..] [--engineer-order ..] [--reviewer-order ..] [--qa-order ..]
                  [--knowledge <name>=<path>]... [--no-detect]     # idempotent
sta start [--port <n>] · sta stop · sta core status    # background service (127.0.0.1) + Local API
sta settings · sta settings intent-key <key> [--clear] # machine.yaml + Intent key (machine-local secret store)
sta work <module> [--root <name>] [--phase <n> | --task <id,...>] [--until next-gate] [--autonomy edit|full] [--text "<คำสั่ง>"]
sta work status [<module>|<run-id>] [--root <name>] [--json]   # อ่าน core.db ตรง ใช้ได้แม้ service ไม่เปิด
sta work pause|resume|stop <module>|<run-id> [--root <name>] [--force]
sta work approve <module>|<run-id> --by <name> [--note <text>] · sta work send-back … --by <name> --note <text>
sta stop <module>                                      # = sta work stop <module>; `sta stop` ไม่มี argument = หยุด service
sta knowledge add <name> <path> [--default] | list | validate [<name>] | default <name> | remove <name> | modules <name>
```

`sta status`/`sta pause`/`sta resume <task-id>` เดิมยังเป็นคำสั่งระดับ **task** ของ engine ตามเดิม — ระดับ
**work run** (ทั้ง module) อยู่ใต้ `sta work …` เพื่อไม่ให้ความหมายเดิมเปลี่ยน

### Install / machine config / diagnostics

```bash
sta init    --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>] [--force]
sta upgrade --mode <legacy-project|three-repo> [...]  # legacy `.sta/`-only workspace: error พร้อมชี้ไป software-team-agents init
sta migrate [--project-root <path>]                  # สำหรับ breaking manifest schema change
sta rollback [--backup <name>] / sta list-backups    # คืนจาก .sta/backups/ snapshots
sta configure knowledge-root <path> [--root <name>] [--default]
            # ไม่ส่ง --root: ฟอร์ม single-root ของ V10 — ใช้ได้จนกว่าเครื่องจะมีไฟล์ v2 (แล้วจะถูก refuse พร้อมชี้ --root)
            # ส่ง --root: named-root surface — named operation แรก migrate installation.yaml เป็น v2
            #   (knowledge_roots map + default_root), คง identities และ root เดิม
sta configure default-root --root <name>             # เปลี่ยน root ที่งานใหม่เลือกเมื่อไม่ส่ง --root
sta configure identity --figma-email <e> --claude-email <e>   # design accounts (emails only)
sta transfer plan --source-root <name> --source-target <id> --destination-root <name>
sta transfer release|register|rollback|verify --transfer <path>
            # ขั้นตอนย้ายความเป็นเจ้าของ Target ข้าม root — human-gated: คนเป็นผู้กรอกและอนุมัติ
            # approval record, คำสั่งตรวจ record เท่านั้น (plan เป็น read-only)
sta doctor [--root <name>] [--project-root <path>]   # read-only diagnostics, exit 1 เมื่อมี FAIL
            # --root ตรวจ root ที่ระบุ, ไม่ส่ง = ตรวจ default; รวม check
            # "Target ownership across configured roots" — duplicate key/alias/checkout
            # ข้าม root = FAIL, SSH alias ไม่มี mapping = WARNING, ข้ามเครื่องเป็น WARNING
            # (coverage เฉพาะ root ที่ installation ของเครื่องนี้ประกาศ — ไม่ใช่ guarantee)
sta runtimes                                         # runtime + support level จาก source of truth เดียวกับ docs/runtimes.md
```

**Named Knowledge roots (V11):** installation.yaml หนึ่งไฟล์มี root ได้หลายชื่อ (`knowledge_roots`) แต่
หนึ่งคำสั่ง/หนึ่ง run/หนึ่ง session เลือกได้ **หนึ่ง root เท่านั้น** — เลือกด้วย `--root <name>` หรือใช้ default;
`sta run` จะ freeze root ไว้ที่ intake แล้ว `sta resume/retry` ใช้ค่าที่ freeze เสมอ (`--root` ที่ส่งมาเป็น
drift assertion — ขัด = refuse) รายชื่อ flag ที่รับ `--root`: run/resume/retry/bounded-run/context/report/doctor
(ฝั่ง `sta`) และ init/sync/status/open (ฝั่ง `software-team-agents`)

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
| `--runtime <claude-code|codex|opencode|antigravity|zcode>` | เลือก runner สำหรับ run นี้ (precedence สูงสุด) |
| `--model <name>` | explicit model override สำหรับทุก stage ของ run นี้; runtime ปฏิเสธ model ที่มันใช้ไม่ได้ |
| `--effort <name>` | explicit effort override สำหรับทุก stage ของ run นี้; adapter ปฏิเสธ vocabulary/capability ที่มันใช้ไม่ได้ |
| `--token-budget <n>` | positive integer, post-hoc task token ceiling; ไม่ใช่ pre-spawn context cap |
| `--mode <single|auto|manual>` | **ถอดออกแล้ว** — error พร้อมชี้ไป `--runtime`/`--model`/`routing.by_role` |

options เสริมของ run: `--frontend-target/--backend-target <id>` (immutable ต่อ task), `--phase <n,n>`,
`--depends-on <id,id>`, `--ad-hoc`, `--env <local|dev|staging|production>`, `--state-db <path>`,
`--root <name>` (named Knowledge root — ดูหมายเหตุ Named Knowledge roots),
`--project-root <path>` (three-repo mode: path คือ Knowledge root — เป็น compatibility assertion กับ
root ที่ installation เลือกแล้ว ไม่ใช่ selector ตัวที่สอง) — ไม่มี user-facing `--qa-skip`

### Validation flags (`sta --check-*`)

registry เดียวใน `orchestrator/src/cli/checkers.ts` — ตรวจความสม่ำเสมอของ repo แบบ read-only:

`--check-contracts` (contracts/*.yaml vs agent roster) · `--check-layout` (layout.yaml vs real dirs) ·
`--check-prompt-budget` (prompt floor) · `--check-workflows` (generated workflows byte-match classifier) ·
`--check-bindings` (generated renderings byte-match sources) · `--check-profile` (project.yaml + stacks/) ·
`--check-decisions` (ADR schema + cross-links) · `--check-test-pyramid` · `--check-review-separation` ·
`--check-escalation-policy` · `--check-workspace` (workspace.yaml + misplaced docs) · `--check-repos` ·
`--check-environments` · `--check-doc-structure` · `--check-doc-size` ·
`--check-plan` (plan.md เป็น dependency graph) · `--check-knowledge` · `--check-installation` ·
`--check-git-ownership` (git mutation อยู่ใน `orchestrator/src/git/` เท่านั้น) ·
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
