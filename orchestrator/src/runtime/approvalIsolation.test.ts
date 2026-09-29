import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalIsolationDenial } from "../cli/composition/approvalIsolation.js";
import { AntigravityAdapter } from "./antigravityAdapter.js";
import { ClaudeCodeAdapter, claudeIsolationInvocationFor, claudeIsolationRunDirs } from "./claudeCodeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import { OpenCodeAdapter } from "./openCodeAdapter.js";
import { NO_GUARDS, type RuntimeAgentRequest, type RuntimeGuards } from "./runtimeAdapter.js";
import { ZcodeAdapter } from "./zcodeAdapter.js";

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

  it("refuses each concrete non-isolated adapter before spawn at every autonomy level", () => {
    const { workspace, approval, req } = fixture();
    const neverSpawn = () => { throw new Error("must not spawn"); };
    // TASK-031 R14F spike: none of these has an OS boundary covering its built-in file tools.
    const runtimes = [
      new AntigravityAdapter({ projectRoot: workspace, spawnSync: neverSpawn }),
      new OpenCodeAdapter({ projectRoot: workspace, spawnSync: neverSpawn }),
      new ZcodeAdapter({ projectRoot: workspace, spawnSync: neverSpawn }),
    ];
    for (const runtime of runtimes) {
      for (const autonomy of ["read-only", "propose", "edit", "full"] as const) {
        expect(approvalIsolationDenial(runtime, { ...req, autonomy }, approval), `${runtime.id}/${autonomy}`)
          .toContain("APPROVAL_ISOLATION_UNAVAILABLE");
      }
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

  describe("TASK-031 Claude Code under the whole-process Codex sandbox wrapper", () => {
    const winOnly = it.runIf(process.platform === "win32");
    const claude = (workspace: string) => new ClaudeCodeAdapter({ projectRoot: workspace, spawnSync: () => { throw new Error("must not spawn"); } });

    winOnly("accepts the real Claude Code invocation at every autonomy level: elevated wrapper, exact deny, disjoint grants", () => {
      const { workspace, approval, req } = fixture();
      for (const autonomy of ["read-only", "propose", "edit", "full"] as const) {
        expect(approvalIsolationDenial(claude(workspace), { ...req, autonomy }, approval), autonomy).toBeNull();
      }
      expect(approvalIsolationDenial(claude(workspace), { ...req, guards: { ...req.guards, writeAllow: ["**"] } }, approval)).toBeNull();
    });

    winOnly("the preflight inspects the same builder the spawn uses: deny entry, elevated backend, per-run homes", () => {
      const { root, workspace, approval, req } = fixture();
      const inv = claudeIsolationInvocationFor(req, claudeIsolationRunDirs(path.join(root, "run")), approval);
      const profile = inv.sandboxArgs.find((arg) => arg.startsWith("permissions.sta_run="))!;
      expect(inv.sandboxArgs.slice(0, 1)).toEqual(["sandbox"]);
      expect(inv.sandboxArgs).toContain('windows.sandbox="elevated"');
      expect(profile).toContain(`${JSON.stringify(fs.realpathSync.native(approval))} = "deny"`);
      expect(profile).toContain('":root" = "read"');
      // OS network lock: the only egress is the adapter's loopback allowlist proxy.
      expect(profile.endsWith("network = { enabled = false } }")).toBe(true);
      expect(profile).toContain('".claude" = "read"');
      expect(inv.env.CLAUDE_CONFIG_DIR).toBe(path.join(root, "run", "config"));
      expect(inv.writeGrants).not.toContain(path.join(os.homedir(), ".claude"));
      expect(inv.writeGrants).toContain(path.resolve(workspace, "src"));
    });

    winOnly("refuses a write root containing the approval directory, or an approval file inside a granted root", () => {
      const { root, workspace, approval, req } = fixture();
      expect(approvalIsolationDenial(claude(workspace), {
        ...req, workRoots: [{ targetId: "unsafe", path: root, access: "write" }],
      }, approval)).toContain("overlaps");
      expect(approvalIsolationDenial(claude(workspace), {
        ...req, cwd: root, guards: { ...req.guards, writeAllow: ["approval/github-app.json"] },
      }, approval)).toContain("overlaps");
    });

    winOnly("resolves a junction to the approval channel before judging overlap", () => {
      const { root, workspace, approval, req } = fixture();
      const link = path.join(root, "innocent-looking");
      fs.symlinkSync(approval, link, "junction");
      expect(approvalIsolationDenial(claude(workspace), {
        ...req, workRoots: [{ targetId: "linked", path: link, access: "write" }],
      }, approval)).toContain("overlaps");
    });

    winOnly("refuses an unrepresentable glob before spawn", () => {
      const { workspace, approval, req } = fixture();
      const guards: RuntimeGuards = { ...req.guards, writeAllow: ["does-not-exist/*/file"] };
      expect(approvalIsolationDenial(claude(workspace), { ...req, guards }, approval)).toContain("cannot verify native boundary");
    });

    it("the wrapper builder refuses any platform other than the verified Windows backend", () => {
      const { root, approval, req } = fixture();
      for (const platform of ["linux", "darwin"]) {
        expect(() => claudeIsolationInvocationFor(req, claudeIsolationRunDirs(path.join(root, "run")), approval, platform)).toThrow(/verified only on Windows/);
      }
    });
  });
});
