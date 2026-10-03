"use client";

/** Knowledge admin: adopt a STA machine root into the org, manage members. */

import { useCallback, useEffect, useState } from "react";
import { knowledgeApi } from "../api";
import type { KnowledgeRow } from "../types";
import { Banner, Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui/primitives";

export function KnowledgeAdmin() {
  const [rows, setRows] = useState<KnowledgeRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    knowledgeApi
      .list()
      .then(setRows)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="font-medium">เพิ่ม Knowledge เข้าองค์กร</h2>
        <p className="text-sm text-stone-500">
          Knowledge เนื้อหาจริงอยู่ใน Git repo — ที่นี่เป็น metadata ของแพลตฟอร์ม และต้องมี root ชื่อเดียวกันบนเครื่อง STA Core ก่อน
        </p>
        <ErrorBanner error={error} />
        {notice ? <Banner tone="ok">{notice}</Banner> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="ชื่อ (ต้องตรงกับ STA root, a-z 0-9 -)">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="timetable" />
          </Field>
          <Field label="Git remote (ถ้ามี)">
            <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/acme/timetable-knowledge.git" />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={() => {
            setError(null);
            setNotice(null);
            knowledgeApi
              .add(name.trim(), url.trim() || undefined)
              .then(() => {
                setNotice(`เพิ่ม ${name.trim()} แล้ว`);
                setName("");
                setUrl("");
                load();
              })
              .catch(setError);
          }}
        >
          เพิ่ม
        </Button>
      </Card>

      {(rows ?? []).map((row) => (
        <KnowledgeCard key={row.id} row={row} onChanged={load} onError={setError} />
      ))}
    </div>
  );
}

function KnowledgeCard({ row, onChanged, onError }: { row: KnowledgeRow; onChanged: () => void; onError: (e: unknown) => void }) {
  const [users, setUsers] = useState<{ id: number; name: string; email: string }[]>([]);
  const [pick, setPick] = useState("");

  useEffect(() => {
    knowledgeApi
      .users()
      .then((all) => setUsers(all.map((u) => ({ id: u.id, name: u.name, email: u.email }))))
      .catch(() => undefined);
  }, [row.id]);

  const memberIds = new Set(row.members.map((m) => m.userId));

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{row.name}</h3>
          <p className="text-xs text-stone-500">
            {row.repositoryUrl ?? "ยังไม่ระบุ remote"} · สมาชิก {row.members.length} คน
          </p>
        </div>
        <Button
          variant="danger"
          onClick={() => {
            if (confirm(`ลบ Knowledge ${row.name} ออกจากแพลตฟอร์ม? (repo ไม่ถูกลบ)`)) {
              knowledgeApi.remove(row.id).then(onChanged).catch(onError);
            }
          }}
        >
          ลบ
        </Button>
      </div>
      <div className="space-y-1">
        {row.members.map((member) => (
          <div key={member.userId} className="flex items-center justify-between rounded-lg bg-stone-50 px-3 py-1.5 text-sm dark:bg-stone-800">
            <span>
              {member.name} <span className="text-stone-400">{member.email}</span>
            </span>
            <Button
              variant="ghost"
              onClick={() => knowledgeApi.removeMember(row.id, member.userId).then(onChanged).catch(onError)}
            >
              ถอดออก
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <select className={inputClass} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">— เพิ่มสมาชิก —</option>
          {users
            .filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name} ({u.email})
              </option>
            ))}
        </select>
        <Button
          disabled={!pick}
          onClick={() => knowledgeApi.addMember(row.id, Number(pick)).then(() => { setPick(""); onChanged(); }).catch(onError)}
        >
          เพิ่มสมาชิก
        </Button>
      </div>
    </Card>
  );
}
