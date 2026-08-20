import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask } from "./taskStore.js";
import { buildStateViewDocument } from "./stateView.js";
import {
  StateViewSchemaError,
  assertValidStateView,
  isValidStateView,
  loadStateViewSchema,
  stateViewSchemaPath,
} from "./stateSchema.js";

const schema = loadStateViewSchema() as any;

function sampleDocument() {
  const classification = classifyTask({ isIncrementalFeature: true, touchesBackend: true });
  const task = newPersistedTask({
    taskId: "T-1",
    classification,
    machine: initTaskMachine(classification.pipeline, classification.requiresHumanApproval),
    now: 1_700_000_000_000,
  });
  return buildStateViewDocument([task], { now: 1_700_000_000_000 });
}

describe("state view schema", () => {
  it("ships as a real .json file so tools other than this package can read it", () => {
    expect(fs.existsSync(stateViewSchemaPath())).toBe(true);
    expect(schema.$schema).toContain("json-schema.org");
  });

  /**
   * The schema restates enums the TypeScript code also defines. That is the
   * price of publishing a contract other tools can read — these three cases
   * are what stops the two copies from drifting apart silently.
   */
  it("lists exactly the agents the code defines", () => {
    expect(schema.definitions.agent.enum.sort()).toEqual(Object.values(AgentStage).sort());
  });

  it("lists exactly the states the code defines", () => {
    expect(schema.definitions.state.enum.sort()).toEqual(Object.values(TaskState).sort());
  });

  it("lists exactly the task levels the code defines", () => {
    const levels = schema.definitions.task.properties.level.enum;
    expect(levels.sort()).toEqual(Object.values(TaskLevel).sort());
  });
});

describe("assertValidStateView", () => {
  it("accepts a document the generator actually produced", () => {
    expect(() => assertValidStateView(sampleDocument())).not.toThrow();
    expect(isValidStateView(sampleDocument())).toBe(true);
  });

  it("rejects a document with a missing required field", () => {
    const doc: any = sampleDocument();
    delete doc.tasks[0].retry;
    expect(() => assertValidStateView(doc)).toThrow(StateViewSchemaError);
  });

  it("rejects a field the contract does not declare, rather than passing it through silently", () => {
    const doc: any = sampleDocument();
    doc.tasks[0].mystery = "where did this come from";
    expect(() => assertValidStateView(doc)).toThrow(StateViewSchemaError);
  });

  it("rejects a state or agent outside the pipeline's vocabulary", () => {
    const doc: any = sampleDocument();
    doc.tasks[0].state = "VIBES";
    expect(() => assertValidStateView(doc)).toThrow(StateViewSchemaError);
  });

  it("rejects a timestamp that is not a real date-time", () => {
    const doc: any = sampleDocument();
    doc.generated_at = "yesterday-ish";
    expect(() => assertValidStateView(doc)).toThrow(StateViewSchemaError);
  });

  it("names every failing field, not just the first", () => {
    const doc: any = sampleDocument();
    doc.tasks[0].state = "VIBES";
    doc.tasks[0].status = "MAYBE";
    try {
      assertValidStateView(doc);
      throw new Error("expected it to throw");
    } catch (e) {
      expect((e as StateViewSchemaError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
