"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { gatesApi } from "../api";
import type { GateDetail } from "../types";
import { Banner, Button, Card, ErrorBanner, Field, PageTitle, Pill, Spinner, fmtDateTime, inputClass } from "@/components/ui/primitives";

/** Gate detail + the answer form. The server rejects a wrong role — the UI merely reflects it. */
export function GateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const [detail, setDetail] = useState<GateDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [answerError, setAnswerError] = useState<unknown>(null);
  const [approved, setApproved] = useState<boolean | null>(null);
  const [choice, setChoice] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    gatesApi
      .get(id)
      .then(setDetail)
      .catch(setError);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBanner error={error} />;
  if (!detail) return <Spinner />;
  const gate = detail.gate;
  const isOpen = ["Open", "Assigned", "Waiting"].includes(gate.status);

  const submit = () => {
    setBusy(true);
    setAnswerError(null);
    gatesApi
      .answer(id, { approved: approved ?? undefined, choice: choice || undefined, comment: comment || undefined })
      .then(() => {
        setDone("บันทึกการตัดสินใจแล้ว — งานที่ผูกกับ gate นี้จะเดินต่อโดยอัตโนมัติ");
        load();
      })
      .catch(setAnswerError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4">
      <PageTitle
        title={`${gate.displayId} · ${gate.gateType}`}
        subtitle={`${gate.knowledgeName}${gate.module ? ` / ${gate.module}` : ""} · สร้าง ${fmtDateTime(gate.createdAt)}`}
        action={
          <div className="flex gap-1">
            {gate.requiredRole ? <Pill tone="info">ต้องการ role: {gate.requiredRole}</Pill> : null}
            <Pill tone={gate.status === "Answered" ? "ok" : "warn"}>{gate.status}</Pill>
          </div>
        }
      />

      <Card className="space-y-3">
        <p className="text-sm text-stone-800 dark:text-stone-200">{gate.question}</p>
        {gate.aiAnalysis ? (
          <div>
            <h3 className="text-xs font-semibold uppercase text-stone-500">AI analysis</h3>
            <p className="text-sm text-stone-600 dark:text-stone-300">{gate.aiAnalysis}</p>
          </div>
        ) : null}
        {gate.options.length > 0 ? (
          <Field label="ตัวเลือก (AI เสนอไว้)">
            <select className={inputClass} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">— เลือก —</option>
              {gate.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {detail.blockedRefsJson ? (
          <div>
            <h3 className="text-xs font-semibold uppercase text-stone-500">งานที่ถูกบล็อก</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-stone-100 p-2 text-xs dark:bg-stone-800">{detail.blockedRefsJson}</pre>
          </div>
        ) : null}
        {gate.decisionSummary ? (
          <Banner tone="ok">
            ตัดสินใจแล้วโดย {gate.answeredByName} (ในบทบาท {gate.actingRole}) — {gate.decisionSummary}
          </Banner>
        ) : null}
      </Card>

      {isOpen && gate.canAnswer ? (
        <Card className="space-y-3">
          <h3 className="font-medium">ตอบ gate นี้ (จะบันทึกในบทบาท {gate.requiredRole ?? "assignee"})</h3>
          <ErrorBanner error={answerError} />
          <div className="flex gap-2">
            <Button variant={approved === true ? "primary" : "default"} onClick={() => setApproved(true)}>
              เห็นด้วย / ดำเนินการต่อ
            </Button>
            <Button variant={approved === false ? "danger" : "default"} onClick={() => setApproved(false)}>
              ไม่เห็นด้วย / ส่งกลับ
            </Button>
            {gate.options.length > 0 ? <Pill tone="info">หรือเลือกตัวเลือกด้านบน</Pill> : null}
          </div>
          <Field label="ความเห็นประกอบ (บันทึกใน audit)">
            <textarea className={inputClass} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={busy || (approved === null && !choice)} onClick={submit}>
            {busy ? "กำลังบันทึก…" : "บันทึกคำตอบ"}
          </Button>
        </Card>
      ) : null}

      {isOpen && !gate.canAnswer ? (
        <Banner tone="warn">Gate นี้ต้องการ role ที่คุณไม่ได้ถือในขอบเขตนี้ (หรือเป็นตาของ primary) — backend จะปฏิเสธการตอบ</Banner>
      ) : null}
      {done ? <Banner tone="ok">{done}</Banner> : null}
      <ErrorBanner error={error} />
    </div>
  );
}
