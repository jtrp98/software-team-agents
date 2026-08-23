# Task: Rewrite README.md ให้ตรงกับ Code ปัจจุบัน

ตรวจสอบ repository ปัจจุบันทั้งหมด แล้วปรับปรุง `README.md` ให้สะท้อน **architecture, behavior, commands และ workflow ที่มีอยู่จริงใน code ณ ปัจจุบัน**

สามารถ **เขียน `README.md` ใหม่ทั้งหมดได้** โดยไม่ต้องรักษาโครงสร้าง เนื้อหา หรือข้อความจาก README เดิม

## Source of Truth

ให้ถือว่า **code ปัจจุบันคือ Source of Truth**

ลำดับความน่าเชื่อถือ:

1. Source code / CLI implementation
2. `package.json` และ package configuration
3. Scripts / commands / entrypoints
4. Configuration และ runtime behavior
5. Tests
6. Documentation / planning files ที่ยังตรงกับ implementation
7. README เดิม

หาก README หรือ documentation เดิมขัดแย้งกับ code:

> ให้เชื่อ code และแก้ README ให้ตรงกับ code

ห้ามรักษาข้อมูลเก่าเพียงเพราะมีอยู่ใน README เดิม

---

## Instructions

### 1. Inspect repository ก่อนเขียน

ตรวจสอบอย่างน้อย:

* project structure
* `package.json`
* CLI entrypoints
* commands
* scripts
* configuration
* framework structure
* knowledge structure
* target/project integration
* role definitions
* setup/install flow
* sync/update behavior
* version handling
* Claude integration
* Codex integration
* generated files
* tests
* examples
* relevant documentation

อย่าเดา behavior จากชื่อไฟล์อย่างเดียว

ให้ trace implementation จริงว่าคำสั่งและ workflow ทำงานอย่างไร

---

### 2. Rewrite README จาก implementation ปัจจุบัน

README ใหม่ต้องอธิบายระบบ **ตามสิ่งที่ใช้งานได้จริง**

ควรครอบคลุมหัวข้อที่เกี่ยวข้อง เช่น:

* Project Overview
* แนวคิดและเป้าหมาย
* Architecture
* Framework / Knowledge / Target
* ความสัมพันธ์ระหว่าง repositories
* Installation
* การติดตั้งแบบ local / package / global ถ้ามีจริง
* Setup
* CLI Usage
* Commands
* Roles
* BA / SA / Dev / QA และ role อื่นที่มีจริง
* Target binding
* Target setup
* Framework sync
* Knowledge sync
* Version management
* Claude usage
* Codex usage
* Workflow ตัวอย่าง
* Repository structure
* Configuration
* Update / Upgrade
* Troubleshooting
* Development

แต่ **ไม่จำเป็นต้องสร้างหัวข้อที่ implementation ไม่มีหรือไม่เกี่ยวข้อง**

เลือกโครงสร้าง README ที่เหมาะกับระบบปัจจุบันเอง

---

### 3. ภาษา

README ต้องเป็น **ภาษาไทย**

สามารถใช้ technical terms ภาษาอังกฤษได้เมื่อเหมาะสม เช่น:

`Framework`, `Knowledge`, `Target`, `CLI`, `Role`, `Sync`, `Binding`, `Package`, `Version`

ชื่อ:

* command
* path
* filename
* package
* config key
* environment variable
* code identifier

ให้ใช้ชื่อจริงจาก code และห้ามแปลจนใช้งานไม่ได้

---

### 4. Commands ต้องตรวจสอบจาก code

ทุก command ที่ใส่ใน README ต้องมีอยู่จริง

ตัวอย่างเช่น หาก README มี:

```bash
npm install -g ...
```

ต้องตรวจสอบก่อนว่า package รองรับ installation แบบนั้นจริง

เช่นเดียวกับ:

```bash
<cli> init
<cli> setup
<cli> sync
<cli> update
```

ห้ามสร้าง command จาก assumption

ถ้า implementation ปัจจุบันไม่ได้รองรับ ให้ไม่ต้องใส่

---

### 5. Architecture ต้องตรงกับของจริง

อธิบายให้ชัดเจนว่าแต่ละส่วนทำหน้าที่อะไร เช่น:

```text
Framework
Knowledge
Target
```

และตรวจสอบจาก implementation จริงว่า:

* อะไรถูก install
* อะไรถูก clone
* อะไรถูก reference
* อะไรถูก copy
* อะไรถูก sync
* อะไรอยู่ global
* อะไรอยู่ใน target repo
* อะไรถูก generate
* ใครเป็น owner ของแต่ละไฟล์
* update แล้วอะไรเปลี่ยน / ไม่เปลี่ยน

ห้ามอธิบาย architecture จาก planning document หาก code ปัจจุบันทำงานต่างออกไป

---

### 6. Version

ตรวจสอบ implementation ของ version management จริง

README ต้องอธิบายเฉพาะสิ่งที่ code รองรับ เช่น:

* Framework version
* Knowledge version
* Target binding version
* package version
* compatibility
* upgrade behavior

ถ้ายังไม่มี mechanism บางอย่างจริง:

ให้ระบุว่า **ยังไม่รองรับ** หรือไม่ต้องกล่าวถึง

ห้ามเขียน future design ให้เหมือนเป็น feature ที่มีแล้ว

---

### 7. Claude / Codex

ตรวจสอบ integration จริงของ:

```text
.claude/
.codex/
CLAUDE.md
AGENTS.md
```

รวมถึงไฟล์หรือ directory อื่นที่เกี่ยวข้อง

README ต้องอธิบายเฉพาะ workflow ที่ repository ปัจจุบันรองรับจริง

ถ้า documentation เก่ายังอ้างถึง path เช่น:

```text
.Codex/
_docs/
```

แต่ implementation ปัจจุบันไม่ได้ใช้แล้ว:

**ให้ลบข้อมูลนั้นออก**

---

### 8. Examples

เพิ่มตัวอย่าง workflow ที่ copy/paste แล้วใช้งานได้จริง

เช่น flow:

```text
Install
↓
Setup
↓
Bind Target
↓
Run Agent
↓
Sync / Update
```

แต่ต้องสร้าง flow จาก implementation จริง

อย่าสร้าง workflow ตาม conceptual architecture ถ้า CLI ยังไม่รองรับ

---

## Cleanup Rules

ลบ documentation ที่:

* deprecated
* duplicate
* misleading
* ไม่ตรงกับ code
* เป็น design เก่าที่ไม่ได้ใช้แล้ว
* กล่าวถึง command ที่ไม่มีจริง
* กล่าวถึง path ที่ไม่มีจริง
* กล่าวถึง architecture ที่ implementation เปลี่ยนไปแล้ว
* กล่าวถึง feature ที่ยังไม่ได้ implement

ไม่ต้องเก็บข้อความเก่าเพื่อ backward compatibility ของ documentation

---

## README Style

README ควร:

* อ่านง่าย
* กระชับ
* technical
* ใช้งานจริงได้
* มีตัวอย่าง command ที่ copy/paste ได้
* อธิบาย architecture ให้เข้าใจได้เร็ว
* แยก clearly ระหว่าง Framework / Knowledge / Target
* ไม่เขียน marketing เกินความจริง
* ไม่อธิบาย implementation detail ที่ผู้ใช้ไม่จำเป็นต้องรู้

Comments หรือคำอธิบายควรเน้น **why** มากกว่าอธิบายสิ่งที่ code หรือ command แสดงอยู่แล้ว

---

## Validation

หลังเขียน README เสร็จ ให้ตรวจสอบ README กับ repository อีกรอบ

ตรวจสอบว่า:

* ทุก command มีจริง
* ทุก path มีจริง
* ทุก filename มีจริง
* ทุก config key มีจริง
* installation instructions ใช้งานได้จริง
* workflow ตรงกับ implementation
* Framework / Knowledge / Target relationship ถูกต้อง
* Claude / Codex instructions ถูกต้อง
* version behavior ถูกต้อง
* ไม่มี deprecated architecture หลงเหลือ
* ไม่มี future feature ถูกเขียนเหมือน implement แล้ว

ถ้าทำได้ ให้ทดลอง commands ที่ไม่ destructive เพื่อ validate README

---

## Final Requirement

เป้าหมายไม่ใช่การ "แก้ README เดิม"

เป้าหมายคือ:

> **สร้าง README.md ที่เป็น documentation ของระบบปัจจุบันจาก code จริง**

หาก README เดิมไม่เหมาะสม สามารถ:

**ลบเนื้อหาเดิมทั้งหมดแล้วสร้างใหม่ตั้งแต่ต้นได้**

เมื่อเสร็จแล้ว ให้รายงานสั้น ๆ:

1. README เปลี่ยนโครงสร้างอะไรบ้าง
2. ข้อมูลเก่าอะไรที่ถูกลบเพราะไม่ตรงกับ code
3. architecture ที่ตรวจพบจาก code จริง
4. commands/workflows หลักที่ README อธิบาย
5. จุดที่ code ยังไม่รองรับหรือยังไม่สมบูรณ์ (ถ้ามี)

จากนั้นแก้ไข `README.md` จริงใน repository ไม่ใช่เพียงเสนอเนื้อหา README ในคำตอบ
