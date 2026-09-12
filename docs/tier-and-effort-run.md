# คู่มือสั่ง tier และ effort

เอกสารนี้เป็น canonical home ของ "จะสั่ง tier/effort ยังไงใน terminal" ความหมายดั้งเดิมของแต่ละ tier
บันทึกไว้ที่ [ADR-022](../decisions/ADR-022-per-phase-model-tier.md); policy ปัจจุบัน — role default และ
binding ของ tier → model/effort ต่อ camp — อยู่ที่ [`model-tiers.yaml`](../model-tiers.yaml) ซึ่งเป็นไฟล์ที่
คนเป็นเจ้าของ คู่มือนี้ไม่เขียน provider/model catalog ซ้ำ

**เส้นแบ่งที่ต้องเข้าใจก่อน:** tier ทำงานเฉพาะเส้นทาง orchestrated (`sta run`) เท่านั้น
เซสชัน interactive (`software-team-agents dev`) ไม่มี orchestrator จึงไม่มี tier — ที่นั่นตั้ง effort
ด้วยคำสั่งในเซสชันเอง (§4)

## 1. Cast Tier ใน canonical PlanTask — ฝั่ง BA/Knowledge workspace

ทุก canonical PlanTask มี `Tier` แบบ optional (`T2`–`T6`) ได้ ไม่ว่า owner จะเป็น analysis, implementation,
QA, security หรือ devops. ใส่เฉพาะ task ที่ต้อง override role default; task ที่ไม่ใส่ Tier ใช้ role default
จาก `model-tiers.yaml` หรือ intentional `runtime-default` ของ role นั้น:

```yaml
id: BE-12
owner: backend-engineer
tier: T4
```

กฎที่ validator บังคับ: `T1` ถูกปฏิเสธเพราะสงวนไว้สำหรับการเลือก model/effort โดยคนโดยตรง และค่าอื่น
นอก `T2`–`T6` ถูกปฏิเสธ. PlanTask ไม่ถือ runtime, provider model หรือ fallback เพราะ camp เลือกตอนรัน
ไม่ใช่ตอนวางแผน. ตาราง plan แบบเก่าอ่านได้ผ่าน compatibility adapter แต่ไม่ใช่ schema authority ใหม่

## 2. ตรวจ plan ก่อนส่งต่อ

```powershell
sta --check-plan --module <module>
```

## 3. รันด้วย tier — ฝั่ง DEV/Target workspace

`--runtime` คือการเลือก camp; Tier จะ resolve เป็น model/effort ของ camp นั้นจาก `model-tiers.yaml`:

```powershell
sta run --task-id <id> --module <module> --backend --autonomy edit --runtime claude-code
```

ลำดับการเลือก camp: `--runtime` → `execution.runner` ใน
`.sta/config.yaml` → ถ้ามี `routing.by_role` ปล่อยให้ resolve ต่อ stage → ถ้ามี TTY จะถามที่ terminal
(`choose camp/runtime [...]`) → ไม่มี TTY ใช้ default

runtime/camp ที่ชนะแล้วจึงนำไป resolve model/effort ด้วย precedence เดียว:

1. operator override (`--model` / `--effort` หรือ `routing.by_role.<role>.model|effort`)
2. Tier ของ task
3. role default Tier จาก `model-tiers.yaml`
4. intentional runtime default

precedence ใช้แยกต่อ field. ถ้า override แค่ effort, model จาก Tier ยังใช้ได้; ถ้า override model โดยไม่ระบุ
effort ระบบปล่อย effort เป็น runtime default แทนการนำ effort ของ Tier ไปผูกกับ model คนละตัว. Frontmatter
`model:`/`effort:` ใน `.claude/agents` เป็น generated compatibility output ไม่ใช่ policy authority และ
`--check-bindings` ปฏิเสธ drift

role policy ปัจจุบันคือ BA=T3, SA=T2, PM=T2, test-planner=T3, QA=T3, security=T2,
setup=T6 และ implementation/UX/devops=T5. Backend/frontend จึงใช้ T5 ตามปกติ; task ที่ยากหรือเสี่ยง
ควรระบุ Tier ที่สูงกว่าบน PlanTask และ operator ยัง override model/effort ได้สำหรับ bounded run นั้น

ตรวจว่า tier ลงจริงหรือไม่:

```powershell
sta status <task-id>
```

อ่านบรรทัด `runner=… → … model=… → … effort=… basis=…`. `basis` ระบุทั้ง effective Tier และผู้ชนะ
ของ model/effort; manifest เก็บ requested values เดิมด้วย. route ที่ freeze/persist แล้วใช้ค่าที่บันทึกไว้เมื่อ
resume จึงไม่เปลี่ยนตาม policy ใหม่เงียบ ๆ

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
