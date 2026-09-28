import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * V13 TASK-029: Unit tests for Antigravity's `.agents/hooks/sta-guard.js`
 * tool-call guard parser using real payloads captured from `agy` 1.2.7.
 */

const repoRoot = path.resolve(__dirname, "../../..");
const guardScript = path.join(repoRoot, ".agents", "hooks", "sta-guard.js");
const approvalDirName = [".sta-", "approval-channel"].join("");
const keyFileName = ["github-app.", "private-key.pem"].join("");

function runGuard(payload: unknown, env: Record<string, string> = {}): { status: number; stdout: string; parsed: { decision: string; reason?: string } } {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const proc = spawnSync(process.execPath, [guardScript], {
    input,
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  let parsed = { decision: "error", reason: proc.stderr || "unparseable stdout" };
  try {
    parsed = JSON.parse(proc.stdout.trim());
  } catch {
    // leave as error
  }
  return { status: proc.status ?? -1, stdout: proc.stdout, parsed };
}

describe("Antigravity sta-guard.js parser and policy verification (TASK-029)", () => {
  it("denies out-of-scope write for backend-engineer with real agy camelCase payload", () => {
    const payload = {
      conversationId: "test-conv-1",
      stepIdx: 1,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [repoRoot],
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: path.join(repoRoot, "planning", "v13", "evidence", "agy-spike", "test-write.txt"),
          CodeContent: "sample",
          Overwrite: true,
          toolAction: "Writing file",
          toolSummary: "Write file",
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "backend-engineer", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("outside this role's declared paths");
    expect(res.parsed.reason).toContain("You are running as `backend-engineer`");
  });

  it("allows in-scope write for backend-engineer with real agy payload", () => {
    const payload = {
      conversationId: "test-conv-2",
      stepIdx: 2,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [repoRoot],
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: path.join(repoRoot, "README.md"),
          CodeContent: "update readme",
          Overwrite: true,
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "backend-engineer", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("allow");
  });

  it("denies write to human-owned approval channel even without STA_ROLE or STA_WORKSPACE_ROOT", () => {
    const payload = {
      conversationId: "test-conv-3",
      stepIdx: 3,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [],
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: `C:/Users/jabja/${approvalDirName}/evil.txt`,
          CodeContent: "evil payload",
          Overwrite: true,
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "", STA_WORKSPACE_ROOT: "" });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("human-owned STA approval channel");
  });

  it("denies view_file reading GitHub App private key in approval channel", () => {
    const payload = {
      conversationId: "test-conv-4",
      stepIdx: 4,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [repoRoot],
      toolCall: {
        name: "view_file",
        args: {
          AbsolutePath: `C:/Users/jabja/${approvalDirName}/${keyFileName}`,
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "backend-engineer", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("human-owned STA approval channel");
  });

  it("denies run_command executing shell that names approval channel directory", () => {
    const payload = {
      conversationId: "test-conv-5",
      stepIdx: 5,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [repoRoot],
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: `cat ~/${approvalDirName}/approvers.json`,
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "backend-engineer", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("human-owned STA approval channel");
  });

  it("denies unassigned direct session writing governed artifacts (_docs/**)", () => {
    const payload = {
      conversationId: "test-conv-6",
      stepIdx: 6,
      modelName: "gemini-3.7-flash-medium",
      workspacePaths: [repoRoot],
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: path.join(repoRoot, "_docs", "status.md"),
          CodeContent: "tampered status",
          Overwrite: true,
        },
      },
    };

    const res = runGuard(payload, { STA_ROLE: "", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("governed work");
  });

  it("fails closed (deny) on unparseable/corrupt stdin", () => {
    const res = runGuard("NOT_A_VALID_JSON{", { STA_ROLE: "backend-engineer", STA_WORKSPACE_ROOT: repoRoot });
    expect(res.status).toBe(0);
    expect(res.parsed.decision).toBe("deny");
    expect(res.parsed.reason).toContain("could not parse the hook payload");
  });
});
