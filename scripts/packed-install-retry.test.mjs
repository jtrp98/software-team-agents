import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { installPackedWithRetry } from "./packed-install-retry.mjs";

test("packed install retries once from an empty fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-packed-retry-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules", "partial"), { recursive: true });
    fs.writeFileSync(path.join(root, "package-lock.json"), "partial");
    let attempts = 0;
    installPackedWithRetry((_args, cwd) => {
      attempts += 1;
      if (attempts === 1) throw new Error("asset timeout");
      assert.equal(fs.existsSync(path.join(cwd, "node_modules")), false);
      assert.equal(fs.existsSync(path.join(cwd, "package-lock.json")), false);
      return "installed";
    }, root, "candidate.tgz", "test");
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("packed install remains red after the bounded retry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-packed-retry-red-"));
  try {
    let attempts = 0;
    assert.throws(
      () => installPackedWithRetry(() => {
        attempts += 1;
        throw new Error(`bad package ${attempts}`);
      }, root, "candidate.tgz", "test"),
      /bad package 2[\s\S]*First packed-install attempt also failed: bad package 1/,
    );
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
