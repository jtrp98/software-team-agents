"use client";

/** My AI Connections (spec §43): private by default, credentials never touch this page. */

import { useCallback, useEffect, useState } from "react";
import { connectionsApi } from "../api";
import type { ConnectionRow } from "../types";
import { Button, Card, ErrorBanner, Pill, Spinner } from "@/components/ui/primitives";

const RUNTIMES = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "AGY (Antigravity)" },
  { id: "zcode", label: "ZCode" },
];

export function MyConnections() {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    connectionsApi
      .mine()
      .then(setRows)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  if (!rows) return <Spinner />;

  const owned = new Set(rows.map((r) => r.runtimeType));

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <h2 className="font-medium">เพิ่ม connection ส่วนตัว</h2>
        <p className="text-sm text-stone-500">connection ส่วนตัวเป็น private โดยดีฟอลต์ — ไม่มีใครใช้ของคุณโดยปริยาย (runtime ยืนยันตัวตนด้วย login ของคุณบนเครื่อง)</p>
        <div className="flex flex-wrap gap-2">
          {RUNTIMES.filter((rt) => !owned.has(rt.id)).map((rt) => (
            <Button key={rt.id} onClick={() => connectionsApi.add(rt.id).then(load).catch(setError)}>
              + {rt.label}
            </Button>
          ))}
        </div>
      </Card>

      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">ยังไม่มี connection — งานของคุณจะใช้ pool ของ Knowledge/องค์กรตาม policy</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => (
            <Card key={row.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{RUNTIMES.find((rt) => rt.id === row.runtimeType)?.label ?? row.runtimeType}</h3>
                <Pill tone={row.status === "Enabled" ? "ok" : "muted"}>{row.status}</Pill>
              </div>
              <dl className="space-y-1 text-xs text-stone-500">
                <div>สถานะบนเครื่อง: {row.staState ?? "ไม่ทราบ"}</div>
                <div>การยืนยันตัวตน: {row.staAuthentication ?? "-"}</div>
                <div>การแชร์: {row.sharingScope}</div>
              </dl>
              <Button
                variant={row.status === "Enabled" ? "ghost" : "primary"}
                onClick={() => connectionsApi.setStatus(row.id, row.status === "Enabled" ? "disabled" : "enabled").then(load).catch(setError)}
              >
                {row.status === "Enabled" ? "ปิดใช้งาน" : "เปิดใช้งาน"}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
