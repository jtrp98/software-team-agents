import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliUsageError, runCli } from "../../cli.js";
import { parseBoundedRunArgs, BOUNDED_RUN_USAGE } from "./boundedRun.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../../runtime/mockAdapter.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";

/**
 * T-V8-021 — CLI-level coverage for the explicit bounded-run command:
 * parsing/refusal, the ambiguity gate, dry-run preview, an eligible run to
 * COMPLETED, a gated run, and `--resume`. `boundedRunServices.test.ts` already
 * proves the production services in isolation; this file proves the CLI
 * surface (`sta bounded-run`) that composes them, exactly as a caller
 * (or `sta status`/`sta report`'s "next required action" reader) would use it.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const roots: string[] = [];

// `resolveContextDocsRoot` reads `AGENTCLAUDE_KNOWLEDGE_ROOT`/an installation
// config before falling back to `projectRoot` — a fixture must not inherit
// whatever real three-repo installation happens to be configured on the
// machine running this suite (`cli.test.ts` pins the same two vars).
const KNOWLEDGE_ROOT_ORIGINAL = process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
const INSTALLATION_CONFIG_ORIGINAL = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
beforeEach(() => {
  delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-boundedrun-test-no-installation.yaml");
});
afterEach(() => {
  if (KNOWLEDGE_ROOT_ORIGINAL === undefined) delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
  else process.env.AGENTCLAUDE_KNOWLEDGE_ROOT = KNOWLEDGE_ROOT_ORIGINAL;
  if (INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
  else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = INSTALLATION_CONFIG_ORIGINAL;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("parseBoundedRunArgs", () => {
  it("requires --module and exactly one scope for a new run", () => {
    expect(() => parseBoundedRunArgs(["--all"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--phase", "1"], "/repo")).toThrow(CliUsageError);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit"], "/repo")).not.toThrow();
  });

  it("requires --autonomy edit|full for an unattended (non-dry-run) new run", () => {
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all"], "/repo")).toThrow(/--autonomy/);
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--dry-run"], "/repo")).not.toThrow();
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "read-only"], "/repo")).toThrow(/--autonomy edit or --autonomy full/);
  });

  it("validates --until against the closed RunBoundary vocabulary", () => {
    expect(() => parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit", "--until", "nope"], "/repo")).toThrow(/--until must be one of/);
    for (const until of ["next-gate", "qa", "done"]) {
      expect(parseBoundedRunArgs(["--module", "orders", "--all", "--autonomy", "edit", "--until", until], "/repo").until).toBe(until);
    }
  });

  it("--resume refuses scope and classification flags — those belong to the frozen run, not to resuming it", () => {
    expect(() => parseBoundedRunArgs(["--resume", "01ABC", "--all"], "/repo")).toThrow(/--all\/--phase\/--task do not apply/);
    expect(() => parseBoundedRunArgs(["--resume", "01ABC", "--bug-fix"], "/repo")).toThrow(/classification flags do not apply/);
    expect(parseBoundedRunArgs(["--resume", "01ABC"], "/repo").resumeRunId).toBe("01ABC");
  });

  it("--task splits and trims a comma list; an empty one refuses", () => {
    expect(parseBoundedRunArgs(["--module", "m", "--task", "BE-1, BE-2", "--dry-run"], "/repo").scope).toEqual({ kind: "tasks", taskIds: ["BE-1", "BE-2"] });
    expect(() => parseBoundedRunArgs(["--module", "m", "--task", "", "--dry-run"], "/repo")).toThrow(CliUsageError);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--dry-run", "--not-a-flag"], "/repo")).toThrow(/unrecognized argument/);
  });

  it("USAGE names every classification override flag and both invocation forms", () => {
    expect(BOUNDED_RUN_USAGE).toContain("--resume");
    expect(BOUNDED_RUN_USAGE).toContain("--dry-run");
    expect(BOUNDED_RUN_USAGE).toContain("--bug-fix");
    expect(BOUNDED_RUN_USAGE).toContain("--schema");
  });
});

import { boundedRunProject as project } from "./boundedRunFixture.testSupport.js";

export function completingAdapter(targetRoot: string): MockRuntimeAdapter {
  let self: MockRuntimeAdapter;
  const adapter = new MockRuntimeAdapter({
    id: "claude-code",
    models: ["sonnet"],
    respond: (req) => {
      if (req.role === "qa-engineer") {
        self.workspace.files.set(
          "_docs/module/orders/review.md",
          "# review.md — orders\n\n## Round 1 — verify\n\n**Status:** ✅ Verified (FULL)\n\n" +
            "## Per-Task Results\n\n" +
            "- BE-004: ✅ Verified — the empty-order response stays stable.\n" +
            "- AC-007.2: ✅ Verified — zero-total response confirmed by inspection.\n" +
            "- DES-011: ✅ Verified — serializer boundary preserved.\n",
        );
        return okResult();
      }
      fs.writeFileSync(path.join(targetRoot, "README.md"), "# orders\n\nReviewed the empty-order summary path.\n");
      return okResult();
    },
    files: {
      ".mock/guards.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-path-permissions.js" }] }],
          Stop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }] }],
        },
      }),
    },
  });
  self = adapter;
  return adapter;
}


describe("sta bounded-run (CLI)", () => {
  it("dry-run preview matches what a real freeze would register, and mutates nothing", async () => {
    const { root, targetRoot } = project(roots, git);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("plan_hash=") && l.includes("tasks=1"))).toBe(true);
    expect(logs.some((l) => l.includes("BE-004") && l.includes("owner=backend-engineer"))).toBe(true);
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
    expect(git(targetRoot, "branch", "--list")).not.toContain("sta/run");
  });

  it("stops with the exact ambiguity rather than guessing when the requested scope names an unknown task", async () => {
    const { root, targetRoot } = project(roots, git);
    const errors: string[] = [];
    const spy = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--task", "NOPE", "--target-root", targetRoot, "--project-root", root, "--dry-run"],
        root,
      );
    } finally {
      console.error = spy;
    }
    expect(code).toBe(4);
    expect(errors.some((l) => l.includes("unknown-task") && l.includes("NOPE"))).toBe(true);
    // Nothing was registered — the refusal happened before any mutation.
    expect(fs.existsSync(path.join(root, "state.db"))).toBe(false);
  });

  it("runs an eligible task to COMPLETED through the real CLI dispatch", async () => {
    const { root, targetRoot } = project(roots, git);
    const adapter = completingAdapter(targetRoot);
    const registry = new RuntimeRegistry([adapter]);
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("froze run"))).toBe(true);
    expect(logs.some((l) => l.includes("COMPLETED"))).toBe(true);

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    const ledger = new SqliteRunLedger(store, { projectRoot: root });
    try {
      const runs = ledger.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("COMPLETED");
    } finally {
      ledger.close();
    }
  }, 30_000);

  it("gates a run with no runtime route, and names the exact resume command", async () => {
    const { root, targetRoot } = project(roots, git);
    const registry = new RuntimeRegistry([]); // nothing registered
    const logs: string[] = [];
    const spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(4);
    expect(logs.some((l) => l.includes("GATE"))).toBe(true);
    expect(logs.some((l) => l.includes("sta bounded-run --resume"))).toBe(true);
  });

  it("--resume reports current readiness without mutating state under --dry-run", async () => {
    const { root, targetRoot } = project(roots, git);
    const registry = new RuntimeRegistry([]);
    let runId = "";
    const capture: string[] = [];
    let spy = console.log;
    console.log = (line: string) => capture.push(line);
    try {
      await runCli(
        ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    const froze = capture.find((l) => l.includes("froze run"));
    expect(froze).toBeDefined();
    runId = froze!.match(/froze run (\S+):/)![1]!;

    const logs: string[] = [];
    spy = console.log;
    console.log = (line: string) => logs.push(line);
    let code: number;
    try {
      code = await runCli(
        ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--dry-run"],
        root,
        { createRuntimeRegistry: () => registry },
      );
    } finally {
      console.log = spy;
    }
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes(`resuming run ${runId}`))).toBe(true);
    expect(logs.some((l) => l.includes("readiness:"))).toBe(true);
  });
});
