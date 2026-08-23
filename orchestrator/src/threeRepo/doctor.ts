import * as fs from "node:fs";
import * as path from "node:path";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { validateInstallation } from "../packaging/installValidation.js";
import { assertStandaloneKnowledgeRoot, defaultInstallationConfigPath, loadInstallationConfig } from "./installation.js";
import { loadLocalTargetMapping } from "./localTargets.js";
import { loadTargetRegistry } from "./targets.js";

/**
 * `sta doctor` (T166) — read-only diagnostics for one machine's installation.
 *
 * Every check answers the three questions an operator has when something will
 * not run: WHAT is broken here, WHY (the underlying message), and HOW to fix
 * it — without leaking configuration contents and without mutating anything.
 * Checks are independent: one failing does not skip the rest, because a doctor
 * that stops at its first finding forces a fix-one-re-run loop instead of
 * showing the whole picture at once.
 *
 * Statuses: FAIL = this machine cannot run tasks until fixed (process exits
 * non-zero); WARNING = usable with a named caveat; PASS.
 */
export type DoctorStatus = "PASS" | "WARNING" | "FAIL";

interface DoctorCheckBody {
  status: DoctorStatus;
  detail?: string;
  /** Shown only when status is not PASS — the recovery step, as a command or a named file. */
  fix?: string;
}

export interface DoctorCheck extends DoctorCheckBody {
  name: string;
}

function check(name: string, fix: string | undefined, run: () => DoctorCheckBody): DoctorCheck {
  try {
    const body = run();
    // A check that reports a problem without naming the recovery step gets the
    // check-level default fix attached — no FAIL/WARNING ships without a "Fix:".
    return { name, ...body, fix: body.fix ?? (body.status === "PASS" ? undefined : fix) };
  } catch (error) {
    return { name, status: "FAIL", detail: error instanceof Error ? error.message : String(error), fix };
  }
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when at least one check is FAIL — the only state that blocks work. */
  ok: boolean;
}

export function exitCodeFor(report: DoctorReport): number {
  return report.checks.some((check) => check.status === "FAIL") ? 1 : 0;
}

export interface DoctorOptions {
  /** Project whose .sta/, .claude and state store are examined. Absent = those checks report skipped-by-scope rather than guessed. */
  projectRoot?: string;
  /** Overrides where the installation config is read from (tests; unusual setups). */
  installationConfigPath?: string;
  /**
   * Injectable so tests never spawn the real runtime probe — and, since the
   * capability-contract work (OFF04), the *only* way a runtime is probed at all:
   * the composition root (cli.ts) wires whichever adapter the run would use.
   * A doctor that constructed its own adapter would make a core module name a
   * specific provider, which is the coupling `runtimeAdapter.ts` exists to
   * prevent. Absent probe ⇒ WARNING, never a guess.
   */
  probe?: () => Promise<{ available: boolean; version?: string; reason?: string }>;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const projectRoot = options.projectRoot;
  const configureFix = "run: orchestrate configure knowledge-root <path>";

  // Mode awareness: a Knowledge root never carries framework internals (.sta/,
  // .claude) — `init --mode three-repo` deliberately writes zero template files
  // there. When the examined projectRoot IS the bound Knowledge root, those two
  // checks are satisfied by absence, so they report n/a instead of FAILing on
  // the architecture working as designed.
  const sameRealPath = (a: string | undefined, b: string | undefined): boolean => {
    if (!a || !b) return false;
    try {
      return fs.realpathSync.native(path.resolve(a)) === fs.realpathSync.native(path.resolve(b));
    } catch {
      return false;
    }
  };
  let configLoaded = true;
  let boundKnowledgeRoot: string | undefined;
  let knowledgeRootValue: string | undefined;
  try {
    const config = loadInstallationConfig(options.installationConfigPath ?? defaultInstallationConfigPath());
    boundKnowledgeRoot = config.knowledge_root;
    knowledgeRootValue = config.knowledge_root;
  } catch {
    configLoaded = false;
  }
  const naDetail = "n/a — this project IS the Knowledge root; framework internals stay out by design";

  checks.push(
    check("Framework installation (.sta/)", "run: orchestrate init --mode <mode> --templates <dir> --project-root <path>", () => {
      if (!projectRoot) return { status: "WARNING", detail: "no --project-root given — .sta/state/guard checks skipped", fix: "re-run with --project-root <path>" };
      if (sameRealPath(projectRoot, boundKnowledgeRoot)) return { status: "PASS", detail: naDetail };
      const result = validateInstallation(projectRoot);
      if (result.problems.length > 0) return { status: "FAIL", detail: result.problems.join("; ") };
      return { status: "PASS", detail: `${path.join(projectRoot, ".sta")} valid` };
    }),
  );

  checks.push(
    check("Installation config (Knowledge root binding)", configureFix, () => {
      if (!configLoaded) throw new Error("cannot read installation config");
      return { status: "PASS", detail: `Knowledge root: ${boundKnowledgeRoot}` };
    }),
  );

  if (knowledgeRootValue !== undefined) {
    checks.push(
      check("Knowledge root standalone", "point installation.yaml at a standalone Knowledge repository checkout", () => {
        const canonical = assertStandaloneKnowledgeRoot(knowledgeRootValue!);
        return { status: "PASS", detail: canonical };
      }),
    );

    checks.push(
      check("Knowledge schema (items load cleanly)", "run: orchestrate --check-knowledge --knowledge-root <path> for the full list", () => {
        const report = checkKnowledge(knowledgeRootValue!);
        if (report.problems.length > 0) {
          return { status: "FAIL", detail: `${report.problems.length} problem(s) — first: ${report.problems[0]}` };
        }
        return { status: "PASS" };
      }),
    );

    let registry: ReturnType<typeof loadTargetRegistry> | undefined;
    checks.push(
      check("Target registry (targets.yaml)", "create targets.yaml in the Knowledge root, or remove it to stay in legacy single-repo mode", () => {
        registry = loadTargetRegistry(knowledgeRootValue!);
        return { status: "PASS", detail: `${registry.targets.length} target(s registered)` };
      }),
    );

    checks.push(
      check("Local Target mappings (.workflow/targets.local.yaml)", "fix paths under .workflow/targets.local.yaml in the Knowledge root", () => {
        if (!registry) throw new Error("registry unavailable");
        if (registry.targets.length === 0) return { status: "PASS", detail: "no targets registered" };
        try {
          const mapping = loadLocalTargetMapping(knowledgeRootValue!, registry, options.projectRoot ?? process.cwd());
          if (mapping.length === 0) {
            return { status: "WARNING", detail: `${registry.targets.length} registered target(s) have no local mapping`, fix: "add paths under .workflow/targets.local.yaml in the Knowledge root" };
          }
          return { status: "PASS", detail: mapping.map((m) => m.target_id).join(", ") };
        } catch (error) {
          return { status: "WARNING", detail: error instanceof Error ? error.message : String(error), fix: "create/fix .workflow/targets.local.yaml in the Knowledge root" };
        }
      }),
    );
  } else {
    for (const skipped of ["Knowledge root standalone", "Knowledge schema (items load cleanly)", "Target registry (targets.yaml)", "Local Target mappings (.workflow/targets.local.yaml)"]) {
      checks.push({ name: skipped, status: "WARNING", detail: "skipped — no Knowledge root configured yet", fix: configureFix });
    }
  }

  checks.push(
    await (async (): Promise<DoctorCheck> => {
      const name = "Runtime adapter (claude CLI)";
      const fix = "install Claude Code and ensure `claude --version` works in a shell";
      try {
        if (!options.probe) {
          return { name, status: "WARNING", detail: "skipped — no runtime probe wired by the caller", fix };
        }
        const result = await options.probe();
        if (!result.available) return { name, status: "FAIL", detail: result.reason ?? "claude unavailable", fix };
        return { name, status: "PASS", detail: result.version ?? "available" };
      } catch (error) {
        return { name, status: "FAIL", detail: error instanceof Error ? error.message : String(error), fix };
      }
    })(),
  );

  checks.push(
    check("State store (.workflow/state.db)", "ensure the project directory is writable, then re-run this check", () => {
      if (!projectRoot) return { status: "WARNING", detail: "skipped — no --project-root given" };
      const file = path.join(projectRoot, ".workflow", "state.db");
      // Read-only: a doctor that creates state.db on the machine it only
      // examines would violate its own never-mutates contract.
      if (!fs.existsSync(file)) return { status: "WARNING", detail: `${file} does not exist yet — created automatically on the first task run` };
      const store = new SqliteTaskStore(file);
      try {
        store.loadTask("__doctor-probe__");
        return { status: "PASS", detail: file };
      } finally {
        store.close();
      }
    }),
  );

  checks.push(
    check("Guard wiring (.claude/settings.json)", "run: orchestrate init --force to restore hook wiring", () => {
      if (!projectRoot) return { status: "WARNING", detail: "skipped — no --project-root given" };
      if (sameRealPath(projectRoot, boundKnowledgeRoot)) return { status: "PASS", detail: naDetail };
      const settingsPath = path.join(projectRoot, ".claude", "settings.json");
      if (!fs.existsSync(settingsPath)) return { status: "WARNING", detail: "no .claude/settings.json in this project" };
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown[]> };
      const wired = ["PreToolUse", "Stop", "SubagentStop"].filter((event) => Array.isArray(parsed.hooks?.[event]) && parsed.hooks[event]!.length > 0);
      if (wired.length === 0) return { status: "WARNING", detail: "settings.json exists but wires no PreToolUse/Stop/SubagentStop hooks" };
      return { status: "PASS", detail: wired.join(", ") };
    }),
  );

  return { checks, ok: !checks.some((c) => c.status === "FAIL") };
}
