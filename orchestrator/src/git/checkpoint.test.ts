import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runDeterministicVerification,
  type DeterministicCheckId,
  type DeterministicVerification,
} from "../qa/deterministic.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import {
  checkpointMessages,
  CheckpointRefusal,
  checkpointTask,
  parsePorcelainStatus,
} from "./checkpoint.js";
import { defaultGitProcessRunner, GitCommandLayer, type GitProcessRunner } from "./commandLayer.js";

const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function run(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-checkpoint-"));
  run(root, ["init", "-b", "main"]);
  run(root, ["config", "user.name", "Fixture"]);
  run(root, ["config", "user.email", "fixture@example.invalid"]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "base.txt"), "base\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "outside\n");
  run(root, ["add", "--", "src/base.txt", "outside.txt"]);
  run(root, ["commit", "-m", "initial", "--"]);
  return root;
}

function verification(status: DeterministicVerification["status"] = "passed"): DeterministicVerification {
  const ids: DeterministicCheckId[] = ["lint", "typecheck", "unit-tests", "build"];
  const ran = status === "passed"
    ? ids.map((id) => ({ id, status: "PASS" as const, durationMs: 1, outputSummary: "ok" }))
    : status === "failed"
      ? [{ id: "typecheck" as const, status: "FAIL" as const, durationMs: 1, outputSummary: "failed" }]
      : [];
  return {
    required: ids,
    ran,
    failures: ran.filter((item) => item.status === "FAIL"),
    skipped: status === "skipped" ? ids : [],
    missingRequired: status === "skipped" ? ids : [],
    status,
    enforcement: "enforce",
    passed: status === "passed",
  };
}

const adapter = {
  status: "OK",
  exitCode: 0,
  text: "I changed src/new.txt and phantom-from-model.txt",
} as RuntimeAgentResult;

function input(root: string, overrides: Record<string, unknown> = {}) {
  return {
    git: new GitCommandLayer({ cwd: root }),
    adapter,
    writableRoots: [path.join(root, "src")],
    runVerification: () => runDeterministicVerification((id) => ({
      id,
      status: "PASS",
      durationMs: 1,
      outputSummary: "ok",
    })),
    runId: "run-1",
    taskId: "BE-004",
    module: "example",
    planHash: "abc123",
    taskDescription: "implement the checkpoint",
    secretScanner: () => ({ ok: true, problems: [] }),
    ...overrides,
  };
}

async function refusalKind(promise: Promise<unknown>): Promise<CheckpointRefusal["kind"]> {
  try {
    await promise;
    throw new Error("checkpoint unexpectedly created");
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointRefusal);
    return (error as CheckpointRefusal).kind;
  }
}

describe("checkpoint status parsing and messages", () => {
  it("keeps both sides of a rename from NUL-terminated porcelain output", () => {
    expect(parsePorcelainStatus(" M src/a.ts\0R  src/new.ts\0src/old.ts\0?? src/b.ts\0"))
      .toEqual(["src/a.ts", "src/new.ts", "src/old.ts", "src/b.ts"]);
  });

  it("sanitizes untrusted text, caps the subject and generates one trailer block", () => {
    const [subject, trailers] = checkpointMessages({
      taskId: "BE-004\n--amend",
      taskDescription: "-leading\n" + "x".repeat(100),
      runId: "run-1\nInjected: no",
      module: "example\rmodule",
      planHash: "abc123",
      verification: verification(),
    });
    expect(subject).toHaveLength(72);
    expect(subject).toMatch(/^sta\(BE-004_--amend\): -leading x/);
    expect(subject).not.toContain("\n");
    expect(trailers.split("\n")).toEqual([
      "STA-Run-Id: run-1 Injected: no",
      "STA-Task-Id: BE-004 --amend",
      "STA-Module: example module",
      "STA-Plan-Hash: abc123",
      "STA-Gate: lint=PASS typecheck=PASS build=PASS unit-tests=PASS",
    ]);
  });
});

describe("checkpoint integration", () => {
  it("stages only status-derived paths, commits additions/deletions with trailers, and creates no tags", async () => {
    const root = fixture();
    const calls: string[][] = [];
    try {
      fs.writeFileSync(path.join(root, "src", "new.txt"), "new\n");
      fs.rmSync(path.join(root, "src", "base.txt"));
      const processRunner: GitProcessRunner = async (args, options) => {
        calls.push([...args]);
        return defaultGitProcessRunner(args, options);
      };
      const result = await checkpointTask(input(root, {
        git: new GitCommandLayer({ cwd: root, processRunner }),
      }));
      expect([...result.changedPaths].sort()).toEqual(["src/base.txt", "src/new.txt"]);
      expect(run(root, ["show", "--pretty=format:", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean).sort())
        .toEqual(["src/base.txt", "src/new.txt"]);
      expect(run(root, ["log", "-1", "--format=%s"])).toBe("sta(BE-004): implement the checkpoint");
      const body = run(root, ["log", "-1", "--format=%B"]);
      expect(body).toContain("STA-Task-Id: BE-004");
      const parsedTrailers = execFileSync("git", ["interpret-trailers", "--parse"], { input: body, encoding: "utf8" });
      expect(parsedTrailers).toContain("STA-Run-Id: run-1");
      expect(parsedTrailers).toContain("STA-Gate: lint=PASS typecheck=PASS build=PASS unit-tests=PASS");
      expect(run(root, ["log", "--format=%H", "--grep=STA-Task-Id: BE-004"])).toBe(result.sha);
      expect(run(root, ["tag", "-l"])).toBe("");
      expect(run(root, ["for-each-ref", "--format=%(refname)"]).split(/\r?\n/).every((ref) => ref.startsWith("refs/heads/"))).toBe(true);
      expect(calls.some((args) => args[0] === "add" && args.includes("phantom-from-model.txt"))).toBe(false);
      expect(calls.every((args) => !args.includes("-A") && !args.includes("-a"))).toBe(true);
      const commitArgs = calls.find((args) => args.includes("commit")) ?? [];
      expect(commitArgs.filter((arg) => arg === "-m")).toHaveLength(2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an adapter error before status or verification", async () => {
    const root = fixture();
    let processCalls = 0;
    let verificationCalls = 0;
    try {
      const git = new GitCommandLayer({ cwd: root, processRunner: async () => {
        processCalls += 1;
        return { stdout: "", stderr: "" };
      } });
      expect(await refusalKind(checkpointTask(input(root, {
        git,
        adapter: { status: "ERROR", exitCode: 1 },
        runVerification: async () => { verificationCalls += 1; return verification(); },
      })))).toBe("ADAPTER_FAILURE");
      expect(processCalls).toBe(0);
      expect(verificationCalls).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("reports NO_CHANGES and does not run verification or create a commit", async () => {
    const root = fixture();
    let verificationCalls = 0;
    try {
      const before = run(root, ["rev-parse", "HEAD"]);
      expect(await refusalKind(checkpointTask(input(root, {
        runVerification: async () => { verificationCalls += 1; return verification(); },
      })))).toBe("NO_CHANGES");
      expect(verificationCalls).toBe(0);
      expect(run(root, ["rev-parse", "HEAD"])).toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("halts on a path outside writable roots before verification, staging or commit", async () => {
    const root = fixture();
    let verificationCalls = 0;
    try {
      fs.writeFileSync(path.join(root, "outside.txt"), "changed outside\n");
      const before = run(root, ["rev-parse", "HEAD"]);
      expect(await refusalKind(checkpointTask(input(root, {
        runVerification: async () => { verificationCalls += 1; return verification(); },
      })))).toBe("GUARD_FAILURE");
      expect(verificationCalls).toBe(0);
      expect(run(root, ["diff", "--cached", "--name-only"])).toBe("");
      expect(run(root, ["rev-parse", "HEAD"])).toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("halts on UNIVERSAL_DENY content before verification", async () => {
    const root = fixture();
    try {
      fs.mkdirSync(path.join(root, ".workflow"));
      fs.writeFileSync(path.join(root, ".workflow", "forged.json"), "{}\n");
      expect(await refusalKind(checkpointTask(input(root, {
        writableRoots: [root],
      })))).toBe("DENIED_PATH");
      expect(run(root, ["diff", "--cached", "--name-only"])).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("halts when a changed symlink resolves outside the writable root", async () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sta-checkpoint-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
      fs.symlinkSync(outside, path.join(root, "src", "escape"), process.platform === "win32" ? "junction" : "dir");
      expect(await refusalKind(checkpointTask(input(root)))).toBe("GUARD_FAILURE");
      expect(run(root, ["diff", "--cached", "--name-only"])).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(["skipped", "failed"] as const)("keeps a %s deterministic result distinct and uncommitted", async (status) => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "src", "new.txt"), "new\n");
      const before = run(root, ["rev-parse", "HEAD"]);
      const kind = await refusalKind(checkpointTask(input(root, { runVerification: async () => verification(status) })));
      expect(kind).toBe(status === "skipped" ? "DETERMINISTIC_SKIPPED" : "DETERMINISTIC_FAILED");
      expect(run(root, ["diff", "--cached", "--name-only"])).toBe("");
      expect(run(root, ["rev-parse", "HEAD"])).toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the static-analysis gate's secret pattern and refuses before staging", async () => {
    const root = fixture();
    try {
      const scripts = path.join(root, ".claude", "scripts");
      fs.mkdirSync(scripts, { recursive: true });
      fs.copyFileSync(path.join(FRAMEWORK_ROOT, ".claude", "scripts", "static-analysis-gate.js"), path.join(scripts, "static-analysis-gate.js"));
      fs.copyFileSync(path.join(FRAMEWORK_ROOT, ".claude", "scripts", "package.json"), path.join(scripts, "package.json"));
      run(root, ["add", "--", ".claude/scripts/static-analysis-gate.js", ".claude/scripts/package.json"]);
      run(root, ["commit", "-m", "install fixture scanner", "--"]);
      fs.writeFileSync(path.join(root, "src", "secret.ts"), 'const key = process.env.JWT_SECRET || "hardcoded";\n');
      expect(await refusalKind(checkpointTask(input(root, { secretScanner: undefined })))).toBe("SECRET_DETECTED");
      expect(run(root, ["diff", "--cached", "--name-only"])).toBe("");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
