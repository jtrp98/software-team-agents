"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { gatesApi } from "../api";
import type { GateCard } from "../types";
import { Card, Pill } from "@/components/ui/primitives";

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  Open: "warn",
  Assigned: "info",
  Waiting: "warn",
  Answered: "ok",
  Cancelled: "muted",
  Superseded: "muted",
};

/** One gate card (spec §18): knowledge, module, role, question, AI analysis, options, age. */
export function GateCardView({ gate, onOpen }: { gate: GateCard; onOpen?: () => void }) {
  const age = Math.max(0, Math.floor((Date.now() - new Date(gate.createdAt).getTime()) / 60_000));
  const ageLabel = age < 60 ? `${age} นาที` : age < 1440 ? `${Math.floor(age / 60)} ชั่วโมง` : `${Math.floor(age / 1440)} วัน`;
  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/gates/${gate.id}`} className="font-medium text-stone-900 hover:underline dark:text-stone-100" onClick={onOpen}>
          {gate.displayId} · {gate.gateType}
        </Link>
        <div className="flex shrink-0 gap-1">
          {gate.requiredRole ? <Pill tone="info">{gate.requiredRole}</Pill> : null}
          <Pill tone={STATUS_TONE[gate.status] ?? "muted"}>{gate.status}</Pill>
        </div>
      </div>
      <p className="text-sm text-stone-700 dark:text-stone-300">{gate.question}</p>
      {gate.aiAnalysis ? <p className="text-xs text-stone-500">AI: {gate.aiAnalysis}</p> : null}
      <div className="flex flex-wrap gap-2 text-xs text-stone-500">
        <span>
          {gate.knowledgeName}
          {gate.module ? ` / ${gate.module}` : ""}
        </span>
        <span>· รอมา {ageLabel}</span>
        {gate.assigneeName ? <span>· มอบหมาย: {gate.assigneeName}</span> : null}
        {gate.staRunId ? <span>· run {gate.staRunId}</span> : null}
      </div>
    </Card>
  );
}

/** My Gates inbox (spec §18): grouped by the role that must answer. */
export function GateInbox() {
  const [gates, setGates] = useState<GateCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<"mine" | "all">("mine");

  const load = useCallback(() => {
    gatesApi
      .mine()
      .then(setGates)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <div className="text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</div>;
  if (!gates) return <div className="text-sm text-stone-500">กำลังโหลด…</div>;

  const visible = filter === "mine" ? gates.filter((g) => g.canAnswer) : gates;
  const byRole = new Map<string, GateCard[]>();
  for (const gate of visible) {
    const key = gate.requiredRole ?? "ไม่ผูก role";
    byRole.set(key, [...(byRole.get(key) ?? []), gate]);
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          className={`rounded-full px-3 py-1 text-sm ${filter === "mine" ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "border border-stone-300 dark:border-stone-700"}`}
          onClick={() => setFilter("mine")}
        >
          ที่ฉันตอบได้ ({gates.filter((g) => g.canAnswer).length})
        </button>
        <button
          className={`rounded-full px-3 py-1 text-sm ${filter === "all" ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "border border-stone-300 dark:border-stone-700"}`}
          onClick={() => setFilter("all")}
        >
          ทั้งหมดที่เห็น ({gates.length})
        </button>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500 dark:border-stone-700">
          ไม่มี gate ที่รอคำตอบ — งานเดินต่อเองเมื่อ AI ไม่ต้องการคำตัดสินใจ
        </div>
      ) : (
        [...byRole.entries()].map(([role, roleGates]) => (
          <section key={role} className="space-y-2">
            <h2 className="text-sm font-semibold text-stone-600 dark:text-stone-300">
              {role} · {roleGates.length} รอคำตอบ
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {roleGates.map((gate) => (
                <GateCardView key={gate.id} gate={gate} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
