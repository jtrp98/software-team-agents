import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { parsePrismaModels } from "../bootstrap/discovery/dbSchemaDiscovery.js";
import { migrateLegacyDesign } from "./legacyDesign.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-design-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const DESIGN = `# Sales CRM — Feasibility & Design

**Contract Version:** 3

## Feasibility Summary
All feasible.

## Feature-by-Feature Feasibility
- DES-001 — covers REQ-001: straightforward, standard JWT login.
- DES-002 — covers REQ-002, REQ-003: needs a new dependency for card tokenisation.

## Data Model
\`\`\`prisma
model Order {
  id        String   @id @default(cuid())
  total     Int
  note      String?
  customer  Customer @relation(fields: [customerId], references: [id])
  customerId String
}

model Customer {
  id     String  @id @default(cuid())
  email  String  @unique
  orders Order[]
}
\`\`\`

## Modules
### Module: orders
Order capture and totals.

### Module: payments
Card charging. Security Considerations: card numbers are untrusted input and must never be logged.

## Risks & Dependencies
- DES-002 depends on a tokenisation vendor that is not chosen yet.
- Postgres version on staging is behind production.

## Change Log
2026-08-01: v1 -> v3.
`;

function items(root: string) {
  return migrateLegacyDesign(root, NOW).items;
}

describe("migrateLegacyDesign — the feasibility rows", () => {
  it("makes one architecture item per DES-NNN, refining every REQ it names", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const architecture = items(root).filter((i) => i.kind === "architecture");

    expect(architecture.map((i) => i.id)).toEqual(["DES-001", "DES-002"]);
    expect(architecture[1].relations).toEqual([
      { type: "refines", to: "REQ-002" },
      { type: "refines", to: "REQ-003" },
    ]);
  });

  it("never promotes prose to a feasibility verdict, only to feasible-with-risk when the document lists a risk", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const des002 = items(root).find((i) => i.id === "DES-002") as KnowledgeItemOf<"architecture">;

    // The row says "needs a new dependency", which reads like a judgement and is not one.
    expect(des002.payload.feasibility).toBe("feasible-with-risk");
    expect(des002.payload.risks).toEqual(["DES-002 depends on a tokenisation vendor that is not chosen yet."]);
  });

  it("says unknown when the document lists no risk at all", () => {
    const root = project({
      "_docs/module/m/design.md": "## Feature-by-Feature Feasibility\n- DES-001 — covers REQ-001: fine.\n\n## Data Model\nmodel A { id String @id }\n",
    });

    const des = items(root).find((i) => i.id === "DES-001") as KnowledgeItemOf<"architecture">;

    expect(des.payload.feasibility).toBe("unknown");
    expect(des.payload.risks).toEqual([]);
  });

  it("records the Contract Version the import happened at, in the item's own body", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    expect(items(root).find((i) => i.id === "DES-001")!.body).toContain("Contract Version at import: 3");
  });
});

describe("migrateLegacyDesign — the Data Model", () => {
  it("makes one db-schema item per model, with its fields and optionality intact", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const order = items(root).find((i) => i.id === "DB-Order") as KnowledgeItemOf<"db-schema">;

    expect(order.payload.model).toBe("Order");
    expect(order.payload.fields).toEqual([
      { name: "id", type: "String", optional: false },
      { name: "total", type: "Int", optional: false },
      { name: "note", type: "String?", optional: true },
      { name: "customer", type: "Customer", optional: false },
      { name: "customerId", type: "String", optional: false },
    ]);
  });

  it("derives relations from field types that name another model in the same document", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const order = items(root).find((i) => i.id === "DB-Order") as KnowledgeItemOf<"db-schema">;
    const customer = items(root).find((i) => i.id === "DB-Customer") as KnowledgeItemOf<"db-schema">;

    expect(order.payload.relations).toEqual(["Customer"]);
    expect(customer.payload.relations).toEqual(["Order"]);
  });

  it("reads the Data Model with the same parser T76 reads schema.prisma with", () => {
    const dataModel = DESIGN.slice(DESIGN.indexOf("## Data Model"));
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const direct = parsePrismaModels(dataModel).map((m) => ({ name: m.name, fields: m.fields }));
    const imported = items(root)
      .filter((i): i is KnowledgeItemOf<"db-schema"> => i.kind === "db-schema")
      .map((i) => ({ name: i.payload.model, fields: i.payload.fields }));

    expect(imported).toEqual(direct);
  });

  it("says so when the Data Model is a summary rather than schema syntax, instead of importing nothing quietly", () => {
    const root = project({
      "_docs/module/m/design.md": "## Feature-by-Feature Feasibility\n- DES-001 — covers REQ-001: fine.\n\n## Data Model\nOrders table with a total column.\n",
    });

    const result = migrateLegacyDesign(root, NOW);

    expect(result.items.filter((i) => i.kind === "db-schema")).toHaveLength(0);
    expect(result.notes.some((n) => n.includes("summary rather than the schema"))).toBe(true);
  });
});

describe("migrateLegacyDesign — what survives the import", () => {
  it("carries a module's sensitive concern onto the design, because nobody but the user removes that flag", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    expect(items(root).find((i) => i.id === "DES-001")!.sensitive).toBe(true);
  });

  it("leaves a design with no sensitive module unflagged", () => {
    const root = project({
      "_docs/module/m/design.md": "## Feature-by-Feature Feasibility\n- DES-001 — covers REQ-001: fine.\n\n## Modules\n### Module: reports\nRead-only dashboards.\n\n## Data Model\nmodel A { id String @id }\n",
    });

    expect(items(root).find((i) => i.id === "DES-001")!.sensitive).toBe(false);
  });

  it("marks every item as a legacy import at version 1, owned by system-analyst, still a draft", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    for (const item of items(root)) {
      expect(item.sources[0].note).toBe("legacy import (T85)");
      expect(item.version).toBe(1);
      expect(item.status).toBe("draft");
      expect(item.owner).toBe(AgentStage.SYSTEM_ANALYST);
      expect(item.module).toBe("sales-crm");
    }
  });

  it("cites the line its row or model sits on, so the import can be checked against the document", () => {
    const root = project({ "_docs/module/sales-crm/design.md": DESIGN });

    const des = items(root).find((i) => i.id === "DES-001")!;
    const db = items(root).find((i) => i.id === "DB-Order")!;

    expect(des.sources[0].locator).toMatch(/^_docs\/module\/sales-crm\/design\.md#L\d+$/);
    expect(db.sources[0].locator).toMatch(/^_docs\/module\/sales-crm\/design\.md#L\d+-L\d+$/);
  });

  it("registers one source per design.md, not one per item", () => {
    const root = project({
      "_docs/module/a/design.md": DESIGN,
      "_docs/module/b/design.md": DESIGN,
    });

    const result = migrateLegacyDesign(root, NOW);

    expect(result.sources).toHaveLength(2);
    expect(result.items.length).toBeGreaterThan(2);
  });

  it("reports a module with no design.md instead of failing the run", () => {
    const root = project({ "_docs/module/a/requirement.md": "# just a requirement" });

    const result = migrateLegacyDesign(root, NOW);

    expect(result.items).toEqual([]);
    expect(result.notes).toContain("a has no design.md");
  });
});
