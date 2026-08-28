import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_ARTIFACT_RETENTION,
  pruneRuntimeArtifacts,
  runtimeArtifactPaths,
} from "./runtimeArtifacts.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-runtime-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("T-V3R-003 runtime artifact contract", () => {
  it("declares packet, evidence and run homes below .workflow and creates none eagerly", () => {
    const root = tempRoot();
    const paths = runtimeArtifactPaths(root, "T-V3R-003");
    expect(paths).toEqual({
      packets: path.join(root, ".workflow", "packets", "T-V3R-003"),
      evidence: path.join(root, ".workflow", "evidence", "T-V3R-003"),
      runs: path.join(root, ".workflow", "runs", "T-V3R-003"),
    });
    expect(fs.existsSync(path.join(root, ".workflow"))).toBe(false);
  });

  it("encodes task ids so path-like input cannot escape the runtime-state home", () => {
    const root = tempRoot();
    const resolved = runtimeArtifactPaths(root, "../outside").packets;
    expect(path.relative(path.join(root, ".workflow", "packets"), resolved)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(resolved).toContain("..%2Foutside");
  });

  it("bounds growth deterministically while never pruning the current run artifact", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-RETENTION").packets;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const names = Array.from({ length: DEFAULT_RUNTIME_ARTIFACT_RETENTION + 2 }, (_, index) => `${String(index).padStart(2, "0")}.json`);
    for (const [index, name] of names.entries()) {
      const file = path.join(taskDirectory, name);
      fs.writeFileSync(file, name, "utf8");
      const time = new Date(1_000 + index * 1_000);
      fs.utimesSync(file, time, time);
    }
    const current = path.join(taskDirectory, names[0]); // deliberately oldest

    const removed = pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current });
    const remaining = fs.readdirSync(taskDirectory).sort();
    expect(remaining).toHaveLength(DEFAULT_RUNTIME_ARTIFACT_RETENTION);
    expect(remaining).toContain(names[0]);
    expect(removed.map((file) => path.basename(file))).toEqual([names[1], names[2]]);
    expect(pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current })).toEqual([]);
  });

  it("refuses an invalid bound or a current artifact outside the task directory before deleting anything", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-SAFE").evidence;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const current = path.join(taskDirectory, "current.json");
    fs.writeFileSync(current, "current", "utf8");
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "outside", "utf8");

    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current, maxRunsPerTask: 0 })).toThrow(/positive integer/);
    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: outside })).toThrow(/direct child/);
    expect(fs.readFileSync(current, "utf8")).toBe("current");
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("never follows a symlink presented as the current artifact", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-SYMLINK").runs;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel.json"), "outside", "utf8");
    const linked = path.join(taskDirectory, "current.json");
    fs.symlinkSync(outside, linked, "junction");

    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: linked, maxRunsPerTask: 1 })).toThrow(/not a file/);
    expect(fs.readFileSync(path.join(outside, "sentinel.json"), "utf8")).toBe("outside");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });
});
