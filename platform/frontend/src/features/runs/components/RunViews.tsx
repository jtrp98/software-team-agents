"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { runsApi } from "../api";
import type { KnowledgeInfo, RunRow } from "../types";
import { Banner, Button, Card, ErrorBanner, Field, PageTitle, Pill, Spinner, fmtDateTime, inputClass } from "@/components/ui/primitives";

export const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  RUNNING: "info",
  QUEUED: "info",
  WAITING_FOR_HUMAN: "warn",
  PAUSED: "warn",
  PAUSED_RUNTIME_EXHAUSTED: "warn",
  READY_FOR_REVIEW: "ok",
  APPROVED: "ok",
  FAILED: "bad",
  STOPPED: "muted",
};

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: "รอเริ่ม",
  RUNNING: "กำลังทำงาน",
  PAUSING: "กำลังพัก",
  PAUSED: "พักไว้",
  STOPPING: "กำลังหยุด",
  STOPPED: "หยุดแล้ว",
  WAITING_FOR_HUMAN: "รอคนตัดสินใจ",
  PAUSED_RUNTIME_EXHAUSTED: "Runtime ไม่ว่าง",
  READY_FOR_REVIEW: "พร้อมตรวจสอบ",
  APPROVED: "อนุมัติแล้ว",
  FAILED: "ล้มเหลว",
};

/** Start Work (spec §112): เลือก Knowledge → Module → พิมพ์คำสั่งภาษาคน */
export function StartRunForm({ knowledgeOptions }: { knowledgeOptions: KnowledgeInfo[] }) {
  const [knowledge, setKnowledge] = useState(knowledgeOptions[0]?.name ?? "");
  const [module, setModule] = useState("");
  const [text, setText] = useState(
    "ทำงานที่พร้อมให้หมดจน QA ผ่าน\nแล้วหยุดให้ฉันตรวจ\nห้าม push\nห้าม merge\nห้าม deploy",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<RunRow | null>(null);

  const modules = useMemo(() => knowledgeOptions.find((k) => k.name === knowledge)?.modules ?? [], [knowledge, knowledgeOptions]);

  return (
    <Card className="space-y-3">
      <h2 className="font-medium">สั่งงานใหม่</h2>
      <ErrorBanner error={error} />
      {started ? (
        <Banner tone="ok">
          เริ่ม run <Link className="underline" href={`/runs/${started.staRunId}`}>{started.staRunId}</Link> แล้ว — ปิดหน้านี้ได้ งานเดินต่อใน background
        </Banner>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Knowledge">
          <select className={inputClass} value={knowledge} onChange={(e) => setKnowledge(e.target.value)}>
            {knowledgeOptions.map((k) => (
              <option key={k.name} value={k.name}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Module">
          <select className={inputClass} value={module} onChange={(e) => setModule(e.target.value)}>
            <option value="">— เลือก module —</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="คำสั่ง (ภาษาคน)" hint="push · merge · deploy เป็นของคนเท่านั้น — STA ไม่ทำเอง">
        <textarea className={inputClass} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button
        variant="primary"
        disabled={busy || !knowledge || !module}
        onClick={() => {
          setBusy(true);
          setError(null);
          setStarted(null);
          runsApi
            .start(knowledge, module, text)
            .then(setStarted)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "กำลังเริ่ม…" : "เริ่มงาน"}
      </Button>
    </Card>
  );
}

/** The run list of the knowledges this user can see — live status from STA via the backend. */
export function RunTable() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    runsApi
      .list()
      .then(setRuns)
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  if (!runs) return <Spinner />;

  return (
    <Card>
      <h2 className="mb-3 font-medium">Work runs</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-stone-500">ยังไม่มี run</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-stone-500">
                <th className="py-2 pr-3">Run</th>
                <th className="py-2 pr-3">Knowledge / Module</th>
                <th className="py-2 pr-3">สถานะ</th>
                <th className="py-2 pr-3">Gates</th>
                <th className="py-2 pr-3">โดย</th>
                <th className="py-2 pr-3">อัปเดต</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.staRunId} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-2 pr-3 font-mono text-xs">
                    <Link className="hover:underline" href={`/runs/${run.staRunId}`}>
                      {run.staRunId}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    {run.knowledgeName} / {run.module}
                  </td>
                  <td className="py-2 pr-3">
                    <Pill tone={STATUS_TONE[run.status ?? ""] ?? "muted"}>{STATUS_LABEL[run.status ?? ""] ?? run.status ?? "-"}</Pill>
                  </td>
                  <td className="py-2 pr-3">{run.openGates > 0 ? <Pill tone="warn">{run.openGates} รอคำตอบ</Pill> : "-"}</td>
                  <td className="py-2 pr-3">{run.createdByName ?? "-"}</td>
                  <td className="py-2 pr-3 text-xs text-stone-500">{fmtDateTime(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
