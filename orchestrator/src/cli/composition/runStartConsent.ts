import * as readline from "node:readline";
import { resolveIndexConsent } from "../../codeintel/consent.js";

/**
 * The run-start consent hook (V10 TASK-015, ADR-006 Option A): for each
 * Target the run will touch, resolve index freshness and — when it is not
 * fresh and no consent record answers for that `targetId + revision` — ask
 * the person at the terminal once. Glue only: every per-target failure is
 * caught here, because a broken consent check must never stop a run.
 */
export interface RunStartConsentTarget {
  targetId: string;
  path: string;
}

export interface RunStartConsentOptions {
  /** A person is at the terminal; `false` (headless) never poses the question. */
  interactive: boolean;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export async function askCodeIntelConsentAtRunStart(
  targets: readonly RunStartConsentTarget[],
  options: RunStartConsentOptions,
): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const prompt = options.prompt ?? (options.interactive ? terminalPrompt : undefined);
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.targetId)) continue;
    seen.add(target.targetId);
    try {
      await resolveIndexConsent(
        { targetId: target.targetId, targetRoot: target.path },
        { actor: process.env.USER ?? process.env.USERNAME, ...(prompt ? { prompt } : {}), log },
      );
    } catch (error) {
      log(`[code-intel] consent check skipped for ${target.targetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function terminalPrompt(question: string): Promise<string> {
  // A per-question readline lifecycle — a long-lived
  // interface here would fight whatever stdin handling the caller already has.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve, reject) => {
    rl.question(`${question} `, (answer) => resolve(answer));
    rl.on("close", () => reject(new Error("stdin closed before the code-intel consent question was answered")));
  }).finally(() => rl.close());
}
