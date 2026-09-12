import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Install a release artifact into a disposable fixture, with one bounded retry.
 * Native prebuilds are hosted separately from the npm registry, so a transient
 * asset timeout must not make an otherwise deterministic release sweep flaky.
 * A bad package still fails: the second attempt rethrows the original command
 * failure after starting from an empty fixture install.
 */
export function installPackedWithRetry(runNpm, cwd, tgz, label) {
  const args = ["install", "--no-audit", "--no-fund", "--loglevel=error", tgz];
  try {
    return runNpm(args, cwd);
  } catch (firstError) {
    console.warn(`[${label}] packed install failed once; retrying from an empty fixture install`);
    fs.rmSync(path.join(cwd, "node_modules"), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
    fs.rmSync(path.join(cwd, "package-lock.json"), { force: true });
    try {
      return runNpm(args, cwd);
    } catch (secondError) {
      if (secondError instanceof Error && firstError instanceof Error) {
        secondError.message += `\nFirst packed-install attempt also failed: ${firstError.message}`;
      }
      throw secondError;
    }
  }
}
