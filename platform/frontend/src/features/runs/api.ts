import { get, post } from "@/lib/api";
import type { KnowledgeInfo, KnowledgeRow, RunRow, StaPrepareCommit, StaRunDiff } from "./types";

export const runsApi = {
  start: (knowledgeName: string, module: string, commandText: string) =>
    post<RunRow>("/runs", { knowledgeName, module, commandText }),
  list: (params?: { status?: string; knowledge?: string; module?: string }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.knowledge) query.set("knowledge", params.knowledge);
    if (params?.module) query.set("module", params.module);
    const suffix = query.toString();
    return get<RunRow[]>(`/runs${suffix ? `?${suffix}` : ""}`);
  },
  knowledgeOptions: () => get<KnowledgeInfo[]>("/knowledge"),
  diff: (staRunId: string) => get<StaRunDiff>(`/runs/${encodeURIComponent(staRunId)}/diff`),
  prepareCommit: (staRunId: string) => get<StaPrepareCommit>(`/runs/${encodeURIComponent(staRunId)}/prepare-commit`),
};

export type { KnowledgeRow };
