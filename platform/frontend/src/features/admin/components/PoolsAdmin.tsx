"use client";

/** Admin · Runtime pool (spec §44/§45/§77): who owns what capacity, health, sharing. */

import { useCallback, useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import type { ConnectionRow } from "@/features/connections/types";
import { Button, Card, ErrorBanner, Field, PageTitle, Pill, Spinner, inputClass } from "@/components/ui/primitives";

export function PoolsAdmin() {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runtimeType, setRuntimeType] = useState("codex");
  const [ownerType, setOwnerType] = useState<"knowledge" | "organization">("knowledge");
  const [knowledgeId, setKnowledgeId] = useState("");
  const [knowledges, setKnowledges] = useState<{ id: number; name: string }[]>([]);

  const load = useCallback(() => {
    get<ConnectionRow[]>("/pools")
      .then(setRows)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
    get<{ id: number; name: string }[]>("/knowledge")
      .then((rows) => {
        setKnowledges(rows.filter((r) => r.id > 0));
        if (rows.length > 0) setKnowledgeId(String(rows[0].id));
      })
      .catch(() => undefined);
  }, [load]);

  const add = () => {
    const ownerId = ownerType === "organization" ? 1 : Number(knowledgeId);
    post<ConnectionRow>("/pools/connections", { runtimeType, ownerType, ownerId, sharingScope: ownerType === "organization" ? "organization" : "knowledge_members" })
      .then(load)
      .catch(setError);
  };

  const toggle = (row: ConnectionRow) =>
    post<ConnectionRow>(`/pools/connections/${row.id}`, { status: row.status === "Enabled" ? "disabled" : "enabled" })
      .then(load)
      .catch(setError);

  return (
    <div className="space-y-4">
      <PageTitle title="Shared AI Capacity" subtitle="pool ของ Knowledge และองค์กร — ความจุ AI ที่ทีมใช้ร่วมกันตาม policy" />
      <ErrorBanner error={error} />

      <Card className="space-y-3">
        <h2 className="font-medium">เพิ่ม connection ใน pool</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Runtime">
            <select className={inputClass} value={runtimeType} onChange={(e) => setRuntimeType(e.target.value)}>
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="antigravity">AGY</option>
              <option value="zcode">ZCode</option>
            </select>
          </Field>
          <Field label="สังกัด">
            <select className={inputClass} value={ownerType} onChange={(e) => setOwnerType(e.target.value as "knowledge" | "organization")}>
              <option value="knowledge">Knowledge (แชร์ในสมาชิก)</option>
              <option value="organization">องค์กร (fallback ร่วม)</option>
            </select>
          </Field>
          {ownerType === "knowledge" ? (
            <Field label="Knowledge">
              <select className={inputClass} value={knowledgeId} onChange={(e) => setKnowledgeId(e.target.value)}>
                {knowledges.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        <Button variant="primary" disabled={ownerType === "knowledge" && !knowledgeId} onClick={add}>
          เพิ่ม
        </Button>
      </Card>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-stone-500">ยังไม่มี connection ใน pool</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => (
            <Card key={row.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">
                  {row.runtimeType} · {row.ownerLabel}
                </h3>
                <div className="flex gap-1">
                  <Pill tone={row.ownerType === "Organization" ? "info" : "ok"}>{row.ownerType}</Pill>
                  <Pill tone={row.status === "Enabled" ? "ok" : "muted"}>{row.status}</Pill>
                </div>
              </div>
              <p className="text-xs text-stone-500">
                การแชร์: {row.sharingScope} · สถานะบนเครื่อง: {row.staState ?? "ไม่ทราบ"} · เครื่อง: {row.machineName ?? "-"}
              </p>
              <Button onClick={() => toggle(row)}>{row.status === "Enabled" ? "ปิดใช้งาน" : "เปิดใช้งาน"}</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
