"use client";

/** The app chrome: identity-aware navigation with a live gate badge, admin section for org admins. */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMe } from "@/features/auth/hooks/useMe";
import { gatesApi } from "@/features/gates/api";
import { Button, Spinner } from "@/components/ui/primitives";

export function AppShell({ children }: { children: ReactNode }) {
  const { me, loading, logout } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";
  const [gateCount, setGateCount] = useState<number | null>(null);

  useEffect(() => {
    if (!me || isLogin) return;
    let cancelled = false;
    const tick = () =>
      gatesApi
        .mine()
        .then((gates) => {
          if (!cancelled) setGateCount(gates.filter((g) => g.canAnswer).length);
        })
        .catch(() => undefined);
    tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [me, isLogin, pathname]);

  useEffect(() => {
    if (!loading && !me && !isLogin) router.replace("/login");
  }, [loading, me, isLogin, router]);

  if (isLogin) return <main className="flex min-h-screen items-center justify-center p-6">{children}</main>;
  if (loading) return <main className="flex min-h-screen items-center justify-center"><Spinner /></main>;
  if (!me) return null;

  const navClass = (href: string) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      pathname === href ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
    }`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur dark:border-stone-800 dark:bg-stone-900/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <Link href="/" className="mr-2 font-semibold">
            <span className="text-stone-900 dark:text-stone-100">◆ STA Platform</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            <Link href="/" className={navClass("/")}>
              My Work
            </Link>
            <Link href="/gates" className={navClass("/gates")}>
              Gates{gateCount ? ` (${gateCount})` : ""}
            </Link>
            <Link href="/runs" className={navClass("/runs")}>
              Runs
            </Link>
            <Link href="/team" className={navClass("/team")}>
              Team
            </Link>
            <Link href="/connections" className={navClass("/connections")}>
              My AI
            </Link>
            {me.isOrgAdmin ? (
              <>
                <Link href="/admin/users" className={navClass("/admin/users")}>
                  Users
                </Link>
                <Link href="/admin/knowledge" className={navClass("/admin/knowledge")}>
                  Knowledge
                </Link>
                <Link href="/admin/pools" className={navClass("/admin/pools")}>
                  Pools
                </Link>
                <Link href="/admin/audit" className={navClass("/admin/audit")}>
                  Audit
                </Link>
              </>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-stone-500">
              {me.name}
              {me.isOrgAdmin ? " · ผู้ดูแล" : ""}
            </span>
            <Button variant="ghost" onClick={() => void logout()}>
              ออกจากระบบ
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  );
}
