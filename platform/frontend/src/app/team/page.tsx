import { TeamBoard } from "@/features/team/components/TeamBoard";
import { PageTitle } from "@/components/ui/primitives";

export default function TeamPage() {
  return (
    <div>
      <PageTitle title="Team Workflow" subtitle="ใครทำอะไร งานไหนรอใคร — สิทธิ์ทำ action ยังตาม role เดิม" />
      <TeamBoard />
    </div>
  );
}
