"use client";

/** Admin · Audit (spec §70/§71): the authorization story of the whole org. */

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "../api";
import type { AuditRow, UsageRow } from "../types";
import { Card, ErrorBanner, PageTitle, Pill, Spinner, fmtDateTime } from "@/components/ui/primitives";

const ACTOR_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  User: "info",
  Ai: "warn",
  System: "muted",
};

export function AuditTable() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    adminApi.audit().then(setRows).catch(setError);
    adminApi.usage().then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  if (!rows) return <Spinner />;

  return (
    <div className="space-y-4">
      <PageTitle title="Audit" subtitle="ทุกการเปลี่ยนสิทธิ์ ทุกการตัดสินใจ ทุกเหตุการณ์ AI — ใคร ทำอะไร เมื่อไร ในบทบาทอะไร" />
      {usage && usage.length > 0 ? (
        <Card>
          <h2 className="mb-2 font-medium">การใช้ runtime (30 วันล่าสุด)</h2>
          <div className="flex flex-wrap gap-2">
            {usage.map((row) => (
              <Pill key={`${row.runtimeType}-${row.outcome}`} tone={row.outcome === "success" ? "ok" : "warn"}>
                {row.runtimeType}: {row.outcome ?? "recorded"} ×{row.count}
              </Pill>
            ))}
          </div>
        </Card>
      ) : null}
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-stone-500">
              <th className="py-2 pr-3">เมื่อ</th>
              <th className="py-2 pr-3">ใคร</th>
              <th className="py-2 pr-3">บทบาท</th>
              <th className="py-2 pr-3">เหตุการณ์</th>
              <th className="py-2 pr-3">ขอบเขต</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-2 pr-3 text-xs text-stone-500">{fmtDateTime(row.at)}</td>
                <td className="py-2 pr-3">
                  <Pill tone={ACTOR_TONE[row.actorType] ?? "muted"}>{row.actorType}</Pill> {row.actorName ?? "-"}
                </td>
                <td className="py-2 pr-3">{row.actingRole ?? "-"}</td>
                <td className="py-2 pr-3 font-mono text-xs">{row.action}</td>
                <td className="py-2 pr-3 text-xs text-stone-500">
                  {row.knowledge ?? "-"}
                  {row.module ? ` / ${row.module}` : ""} · {row.objectType ?? ""} {row.objectId ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
