import { AgentStage } from "../types.js";
import { defaultCacheRoot } from "../codeintel/cache.js";
import { GraphifyProvider } from "../codeintel/graphifyProvider.js";
import { resolveTargetRevision } from "../codeintel/targetRevision.js";
import { resolveCodeContext } from "../codeintel/resolver.js";
import type { CodeIntelligenceProvider } from "../codeintel/provider.js";

/**
 * The one place the optional code-intelligence provider touches a run's prompt.
 *
 * The shape copies `sliceModuleDocsFor`'s "additive by design" contract:
 * whatever happens — feature off, tool absent, index stale, timeout, anything
 * thrown — the answer is `[]`, and the prompt is byte-identical to a pipeline
 * without this module. Context enrichment is an optimization; the run
 * proceeding is the requirement.
 *
 * OFF is the default and reads one env var: `STA_CODE_INTEL=on`. There is no
 * settings-file surface and no hook — enabling is a per-machine decision,
 * which is also why discovery scopes itself to the task's bound target root.
 */

export const CODE_INTEL_ENV = "STA_CODE_INTEL";
export const CODE_INTEL_PIN_ENV = "STA_CODE_INTEL_PIN";
/** Binary name/path override — needed where uv's tool bin dir is not on the spawning process's PATH. */
export const CODE_INTEL_BIN_ENV = "STA_CODE_INTEL_BIN";

export function codeIntelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["on", "true", "1"].includes((env[CODE_INTEL_ENV] ?? "").trim().toLowerCase());
}

/** Env → adapter config for the default construction path. Pure, so tests pin it without spawning anything. */
export function defaultProviderConfig(env: Record<string, string | undefined> = process.env): { pinnedVersion?: string; command?: string } {
  return { pinnedVersion: env[CODE_INTEL_PIN_ENV], command: env[CODE_INTEL_BIN_ENV] };
}

export interface CodeIntelSliceInput {
  stage: AgentStage;
  taskId?: string;
  /** Discovery query seed — the module this run works on. */
  moduleName?: string;
  /** The bound target checkout whose index would be consulted. */
  targetRoot?: string;
  targetId?: string;
}

export interface CodeIntelSliceDeps {
  enabled?: boolean;
  env?: Record<string, string | undefined>;
  providerFactory?: () => CodeIntelligenceProvider;
  resolveRevision?: (root: string) => Promise<string>;
  now?: () => number;
}

export async function codeIntelSlices(input: CodeIntelSliceInput, deps: CodeIntelSliceDeps = {}): Promise<string[]> {
  if (!(deps.enabled ?? codeIntelEnabled(deps.env))) return [];
  if (!input.targetRoot || !input.moduleName || !input.targetId) return [];

  let provider: CodeIntelligenceProvider;
  try {
    const built = deps.providerFactory?.();
    // An injected factory may return nothing (it is a test/extension seam) —
    // that means "use the default", never "silently disable": silent disables
    // are indistinguishable from broken installs when debugging.
    provider = built ?? new GraphifyProvider({ cacheRoot: defaultCacheRoot(), config: defaultProviderConfig(deps.env) });
    const revision = await (deps.resolveRevision ?? ((root) => resolveTargetRevision(root)))(input.targetRoot);
    const result = await resolveCodeContext(
      { enabled: true, provider, now: deps.now },
      {
        role: input.stage,
        operation: "findRelevantCode",
        description: input.moduleName,
        target: { targetId: input.targetId, rootPath: input.targetRoot, revision },
        taskId: input.taskId,
      },
    );
    if (!result.used || result.evidenceBlock === "") return [];
    return ["", result.evidenceBlock];
  } catch {
    // Same posture as sliceModuleDocsFor: enrichment must never fail a run.
    return [];
  }
}
