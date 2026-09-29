import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GUARD_TARGET_WORK_ROOTS_ENV, serializeGuardTargetWorkRoots } from "../agents/pathPermissions.js";
import { launchEnv, resolveSessionTargetWorkRoots } from "./roleWorkspace.js";

/**
 * V10 TASK-023 — what an interactive session may do to a bound Target.
 *
 * The decision this file pins: read, never write. A person types in these
 * sessions, so nothing sets STA_ROLE and the guard's whole per-role layer is
 * unreachable; a writable Target root there would be defended by the universal
 * floor alone. So the Targets ride on the identification channel only, and the
 * refusal has to name the Target rather than the path.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = path.join(REPO_ROOT, ".claude", "hooks", "block-path-permissions.js");

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-itarget-${prefix}-`));
  roots.push(root);
  return root;
}

function appRepo(prefix: string): string {
  const app = tmpRoot(prefix);
  fs.mkdirSync(path.join(app, ".git"));
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  return app;
}

/** A Knowledge root whose registry and machine-local mapping name every given Target. */
function knowledgeWith(targets: Record<string, string>): string {
  const knowledge = tmpRoot("kb");
  fs.mkdirSync(path.join(knowledge, ".git"));
  fs.mkdirSync(path.join(knowledge, "knowledge"));
  const registry = Object.keys(targets)
    .map((id) => `  - target_id: ${id}\n    name: ${id}\n    remote_url: https://github.com/acme/${id}.git\n    status: active\n`)
    .join("");
  fs.writeFileSync(path.join(knowledge, "targets.yaml"), `schema_version: 1\ntargets:\n${registry}`, "utf8");
  fs.mkdirSync(path.join(knowledge, ".workflow"), { recursive: true });
  const local = Object.entries(targets)
    .map(([id, p]) => `  ${id}:\n    path: ${JSON.stringify(p)}\n`)
    .join("");
  fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n${local}`, "utf8");
  return knowledge;
}

/** The real hook, run the way a host runs it, with only the variables a launch sets. */
function hookVerdict(cwdRoot: string, target: string, env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const clean: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: cwdRoot };
  for (const key of ["STA_ROLE", "STA_WRITABLE_WORK_ROOTS", GUARD_TARGET_WORK_ROOTS_ENV, "STA_KNOWLEDGE_ROOT", "STA_KNOWLEDGE_ROOT_NAME"]) delete clean[key];
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: target } }),
    encoding: "utf8",
    env: { ...clean, ...env },
    cwd: cwdRoot,
    timeout: 60000,
  });
  return { status: res.status, stderr: res.stderr ?? "" };
}

describe("V10 TASK-023 — an interactive session reads its Targets and writes none of them", () => {
  it("resolves every mapped Target as read, and never its own workspace", () => {
    const api = appRepo("api");
    const web = appRepo("web");
    const knowledge = knowledgeWith({ api, web });

    const fromKnowledge = resolveSessionTargetWorkRoots({ knowledgeRoot: knowledge, workspaceRoot: knowledge });
    expect(fromKnowledge.map((entry) => entry.targetId).sort()).toEqual(["api", "web"]);
    expect(fromKnowledge.every((entry) => entry.access === "read")).toBe(true);

    // Opened inside one of them: that one is the session root, writable through
    // the root itself, so listing it read would refuse the session's own work.
    const fromTarget = resolveSessionTargetWorkRoots({ knowledgeRoot: knowledge, workspaceRoot: api });
    expect(fromTarget.map((entry) => entry.targetId)).toEqual(["web"]);
  });

  it("returns nothing rather than throwing when the machine maps no Target", () => {
    const bare = tmpRoot("bare");
    expect(resolveSessionTargetWorkRoots({ knowledgeRoot: bare, workspaceRoot: bare })).toEqual([]);
  });

  it("hands the roots over in exactly the orchestrated path's shape, and grants no write root", () => {
    const api = appRepo("api2");
    const roots = [{ targetId: "api", path: api, access: "read" as const }];
    const env = launchEnv("ba", { PATH: "keep" }, undefined, undefined, undefined, roots);

    expect(env[GUARD_TARGET_WORK_ROOTS_ENV]).toBe(serializeGuardTargetWorkRoots(roots));
    expect(env.STA_WRITABLE_WORK_ROOTS).toBe("[]");
    expect(env.PATH).toBe("keep");

    // Absent, not empty, when nothing mapped: the guard treats a missing
    // channel and an empty list alike, and an unset variable says so plainly.
    expect(launchEnv("ba", {})[GUARD_TARGET_WORK_ROOTS_ENV]).toBeUndefined();
  });

  it("the guard refuses a Target write from such a session and names the Target — with no STA_ROLE set", () => {
    const api = appRepo("api3");
    const knowledge = knowledgeWith({ api });
    const launched = launchEnv(
      "ba",
      {},
      undefined,
      api,
      undefined,
      resolveSessionTargetWorkRoots({ knowledgeRoot: knowledge, workspaceRoot: knowledge }),
    );
    const env = {
      [GUARD_TARGET_WORK_ROOTS_ENV]: launched[GUARD_TARGET_WORK_ROOTS_ENV],
      STA_WRITABLE_WORK_ROOTS: launched.STA_WRITABLE_WORK_ROOTS,
    };

    const refused = hookVerdict(knowledge, path.join(api, "src", "route.ts"), env);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('Target "api"');
    expect(refused.stderr).toContain("read-only");

    // The decision is the rule, not an accident of the missing role: the same
    // write is still refused when a stage name is present, and the session's
    // own workspace stays writable outside the governed artifact tree (V13
    // TASK-012: an unassigned session's `_docs/**` writes are refused on the
    // floor — read/discover/propose is its contract).
    expect(hookVerdict(knowledge, path.join(api, "src", "route.ts"), { ...env, STA_ROLE: "backend-engineer" }).status).toBe(2);
    expect(hookVerdict(knowledge, path.join(knowledge, "_docs", "module", "m", "requirement.md"), env).status).toBe(2);
    expect(hookVerdict(knowledge, path.join(knowledge, "notes", "session.md"), env).status).toBe(0);
  });
});
