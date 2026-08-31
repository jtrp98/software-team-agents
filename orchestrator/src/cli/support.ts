import { DEFAULT_BUDGET } from "../cost/costControl.js";
import { StaConfigMissingError, loadStaConfig } from "../packaging/staConfig.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath, defaultStateViewPath } from "../store/stateView.js";

/** Flags a verb accepts that take a value — their value must never be mistaken for a positional argument. */
const VERB_VALUE_FLAGS = new Set(["--project-root", "--state-db", "--reason", "--interval", "--module", "--phase", "--task", "--target", "--by", "--since", "--docs-root", "--config-path", "--source-root", "--knowledge-root", "--figma-email", "--claude-email", "--now", "--confirm", "--export-json", "--baseline", "--escaped-defects", "--runtime", "--model", "--mode", "--as", "--note", "--lane"]);

/** Every non-flag token in a verb's remaining args, in order, skipping over each value-flag's own argument. */
export function positionalArgs(rest: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      if (VERB_VALUE_FLAGS.has(rest[i])) i++;
      continue;
    }
    found.push(rest[i]);
  }
  return found;
}

export function positionalArg(rest: string[]): string | undefined {
  return positionalArgs(rest)[0];
}

export function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i === -1 ? undefined : rest[i + 1];
}

export function openStore(projectRoot: string, stateDb?: string): { store: SqliteTaskStore; registry: TaskRegistry } {
  const store = new SqliteTaskStore(stateDb ?? defaultStateDbPath(projectRoot));
  const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(projectRoot) });
  return { store, registry };
}

export function configuredTokenBudget(projectRoot: string): number {
  let configured: number | undefined;
  try {
    configured = loadStaConfig(projectRoot).token_budget;
  } catch (error) {
    if (!(error instanceof StaConfigMissingError)) throw error;
  }
  return configured ?? DEFAULT_BUDGET.token_budget;
}
