# STA Platform — Phase 2 (Multi-user)

Phase 2 ของ software-team-agents: เปลี่ยนจาก single-user orchestrator เป็น **แพลตฟอร์มทีมซอฟต์แวร์** —
multi-user, role-aware, human-gate-aware, AI-capacity-aware

```
Next.js (platform/frontend)          ← component-based + feature/domain + colocation
   ↕ same-origin /api (rewrites)
.NET Backend — Clean Architecture    ← platform layer: identity, org, roles, gates, pools, audit
   ↕ EF Core → Supabase Postgres    ← database (connection string จาก env)
   ↕ STA Core Local API (127.0.0.1) ← STA เดิม (TypeScript) ไม่ถูกแก้ — เป็น workflow owner
      ↕ bounded-run → claude-code / codex / agy / zcode
```

## สิ่งที่แต่ละชั้นเป็นเจ้าของ (one concept, one source of truth)

| เรื่อง | เจ้าของ |
|---|---|
| Identity / session / role assignment / membership | .NET platform (Postgres) |
| Role-Owned Human Gates (routing + inbox + audit) | .NET platform |
| RuntimeConnection registry + pool policy + usage | .NET platform |
| Workflow engine, Knowledge pinning, runtime routing/failover | STA Core (TypeScript, ไม่แก้) |
| Knowledge เนื้อหาจริง | Git repo ของ Knowledge |
| เป้าหมาย source code | Target repos ของ STA |
| การ push / merge / deploy | คนเท่านั้น (ทั้งสองชั้นห้ามทำแทน) |

## โครงสร้าง

```
platform/
  backend/
    src/
      StaPlatform.Domain/          ← entities + enums + ค่าคงที่ (int4 PK ทุกตาราง)
      StaPlatform.Application/     ← use cases (auth, users, assignments, gates, runs, pools, audit, STA sync)
      StaPlatform.Infrastructure/  ← EF Core (Npgsql/Supabase), JWT, PBKDF2, STA Core client, migrations
      StaPlatform.Api/             ← endpoints ต่อ feature, JWT cookie auth, background sync worker
    tests/StaPlatform.Tests/       ← unit + end-to-end authorization suite (19 tests)
  frontend/                        ← Next.js (App Router): features/auth, gates, runs, team, connections, knowledge, admin
  .env.example                     ← ทุกตัวแปรที่ต้องใส่
```

## การติดตั้ง / รัน

```bash
# 1. Database — สร้างโปรเจกต์ Supabase แล้วใส่ connection string ใน env
cd platform && cp .env.example .env   # แล้วแก้ค่า

# 2. Backend
cd backend
dotnet ef database update --project src/StaPlatform.Infrastructure   # สร้างตารางบน Supabase
dotnet run --project src/StaPlatform.Api                             # http://localhost:5000
#   ครั้งแรก: สร้าง default organization + admin (admin@sta.local) จาก STA_ADMIN_PASSWORD
#   (ถ้าไม่ตั้ง env ระบบจะสุ่มรหัสผ่านแล้วเขียนไฟล์ bootstrap-admin-credentials.txt ให้ครั้งเดียว)

# 3. Frontend
cd ../frontend
npm install
npm run dev    # http://localhost:3000 (proxy /api → backend)

# 4. STA Core (เครื่องที่จะให้ AI ลงมือ) — เหมือน Phase 1 เดิมทุกอย่าง
sta start
```

## ทดสอบ

```bash
cd platform/backend && dotnet test      # 19 tests: auth, roles, gates, pools, isolation, audit
cd platform/frontend && npm run build   # typecheck + build
```

## Flow หลัก (end-to-end)

1. **Admin** login → สร้าง Knowledge (ชื่อเดียวกับ STA root บนเครื่อง) → เชิญ user →
   assign `User → Knowledge → Module → Roles` (หน้า Users → แก้ assignments)
2. **User** login → หน้า Runs → เลือก Knowledge/Module → พิมพ์คำสั่ง → backend สั่ง STA Core ผ่าน Local API
3. งานเดิน (engineer → review → QA) บนเครื่อง STA เดิม; sync worker ของ backend ดึงสถานะทุก 15 วินาที
4. เมื่องานหยุดรอคน (`WAITING_FOR_HUMAN` / `READY_FOR_REVIEW`) → platform สร้าง **Role-Owned Gate**
   (route ตาม `gate_policies`: REVIEW→reviewer ฯลฯ) ตกถึงกล่องขาเข้าของคนที่ถือ role นั้น
5. คนที่**ไม่ใช่** role นั้นเห็นได้แต่ backend ปฏิเสธการตอบ (403) · ตอบพร้อมกัน 2 คน → คนแรกชนะ อีกคนได้ 409
   · คำตอบบันทึก `acting_role` + audit แล้ว platform สั่ง STA approve/resume ให้เอง — งานเดินต่อโดยไม่ต้องกดปุ่มซ้ำ
6. **ตรวจงาน**: หน้า Run detail กด **ดู Diff** (สี + / -) และ **เตรียม Commit** (คำสั่ง git ให้คนรันเอง — ทั้ง STA และ platform ไม่ push/merge แทน) — ทั้งสองอย่าง proxy ผ่าน backend โดยตรวจ membership ของ Knowledge ก่อนทุกครั้ง
7. Runtime capacity: user เพิ่ม **My AI Connections** (private โดยดีฟอลต์) · admin เพิ่ม pool ของ
   Knowledge/องค์กร — `GET /api/pools/resolve` คืนลำดับความจุตาม policy (PRIVATE_ONLY … SHARED_ONLY)

## ข้อจำกัดที่รู้ตัว (ออกแบบให้ต่อยอดได้ ไม่ overbuild)

- Per-run pool enforcement ฝั่ง STA ยังใช้ machine-level routing ของ STA เอง — platform คืน "ลำดับที่แนะนำ"
  ผ่าน `pools/resolve`; จะบังคับราย run ต้องมี hook เล็ก ๆ ฝั่ง STA (ยังไม่ทำ เพื่อไม่แก้ STA)
- Gate ที่สร้างอัตโนมัติจากงานคือ run-level gates ของ STA (review/operational) — engine-level approval
  (REQUIREMENT_INTERVIEW ฯลฯ) ยังตอบผ่าน `sta approve` ของ STA; platform สร้าง gate เองได้ผ่าน `POST /api/gates`
- อีเมลเชิญยังไม่มี — ผู้ดูแลส่งรหัสผ่านเริ่มต้นให้เอง (มี status Invited รองรับ flow อีเมลในอนาคต)
