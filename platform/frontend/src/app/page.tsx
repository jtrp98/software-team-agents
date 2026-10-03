"use client";

/** My Work (spec §76/§114): gates that wait on MY roles, active runs, my knowledge. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { gatesApi } from "@/features/gates/api";
import { GateCardView } from "@/features/gates/components/GateInbox";
import { runsApi } from "@/features/runs/api";
import { useMe } from "@/features/auth/hooks/useMe";
import { Card, PageTitle, Pill, Spinner } from "@/components/ui/primitives";
import { STATUS_LABEL } from "@/features/runs/components/RunViews";
import type { GateCard } from "@/features/gates/types";
import type { RunRow } from "@/features/runs/types";

export default function MyWorkPage() {
  const { me } = useMe();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [gates, setGates] = useState<GateCard[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);

  useEffect(() => {
    gatesApi.counts().then(setCounts).catch(() => undefined);
    gatesApi.mine().then(setGates).catch(() => undefined);
    runsApi.list().then(setRuns).catch(() => undefined);
    const timer = setInterval(() => {
      gatesApi.mine().then(setGates).catch(() => undefined);
      runsApi.list().then(setRuns).catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  if (!me) return <Spinner />;
  const activeRuns = (runs ?? []).filter((r) => ["QUEUED", "RUNNING", "PAUSING", "STOPPING"].includes(r.status ?? ""));

  return (
    <div className="space-y-6">
      <PageTitle title={`สวัสดี ${me.name}`} subtitle="งานที่รอคำตัดสินใจของคุณ และงานที่ AI กำลังทำให้" />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-stone-500">Human Gates รอคำตอบ</p>
          <p className="text-2xl font-semibold">{counts ? Object.values(counts).reduce((a, b) => a + b, 0) : "…"}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(counts ?? {}).map(([role, n]) => (
              <Pill key={role} tone="info">
                {role} ×{n}
              </Pill>
            ))}
          </div>
        </Card>
        <Card>
          <p className="text-sm text-stone-500">Active AI runs</p>
          <p className="text-2xl font-semibold">{runs ? activeRuns.length : "…"}</p>
          <Link className="text-xs underline" href="/runs">ดูทั้งหมด</Link>
        </Card>
        <Card>
          <p className="text-sm text-stone-500">Knowledge ของคุณ</p>
          <p className="text-2xl font-semibold">{me.visibleKnowledgeNames.length}</p>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">Gates ที่ฉันตอบได้</h2>
        {!gates ? (
          <Spinner />
        ) : gates.filter((g) => g.canAnswer).length === 0 ? (
          <p className="text-sm text-stone-500">ไม่มี — งานเดินต่อโดยไม่ต้องรอคุณ</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {gates.filter((g) => g.canAnswer).slice(0, 6).map((gate) => (
              <GateCardView key={gate.id} gate={gate} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">งานที่กำลังเดิน</h2>
        {(runs ?? []).filter((r) => r.status === "WAITING_FOR_HUMAN").slice(0, 4).map((run) => (
          <Link key={run.staRunId} href={`/runs/${run.staRunId}`} className="block rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
            ⚑ {run.knowledgeName} / {run.module} — {STATUS_LABEL[run.status ?? ""] ?? run.status}
          </Link>
        ))}
        {(runs ?? []).filter((r) => r.status === "READY_FOR_REVIEW").slice(0, 4).map((run) => (
          <Link key={run.staRunId} href={`/runs/${run.staRunId}`} className="block rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950">
            ✓ {run.knowledgeName} / {run.module} — พร้อมให้ตรวจ
          </Link>
        ))}
      </section>
    </div>
  );
}
