# คู่มือ bounded run

เอกสารนี้เป็น canonical home เพียงแห่งเดียวสำหรับการใช้งาน `sta bounded-run` — คำสั่งเดียวที่ compile
plan scope, freeze มัน, แล้วเดิน DAG ผ่าน DEV → deterministic verification → checkpoint → coherent
QA/repair จนถึง boundary ที่เลือก รายละเอียดของ checkpoint อยู่ที่
[`policies/git.md` §22](../policies/git.md#22-orchestrator-owned-checkpoint-contract) และเหตุผลของ
ขอบเขต Git อยู่ที่ [ADR-026](../decisions/ADR-026-trusted-orchestrator-git-ownership.md);
คู่มือนี้ไม่เขียนซ้ำทั้งสองส่วน

> V8 ปลด `sta run --wave <n>`, `--register-only`, `--max-tasks`, `--resume-run` และ `--no-wave-runner`
> ออกทั้งหมด (T-V8-029) ไม่มีขั้น "register ทีละ task ก่อน" อีกแล้ว — `bounded-run` ลงทะเบียนทั้ง scope
> ใน transaction เดียว record เก่าใต้ `.workflow/wave-runs/` ยังอ่านได้ แต่ resume ไม่ได้ (§8)

## 1. เริ่ม bounded run

ก่อนเริ่มงานจริง ให้ดู scope, ลำดับงาน, gate, base revision และ route โดยไม่สร้าง branch, lock,
run record หรือ commit:

```powershell
sta bounded-run --module <module> --phase <n> --dry-run
```

scope เลือกได้อย่างใดอย่างหนึ่งเท่านั้น: `--all`, `--phase <n>` หรือ `--task <id>[,<id>...]`
preview กับการรันจริงเป็น computation เดียวกัน (ทั้งคู่เรียก `resolvePlanScope`/`previewPlanRegistration`
บน byte เดียวกันของ `plan.md`) ไม่ใช่สองอันที่ "ควรจะตรงกัน"

เมื่อ preview ถูกต้องและ gate ที่เห็นได้รับการจัดการแล้ว จึง freeze และรันจริง:

```powershell
sta bounded-run --module <module> --phase <n> --until next-gate --autonomy edit
```

`--until` เลือก boundary ได้สามค่า: `next-gate` (หยุดที่ gate แรก), `qa` และ `done`
ไม่มีค่าใดที่ยกเว้น hard gate ได้

## 2. Precondition และความหมายของ refusal

ใช้ `--dry-run` ก่อนทุกครั้ง เพราะ refusal คือการหยุดเพื่อรักษาหลักฐาน ไม่ใช่สิ่งที่ควรข้าม:

| สิ่งที่ตรวจ | ผู้บังคับใช้ | สิ่งที่คนต้องทำ |
|---|---|---|
| `plan.md` เป็น canonical plan, scope ปิด, ไม่มี cycle, ไม่ drift | `orchestrator/planCompilation.ts` | แก้ plan แล้ว `--dry-run` ใหม่; refusal บอก kind และ task id ที่ขัดแย้ง |
| ไม่มี human/approval gate ค้างของ task ที่จะรัน | `run/unattendedGate.ts` | resolve gate (`sta approve <task-id>`) หรือ unpause/uncancel แล้วรันใหม่ |
| dependency ทุกตัว checkpoint/done แล้ว | `RunLedger.readiness()` บน frozen DAG | ปล่อยให้ upstream task เดินก่อน; plan Status cell ปลดล็อกให้ไม่ได้ |
| runtime support level, guard capability, writable root เดียว | `ledger/attemptFreeze.ts` | แก้สาเหตุที่ refusal ระบุ; V8 ยอมรับเฉพาะ runtime ระดับ `supported` สำหรับการเขียน Target |
| working tree สะอาดและอยู่ base/run branch ที่ frozen ไว้ | `git/guardedRun.ts` | ตรวจ diff และตัดสินใจกับงานค้างก่อน STA ไม่ลบหรือ restore ไฟล์ของคน |
| deterministic gate รันได้จริงและผ่าน | `qa/verificationHook.ts` + controller | ทำตาม remediation ที่ refusal พิมพ์; ไม่มี suite = `unverified` ไม่ใช่ pass |
| ไม่มี run อื่นที่ยังไม่จบบน Target เดียวกัน | `git/guardedRun.ts` | reconcile run เดิมก่อน หรือ resume มันด้วย `--resume <run-id>` |

ข้อความ refusal ระบุสาเหตุและ remediation ที่ใช้ได้กับ Target นั้น; อย่าเดา flag เพื่อบังคับผ่าน

## 3. ดูผลของ run

```powershell
sta bounded-run --resume <run-id> --module <module> --dry-run
sta changed
sta report --module <module> --output .workflow/report.html
git log --oneline --decorate <base>..<run_branch>
```

`--resume ... --dry-run` พิมพ์ status, boundary, task order และ readiness ปัจจุบันจาก ledger
โดยไม่แก้ state, `changed` รวม working-tree/gate, ส่วน `report` เขียน dashboard HTML
`CHECKPOINTED` เป็นสถานะ durability เท่านั้น ไม่ใช่ QA verdict หรือ approval

## 4. Resume run ที่หยุดไว้

```powershell
sta bounded-run --resume <run-id> --module <module> --autonomy edit
```

resume ใช้ Target root, knowledge root, base revision, plan hash และ task order ที่ **frozen ไว้ใน run**
ไม่ใช่ค่าจาก flag ของการเรียกครั้งนี้ — flag ที่ขัดแย้งคือ refusal ไม่ใช่ override ถ้า `plan.md`,
`requirement.md` หรือ `design.md` เปลี่ยนไป คำสั่งจะ refuse แทนการรัน frozen scope กับ input ที่ต่างออกไป

`--resume` ของ `bounded-run` เป็น resume ระดับ **run**; `sta run --resume --task-id <id>` ยังเป็น resume
ระดับ **task เดียว** ตามเดิม

## 5. หยุดหรือยกเลิก

กด `Ctrl+C` แล้วดู state, diff และ evidence ตามหัวข้อ 3 กับหัวข้อ 7 ก่อนเลือก resume
การหยุดไม่ลบ branch, checkpoint หรือ partial diff — attempt ที่ถูกขัดจังหวะจะถูกบันทึกเป็น
`ABANDONED` และ task ไม่ถูกนับว่าล้มเหลว

`sta pause <task-id>` / `sta cancel <task-id>` หยุด **task** ไม่ใช่ process ที่กำลังรัน แต่ทั้งคู่เป็น
gate ที่ bounded run ตัวถัดไปจะเคารพ (`run/unattendedGate.ts`)

## 6. Merge ในเครื่องโดยคน

หลัง human review/QA แล้วเท่านั้น ให้คนเป็นผู้รันเอง:

```powershell
git switch <base> && git merge --ff-only <run_branch>
```

หาก base branch เดินหน้าไปแล้ว `--ff-only` จะ refuse นี่คือพฤติกรรมที่ตั้งใจไว้เพื่อไม่สร้าง history
หรือแก้ conflict โดยอัตโนมัติ STA ไม่ลบ run branch หรือ commit; orphan branch แสดงใน `sta report`
เพื่อให้คนตัดสินใจเอง

## 7. เมื่อ run ล้มเหลวและหลักฐานอยู่ที่ไหน

```powershell
git status --porcelain
git diff
sta bounded-run --resume <run-id> --module <module> --dry-run
sta report --module <module> --output .workflow/report.html
```

run, task, attempt, checkpoint, finding และ event ทุกอันอยู่ใน run ledger (SQLite เดียวกับ task store
จึงเขียนใน transaction เดียว); packet ที่ frozen อยู่ใต้ `.workflow/packets/` ถ้า crash ทิ้ง partial diff
ไว้ ให้ตรวจ diff ก่อนเสมอ STA จะ refuse resume จนคนเลือกว่าจะเก็บหรือ discard งานนั้นด้วยตนเอง

## 8. Record ของ wave run เดิม

`.workflow/wave-runs/<run-id>/` เป็น record ของ wave runner ที่ปลดไปแล้ว ไม่มี code path ใดเขียน
directory นี้อีก จึงเป็นไปไม่ได้ที่มันจะกลายเป็น authority ที่สองอีกครั้ง `sta status`, `sta report`
และ `sta changed` ยังอ่านและแสดงมัน โดยกำกับว่าเป็น legacy record ที่ resume ไม่ได้ —
ผู้ที่ต้องตัดสินใจเรื่อง branch หรือ commit ที่ค้างจาก run เก่าคือคน

## 9. ทำไม STA ไม่ push

Bounded run ทำงานเฉพาะ local branch และไม่มี remote operation STA ไม่มี code path สำหรับ push;
การ publish, merge หรือการตัดสินใจใช้ remote เป็นหน้าที่ของคน ขอบเขตที่บังคับใช้และเหตุผลอยู่ใน
[`policies/git.md` §22](../policies/git.md#22-orchestrator-owned-checkpoint-contract) และ
[ADR-026](../decisions/ADR-026-trusted-orchestrator-git-ownership.md)
