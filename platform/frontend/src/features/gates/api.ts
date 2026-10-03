import { get, post } from "@/lib/api";
import type { AnswerGateRequest, GateCard, GateDetail, CreateGateRequest } from "./types";

export const gatesApi = {
  mine: () => get<GateCard[]>("/gates/mine"),
  counts: () => get<Record<string, number>>("/gates/counts"),
  get: (id: number) => get<GateDetail>(`/gates/${id}`),
  create: (request: CreateGateRequest) => post<GateCard>("/gates", request),
  answer: (id: number, request: AnswerGateRequest) => post<GateCard>(`/gates/${id}/answer`, request),
  reassign: (id: number, assigneeId: number) => post<GateCard>(`/gates/${id}/reassign`, { assigneeId }),
  cancel: (id: number, reason?: string) => post<{ ok: boolean }>(`/gates/${id}/cancel?reason=${encodeURIComponent(reason ?? "")}`),
};
