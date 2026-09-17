import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Simulate the Windows indexer: the injected denial state rejects a rename of
// the temp file N times before letting the real fs through.
const denial = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (denial.remaining > 0 && String(from).includes(".tmp")) {
        denial.remaining--;
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return actual.renameSync(from, to);
    },
  };
});

const { renameSyncRetrying } = await import("./atomicRename.js");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-rename-"));
}

describe("renameSyncRetrying — durable temp+rename under Windows transient locks", () => {
  it("renames normally when nothing contests the destination", () => {
    const dir = tempDir();
    const temp = path.join(dir, "state.yaml.tmp");
    const dest = path.join(dir, "state.yaml");
    fs.writeFileSync(temp, "body\n");
    renameSyncRetrying(temp, dest);
    expect(fs.readFileSync(dest, "utf8")).toBe("body\n");
    expect(fs.existsSync(temp)).toBe(false);
  });

  it("succeeds when the transient denial clears within the backoff window", () => {
    const dir = tempDir();
    const temp = path.join(dir, "state.yaml.tmp");
    const dest = path.join(dir, "state.yaml");
    fs.writeFileSync(temp, "body\n");
    fs.writeFileSync(dest, "stale\n");
    denial.remaining = 2;
    renameSyncRetrying(temp, dest);
    expect(denial.remaining).toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toBe("body\n");
    expect(fs.existsSync(temp)).toBe(false);
  });

  it("exhausts the backoff on a persistent denial and rethrows the last error", () => {
    const dir = tempDir();
    const temp = path.join(dir, "state.yaml.tmp");
    const dest = path.join(dir, "state.yaml");
    fs.writeFileSync(dest, "stale\n");
    denial.remaining = Number.MAX_SAFE_INTEGER;
    expect(() => renameSyncRetrying(temp, dest)).toThrow();
    denial.remaining = 0;
  });

  it("rethrows a non-transient error immediately", () => {
    const dir = tempDir();
    const missing = path.join(dir, "does-not-exist.tmp");
    const dest = path.join(dir, "state.yaml");
    const error = (() => {
      try {
        renameSyncRetrying(missing, dest);
        return null;
      } catch (e) {
        return e as NodeJS.ErrnoException;
      }
    })();
    expect(error?.code).toBe("ENOENT");
  });
});
