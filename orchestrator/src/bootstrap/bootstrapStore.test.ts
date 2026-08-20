import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newBootstrapState } from "./bootstrapModel.js";
import { BootstrapStateError, bootstrapStatePath, readBootstrapState, writeBootstrapState } from "./bootstrapStore.js";

const NOW = "2026-08-20T09:00:00Z";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-bootstrap-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readBootstrapState", () => {
  it("returns null state with no problems when nothing has been written yet", () => {
    expect(readBootstrapState(root)).toEqual({ state: null, problems: [] });
  });

  it("round-trips a state written with writeBootstrapState", () => {
    const state = newBootstrapState("sales-crm", NOW);
    writeBootstrapState(state, root);
    const result = readBootstrapState(root);
    expect(result.problems).toEqual([]);
    expect(result.state).toEqual(state);
  });

  it("reports a parse failure without throwing", () => {
    fs.mkdirSync(path.dirname(bootstrapStatePath(root)), { recursive: true });
    fs.writeFileSync(bootstrapStatePath(root), "status: [unterminated", "utf8");
    const result = readBootstrapState(root);
    expect(result.state).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("reports a schema violation without throwing", () => {
    fs.mkdirSync(path.dirname(bootstrapStatePath(root)), { recursive: true });
    fs.writeFileSync(bootstrapStatePath(root), "not_a_valid_field: true\n", "utf8");
    const result = readBootstrapState(root);
    expect(result.state).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

describe("writeBootstrapState", () => {
  it("refuses to write an inconsistent state", () => {
    const state = newBootstrapState(null, NOW);
    state.validated_by = "Nok"; // validated_at left null — invalid pair
    expect(() => writeBootstrapState(state, root)).toThrow(BootstrapStateError);
  });

  it("writes atomically, leaving no .tmp file behind", () => {
    writeBootstrapState(newBootstrapState(null, NOW), root);
    const files = fs.readdirSync(path.dirname(bootstrapStatePath(root)));
    expect(files.every((f) => !f.includes(".tmp-"))).toBe(true);
  });
});
