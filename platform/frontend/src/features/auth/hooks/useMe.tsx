"use client";

/** The one identity context of the app: /api/auth/status, refresh-aware. */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "../api";
import type { Me } from "../types";

type MeState = {
  me: Me | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
};

const MeContext = createContext<MeState>({ me: null, loading: true, reload: async () => {}, logout: async () => {} });

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const reload = useCallback(async () => {
    try {
      const status = await authApi.status();
      setMe(status.authenticated ? status.user : null);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setMe(null);
    router.replace("/login");
  }, [router]);

  return <MeContext.Provider value={{ me, loading, reload, logout }}>{children}</MeContext.Provider>;
}

export function useMe() {
  return useContext(MeContext);
}
