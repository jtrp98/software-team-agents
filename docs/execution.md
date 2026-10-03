# Execution model — `sta execute`

STA คือ execution/context/policy layer ที่ AI ตัวไหนก็เรียกได้ ไม่ใช่ controller ตัวที่สองที่แข่งกับผู้เรียก

```text
controller → sta.execute() → runtime adapter → result → controller
```

Nested execution คือการเรียก primitive ตัวเดิมซ้ำ:

```text
controller → sta.execute() → child (executor ของ parent, controller ของลูกตัวเอง) → sta.execute() → executor → result
```

- **Claude Code, Codex, Antigravity, ZCode (และ OpenCode) เป็น runtime** ทุกตัวถูกเรียกผ่าน
  `RuntimeAdapter` ตัวเดียวกัน (`orchestrator/src/runtime/runtimeAdapter.ts`) ไม่มีตัวไหนถูกกำหนดตายตัวว่าเป็น
  "controller" หรือ "executor"
- **Controller กับ Executor เป็นบทบาทต่อ run** ถ้า A เริ่ม B แล้ว A คือ controller ของ B และ B คือ executor ของ A
  ถ้า B เริ่ม C ต่อ B ก็เป็น controller ของ C ไปพร้อมกัน บทบาทอ่านได้จาก `parentRunId` ไม่มี field ชื่อ role
  สำหรับเรื่องนี้
- runtime เดียวกันอยู่ใน tree ได้กี่ครั้งก็ได้ (Claude → Claude → Codex → Claude)
- **STA คืนการควบคุมให้ผู้เรียกเสมอ** ผลลัพธ์มีสี่แบบ แล้วผู้เรียกเป็นคนตัดสินใจขั้นต่อไป
  - `completed`: มี `output` และ `evidence`
  - `partial`: มี `output` และ `remainingWork`
  - `needs_approval`: มี `request`
  - `failed`: มี `error`
- **Workflow เป็นตัวช่วย ไม่ใช่อำนาจบังคับ** `sta run` / `sta bounded-run` ยังใช้ได้เหมือนเดิม และแต่ละ stage
  attempt ก็เป็น node ใน run tree เดียวกัน ตัว agent ของ stage จึง delegate ด้วย `sta execute` ได้เหมือน run ทั่วไป

## ใครทำอะไร

| ฝ่าย | หน้าที่ |
|---|---|
| Controller (ใครก็ได้ที่เรียก) | เข้าใจเจตนา, แตกงาน, เลือก runtime, ตัดสินใจว่าจะ delegate ไหม, ตีความผล, ตัดสินว่าจบหรือยัง |
| STA | resolve workspace/permissions/limits, บันทึก run tree, เรียก adapter, บังคับ safety boundary, normalize ผลลัพธ์ |
| Executor | ทำงานตามที่ได้รับภายใน permission และ delegate ต่อได้ถ้าได้รับอนุญาต |

## Run model

แต่ละ run เป็นไฟล์ JSON หนึ่งไฟล์ที่ `<store>/<rootRunId>/<runId>.json` (`orchestrator/src/execute/runStore.ts`)
ค่าเริ่มต้นของ store คือ `STA_RUN_STORE` ถ้าไม่มีก็ใช้ `<project>/.workflow/runs` ใช้ไฟล์ละ run ไม่มี index กลาง
run พี่น้องหรือ STA process ที่ซ้อนกันจึงไม่เขียนไฟล์เดียวกัน

| field | ความหมาย |
|---|---|
| `runId`, `parentRunId`, `rootRunId`, `depth` | ตำแหน่งใน tree (root มี depth 0) |
| `runtime`, `role?` | adapter ที่ใช้ และ persona ที่เลือกได้จาก binding (เป็นชุดคำสั่ง ไม่ใช่สิทธิ์) |
| `workspace` | directory ที่ run ทำงาน ลูกต้องอยู่ภายใน workspace ของ parent |
| `permissions` | `write`, `writePaths`, `delegate`, `autonomy` ลูกได้ไม่เกิน parent |
| `limits` | `maxDepth` (3), `maxChildren` (8), `maxTotalRuns` (25), `timeoutMs` ค่าเหล่านี้ root เป็นคนกำหนด ลูกเข้มขึ้นได้แต่ผ่อนลงไม่ได้ |
| `status`, `attempts`, `approval`, `blockedOn` | สถานะของ run นั้นเอง |

Executor ได้รับ `STA_RUN_ID` และ `STA_RUN_STORE` ใน environment การเรียก `sta execute` จากข้างใน run
จึงเป็น child ของ run นั้นโดยอัตโนมัติ ส่วน executor แบบ in-process ส่ง `parentRunId` เอง นอกจากนี้
`STA_ROLE` และ guard channel อื่น ๆ ถูกตั้งใหม่ทุก run จึงไม่มีสิทธิ์ของ parent รั่วมาทาง environment

## Policy — action ไม่ใช่ตำแหน่งงาน

`orchestrator/src/execute/policy.ts` ถามว่า "run นี้ทำ action นี้ได้ไหม" ไม่เคยถามว่า "ผู้เรียกเป็น role อะไร"

**Hard boundary (ปฏิเสธเสมอ):**

- ลูกเขียนนอก workspace หรือ path ที่ได้รับ
- ลูกขอสิทธิ์เกิน parent (write, autonomy หรือ path) หรือ delegate ในขณะที่ parent ห้าม
- run เกิน `maxDepth`, `maxChildren` หรือ `maxTotalRuns` ระบบนับหลัง create แบบ exclusive
  sibling ที่แข่งกันจึงถูกปฏิเสธ ไม่ใช่หลุดผ่านทั้งคู่
- run ที่เขียนไฟล์บน runtime ที่ไม่มี `PRE_TOOL_GUARD` หรือ post-run write path ที่อนุญาตไว้ชัดเจน
  (Codex ต้องมี `POST_RUN_WRITE_GUARD` และ executor lifecycle; การตรวจหลังรันไม่ป้องกันหรือย้อนการเขียน)
- floor ที่ทุก run มีเสมอ:
  - ห้าม git ที่เปลี่ยน state
  - ห้ามเขียน `.git/**`, `.workflow/**`, `knowledge/_roles/**` และ framework payload
  - run ที่เขียนไฟล์ต้องผ่าน `no-hardcoded-secret`
- side effect ที่ประกาศไว้ (`--action production-deploy`, `migration`, `force-push`, `external-side-effect` ฯลฯ)
  ต้องมี human approval ก่อน run จะเริ่ม

**ไม่ใช่ blocker อีกต่อไป:**

- ผู้เรียกเป็น product ไหน
- run เข้ามาในฐานะ executor หรือเปล่า
- runtime ซ้ำกับ parent หรือไม่
- ต้องมี BA/SA/PM/workflow ก่อนหรือไม่
- ต้องมี role หรือไม่

## เขียน Target จาก Knowledge workspace

`--workspace` คือที่ที่ run ทำงาน และเป็นที่ที่ runtime อ่านนิยาม role (`.claude/agents/<role>.md`) กับ guard wiring
(`.claude/settings.json`) ด้วย ถ้าตั้ง workspace เป็น Target แล้ว Target ไม่มีของพวกนี้ run จะล้ม ให้ตั้ง workspace เป็น Knowledge
แล้วระบุ Target ที่จะเขียนแยกต่างหาก:

```bash
sta execute --runtime claude-code --role backend-engineer --workspace <knowledge-root> \
  --writable-target <target-id|path> --task "BE-005: ..."
```

- `--writable-target` ใส่ได้หลายตัว และรับได้เฉพาะ Target ที่ `.workflow/targets.local.yaml` ของ workspace map ไว้
  (ตัว resolve เดียวกับ `open --writable-target`) ถ้า Target ไม่อยู่ใน map จะได้ `target_not_mapped` ก่อนจะ spawn อะไร
- การระบุ Target ถือว่าสั่ง `--write` ด้วย และต้องมี `--role` เพราะ guard ใช้ contract และ stack rules ของ role ตรวจทุก path ใน Target
  ถ้าไม่มี role จะได้ `invalid_permissions`
- ตัว workspace จะอ่านได้อย่างเดียว เว้นแต่ใส่ `--write-path` เพิ่มเอง STA ตั้ง `STA_KNOWLEDGE_ROOT` เป็น workspace engineer จึงเขียน
  `_docs/`, `knowledge/` ฯลฯ ไม่ได้ เหมือน stage ที่ orchestrator คุม
- Claude Code ได้ `--add-dir=<target>` และ prompt บอก path ของแต่ละ Target แบบ absolute
- Codex รับ Target paths ใน prompt และตรวจไฟล์ที่เปลี่ยนตาม role/stack ของแต่ละ Target หลังรัน;
  Knowledge workspace ต้องไม่เปลี่ยน, snapshot ที่ไม่มีและ write ผิด scope ทำให้ attempt ล้มเหลว
- stack rules อ่าน `stacks/<profile>/stack.yaml` จาก workspace (Target ไม่มี `stacks/`) และอ่าน `type` ของ Target จาก
  `targets.yaml` ของ workspace เดียวกัน Target แบบ `frontend`/`backend` ให้ engineer ของ type นั้นเขียนได้ทั้ง Target
  (หัก deny) ส่วน `fullstack` ใช้ layout ของ profile บวก `path_overrides` และตัด `**` จาก source root `.` ทิ้ง
  ([architecture.md](architecture.md#ขอบเขตที่-engineer-เขียนได้ใน-target)) ดูผลจริงด้วย `sta doctor`

## `sta execute` ไม่ใช้ OS sandbox

run ตรงคือผู้เรียกสั่ง runtime เองเหมือนพิมพ์ prompt เอง Claude Code จึงถูกเรียกตรงด้วย `claude -p` ไม่ห่อด้วย `codex sandbox`
ใช้ login และ network ของผู้ใช้ และไม่เปิดหน้าต่าง console (`windowsHide`) ส่วน `sta run`/`bounded-run` ยังรันใน OS isolation เหมือนเดิม

สิ่งที่ยังบังคับอยู่มีแค่ hook ใน `.claude/settings.json` ของ workspace คือ path ของ Write/Edit ตาม role และ stack, การบล็อก git
ที่เปลี่ยน state และ `no-hardcoded-secret` สิ่งที่ไม่มีแล้วคือการกันระดับ OS: คำสั่ง Bash เขียนนอก path ที่อนุญาตได้ และ network เปิดเต็ม
ผู้ใช้ยอมรับข้อนี้แล้ว (2026-10-01) เพื่อให้ run ตรงทำงานแบบเดียวกับ session ที่คนสั่งเอง
- run ลูกได้ Target ของ parent โดยอัตโนมัติเมื่อเขียนได้และมี role ระบุ Target ที่ parent ไม่มีจะได้ `permission_escalation`

## Approval ข้าม tree

1. run C ที่ประกาศ side effect จะคืน `needs_approval` โดยไม่ spawn อะไรเลย
2. เมื่อ executor ของ B จบ STA พบ approval ที่ค้างอยู่ใต้ B ผลของ B จึงเป็น `needs_approval` ด้วย
   (`request.runId = C`, `chain = [B, C]`) และ A ก็ได้ผลแบบเดียวกันต่อขึ้นไป
3. ผู้เรียกที่ถือ root นำคำถามไปถามคน แล้ว relay คำตอบกลับด้วย
   `sta execute approve <C> --request <id> --yes --by <ชื่อ>`
   run ที่อยู่ใน tree เดียวกันตัดสิน approval ของ tree ตัวเองไม่ได้
4. `sta execute resume <A>` จะรัน A ต่อ executor ของ A resume B และ B resume C ความเป็นเจ้าของไม่เปลี่ยน
   เพราะมีแค่ parent ของ run หรือผู้เรียกจากนอก tree เท่านั้นที่ resume ได้

ข้อจำกัดที่ต้องรู้: เหมือนกับ chat relay ของ workflow คือ STA ยืนยันตัวตนของคนที่ approve ไม่ได้ และ
การตรวจว่าผู้เรียกอยู่ใน tree เดียวกันหรือไม่อาศัย `STA_RUN_ID` ของผู้เรียก OS approval-isolation ที่ถูก
certify แล้วยังบังคับใช้กับ workflow path เท่านั้น

## Failure

`error` บอกว่า run ไหน runtime ไหน task ไหนล้มเหลว ใครเป็น parent และมี output/diagnostics ของ runtime (ตัดความยาว)
ถ้ามี descendant ล้มเหลวด้วย `error.cause` จะชี้ไปที่ตัวที่ลึกที่สุด ส่วน `evidence.children` สรุปสถานะของลูกทุกตัว

## ตัวอย่าง

Claude Code Desktop (controller) → STA → Claude Code CLI (executor):

```bash
sta execute --runtime claude-code --task "เพิ่ม unit test ให้ parseDate" --write
```

Claude Code Desktop → STA → Codex:

```bash
sta execute --runtime codex --task "หา call site ทั้งหมดของ legacyAuth"
```

Codex controller → STA → Claude:

```bash
sta execute --runtime claude-code --task "review diff นี้ตาม policies/coding.md" --role reviewer
```

Controller → STA → child controller runtime เดียวกัน → executor โดยที่ executor ข้างในรันคำสั่งนี้ (มี `STA_RUN_ID` อยู่แล้ว):

```bash
sta execute --runtime claude-code --task "แยก migration script ออกมา" --write
```

Library (in-process):

```ts
import { createSta } from "./orchestrator/src/execute/execute.js";
const sta = createSta({ registry });
const result = await sta.execute({ runtime: "codex", task: "…", permissions: { write: true } });
if (result.status === "needs_approval") { /* ถามคน แล้ว sta.approve(...) และ sta.resume(...) */ }
```

`createStaApi().execute({ runtime, task, … })` คือ primitive ตัวเดียวกัน ส่วน `execute({ taskId })`
ยังเป็นการเดิน workflow หนึ่ง step เหมือนเดิม

Exit code ของ CLI:

- `0` completed
- `1` failed
- `3` needs_approval
- `4` partial

ผลลัพธ์ JSON พิมพ์ออก stdout เสมอ
