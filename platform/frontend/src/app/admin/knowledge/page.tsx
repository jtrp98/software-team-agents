import { KnowledgeAdmin } from "@/features/knowledge/components/KnowledgeAdmin";
import { PageTitle } from "@/components/ui/primitives";

export default function Page() {
  return (
    <div>
      <PageTitle title="Knowledge" subtitle="metadata อยู่ที่ DB · เนื้อหาจริงอยู่ที่ Git · เป้าหมาย source code อยู่ที่ Target repos" />
      <KnowledgeAdmin />
    </div>
  );
}
