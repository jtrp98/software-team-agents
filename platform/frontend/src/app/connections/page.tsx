import { MyConnections } from "@/features/connections/components/MyConnections";
import { PageTitle } from "@/components/ui/primitives";

export default function ConnectionsPage() {
  return (
    <div>
      <PageTitle title="My AI Connections" subtitle="ความจุ AI ส่วนตัวของคุณ — private โดยดีฟอลต์ credentials ไม่มีวันแสดงที่นี่" />
      <MyConnections />
    </div>
  );
}
