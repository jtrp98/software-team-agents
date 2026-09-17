import * as fs from "node:fs";

const RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows can transiently deny a temp+rename when the destination's just-written
 * bytes are still held by an indexer/scanner (EPERM/EACCES/EBUSY); the lock
 * clears in milliseconds. A bounded backoff turns that into a non-event instead
 * of a failed durable write. Any other errno — and the final exhausted attempt —
 * rethrow unchanged: this widens nothing that a real conflict or disk error
 * should still stop.
 */
export function renameSyncRetrying(temp: string, destination: string): void {
  const attempts = [...RETRY_DELAYS_MS, 0];
  for (const delayMs of attempts) {
    try {
      fs.renameSync(temp, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || delayMs === 0) throw error;
      sleepSync(delayMs);
    }
  }
}
