"use client";

import { useEffect, useState } from "react";
import { runsApi } from "@/features/runs/api";
import { RunTable, StartRunForm } from "@/features/runs/components/RunViews";
import { PageTitle, Spinner } from "@/components/ui/primitives";
import type { KnowledgeInfo } from "@/features/runs/types";

export default function RunsPage() {
  const [options, setOptions] = useState<KnowledgeInfo[] | null>(null);

  useEffect(() => {
    runsApi.knowledgeOptions().then(setOptions).catch(() => setOptions([]));
  }, []);

  return (
    <div className="space-y-4">
      <PageTitle title="Runs" subtitle="สั่งงาน AI บน Knowledge ที่คุณเป็นสมาชิก — 1 run ติดกับ Knowledge เดียว" />
      {!options ? <Spinner /> : <StartRunForm knowledgeOptions={options} />}
      <RunTable />
    </div>
  );
}
