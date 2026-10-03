import type { Metadata } from "next";
import "./globals.css";
import { MeProvider } from "@/features/auth/hooks/useMe";
import { AppShell } from "@/components/layout/AppShell";

export const metadata: Metadata = {
  title: "STA Platform",
  description: "ทีมซอฟต์แวร์ · Knowledge เดียวกัน · คนที่ถูกต้องตัดสินใจที่ Gate ของตัวเอง · AI ทำงานบนความจุที่ถูกต้อง",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className="h-full antialiased">
      <body className="min-h-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
        <MeProvider>
          <AppShell>{children}</AppShell>
        </MeProvider>
      </body>
    </html>
  );
}
