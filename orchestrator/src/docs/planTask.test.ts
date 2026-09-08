import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PlanTaskSchema, parseCanonicalPlan, planTaskHash, renderCanonicalTasks, migrateLegacyTaskTable, type PlanTask } from "./planTask.js";
import { parseLegacyPlanTasks, checkPlanGraphForModule } from "./planGraph.js";
import { checkOneDoc } from "./docStructure.js";

const fixture = fs.readFileSync(fileURLToPath(new URL("./fixtures/canonical-plan.md",import.meta.url)),"utf8");
const refs = {requirementMd:"REQ-007 AC-007.2",designMd:"DES-011 Contract:OrderSummary.v2"};
const parsed = () => parseCanonicalPlan(fixture, refs);
const task = () => parsed().tasks[0];

describe("canonical PlanTask v1",()=>{
  it("parses every normative field once and matches the normalized snapshot",()=>{
    expect(parsed().problems).toEqual([]);
    expect(PlanTaskSchema.parse(task())).toEqual(task());
    const snapshot = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/canonical-plan.normalized.json",import.meta.url)),"utf8"));
    expect(parsed().tasks).toEqual(snapshot);
    expect(Object.keys(task())).not.toContain("description");
    expect(Object.keys(task())).not.toContain("designRefs");
  });
  it("strict object rejects unknown fields",()=>expect(PlanTaskSchema.safeParse({...task(),description:"second authority"}).success).toBe(false));
  it.each(["Objective", "Why", "Owner", "Depends on", "Traceability", "Produces", "Consumes", "Risk", "Human gate", "Status"])("rejects missing/duplicate/empty %s",label=>{
    const line = fixture.split("\n").find(l=>l.startsWith(`${label}:`))!;
    for(const replacement of ["",`${line}\n${line}`,`${label}: `]) {
      const r=parseCanonicalPlan(fixture.replace(line,replacement),refs);
      expect(r.tasks).toEqual([]);expect(r.problems.join(" ")).toContain("BE-004");
    }
  });
  it.each(["Scope and constraints","Retrieval hints","Do not modify","Acceptance criteria","Required validation and expected evidence","Rollback/compatibility notes"])("rejects missing/empty/duplicate heading %s",h=>{
    for(const md of [fixture.replace(`#### ${h}`,"#### Unknown"),fixture.replace(`#### ${h}`,`#### ${h}\n\n#### ${h}`)]) expect(parseCanonicalPlan(md,refs).problems.join(" ")).toContain("BE-004");
  });
  it.each([
    ["Owner: backend-engineer","Owner: human"], ["Tier: T4","Tier: T1"], ["Human gate: none","Human gate: approved"], ["Risk: shared-contract","Risk: speculative"],
    ["Depends on: none","Depends on: BE-999"], ["Depends on: none","Depends on: BE-004"], ["Depends on: none","Depends on: BE-999, BE-999"],
    ["REQ-007, AC-007.2, DES-011","REQ-007, AC-007.2, DES-999"], ["REQ-007, AC-007.2, DES-011","REQ-007, AC-007.2, DES-011, DES-011"],
    ["Contract:OrderSummary.v2","Contract:OrderSummary"], ["Consumes: none","Consumes: Contract:Unknown.v1"], ["Objective: Return","Unknown: Return"], ["## Phase 1:","## Phase 0:"],
  ])("rejects invalid fields/references %s",(from,to)=>{const r=parseCanonicalPlan(fixture.replace(from,to),refs);expect(r.problems.length).toBeGreaterThan(0);expect(r.tasks).toEqual([]);});
  it("requires authoritative documents for cross-document checking",()=>expect(parseCanonicalPlan(fixture,{requirementMd:"",designMd:""}).problems).toEqual(expect.arrayContaining([expect.stringContaining("unknown trace"),expect.stringContaining("unknown design contract")])));
  it("accepts optional Tier absence and explicit declared gates without approving them",()=>{const md=fixture.replace("Tier: T4\n","").replace("Human gate: none","Human gate: schema, security");expect(parseCanonicalPlan(md,refs).tasks[0].humanGate).toEqual(["schema","security"]);});
  it("refuses duplicate IDs, producers, cycles and mixed table authorities",()=>{
    expect(parseCanonicalPlan(renderCanonicalTasks([task(),task()]),refs).problems.join(" ")).toContain("duplicate task ID");
    const second={...task(),id:"FE-005",dependsOn:["BE-004"]};
    expect(parseCanonicalPlan(renderCanonicalTasks([task(),second]),refs).problems.join(" ")).toContain("ambiguous producer");
    expect(parseCanonicalPlan(renderCanonicalTasks([{...task(),dependsOn:["FE-005"]},{...second,produces:[]}]),refs).problems.join(" ")).toContain("circular dependency");
    expect(parseCanonicalPlan(fixture.replace("### Task BE-004", "| Task | Status |\n\n### Task BE-004"),refs).problems.join(" ")).toContain("unexpected phase content");
    expect(parseCanonicalPlan(fixture + "\n## Task BE-009 — malformed\n",refs).problems.join(" ")).toContain("unknown plan heading");
    expect(()=>parseLegacyPlanTasks(fixture.replace("PlanTask format: 1","plantask format : 1"))).toThrow(/legacy runtime/);
  });
  it("ignores fake task headings in fenced semantic content; fails unclosed fences",()=>{
    const t={...task(),retrievalHints:"```text\n### Task BE-900 — example\nOwner: nobody\n```"};
    expect(parseCanonicalPlan(renderCanonicalTasks([t]),refs).tasks).toEqual([t]);
    expect(parseCanonicalPlan(renderCanonicalTasks([t]).replace("Owner: nobody\n```","Owner: nobody"),refs).problems.join(" ")).toContain("unclosed");
  });
  it("status-only edits preserve semantic hash; schema order/CRLF normalize",()=>{
    for(const status of ["pending","in_progress","verified","blocked"] as const) expect(planTaskHash({...task(),status})).toBe(planTaskHash(task()));
    expect(planTaskHash(parseCanonicalPlan(fixture.replace(/\n/g,"\r\n"),refs).tasks[0])).toBe(planTaskHash(task()));
    expect(planTaskHash(Object.fromEntries(Object.entries(task()).reverse()) as PlanTask)).toBe(planTaskHash(task()));
  });
  it("semantic fields each affect hash; generated roundtrips preserve intent for 40 variants",()=>{
    const changes: Partial<PlanTask>={id:"BE-005",phase:2,title:"Changed",objective:"Different outcome",why:"Different rationale",owner:"qa-engineer",tier:"T3",dependsOn:["BE-003"],traceability:["REQ-008","AC-008.1","DES-012"],produces:["Contract:Other.v1"],consumes:["Contract:Other.v1"],risk:["high"],humanGate:["schema"],scopeAndConstraints:"Changed",retrievalHints:"Changed",doNotModify:"Changed",acceptanceCriteria:"Changed",validationAndEvidence:"Changed",compatibility:"Changed"};
    for(const [k,v] of Object.entries(changes)) expect(planTaskHash({...task(),[k]:v})).not.toBe(planTaskHash(task()));
    for(let i=0;i<40;i++){const t={...task(),title:`Case ${i}`,why:`Reason ${i}\u0e01`,tier:undefined};expect(parseCanonicalPlan(renderCanonicalTasks([t]),refs).tasks[0]).toEqual(t);}
  });
  it("schema/doc checker reports canonical invalid fields with task identity",()=>{
    expect(checkOneDoc("plan",fixture,"fixture").ok).toBe(true);
    const result=checkOneDoc("plan",fixture.replace("Owner: backend-engineer","Owner: nobody"),"fixture");expect(result.ok).toBe(false);expect(result.problems.join(" ")).toContain("BE-004");
  });
  it("module --check-plan uses canonical references; missing documents fail",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"v8-plan-check-"));
    try {const dir=path.join(root,"example");fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"plan.md"),fixture);fs.writeFileSync(path.join(dir,"requirement.md"),refs.requirementMd);fs.writeFileSync(path.join(dir,"design.md"),refs.designMd);expect(checkPlanGraphForModule(root,"example").ok).toBe(true);fs.writeFileSync(path.join(dir,"requirement.md"),"");expect(checkPlanGraphForModule(root,"example").ok).toBe(false);} finally{fs.rmSync(root,{recursive:true,force:true});}
  });
});

describe("explicit migration window",()=>{
  const thin="# Plan\n\n## Phase 1\n\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-004 — Preserve order summary | pending | backend-engineer | none |\n";
  it("old rows remain readable, never silently canonical",()=>{expect(parseLegacyPlanTasks(thin).tasks[0].id).toBe("BE-004");expect(parseCanonicalPlan(thin).problems.join(" ")).toContain("BE-004");expect(migrateLegacyTaskTable(thin).problems.join(" ")).toContain("objective");expect(()=>parseLegacyPlanTasks(fixture)).toThrow(/legacy runtime reader/);});
  it("refuses unsupported version, checkbox-only and ambiguous table",()=>{expect(parseCanonicalPlan(fixture.replace("format: 1","format: 99")).problems.length).toBeGreaterThan(0);expect(migrateLegacyTaskTable("## Phase 1\n- [ ] BE-004").problems.length).toBeGreaterThan(0);expect(migrateLegacyTaskTable(thin.replace("BE-004 —","BE-004 (DES-011) —")).problems.join(" ")).toContain("ambiguous");});
  it("losslessly converts a fully specified expanded table, with no inferred prose",()=>{
    const t=task();const cols=["Task","Objective","Why","Owner","Tier","Depends on","Traceability","Produces","Consumes","Risk","Human gate","Status","Scope and constraints","Retrieval hints","Do not modify","Acceptance criteria","Required validation and expected evidence","Rollback/compatibility notes"];
    const cells=[`${t.id} — ${t.title}`,t.objective,t.why,t.owner,t.tier!,"none",t.traceability.join(", "),t.produces.join(", "),"none",t.risk.join(", "),"none",t.status,t.scopeAndConstraints,t.retrievalHints,t.doNotModify,t.acceptanceCriteria,t.validationAndEvidence,t.compatibility];
    const md=`# Plan\n\n## Plan Summary\nPreserve this authored strategy.\n\n## Phase 1\n\n| ${cols.join(" | ")} |\n| ${cols.map(()=>"---").join(" | ")} |\n| ${cells.join(" | ")} |\n\n## Change Log\nPreserve this authored history.\n`;
    const result=migrateLegacyTaskTable(md,refs);expect(result.problems).toEqual([]);expect(result.tasks).toEqual([t]);expect(parseCanonicalPlan(result.markdown!,refs).tasks).toEqual([t]);
    expect(result.markdown).toContain("Preserve this authored strategy.");expect(result.markdown).toContain("Preserve this authored history.");
    expect(migrateLegacyTaskTable(md.replace("| Objective |","| Owner |"),refs).problems.join(" ")).toContain("duplicate/unknown");
  });
});
