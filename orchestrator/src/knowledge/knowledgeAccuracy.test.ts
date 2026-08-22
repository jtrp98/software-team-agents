import { describe, expect, it } from "vitest";
import { makeItem } from "./sampleKnowledge.js";
import { checkDbSchemaAccuracy, describeAccuracy, parsePrismaModels } from "./knowledgeAccuracy.js";

const REAL_SCHEMA = `
model TCrmAiDecisionLog {
  CrmAiDecisionLogId Int       @id @default(autoincrement())
  SubjectType        String    @db.VarChar(20)
  Confidence         Float?
  CreateDate         DateTime  @default(now()) @db.Timestamptz(6)

  @@index([SubjectType, CreateDate(sort: Desc)], map: "IX_Subject")
}

model TCrmStaffRole {
  StaffRoleId Int    @id @default(autoincrement())
  RoleName    String @db.VarChar(50)
}
`;

describe("parsePrismaModels (T115)", () => {
  it("reads every field name and its verbatim type token, including the trailing ? on an optional field", () => {
    const models = parsePrismaModels(REAL_SCHEMA);
    expect([...models.keys()]).toEqual(["TCrmAiDecisionLog", "TCrmStaffRole"]);
    const log = models.get("TCrmAiDecisionLog")!;
    expect(log.fields).toEqual([
      { name: "CrmAiDecisionLogId", type: "Int", optional: false },
      { name: "SubjectType", type: "String", optional: false },
      { name: "Confidence", type: "Float?", optional: true },
      { name: "CreateDate", type: "DateTime", optional: false },
    ]);
  });

  it("skips block-level attributes and blank lines rather than misreading them as fields", () => {
    const models = parsePrismaModels(REAL_SCHEMA);
    const log = models.get("TCrmAiDecisionLog")!;
    expect(log.fields.some((f) => f.name.startsWith("@@"))).toBe(false);
    expect(log.fields).toHaveLength(4);
  });
});

describe("checkDbSchemaAccuracy (T115)", () => {
  function dbItem(model: string, fields: Array<{ name: string; type: string; optional: boolean }>) {
    return makeItem("db-schema", `DB-${model}`, { model, fields, relations: [] });
  }

  it("reports an exact match when every field name and type line up", () => {
    const item = dbItem("TCrmStaffRole", [
      { name: "StaffRoleId", type: "Int", optional: false },
      { name: "RoleName", type: "String", optional: false },
    ]);
    const report = checkDbSchemaAccuracy([item], REAL_SCHEMA);
    expect(report.models).toHaveLength(1);
    expect(report.models[0].exact).toBe(true);
    expect(report.models[0].fieldsMatched).toEqual(["StaffRoleId", "RoleName"]);
    expect(report.summary).toEqual({
      modelsChecked: 1,
      modelsExact: 1,
      modelsMissingInReal: 0,
      fieldAccuracy: 1,
    });
  });

  it("flags a model the knowledge item names that no longer exists in the real schema at all", () => {
    const item = dbItem("TCrmLongGoneModel", [{ name: "Id", type: "Int", optional: false }]);
    const report = checkDbSchemaAccuracy([item], REAL_SCHEMA);
    expect(report.models[0]).toMatchObject({ presentInReal: false, exact: false, fieldsMissingInReal: ["Id"] });
    expect(report.summary.modelsMissingInReal).toBe(1);
  });

  it("distinguishes a stale type from a field that no longer exists", () => {
    // This is exactly the scenario CLAUDE.md's "design.md is the contract" rule
    // exists to catch from the design side — here it is caught from the DB side:
    // Confidence used to be required when design.md captured it, the real schema
    // made it optional since, and CrmAiDecisionLogId was renamed/dropped and
    // knowledge never learned about a real field the model gained (SubjectType).
    const item = dbItem("TCrmAiDecisionLog", [
      { name: "Confidence", type: "Float", optional: false }, // stale: real is now Float?
      { name: "RemovedField", type: "String", optional: false }, // no longer real
    ]);
    const report = checkDbSchemaAccuracy([item], REAL_SCHEMA);
    const m = report.models[0];
    expect(m.exact).toBe(false);
    expect(m.typeMismatches).toEqual([{ field: "Confidence", real: "Float?", knowledge: "Float" }]);
    expect(m.fieldsMissingInReal).toEqual(["RemovedField"]);
    // CrmAiDecisionLogId, SubjectType, CreateDate are real but this item never captured them.
    expect(m.fieldsMissingInKnowledge).toEqual(["CrmAiDecisionLogId", "SubjectType", "CreateDate"]);
    expect(report.summary.fieldAccuracy).toBe(0); // 0 matched out of 2 checked (1 mismatch + 1 missing)
  });

  it("ignores knowledge items that are not db-schema, rather than crashing on their payload shape", () => {
    const req = makeItem("requirement", "REQ-001", {
      acceptance_criteria: [],
      actors: [],
      priority: null,
      assumption_unconfirmed: false,
    });
    const report = checkDbSchemaAccuracy([req], REAL_SCHEMA);
    expect(report.models).toEqual([]);
    expect(report.summary.fieldAccuracy).toBe(1); // nothing to check reads as accurate, not as failing
  });

  it("describeAccuracy renders one readable line per model without throwing on an empty report", () => {
    expect(describeAccuracy({ models: [], summary: { modelsChecked: 0, modelsExact: 0, modelsMissingInReal: 0, fieldAccuracy: 1 } })).toEqual([]);
    const item = dbItem("TCrmStaffRole", [
      { name: "StaffRoleId", type: "Int", optional: false },
      { name: "RoleName", type: "String", optional: false },
    ]);
    const lines = describeAccuracy(checkDbSchemaAccuracy([item], REAL_SCHEMA));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("exact match");
  });
});
