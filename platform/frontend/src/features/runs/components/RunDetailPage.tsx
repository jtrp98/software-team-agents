"use client";

/** Live passthrough of a STA Core run detail — execution truth stays in STA; this is a faithful window. */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { get, post } from "@/lib/api";
import { Banner, Button, Card, ErrorBanner, PageTitle, Pill, Spinner, fmtDateTime } from "@/components/ui/primitives";
import { STATUS_LABEL, STATUS_TONE } from "./RunViews";
import type { StaPrepareCommit, StaRunDiff } from "../types";

type StaRunDetail = {
  run: {
    runId: string;
    knowledge: { name: string; path: string };
    module: string;
    status: string;
    statusReason: string | null;
    humanGates: { id: string; kind: string; reason: string; resolvedAt: number | null }[];
    workers: { engineer: string | null; reviewer: string | null; qa: string | null };
    runtimeHistory: { at: number; role: string; runtimeId: string; event: string; failureClass: string | null; detail: string | null }[];
    snapshot: {
      currentTask: string | null;
      currentStage: string | null;
      tasks: { taskId: string; phase: number; status: string; stage: string | null; reason: string | null }[] | null;
    } | null;
  };
};

export function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const staRunId = params?.id ?? "";
  const [detail, setDetail] = useState<StaRunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [diff, setDiff] = useState<StaRunDiff | null>(null);
  const [commit, setCommit] = useState<StaPrepareCommit | null>(null);

  const load = useCallback(() => {
    get<StaRunDetail>(`/runs/${encodeURIComponent(staRunId)}`)
      .then(setDetail)
      .catch(setError);
  }, [staRunId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  if (!detail) return <Spinner />;
  const run = detail.run;

  const act = (action: string, body?: unknown) => {
    setActionError(null);
    post(`/runs/${encodeURIComponent(staRunId)}/${action}`, body)
      .then(load)
      .catch(setActionError);
  };

  const loadDiff = () => {
    setActionError(null);
    get<StaRunDiff>(`/runs/${encodeURIComponent(staRunId)}/diff`).then(setDiff).catch(setActionError);
  };
  const loadCommit = () => {
    setActionError(null);
    get<StaPrepareCommit>(`/runs/${encodeURIComponent(staRunId)}/prepare-commit`).then(setCommit).catch(setActionError);
  };

  const openGates = run.humanGates.filter((g) => g.resolvedAt === null);
  const tasks = run.snapshot?.tasks ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        title={`${run.knowledge.name} / ${run.module}`}
        subtitle={`${run.runId}`}
        action={<Pill tone={STATUS_TONE[run.status] ?? "muted"}>{STATUS_LABEL[run.status] ?? run.status}</Pill>}
      />
      {run.statusReason ? <Banner tone={STATUS_TONE[run.status] === "bad" ? "bad" : "info"}>{run.statusReason}</Banner> : null}
      <ErrorBanner error={actionError} />

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => act("pause")}>พัก</Button>
        <Button onClick={() => act("resume")}>ทำต่อ</Button>
        <Button variant="danger" onClick={() => act("stop")}>
          หยุด
        </Button>
        {run.status === "READY_FOR_REVIEW" ? (
          <>
            <Button variant="primary" onClick={() => act("approve")}>
              อนุมัติผลงาน (ยังไม่ push/merge/deploy)
            </Button>
            <Button variant="danger" onClick={() => act("send-back", { note: "sent back from platform" })}>
              ส่งกลับ
            </Button>
          </>
        ) : null}
        <Button onClick={loadDiff}>ดู Diff</Button>
        <Button onClick={loadCommit}>เตรียม Commit (คนรันเอง)</Button>
      </div>

      {openGates.length > 0 ? (
        <Card className="space-y-2">
          <h2 className="font-medium">Human gates ที่เปิดอยู่</h2>
          {openGates.map((gate) => (
            <Banner key={gate.id} tone="warn">
              ⚑ {gate.reason}
            </Banner>
          ))}
          <p className="text-xs text-stone-500">Gate เหล่านี้จะปรากฏในกล่องขาเข้าของคนที่รับผิดชอบ — ตอบแล้ว run เดินต่อเอง</p>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 font-medium">งาน ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-stone-500">ยังไม่มีภาพงาน — รอ segment แรก</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-stone-500">
                <th className="py-2 pr-3">Task</th>
                <th className="py-2 pr-3">Phase</th>
                <th className="py-2 pr-3">สถานะ</th>
                <th className="py-2 pr-3">Stage</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.taskId} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-2 pr-3 font-mono text-xs">{task.taskId}</td>
                  <td className="py-2 pr-3">{task.phase}</td>
                  <td className="py-2 pr-3">{task.status}</td>
                  <td className="py-2 pr-3">{task.stage ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {diff ? (
        <Card className="space-y-2">
          <h2 className="font-medium">Diff {diff.truncated ? "(ตัดบางส่วน)" : ""}</h2>
          {diff.note ? <p className="text-sm text-stone-500">{diff.note}</p> : null}
          <pre className="max-h-96 overflow-auto rounded-lg bg-stone-950 p-3 text-xs leading-5">
            {diff.diff.length === 0
              ? <span className="text-stone-500">(ยังไม่มีงานที่ freeze)</span>
              : diff.diff.split("\n").map((line, index) => (
                  <div
                    key={index}
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "text-emerald-400"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-red-400"
                          : line.startsWith("@@")
                            ? "text-sky-400"
                            : "text-stone-300"
                    }
                  >
                    {line || " "}
                  </div>
                ))}
          </pre>
        </Card>
      ) : null}

      {commit ? (
        <Card className="space-y-2">
          <h2 className="font-medium">เตรียม Commit</h2>
          <Banner tone="warn">{commit.note}</Banner>
          <pre className="overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs dark:bg-stone-800">
            {commit.commands.join("\n") || "-"}
          </pre>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 font-medium">Runtime history</h2>
        {run.runtimeHistory.length === 0 ? (
          <p className="text-sm text-stone-500">ยังไม่มี</p>
        ) : (
          <ul className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
            {run.runtimeHistory.slice(-30).map((entry, index) => (
              <li key={index}>
                {fmtDateTime(entry.at)} · {entry.runtimeId} → {entry.role} · {entry.event}
                {entry.failureClass ? ` · ${entry.failureClass}` : ""}
                {entry.detail && entry.event !== "success" ? ` — ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
