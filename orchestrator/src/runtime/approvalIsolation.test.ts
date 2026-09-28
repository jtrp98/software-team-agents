import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalIsolationDenial } from "../cli/composition/approvalIsolation.js";
import { CodexAdapter } from "./codexAdapter.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import { NO_GUARDS, type RuntimeAgentRequest, type RuntimeGuards } from "./runtimeAdapter.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-a1-"));
  const workspace = path.join(root, "workspace");
  const approval = path.join(root, "approval");
  fs.mkdirSync(workspace);
  fs.mkdirSync(approval);
  const req: RuntimeAgentRequest = {
    role: "backend-engineer", cwd: workspace, definitionPath: ".codex/agents/backend-engineer.toml",
    prompt: "test", autonomy: "edit", guards: { ...NO_GUARDS, writeAllow: ["src/**"] },
  };
  return { root, workspace, approval, req };
}

describe("TASK-027 a1 approval isolation", () => {
  it("refuses all four runtimes with only text hooks, including a mock claiming the codex id", () => {
    const { approval, req } = fixture();
    for (const id of ["claude-code", "antigravity", "opencode", "zcode", "codex"]) {
      const denial = approvalIsolationDenial(new MockRuntimeAdapter({ id }), req, approval);
      expect(denial, id).toContain("APPROVAL_ISOLATION_UNAVAILABLE");
    }
  });

  it("accepts Codex only with a native approval-channel read/write deny and disjoint write grants", () => {
    const { workspace, approval, req } = fixture();
    const runtime = new CodexAdapter({ projectRoot: workspace, spawnSync: () => { throw new Error("must not spawn"); } });
    expect(approvalIsolationDenial(runtime, req, approval)).toBeNull();
    expect(approvalIsolationDenial(runtime, { ...req, autonomy: "read-only" }, approval)).toBeNull();
    expect(approvalIsolationDenial(runtime, { ...req, guards: { ...req.guards, writeAllow: ["**"] } }, approval)).toBeNull();
  });

  it("refuses a write root containing the approval directory, or an approval file inside a granted root", () => {
    const { root, workspace, approval, req } = fixture();
    const runtime = new CodexAdapter({ projectRoot: workspace, spawnSync: () => { throw new Error("must not spawn"); } });
    expect(approvalIsolationDenial(runtime, {
      ...req, workRoots: [{ targetId: "unsafe", path: root, access: "write" }],
    }, approval)).toContain("overlaps");
    expect(approvalIsolationDenial(runtime, {
      ...req, cwd: root, guards: { ...req.guards, writeAllow: ["approval/github-app.json"] },
    }, approval)).toContain("overlaps");
  });

  it("refuses an unrepresentable glob before spawn", () => {
    const { workspace, approval, req } = fixture();
    const runtime = new CodexAdapter({ projectRoot: workspace, spawnSync: () => { throw new Error("must not spawn"); } });
    const guards: RuntimeGuards = { ...req.guards, writeAllow: ["does-not-exist/*/file"] };
    expect(approvalIsolationDenial(runtime, { ...req, guards }, approval)).toContain("cannot verify native boundary");
  });
});
