import { get, post } from "@/lib/api";
import type { AuthResponse, Me } from "./types";

export const authApi = {
  status: () => get<{ authenticated: boolean; user: Me | null }>("/auth/status"),
  login: (email: string, password: string) => post<AuthResponse>("/auth/login", { email, password }),
  logout: () => post<{ ok: boolean }>("/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean }>("/auth/change-password", { currentPassword, newPassword }),
};
