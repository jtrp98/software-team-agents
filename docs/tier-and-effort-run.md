# คู่มือสั่ง tier และ effort

เอกสารนี้เป็น canonical home ของ "จะสั่ง tier/effort ยังไงใน terminal" ความหมายของแต่ละ tier และ
เหตุผลที่ plan ถือ tier แต่ operator เลือก camp อยู่ที่
[ADR-022](../decisions/ADR-022-per-phase-model-tier.md); binding ของ tier → model/effort ต่อ camp อยู่ที่
[`model-tiers.yaml`](../model-tiers.yaml) ซึ่งเป็นไฟล์ที่คนเป็นเจ้าของ คู่มือนี้ไม่เขียนซ้ำทั้งสองส่วน

**เส้นแบ่งที่ต้องเข้าใจก่อน:** tier ทำงานเฉพาะเส้นทาง orchestrated (`sta run`) เท่านั้น
เซสชัน interactive (`software-team-agents dev`) ไม่มี orchestrator จึงไม่มี tier — ที่นั่นตั้ง effort
ด้วยคำสั่งในเซสชันเอง (§4)

## 1. Cast tier ใน plan.md — ฝั่ง BA/Knowledge workspace

`project-manager` เพิ่มคอลัมน์ `Tier` ในตารางของ phase นั้น และเขียนค่าเพียง **แถวเดียวต่อ phase**
(`T2`–`T6`) แถวที่เหลือเว้นว่างหรือใส่ `—`:

| Task | Status | Owner | Depends on | Tier |
|---|---|---|---|---|
| BE-12 — payments contract (DES-004) | pending | backend-engineer | BE-11 | T4 |
| BE-13 — refund endpoint (DES-005) | pending | backend-engineer | BE-12 | — |

กฎที่ validator บังคับ: analysis phase ห้ามมี Tier, `T1` ถูกปฏิเสธเพราะสงวนไว้, ค่าซ้ำหลายแถวใน
phase เดียวเป็น error, และห้ามเพิ่มคอลัมน์ runtime/model/fallback เพราะ camp เลือกตอนรัน ไม่ใช่ตอนวางแผน

## 2. ตรวจ plan ก่อนส่งต่อ

```powershell
sta --check-plan --module <module>
```

## 3. รันด้วย tier — ฝั่ง DEV/Target workspace

`--runtime` คือการเลือก camp; tier จะ resolve เป็น model/effort ของ camp นั้นจาก `model-tiers.yaml`:

```powershell
sta run --task-id <id> --module <module> --backend --autonomy edit --runtime claude-code
```

ลำดับการเลือก camp เมื่อ phase นั้นมี tier cast: `--runtime` → `execution.runner` ใน
`.sta/config.yaml` → ถ้ามี `routing.by_role` ปล่อยให้ resolve ต่อ stage → ถ้ามี TTY จะถามที่ terminal
(`choose camp/runtime [...]`) → ไม่มี TTY ใช้ default

**ห้ามใส่ `--model` เมื่อต้องการให้ tier ทำงาน** — `modelExplicit` ชนะ tier ทุกกรณี tier จะถูกข้าม
เช่นเดียวกับ `routing.by_role` ที่ระบุ `model:` ไว้แล้ว

ตรวจว่า tier ลงจริงหรือไม่:

```powershell
sta status <task-id>
```

อ่านบรรทัด `runner=… → … model=… → … effort=… basis=…` ถ้า tier ทำงาน `requested_model` จะเป็นค่า
จาก `model-tiers.yaml` ไม่ใช่ค่า `model:` ใน frontmatter ของ role

## 4. ตั้ง effort ในเซสชัน interactive

`software-team-agents dev` เรียก runtime ด้วย args ว่างเปล่า และปฏิเสธ flag ที่มันไม่รู้จัก จึง
**สั่ง effort จากบรรทัดนี้ไม่ได้** — `software-team-agents dev --effort high` เป็น error:

```powershell
software-team-agents dev
```

แล้วตั้งในเซสชัน (ระดับ: `low`, `medium`, `high`, `xhigh`, `max`):

```
/effort high
```

ค่านี้เป็นของ session ไม่ใช่ของ tier: subagent ทุกตัวที่ spawn ต่อจากนั้นอยู่ใต้ค่าเดียวกัน ต้องการ
ความต่างต่อ phase ให้ใช้ `sta run` ตาม §3

`--runtime <claude|codex|opencode|antigravity>` ที่ wrapper รับ เป็นการเลือกว่าจะ launch CLI ตัวไหน
ไม่ใช่การเลือก tier

## 5. ขอบเขตที่รู้แล้ว

| เรื่อง | สถานะจริง | สิ่งที่ต้องทำ |
|---|---|---|
| `T6` + camp `anthropic` | เซลล์เป็น `haiku` แล้ว ซึ่งเป็นชื่อที่ adapter รับ (`opus`/`sonnet`/`haiku`/`inherit`) — เดิมเป็น `haiku-4.5` และทำให้ run ถูกปฏิเสธก่อน spawn | — |
| effort บน `haiku` | ตรวจกับ CLI แล้ว: flag ผ่าน แต่ `claude-haiku-4-5` ไม่มี capability `effort` จึงไม่มีผล | ไม่ต้องแก้; อย่าคาดหวังว่า `T6` จะต่างกันด้วย effort |
| `native` | หมายถึง reasoning ถูกเลือกโดยชื่อรุ่นหรือ variant ของ runtime นั้นเอง; adapter จะไม่ส่งค่านี้เป็น Claude/Codex effort | อย่าใช้ `native` กับ camp ที่ต้องรับ effort แยกต่างหาก |
| camp `openai` | Codex adapter ส่ง model ที่เลือกด้วย `--model` และส่ง effort ด้วย `--config model_reasoning_effort=...`; catalog ถูกอ่านจาก `model-tiers.yaml` ตอนสร้าง production registry | ใช้เฉพาะ effort `low`/`medium`/`high`/`xhigh`/`max` |
| camp `google` | Antigravity ใช้ชื่อ Gemini แบบเต็มที่มี suffix เช่น `gemini-3.8-flash-high`; suffix เลือกระดับ reasoning เอง | หลัง login ให้รัน `agy models` แล้วแก้ table หาก account ไม่มีชื่อรุ่นนั้น |
| camp `zai` | OpenCode ต้องมี provider/model/variant จริง เช่น `zai-coding-plan/glm-4.7#fast`; `fast` ไม่ได้ถูกสร้างให้อัตโนมัติ | ตรวจ `/models` และตั้งค่า provider ของ OpenCode/Z.AI ให้ตรงก่อน run จริง |
| `T2` vs `T3` และ `T4` vs `T5` บน Claude Code | ต่างกันจริงแล้วที่ effort (`opus high` vs `opus medium`, `sonnet high` vs `sonnet medium`) | — |
