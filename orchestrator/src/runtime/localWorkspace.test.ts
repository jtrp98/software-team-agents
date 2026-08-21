import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWorkspace, OutsideWorkspaceError } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { missingRequiredCapabilities, REQUIRED_RUNTIME_CAPABILITIES } from "./runtimeCapabilities.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-workspace-"));
}

describe("LocalWorkspace (T108)", () => {
  it("round-trips a file, creating the directories on the way", async () => {
    const ws = new LocalWorkspace({ root: tmpRoot() });
    await ws.writeFile("_docs/module/sales-crm/review.md", "## Round 1 (FULL)");
    expect(await ws.readFile("_docs/module/sales-crm/review.md")).toBe("## Round 1 (FULL)");
    expect(await ws.exists("_docs/module/sales-crm/review.md")).toBe(true);
  });

  /**
   * `null` rather than an exception, matching `agents/moduleDocs.ts`: the
   * QA/security readback has to tell "no review.md" from "an empty review.md",
   * and both are meaningful answers rather than faults.
   */
  it("returns null for a file that does not exist", async () => {
    const ws = new LocalWorkspace({ root: tmpRoot() });
    expect(await ws.readFile("_docs/module/nope/review.md")).toBeNull();
    expect(await ws.exists("_docs/module/nope/review.md")).toBe(false);
  });

  it("refuses to read or write outside its root", async () => {
    const ws = new LocalWorkspace({ root: tmpRoot() });
    await expect(ws.readFile("../escape.md")).rejects.toThrow(OutsideWorkspaceError);
    await expect(ws.writeFile("../../escape.md", "x")).rejects.toThrow(OutsideWorkspaceError);
  });

  /**
   * An escaping path is a caller bug, not a missing file. Answering `false`
   * would hide it behind a plausible result — the same rule the framework
   * applies to agents in `.claude/hooks/block-outside-repo.js`, applied to the
   * orchestrator's own reads.
   */
  it("throws rather than answering false when exists() is given an escaping path", async () => {
    const ws = new LocalWorkspace({ root: tmpRoot() });
    await expect(ws.exists("../../etc/passwd")).rejects.toThrow(OutsideWorkspaceError);
  });

  it("accepts an absolute path that is already inside the root", async () => {
    const root = tmpRoot();
    const ws = new LocalWorkspace({ root });
    await ws.writeFile(path.join(root, "inside.md"), "ok");
    expect(await ws.readFile("inside.md")).toBe("ok");
  });

  it("runs a command in the workspace root and reports its exit code and output", async () => {
    const root = tmpRoot();
    let capturedCwd: string | undefined;
    const ws = new LocalWorkspace({
      root,
      spawnSync: ((_cmd: string, _args: string[], options: { cwd?: string }) => {
        capturedCwd = options.cwd;
        return { status: 0, stdout: "clean", stderr: "", error: undefined } as never;
      }) as never,
    });

    const result = await ws.runCommand({ command: "npm", args: ["run", "typecheck"] });

    expect(capturedCwd).toBe(path.resolve(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("clean");
    expect(result.timedOut).toBe(false);
  });

  it("resolves a per-command cwd under the root, not anywhere the caller likes", async () => {
    const root = tmpRoot();
    let capturedCwd: string | undefined;
    const ws = new LocalWorkspace({
      root,
      spawnSync: ((_cmd: string, _args: string[], options: { cwd?: string }) => {
        capturedCwd = options.cwd;
        return { status: 0, stdout: "", stderr: "", error: undefined } as never;
      }) as never,
    });

    await ws.runCommand({ command: "npm", args: ["test"], cwd: "packages/api" });
    expect(capturedCwd).toBe(path.join(path.resolve(root), "packages", "api"));

    await expect(ws.runCommand({ command: "npm", args: ["test"], cwd: "../elsewhere" })).rejects.toThrow(
      OutsideWorkspaceError,
    );
  });

  /**
   * Node signals a timeout by returning normally with `error` set and a null
   * status — the shape T47 already had to handle for the agent spawn itself.
   * Read off `error.code` so a killed-by-signal run stays distinguishable from a
   * timed-out one.
   */
  it("reports a timeout as timedOut rather than as a plain non-zero exit", async () => {
    const ws = new LocalWorkspace({
      root: tmpRoot(),
      spawnSync: (() => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" }),
      })) as never,
    });

    const result = await ws.runCommand({ command: "npm", args: ["test"], timeoutMs: 5 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ETIMEDOUT/);
  });
});

describe("required runtime capabilities (T108)", () => {
  it("reports nothing missing for a runtime that declares everything the design assumes", () => {
    const declared = new Set(REQUIRED_RUNTIME_CAPABILITIES);
    expect(missingRequiredCapabilities(declared)).toEqual([]);
  });

  it("names each assumed capability a runtime does not declare", () => {
    const declared = new Set([RuntimeCapability.NAMED_AGENTS, RuntimeCapability.STRUCTURED_RESULT]);
    const missing = missingRequiredCapabilities(declared);

    expect(missing).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(missing).toContain(RuntimeCapability.EXIT_GUARD);
    expect(missing).toContain(RuntimeCapability.PROJECT_LEVEL_BINDING);
    expect(missing).not.toContain(RuntimeCapability.NAMED_AGENTS);
  });

  /**
   * Guarding a decision, not behaviour: a per-agent exit guard matters for an
   * interactive session that delegates and is irrelevant under the
   * orchestrator, which runs one process per role. Listing it as universally
   * required would make a correct autonomous-only setup report as broken.
   */
  it("does not treat PER_AGENT_EXIT_GUARD as universally required", () => {
    expect(REQUIRED_RUNTIME_CAPABILITIES).not.toContain(RuntimeCapability.PER_AGENT_EXIT_GUARD);
  });

  /** Same reasoning: absent cost reporting degrades the budget guard's input, it does not stop a run. */
  it("does not treat COST_REPORTING as universally required", () => {
    expect(REQUIRED_RUNTIME_CAPABILITIES).not.toContain(RuntimeCapability.COST_REPORTING);
  });
});
