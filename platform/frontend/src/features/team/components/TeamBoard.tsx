"use client";

/** Team workflow view (spec §19): everyone sees where work stands; actions still follow roles. */

import { useCallback, useEffect, useState } from "react";
import { get } from "@/lib/api";
import { Card, ErrorBanner, Field, Pill, Spinner, inputClass } from "@/components/ui/primitives";
import type { TeamRow } from "../types";

type KnowledgeOption = { id: number; name: string; modules: string[] };

export function TeamBoard() {
  const [knowledges, setKnowledges] = useState<KnowledgeOption[]>([]);
  const [knowledgeId, setKnowledgeId] = useState<number | null>(null);
  const [module, setModule] = useState("");
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    get<KnowledgeOption[]>("/knowledge")
      .then((rows) => {
        setKnowledges(rows);
        if (rows.length > 0) setKnowledgeId(rows[0].id);
      })
      .catch(setError);
  }, []);

  const load = useCallback(() => {
    if (knowledgeId === null) return;
    get<TeamRow[]>(`/team?knowledgeId=${knowledgeId}${module ? `&module=${encodeURIComponent(module)}` : ""}`)
      .then(setRows)
      .catch(setError);
  }, [knowledgeId, module]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  const modules = knowledges.find((k) => k.id === knowledgeId)?.modules ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Knowledge">
          <select
            className={inputClass}
            value={knowledgeId ?? ""}
            onChange={(e) => {
              setKnowledgeId(Number(e.target.value));
              setRows(null);
            }}
          >
            {knowledges.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Module (ถ้ามี)">
          <select className={inputClass} value={module} onChange={(e) => setModule(e.target.value)}>
            <option value="">ทุก module</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-stone-500">ไม่มีงานในขอบเขตนี้</p>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-stone-500">
                <th className="py-2 pr-3">Task</th>
                <th className="py-2 pr-3">Phase</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">สถานะ</th>
                <th className="py-2 pr-3">รอใคร</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.staRunId}-${row.taskId}`} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-2 pr-3 font-mono text-xs">{row.taskId}</td>
                  <td className="py-2 pr-3">{row.phase}</td>
                  <td className="py-2 pr-3">{row.role ?? "-"}</td>
                  <td className="py-2 pr-3">{row.status}</td>
                  <td className="py-2 pr-3">
                    {row.waitingOn ? <Pill tone="warn">รอ {row.waitingOn}</Pill> : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
