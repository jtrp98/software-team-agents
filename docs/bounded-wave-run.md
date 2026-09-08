# คู่มือ bounded wave run

เอกสารนี้เป็น canonical home เพียงแห่งเดียวสำหรับการใช้งาน bounded wave run ตาม
`V7-TASKS.md` §14. รายละเอียดของ checkpoint อยู่ที่
[`policies/git.md` §22](../policies/git.md#22-orchestrator-owned-checkpoint-contract) และเหตุผลของ
ขอบเขต Git อยู่ที่
[ADR-026](../decisions/ADR-026-trusted-orchestrator-git-ownership.md); คู่มือนี้ไม่เขียนซ้ำทั้งสองส่วน

## 1. เริ่ม bounded run

ก่อนเริ่มงานจริง ให้ตรวจ wave, ลำดับงาน, route และ eligibility โดยไม่สร้าง branch, lock, manifest
หรือ commit:

```powershell
sta run --wave <n> --module <module> --max-tasks <k> --dry-run
```

เมื่อ dry-run แสดงทุก task เป็น `ELIGIBLE` และ readiness gate ได้รับ human sign-off แล้ว จึงเริ่ม
wave เดียวที่มีขอบเขตชัดเจน:

```powershell
sta run --wave <n> --module <module> --max-tasks <k> --autonomy edit
```

`<k>` เป็นเพดานจำนวน task; ไม่ระบุได้เมื่อคนตั้งใจให้ทั้ง derived wave ทำงาน แต่ห้ามตีความว่า
runner จะข้าม task ที่ halt หรือ ineligible เพื่อไป task ถัดไป

## 2. Precondition และความหมายของ refusal

ใช้ dry-run ก่อนทุกครั้ง เพราะ refusal คือการหยุดเพื่อรักษาหลักฐาน ไม่ใช่สิ่งที่ควรข้าม:

| สิ่งที่ตรวจ | เหตุผลของ refusal | สิ่งที่คนต้องทำ |
|---|---|---|
| plan และ task record อ่านได้, มี wave และมี writable Target เดียว | ป้องกันการเดา order/ownership หรือ checkpoint ข้าม Target | แก้ plan หรือ register task ให้ตรง แล้ว dry-run ใหม่ |
| working tree สะอาดและอยู่บน ordinary branch | ป้องกันการ checkpoint งานของคนอื่น | ตรวจ diff และตัดสินใจกับงานค้างก่อนเริ่ม |
| task ทุกตัว eligible, ไม่มี human gate, และ runtime support level ผ่าน | ไม่ให้ unattended run ข้าม approval หรือใช้ runtime ที่ guard ไม่ครบ | แก้สาเหตุที่รายงาน แล้วเริ่มใหม่; ineligible task ทำให้ wave halt ที่ตำแหน่งนั้น |
| deterministic gate และ commit-hook preflight ผ่าน | ป้องกัน commit ที่ตรวจไม่ได้หรือ hook ที่ทำงานโดยไม่คาดหมาย | ทำตาม remediation ที่ refusal พิมพ์ แล้ว dry-run ใหม่ |
| ไม่มี bounded run เดิมที่ยังไม่จบ | ไม่ให้สอง run เขียน Target เดียวกัน | ตรวจ `sta status` และใช้ `--resume-run` กับ run เดิมเมื่อเหมาะสม |

ข้อความ refusal ระบุสาเหตุและ remediation ที่ใช้ได้กับ Target นั้น; อย่าเดา flag เพื่อบังคับผ่าน

## 3. ดูผลของ run

ใช้สาม surface นี้หลัง dry-run, ระหว่างรอ, หรือหลัง run หยุด:

```powershell
sta status
sta changed
sta report --module <module> --output .workflow/report.html
git log --oneline --decorate <base>..<run_branch>
```

`status` บอก state และ next required human action, `changed` รวม working-tree/gate และ checkpoint
ของ run, ส่วน `report` เขียน dashboard HTML ตาม path ที่ให้ไว้. `CHECKPOINTED` เป็นสถานะ durability
เท่านั้น ไม่ใช่ QA verdict หรือ approval. ถ้า run `HALTED` จะไม่มี merge advice.

## 4. Resume run ที่หยุดไว้

resume เฉพาะ bounded run ที่มีอยู่แล้ว:

```powershell
sta run --wave <n> --module <module> --resume-run --autonomy edit
```

`--resume-run` สร้างมาเพื่อค้น manifest/journal ของ bounded run, ตรวจเทียบกับ Git แล้วไม่ทำ task
ที่ checkpoint แล้วซ้ำ. มันต่างจาก `--resume` ซึ่งเป็นการ resume pipeline ของ **task เดียว**;
ใช้ `--resume` ร่วมกับ `--wave` ไม่ได้. ถ้า Git, journal หรือ plan ไม่ตรงกัน คำสั่งจะ refuse แทนการเดา.

## 5. หยุดหรือยกเลิก

หากต้องหยุด process ที่กำลังทำงาน ให้กด `Ctrl+C` ใน terminal แล้วดู state, diff และ evidence ตาม
หัวข้อ 3 กับหัวข้อ 8 ก่อนเลือก resume. การหยุดไม่ลบ branch, checkpoint หรือ partial diff.

ไม่มี `sta` verb สำหรับยกเลิก bounded run โดยตรงใน V7. `sta cancel <task-id>` ใช้ยกเลิก task record
ของ pipeline ปกติ จึงไม่ใช่วิธีหยุด active bounded run. อย่าใช้มันแทน `Ctrl+C` หรือ `--resume-run`.

## 6. Merge ในเครื่องโดยคน

หลัง human review/QA แล้วเท่านั้น ให้คัดลอก merge advisory ที่ run แสดง แล้วให้คนเป็นผู้รันเอง:

```powershell
git switch <base> && git merge --ff-only <run_branch>
```

หาก base branch เดินหน้าไปแล้ว `--ff-only` จะ refuse. นี่คือพฤติกรรมที่ตั้งใจไว้เพื่อไม่สร้าง history
หรือแก้ conflict โดยอัตโนมัติ; คนต้องตัดสินใจ merge หรือ rebase อย่างชัดเจนเอง. Run ที่ halt ไม่มี
คำแนะนำ merge และต้องไม่ merge.

## 7. Cleanup

STA ไม่ลบ run branch หรือ commit. หลัง merge สำเร็จและคนยืนยันว่าไม่ต้องเก็บ branch แล้ว จึงลบเอง
แบบปลอดภัย:

```powershell
git branch -d <run_branch>
```

คำสั่งจะ refuse หาก branch ยังไม่ merged. Run artifact ที่หมดอายุถูก prune ได้ตาม lifecycle ของ STA;
orphan branch จะถูกแสดงใน report เพื่อให้คนตัดสินใจเอง.

## 8. เมื่อ run ล้มเหลวและหลักฐานอยู่ที่ไหน

Run ที่ล้มเหลว halt และ preserve งานที่ค้างไว้. เริ่มจากดูหลักฐานก่อนแก้หรือ discard:

```powershell
git status --porcelain
git diff
sta status
sta report --module <module> --output .workflow/report.html
```

manifest และ append-only journal อยู่ใต้ `.workflow/runs/<run-id>/`; report แสดง failure class,
reason และ next required human action. ถ้า crash ทิ้ง partial diff ไว้ ให้ตรวจ diff ก่อนเสมอ; STA
จะ refuse resume จนคนเลือกว่าจะเก็บหรือ discard งานนั้นด้วยตนเอง.

## 9. ทำไม STA ไม่ push

Bounded run ทำงานเฉพาะ local branch และไม่มี remote operation. STA ไม่มี code path สำหรับ push;
การ publish, merge หรือการตัดสินใจใช้ remote เป็นหน้าที่ของคน. ขอบเขตที่บังคับใช้และเหตุผลอยู่ใน
[`policies/git.md` §22](../policies/git.md#22-orchestrator-owned-checkpoint-contract) และ
[ADR-026](../decisions/ADR-026-trusted-orchestrator-git-ownership.md).
