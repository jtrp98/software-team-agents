# bounded wave run — ปลดใช้งานแล้ว (V8, T-V8-029)

คำสั่ง `sta run --wave <n>` และ flag ที่เกี่ยวข้องทั้งหมดถูกปลดออกใน V8 หลัง unified controller
พิสูจน์ parity แล้ว flag ที่ไม่มีอีกแล้ว:

| flag เดิม | สิ่งที่ใช้แทน |
|---|---|
| `sta run --task-id ... --register-only` | ไม่ต้อง register ทีละ task อีกแล้ว — `sta bounded-run` ลงทะเบียนทั้ง scope ใน transaction เดียว |
| `sta run --wave <n>` | `sta bounded-run --module <name> (--all \| --phase <n> \| --task <id,...>)` |
| `--max-tasks <k>` | เลือก scope ให้แคบด้วย `--phase` หรือ `--task` แทนการตัดจำนวน |
| `--dry-run` | `sta bounded-run ... --dry-run` |
| `--resume-run` | `sta bounded-run --resume <run-id>` (`--resume` ยังเป็น resume ระดับ task ตามเดิม) |
| `--no-wave-runner` | ไม่มี off-seam แยกอีกแล้ว — ไม่เรียก `bounded-run` ก็คือไม่รัน |

**คู่มือปัจจุบันคือ [`docs/bounded-run.md`](bounded-run.md)** ซึ่งเป็น canonical home เพียงแห่งเดียว
ของ bounded run: precondition, refusal, resume, evidence, merge ที่คนทำเอง และเหตุผลที่ STA ไม่ push

## record เก่ายังอ่านได้ แต่ resume ไม่ได้

`.workflow/wave-runs/<run-id>/` (manifest + append-only journal) ที่ STA เวอร์ชันก่อนเขียนไว้
ยังอ่านได้ตามเดิม: `sta status`, `sta report` และ `sta changed` แสดงมันโดยกำกับว่าเป็น legacy record
และ `ledger/adapters.ts` project มันเข้า ledger vocabulary แบบ read-only ที่มี version กำกับ

ไม่มี code path ใดเขียน directory นั้นอีก — writer ทุกตัวถูกลบไปพร้อม wave lifecycle — จึงเป็นไปไม่ได้
ที่มันจะกลายเป็น authority ที่สอง run ที่ค้างอยู่ใน record เก่า **resume ไม่ได้**: branch, commit และ
diff ที่มันทิ้งไว้เป็นเรื่องที่คนต้องตรวจและตัดสินใจเอง STA ไม่ลบและไม่ restore อะไรให้

เหตุผลของการปลด บันทึกไว้ที่ `planning/v8/V8-PROBLEM-ANALYSIS.md` §13 (หนึ่ง run ledger แทนสอง
lifecycle) และ `planning/v8/V8-TASKS.md` T-V8-029
