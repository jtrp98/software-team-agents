"use client";

/** Admin · Users (spec §73): invite, status, and the assignment editor (spec §74). */

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "../api";
import type { KnowledgeLite, RoleCatalogItem, UserRow } from "../types";
import { Banner, Button, Card, ErrorBanner, Field, PageTitle, Pill, Spinner, fmtDateTime, inputClass } from "@/components/ui/primitives";

export function UsersAdmin() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteNote, setInviteNote] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi
      .users()
      .then(setUsers)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <PageTitle title="Users" subtitle="ใครอยู่ Knowledge ไหน · ถือ role อะไร · สถานะบัญชี" />
      <ErrorBanner error={error} />
      {inviteNote ? <Banner tone="ok">{inviteNote}</Banner> : null}

      <Card className="space-y-3">
        <h2 className="font-medium">เชิญผู้ใช้ใหม่</h2>
        <p className="text-sm text-stone-500">Phase 2 ยังไม่มีอีเมล — ผู้ดูแลส่งรหัสผ่านเริ่มต้นให้ผู้ใช้นอกระบบ แล้วให้ผู้ใช้เปลี่ยนเอง</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="อีเมล">
            <input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="ชื่อ">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="รหัสผ่านเริ่มต้น (8+ ตัวอักษร)">
            <input className={inputClass} type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={!email.trim() || !name.trim() || password.length < 8}
          onClick={() => {
            setError(null);
            adminApi
              .invite(email.trim(), name.trim(), password)
              .then(() => {
                setInviteNote(`เชิญ ${email.trim()} แล้ว — ส่งรหัสผ่านให้เขาเอง`);
                setEmail("");
                setName("");
                setPassword("");
                load();
              })
              .catch(setError);
          }}
        >
          เชิญผู้ใช้
        </Button>
      </Card>

      {!users ? (
        <Spinner />
      ) : (
        users.map((user) => <UserCard key={user.id} user={user} onChanged={load} onError={setError} />)
      )}
    </div>
  );
}

function UserCard({ user, onChanged, onError }: { user: UserRow; onChanged: () => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">
            {user.name} <span className="text-sm text-stone-400">{user.email}</span>{" "}
            {user.isOrgAdmin ? <Pill tone="info">org admin</Pill> : null}
            <Pill tone={user.status === "Active" ? "ok" : user.status === "Invited" ? "warn" : "bad"}>{user.status}</Pill>
          </h3>
          <p className="text-xs text-stone-500">
            เข้าสู่ระบบล่าสุด {fmtDateTime(user.lastLoginAt)} · assignments {user.assignments.length} รายการ
          </p>
        </div>
        <div className="flex gap-1">
          <Button onClick={() => setOpen(!open)}>{open ? "ปิดตัวแก้ assignments" : "แก้ assignments"}</Button>
          {user.status === "Active" ? (
            <Button variant="danger" onClick={() => adminApi.setStatus(user.id, "Disabled").then(onChanged).catch(onError)}>
              ปิดบัญชี
            </Button>
          ) : (
            <Button variant="primary" onClick={() => adminApi.setStatus(user.id, "Active").then(onChanged).catch(onError)}>
              เปิดบัญชี
            </Button>
          )}
        </div>
      </div>
      {open ? <AssignmentEditor userId={user.id} assignments={user.assignments} onSaved={onChanged} onError={onError} /> : null}
    </Card>
  );
}

/** Assignment editor (spec §74): Knowledge → Module (optional) → Roles, many-to-many, scoped. */
export function AssignmentEditor({
  userId,
  assignments,
  onSaved,
  onError,
}: {
  userId: number;
  assignments: UserRow["assignments"];
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [catalog, setCatalog] = useState<RoleCatalogItem[]>([]);
  const [knowledges, setKnowledges] = useState<KnowledgeLite[]>([]);
  const [scope, setScope] = useState<"org" | "knowledge">("knowledge");
  const [knowledgeId, setKnowledgeId] = useState<number | null>(null);
  const [module, setModule] = useState("");
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi.roleCatalog().then(setCatalog).catch(onError);
    adminApi
      .knowledges()
      .then((rows) => {
        setKnowledges(rows);
        if (rows.length > 0) setKnowledgeId(rows[0].id);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const modules = knowledges.find((k) => k.id === knowledgeId)?.modules ?? [];

  const save = () => {
    setBusy(true);
    const keep = assignments
      .filter((a) => a.knowledgeId !== knowledgeId || (a.module ?? "") !== module)
      .map((a) => ({ role: a.role, knowledgeId: a.knowledgeId, module: a.module }));
    const next = [...keep, ...[...roles].map((role) => ({ role, knowledgeId: scope === "org" ? null : knowledgeId, module: scope === "org" ? null : module || null }))];
    adminApi
      .setAssignments(userId, next)
      .then(() => {
        setRoles(new Set());
        onSaved();
      })
      .catch(onError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3 rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="ขอบเขต">
          <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as "org" | "knowledge")}>
            <option value="knowledge">Knowledge / Module</option>
            <option value="org">ทั้งองค์กร</option>
          </select>
        </Field>
        {scope === "knowledge" ? (
          <>
            <Field label="Knowledge">
              <select className={inputClass} value={knowledgeId ?? ""} onChange={(e) => setKnowledgeId(Number(e.target.value))}>
                {knowledges.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Module (ว่าง = ระดับ Knowledge)">
              <select className={inputClass} value={module} onChange={(e) => setModule(e.target.value)}>
                <option value="">ระดับ Knowledge</option>
                {modules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {catalog.map((item) => {
          const active = roles.has(item.role);
          const held = assignments.some((a) => a.role === item.role && a.knowledgeId === (scope === "org" ? null : knowledgeId) && (a.module ?? "") === module);
          return (
            <button
              key={item.role}
              type="button"
              onClick={() => {
                const next = new Set(roles);
                if (active) next.delete(item.role);
                else next.add(item.role);
                setRoles(next);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${active || held ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "border border-stone-300 text-stone-600 dark:border-stone-600 dark:text-stone-300"}`}
            >
              {item.displayName}
              {held && !active ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? "กำลังบันทึก…" : "บันทึกขอบเขตนี้"}
        </Button>
        <span className="text-xs text-stone-500">บันทึกเฉพาะขอบเขตที่เลือก — ขอบเขตอื่นไม่ถูกแตะ · ทุกการเปลี่ยนเข้า audit log</span>
      </div>
    </div>
  );
}
