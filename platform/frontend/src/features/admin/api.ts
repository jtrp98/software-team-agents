import { get, post, put } from "@/lib/api";
import type { AssignmentRow, AuditRow, GatePolicyItem, KnowledgeLite, RoleCatalogItem, UsageRow, UserRow } from "./types";

export const adminApi = {
  users: () => get<UserRow[]>("/users"),
  user: (id: number) => get<UserRow>(`/users/${id}`),
  invite: (email: string, name: string, password: string) => post<UserRow>("/users", { email, name, password }),
  setStatus: (id: number, status: string) => post<UserRow>(`/users/${id}/status`, { status }),
  resetPassword: (id: number, newPassword: string) => post<UserRow>(`/users/${id}/reset-password`, { newPassword }),
  assignments: (id: number) => get<AssignmentRow[]>(`/users/${id}/assignments`),
  setAssignments: (id: number, assignments: { role: string; knowledgeId?: number | null; module?: string | null; priority?: number }[]) =>
    put<AssignmentRow[]>(`/users/${id}/assignments`, { assignments }),
  roleCatalog: () => get<RoleCatalogItem[]>("/roles"),
  gatePolicies: () => get<GatePolicyItem[]>("/gate-policies"),
  knowledges: () => get<KnowledgeLite[]>("/knowledge"),
  audit: (limit = 200) => get<AuditRow[]>(`/audit?limit=${limit}`),
  usage: (days = 30) => get<UsageRow[]>(`/audit/usage?days=${days}`),
};
