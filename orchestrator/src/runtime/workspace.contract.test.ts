import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LocalWorkspace, OutsideWorkspaceError } from "./localWorkspace.js";
import { MemoryWorkspace } from "./mockAdapter.js";
import type { RuntimeWorkspace } from "./runtimeAdapter.js";

/**
 * OFF04 — the Tool-execution port's contract, stated once and applied to every
 * implementation.
 *
 * `RuntimeWorkspace` is how the framework reads artifacts back (review.md,
 * security.md), writes nothing outside what preflight granted, and runs the
 * deterministic verification commands. Anything that satisfies this interface
 * must satisfy the behaviours below, or callers written against one
 * implementation silently break on another. New implementations join by adding
 * one entry to `implementations` — that is the whole point of a contract suite:
 * the interface is only "stable" if conformance is checkable.
 */

const implementations: [string, () => RuntimeWorkspace][] = [
  ["MemoryWorkspace", () => new MemoryWorkspace()],
  ["LocalWorkspace", () => new LocalWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), "sta-ws-contract-")) })],
];

describe.each(implementations)("RuntimeWorkspace contract — %s", (_name, make) => {
  it("round-trips a write through a nested path", async () => {
    const ws = make();
    await ws.writeFile("deep/nested/file.txt", "content");
    await expect(ws.readFile("deep/nested/file.txt")).resolves.toBe("content");
  });

  it("answers null — not an error — for a file that does not exist", async () => {
    const ws = make();
    await expect(ws.readFile("absent.txt")).resolves.toBeNull();
  });

  it("reports existence honestly after a write", async () => {
    const ws = make();
    await expect(ws.exists("maybe.txt")).resolves.toBe(false);
    await ws.writeFile("maybe.txt", "");
    await expect(ws.exists("maybe.txt")).resolves.toBe(true);
  });

  it("returns a fully-shaped command result", async () => {
    const ws = make();
    if (ws instanceof MemoryWorkspace) {
      ws.commandResults.set(process.execPath, { exitCode: 0, stdout: "out", stderr: "", timedOut: false });
    }
    // `echo` is a shell builtin on some platforms and spawnSync runs no shell —
    // node itself is the one executable every machine running these tests has.
    const result = await ws.runCommand({ command: process.execPath, args: ["-e", "process.stdout.write('out')"], timeoutMs: 30_000 });
    expect(Object.keys(result).sort()).toEqual(["exitCode", "stderr", "stdout", "timedOut"].sort());
    expect(typeof result.exitCode).toBe("number");
    expect(result.timedOut).toBe(false);
  });
});

describe("LocalWorkspace specifics", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-ws-local-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to resolve, read, write, or probe outside its root", async () => {
    const ws = new LocalWorkspace({ root });
    expect(() => ws.resolve("../outside.txt")).toThrow(OutsideWorkspaceError);
    await expect(ws.readFile("../outside.txt")).rejects.toBeInstanceOf(OutsideWorkspaceError);
    await expect(ws.writeFile("../outside.txt", "no")).rejects.toBeInstanceOf(OutsideWorkspaceError);
    // exists() is the deliberate exception: escaping is a caller bug there too,
    // but it rethrows rather than answering either way.
    await expect(ws.exists("../outside.txt")).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("runs a real command where the work lives", async () => {
    const ws = new LocalWorkspace({ root });
    const result = await ws.runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ran-in-workspace')"],
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ran-in-workspace");
  });

  it("reports a failing command's exit code without throwing", async () => {
    const ws = new LocalWorkspace({ root });
    const result = await ws.runCommand({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("distinguishes a timeout from any other failure", async () => {
    const ws = new LocalWorkspace({
      root,
      // Node reports a timeout as a normal return with `.error` set — the
      // workspace must read `.code`, not infer from a null status, so a
      // killed-by-signal run stays distinguishable. The fake reproduces that shape.
      spawnSync: (() => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
        pid: 1,
        output: [],
        signal: null,
      })) as unknown as typeof import("node:child_process").spawnSync,
    });
    await expect(ws.runCommand({ command: "slow", args: [] })).resolves.toEqual({
      exitCode: null,
      stdout: "",
      // runCommand appends the error's message rather than using it as a
      // fallback — on a real timeout stderr is empty and this message is the
      // only description of what happened.
      stderr: "spawn timed out",
      timedOut: true,
    });
  });
});

describe("MemoryWorkspace specifics", () => {
  it("never touches the filesystem, so a directory exists when a file under it does", async () => {
    const ws = new MemoryWorkspace();
    await ws.writeFile("binding/agents/qa-engineer.md", "role text");
    await expect(ws.exists("binding/agents")).resolves.toBe(true);
    await expect(ws.exists("binding")).resolves.toBe(true);
  });
});
