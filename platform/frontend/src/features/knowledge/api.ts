import { del, get, post } from "@/lib/api";
import type { KnowledgeInfo, KnowledgeRow, MemberDto, UserLite } from "./types";

export const knowledgeApi = {
  list: () => get<KnowledgeRow[]>("/knowledge"),
  add: (name: string, repositoryUrl?: string) => post<KnowledgeRow>("/knowledge", { name, registerOnStaMachine: false, repositoryUrl }),
  remove: (id: number) => del<{ ok: boolean }>(`/knowledge/${id}`),
  members: (id: number) => get<MemberDto[]>(`/knowledge/${id}/members`),
  addMember: (id: number, userId: number) => post<{ ok: boolean }>(`/knowledge/${id}/members`, { userId }),
  removeMember: (id: number, userId: number) => del<{ ok: boolean }>(`/knowledge/${id}/members/${userId}`),
  users: () => get<UserLite[]>("/users"),
};

export type { KnowledgeInfo };
