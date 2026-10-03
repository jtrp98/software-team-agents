import { GateInbox } from "@/features/gates/components/GateInbox";
import { PageTitle } from "@/components/ui/primitives";

export default function GatesPage() {
  return (
    <div>
      <PageTitle title="My Gates" subtitle="คำถามที่ AI ถามคนที่รับผิดชอบเรื่องนั้นจริง — ตอบแล้วงานเดินต่อเอง" />
      <GateInbox />
    </div>
  );
}
