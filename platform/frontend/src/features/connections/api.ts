import { get, post } from "@/lib/api";
import type { ConnectionRow } from "./types";

export const connectionsApi = {
  mine: () => get<ConnectionRow[]>("/me/connections"),
  add: (runtimeType: string) => post<ConnectionRow>("/me/connections", { runtimeType, ownerType: "user", ownerId: 0, sharingScope: "private" }),
  setStatus: (id: number, status: string) => post<ConnectionRow>(`/me/connections/${id}/status`, { status }),
};
