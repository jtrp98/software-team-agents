"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui/primitives";
import { authApi } from "../api";

/** The login form. Credentials go to the .NET backend; tokens come back as httpOnly cookies. */
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Card className="w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-lg font-semibold">เข้าสู่ระบบ STA Platform</h1>
        <p className="mt-1 text-sm text-stone-500">ทีมซอฟต์แวร์เดียวกัน · Knowledge เดียวกัน · ตัดสินใจที่ Gate ของตัวเอง</p>
      </div>
      <ErrorBanner error={error} />
      <Field label="อีเมล">
        <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="รหัสผ่าน">
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) {
              setBusy(true);
              setError(null);
              authApi
                .login(email.trim(), password)
                .then(() => router.replace("/"))
                .catch(setError)
                .finally(() => setBusy(false));
            }
          }}
        />
      </Field>
      <Button
        variant="primary"
        disabled={busy || !email.trim() || !password}
        onClick={() => {
          setBusy(true);
          setError(null);
          authApi
            .login(email.trim(), password)
            .then(() => router.replace("/"))
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
      </Button>
    </Card>
  );
}
