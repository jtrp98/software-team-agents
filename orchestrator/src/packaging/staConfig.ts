import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * T93 — project-local configuration, `.sta/config.yaml`.
 *
 * This is the one file `sta init` writes that is unambiguously the project's
 * own from the moment it's created: unlike every other templated file, an
 * upgrade never overwrites it (there is nothing "pristine" to diff against —
 * it has no framework-shipped counterpart, it *is* the override layer).
 * Human-editable YAML, like `project.yaml` (`projectProfile.ts`), not the
 * machine-only JSON `.sta/manifest.json` uses.
 */
export const StaConfigSchema = z.object({
  schema_version: z.literal(1),
  /** Overrides project.yaml's stack pointer for orchestrator purposes only, if a project needs to diverge. Unset = defer to project.yaml. */
  stack: z.string().min(1).optional(),
  /** role -> model override, layered over each agent's frontmatter default (CLAUDE.md's "model per agent" table). */
  model_routing: z.record(z.string().min(1), z.string().min(1)).optional(),
  /**
   * V3 runner/model routing. All fields are optional so a pre-V3 config keeps
   * its exact behaviour. `by_role` accepts the existing `runtime:model` spelling
   * as well as a structured target; the latter avoids parsing when both fields
   * are configured explicitly.
   */
  routing: z
    .object({
      strategy: z.literal("subscription-first").optional(),
      order: z.array(z.string().min(1)).min(1).optional(),
      by_role: z
        .record(
          z.string().min(1),
          z.union([
            z.string().min(1),
            z.object({
              runtime: z.string().min(1),
              model: z.string().min(1).optional(),
            }),
          ]),
        )
        .optional(),
      /** Explicit per-runtime consent for automatic routing below `supported`. */
      allow_below_supported: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** role -> extra write/deny globs layered over contracts/<role>.yaml, never replacing them. */
  permission_overrides: z
    .record(
      z.string().min(1),
      z.object({
        write: z.array(z.string().min(1)).optional(),
        deny: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
  /** Post-hoc token ceiling for a task. Pre-spawn context caps are separate. */
  token_budget: z.number().int().positive().optional(),
  /** T-V3TOK-100 warning thresholds, all measured in prompt characters. */
  context_budget: z
    .object({
      roles: z.record(z.string().min(1), z.number().int().positive()).optional(),
      /** Project-declared because model aliases alone are not authoritative limits. */
      model_context_windows: z.record(z.string().min(1), z.number().int().positive()).optional(),
    })
    .optional(),
});
export type StaConfig = z.infer<typeof StaConfigSchema>;

export function defaultStaConfig(): StaConfig {
  return { schema_version: 1 };
}

export function staConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".sta", "config.yaml");
}

export function writeStaConfig(projectRoot: string, config: StaConfig): void {
  const target = staConfigPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, stringifyYaml(config, { lineWidth: 0 }), "utf8");
}

export class StaConfigMissingError extends Error {}
export class StaConfigInvalidError extends Error {
  constructor(public readonly issues: string[]) {
    super(`.sta/config.yaml is invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

export function loadStaConfig(projectRoot: string): StaConfig {
  const target = staConfigPath(projectRoot);
  if (!fs.existsSync(target)) throw new StaConfigMissingError(`${target} does not exist — run \`sta init\` first`);
  const parsed = parseYaml(fs.readFileSync(target, "utf8"));
  const result = StaConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new StaConfigInvalidError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}

/** Non-throwing check, for T98's installation validation — a bad config is a reported problem, not a crash. */
export function checkStaConfig(projectRoot: string): string[] {
  const target = staConfigPath(projectRoot);
  if (!fs.existsSync(target)) return [`${target} is missing`];
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(target, "utf8"));
  } catch (e) {
    return [`${target} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`];
  }
  const result = StaConfigSchema.safeParse(parsed);
  if (result.success) return [];
  return result.error.issues.map((i) => `${target} ${i.path.join(".") || "(root)"}: ${i.message}`);
}
