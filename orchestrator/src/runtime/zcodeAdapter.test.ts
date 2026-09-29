import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { renderZcodeConfigJson } from "./bindingGenerator.js";
import { NO_GUARDS, type RuntimeAgentRequest, type RuntimeGuards, type SpawnSync } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import {
  managedZcodeHooks,
  parseZcodeSummary,
  parseZcodeTrustStatus,
  untrustedManagedHooks,
  verifyZcodeRunWrites,
  ZcodeAdapter,
} from "./zcodeAdapter.js";

/**
 * V13 TASK-015 — unit contract for the governed ZCode adapter. Everything runs
 * through injected spawns and a fake install tree; the real-binary UAT lives
 * in `zcodeAdapter.uat.test.ts` (opt-in, `STA_ZCODE_UAT=1`).
 *
 * Summary/trust shapes mirror what the ZCode 0.16.9 bundle prints (`--json`
 * summary fields and `hooks trust status --json`, the latter captured live).
 */

function spawnResult(over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null, ...over } as unknown as SpawnSyncReturns<string>;
}

const roots: string[] = [];
afterEach(() => {
  // Retries: Windows can briefly hold a just-written journal/git file open.
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Fixture {
  root: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}

/** A fake ZCode install (entry + built-in provider config), a user profile, and a project with the role binding. */
function fixture(options: { zcodeConfig?: boolean; git?: boolean; providerConfig?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-zcode-adapter-"));
  roots.push(root);
  const install = path.join(root, "install", "resources");
  fs.mkdirSync(path.join(install, "glm"), { recursive: true });
  fs.mkdirSync(path.join(install, "config", "provider"), { recursive: true });
  const entry = path.join(install, "glm", "zcode.cjs");
  fs.writeFileSync(entry, "// fake zcode entry\n");
  if (options.providerConfig !== false) fs.writeFileSync(path.join(install, "config", "provider", "zcode-builtin.json"), "{}\n");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "v2", "provider_config.json"), "{}\n");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "agents", "backend-engineer.md"), "---\nname: backend-engineer\n---\nROLE INSTRUCTIONS\n");
  if (options.zcodeConfig) {
    fs.mkdirSync(path.join(project, ".zcode"), { recursive: true });
    fs.writeFileSync(path.join(project, ".zcode", "config.json"), renderZcodeConfigJson());
  }
  if (options.git) {
    fs.writeFileSync(path.join(project, ".gitignore"), ".zcode/*\n!.zcode/config.json\n");
    execFileSync("git", ["init"], { cwd: project });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: project });
  }
  return { root: project, entry, env: { USERPROFILE: home, HOME: home } };
}

/** `hooks trust status --json` for the managed payload, every hook in `state`. */
function trustStatus(state: string): string {
  return JSON.stringify({
    workspacePath: "W",
    workspaceIdentity: "W",
    bundleDigest: "b".repeat(64),
    reasonCode: state === "trusted_persistent" ? "workspace_hooks_trusted" : "workspace_hooks_pending_trust",
    items: managedZcodeHooks().map(({ event, script }, index) => ({
      reviewItemId: `workspace-hook-${index}`,
      event,
      matcher: null,
      displayCommand: `node \${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}`,
      sourcePath: ".zcode/config.json",
      configuredEnabled: true,
      hookDeclarationDigest: String(index).repeat(64).slice(0, 64),
      trustState: state,
    })),
  });
}

const SUMMARY = JSON.stringify(
  {
    sessionId: "sess_11111111-2222-3333-4444-555555555555",
    traceId: "trace-1",
    turnId: "turn-1",
    response: "DONE",
    usage: { inputTokens: 120, outputTokens: 7 },
    eventCount: 4,
    projection: { status: "completed", turnCount: 1, totalTokenCount: 127, contextUsed: null, contextWindow: null },
  },
  null,
  2,
);

interface Calls {
  args: string[][];
  envs: (NodeJS.ProcessEnv | undefined)[];
}

/** A spawn answering `--version`, `hooks trust status` and `-p`, recording every call. */
function fakeSpawn(
  handlers: { run?: (args: string[]) => Partial<SpawnSyncReturns<string>>; trust?: string; version?: string } = {},
): { spawn: SpawnSync; calls: Calls } {
  const calls: Calls = { args: [], envs: [] };
  const spawn = ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const rest = args.slice(1);
    calls.args.push(rest);
    calls.envs.push(options.env);
    if (rest[0] === "--version") return spawnResult({ stdout: `${handlers.version ?? "0.16.9"}\n` });
    if (rest[0] === "hooks") return spawnResult({ stdout: handlers.trust ?? trustStatus("pending_trust") });
    if (rest[0] === "-p") return spawnResult(handlers.run ? handlers.run(rest) : { stdout: SUMMARY });
    return spawnResult({ status: 2, stderr: "unexpected" });
  }) as unknown as SpawnSync;
  return { spawn, calls };
}

function adapterFor(fx: Fixture, spawn: SpawnSync, over: { platform?: string; journalRoot?: string } = {}): ZcodeAdapter {
  return new ZcodeAdapter({
    projectRoot: fx.root,
    cliEntry: fx.entry,
    nodePath: "node",
    spawnSync: spawn,
    env: fx.env,
    platform: over.platform ?? "linux",
    journalRoot: over.journalRoot ?? path.join(fx.root, "..", "attempts"),
  });
}

const GUARDS: RuntimeGuards = { writeAllow: ["src/**"], writeDeny: [".env"], forbidCommands: ["git"], exitChecks: [] };

function request(fx: Fixture, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "backend-engineer",
    cwd: fx.root,
    definitionPath: ".claude/agents/backend-engineer.md",
    prompt: "PACKET BODY",
    autonomy: "read-only",
    guards: NO_GUARDS,
    ...over,
  };
}

const runCalls = (calls: Calls): string[][] => calls.args.filter((args) => args[0] === "-p");

describe("ZcodeAdapter — identity and probe", () => {
  it("declares the governed lifecycle and none of the capabilities it cannot show", () => {
    const fx = fixture();
    const adapter = adapterFor(fx, fakeSpawn().spawn);
    expect(adapter.id).toBe("zcode");
    for (const capability of [
      RuntimeCapability.PRE_TOOL_GUARD,
      RuntimeCapability.STRUCTURED_RESULT,
      RuntimeCapability.ATTEMPT_RESUME,
      RuntimeCapability.ATTEMPT_CANCEL,
      RuntimeCapability.EVIDENCE_COLLECTION,
    ]) {
      expect(adapter.capabilities.has(capability)).toBe(true);
    }
    for (const capability of [
      RuntimeCapability.NAMED_AGENTS,
      RuntimeCapability.MODEL_SELECTION,
      RuntimeCapability.EXIT_GUARD,
      RuntimeCapability.COST_REPORTING,
      RuntimeCapability.INTERACTIVE_PROMPTS,
    ]) {
      expect(adapter.capabilities.has(capability)).toBe(false);
    }
    expect(adapter.models.size).toBe(0);
  });

  it("probe reports the CLI version with the provider-config pair supplied", async () => {
    const fx = fixture();
    const { spawn, calls } = fakeSpawn();
    expect(await adapterFor(fx, spawn).probe()).toEqual({ available: true, version: "0.16.9" });
    expect(calls.envs[0]?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(path.resolve(path.dirname(fx.entry), "..", "config", "provider", "zcode-builtin.json"));
    expect(calls.envs[0]?.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(path.join(String(fx.env.USERPROFILE), ".zcode", "v2", "provider_config.json"));
  });

  it("probe is unavailable — with a reason — when the install or its provider config is missing", async () => {
    const fx = fixture({ providerConfig: false });
    const { spawn, calls } = fakeSpawn();
    const probe = await adapterFor(fx, spawn).probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/built-in provider config not found/);
    expect(calls.args).toHaveLength(0);

    const missing = new ZcodeAdapter({ projectRoot: fx.root, cliEntry: path.join(fx.root, "nope.cjs"), spawnSync: spawn, env: fx.env });
    expect((await missing.probe()).reason).toMatch(/entry .*not found/);
  });
});

describe("ZcodeAdapter — executeAgent", () => {
  it("runs `-p --json` in plan mode for a read-only run, folding the role body and naming the role to hooks", async () => {
    const fx = fixture();
    const { spawn, calls } = fakeSpawn();
    const result = await adapterFor(fx, spawn).executeAgent(request(fx));
    expect(result.status).toBe("OK");
    expect(result.text).toBe("DONE");
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 7 });
    const [args] = runCalls(calls);
    expect(args!.slice(2)).toEqual(["--json", "--cwd", fx.root, "--mode", "plan"]);
    expect(args![1]).toContain("ROLE INSTRUCTIONS");
    expect(args![1]).not.toContain("name: backend-engineer");
    expect(args![1]).toContain("PACKET BODY");
    const env = calls.envs[calls.args.indexOf(args!)];
    expect(env?.STA_ROLE).toBe("backend-engineer");
  });

  it("maps every autonomy level onto the CLI's own modes", async () => {
    for (const [autonomy, mode] of [["propose", "build"], ["edit", "edit"], ["full", "yolo"]] as const) {
      const fx = fixture();
      const { spawn, calls } = fakeSpawn();
      await adapterFor(fx, spawn).executeAgent(request(fx, { autonomy }));
      expect(runCalls(calls)[0]!.at(-1)).toBe(mode);
    }
  });

  it("refuses before spawn when the role binding is missing", async () => {
    const fx = fixture();
    const { spawn, calls } = fakeSpawn();
    const result = await adapterFor(fx, spawn).executeAgent(request(fx, { definitionPath: ".claude/agents/ghost.md" }));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/no role binding/);
    expect(runCalls(calls)).toHaveLength(0);
  });

  it("refuses an explicit model and an effort it cannot observe, before spawn", async () => {
    const fx = fixture();
    const { spawn, calls } = fakeSpawn();
    const adapter = adapterFor(fx, spawn);
    expect((await adapter.executeAgent(request(fx, { model: "glm-5", modelExplicit: true }))).diagnostics.join(" ")).toMatch(/no per-run model flag/);
    expect((await adapter.executeAgent(request(fx, { effort: "high" }))).diagnostics.join(" ")).toMatch(/no effort control/);
    expect(runCalls(calls)).toHaveLength(0);
  });

  it("refuses a packet the Windows command line would truncate — never cuts it", async () => {
    const fx = fixture();
    const { spawn, calls } = fakeSpawn();
    const result = await adapterFor(fx, spawn, { platform: "win32" }).executeAgent(request(fx, { prompt: "x".repeat(40_000) }));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/refuses rather than cut/);
    expect(runCalls(calls)).toHaveLength(0);
  });

  it("a guarded run without the synced .zcode/config.json is refused before any spawn", async () => {
    const fx = fixture({ zcodeConfig: false });
    const { spawn, calls } = fakeSpawn();
    const result = await adapterFor(fx, spawn).executeAgent(request(fx, { autonomy: "edit", guards: GUARDS }));
    expect(result.status).toBe("ERROR");
    expect(result.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(calls.args).toHaveLength(0);
  });

  it("a guarded run whose STA hooks are not persistently trusted is refused — ZCode would skip them headless", async () => {
    const fx = fixture({ zcodeConfig: true });
    const { spawn, calls } = fakeSpawn({ trust: trustStatus("pending_trust") });
    const result = await adapterFor(fx, spawn).executeAgent(request(fx, { autonomy: "edit", guards: GUARDS }));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/zcode hooks trust review/);
    expect(result.diagnostics.join(" ")).toMatch(/block-path-permissions\.js: pending_trust/);
    expect(calls.args.map((args) => args[0])).toEqual(["hooks"]);
  });

  it("a guarded run with every STA hook trusted runs in edit mode and reports the pre-tool guard enforced", async () => {
    const fx = fixture({ zcodeConfig: true });
    const { spawn, calls } = fakeSpawn({ trust: trustStatus("trusted_persistent") });
    const result = await adapterFor(fx, spawn).executeAgent(request(fx, { autonomy: "edit", guards: GUARDS }));
    expect(result.status).toBe("OK");
    expect(result.guards.enforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(runCalls(calls)[0]!.at(-1)).toBe("edit");
  });

  it("a guarded result that says hooks were skipped anyway is an ERROR with the guard unenforced", async () => {
    const fx = fixture({ zcodeConfig: true });
    const skipped = JSON.stringify({ ...JSON.parse(SUMMARY), workspaceHookTrust: { reasonCode: "workspace_hooks_pending_trust", items: [] } });
    const { spawn } = fakeSpawn({ trust: trustStatus("trusted_persistent"), run: () => ({ stdout: skipped }) });
    const result = await adapterFor(fx, spawn).executeAgent(request(fx, { autonomy: "edit", guards: GUARDS }));
    expect(result.status).toBe("ERROR");
    expect(result.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
  });

  it("no success from self-report: exit 0 without a summary sessionId is an ERROR, whatever the text claims", async () => {
    const fx = fixture();
    const { spawn } = fakeSpawn({ run: () => ({ stdout: "All done, task complete! (role: backend-engineer)" }) });
    const result = await adapterFor(fx, spawn).executeAgent(request(fx));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/no summary with a sessionId/);
  });

  it("a non-zero exit is an ERROR even when the response claims success", async () => {
    const fx = fixture();
    const { spawn } = fakeSpawn({ run: () => ({ status: 1, stdout: SUMMARY, stderr: "Error: Turn execution failed" }) });
    expect((await adapterFor(fx, spawn).executeAgent(request(fx))).status).toBe("ERROR");
  });

  it("maps the signing/provider failures seen live to UNAVAILABLE, and a spawn timeout to TIMEOUT", async () => {
    const fx = fixture();
    const auth = fakeSpawn({ run: () => ({ status: 1, stderr: "ClientRequestSigningV4Error: Client signing credential must contain one separator." }) });
    expect((await adapterFor(fx, auth.spawn).executeAgent(request(fx))).status).toBe("UNAVAILABLE");
    const timeout = fakeSpawn({ run: () => ({ status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) }) });
    expect((await adapterFor(fx, timeout.spawn).executeAgent(request(fx))).status).toBe("TIMEOUT");
  });
});

describe("ZcodeAdapter — governed lifecycle (persisted attempt, verification, recovery)", () => {
  it("a write inside the grant completes OK with the run's changed files and native session as evidence", async () => {
    const fx = fixture({ zcodeConfig: true, git: true });
    const { spawn } = fakeSpawn({
      trust: trustStatus("trusted_persistent"),
      run: () => {
        fs.mkdirSync(path.join(fx.root, "src"), { recursive: true });
        fs.writeFileSync(path.join(fx.root, "src", "feature.ts"), "export const x = 1;\n");
        return { stdout: SUMMARY };
      },
    });
    const adapter = adapterFor(fx, spawn);
    const prepared = await adapter.prepare(request(fx, { autonomy: "edit", guards: GUARDS, taskId: "T-ZC", stage: "backend-engineer" }));
    const result = await adapter.execute(prepared);
    expect(result.status).toBe("OK");
    const evidence = await adapter.collectEvidence(prepared);
    expect(evidence.sessionRef).toBe("sess_11111111-2222-3333-4444-555555555555");
    expect(evidence.changedFiles).toEqual(["src/feature.ts"]);
  });

  it("a write outside the grant turns the run into ERROR — the path violation is computed, not reported", async () => {
    const fx = fixture({ zcodeConfig: true, git: true });
    const { spawn } = fakeSpawn({
      trust: trustStatus("trusted_persistent"),
      run: () => {
        fs.writeFileSync(path.join(fx.root, "outside.txt"), "escaped\n");
        return { stdout: SUMMARY };
      },
    });
    const adapter = adapterFor(fx, spawn);
    const prepared = await adapter.prepare(request(fx, { autonomy: "edit", guards: GUARDS }));
    const result = await adapter.execute(prepared);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/outside\.txt was written outside the grant/);
    const evidence = await adapter.collectEvidence(prepared);
    expect(evidence.result?.status).toBe("ERROR");
    expect(evidence.logs.join("\n")).toMatch(/post-run verification failed/);
  });

  it("a read-only run that changed a file is an ERROR", async () => {
    const fx = fixture({ git: true });
    const { spawn } = fakeSpawn({
      run: () => {
        fs.writeFileSync(path.join(fx.root, "sneaky.txt"), "x\n");
        return { stdout: SUMMARY };
      },
    });
    const adapter = adapterFor(fx, spawn);
    const result = await adapter.execute(await adapter.prepare(request(fx)));
    expect(result.status).toBe("ERROR");
  });

  it("the persisted attempt survives a restart before collection: a fresh instance collects the same result", async () => {
    const fx = fixture();
    const journalRoot = path.join(fx.root, "..", "shared-attempts");
    const first = adapterFor(fx, fakeSpawn().spawn, { journalRoot });
    const prepared = await first.prepare(request(fx, { taskId: "T-RESTART", stage: "backend-engineer" }));
    await first.execute(prepared);

    const { spawn, calls } = fakeSpawn();
    const second = adapterFor(fx, spawn, { journalRoot });
    const collected = await second.collectResult({ runtimeId: "zcode", attemptId: prepared.attemptId });
    expect(collected?.status).toBe("OK");
    const evidence = await second.collectEvidence({ runtimeId: "zcode", attemptId: prepared.attemptId });
    expect(evidence.sessionRef).toMatch(/^sess_/);
    // Resuming a finished attempt is its stored result — no second spawn.
    expect((await second.resume({ runtimeId: "zcode", attemptId: prepared.attemptId })).status).toBe("OK");
    expect(runCalls(calls)).toHaveLength(0);
  });

  it("an attempt interrupted before execute is recovered by a fresh session in a new instance", async () => {
    const fx = fixture();
    const journalRoot = path.join(fx.root, "..", "recovery-attempts");
    const prepared = await adapterFor(fx, fakeSpawn().spawn, { journalRoot }).prepare(request(fx));
    const { spawn, calls } = fakeSpawn();
    const resumed = await adapterFor(fx, spawn, { journalRoot }).resume({ runtimeId: "zcode", attemptId: prepared.attemptId });
    expect(resumed.status).toBe("OK");
    expect(runCalls(calls)).toHaveLength(1);
  });

  it("forged references and cancelled attempts are refused typed", async () => {
    const fx = fixture();
    const adapter = adapterFor(fx, fakeSpawn().spawn);
    const forged = { runtimeId: "zcode", attemptId: `atm_${"f".repeat(32)}` };
    await expect(adapter.collectEvidence(forged)).rejects.toMatchObject({ name: "ExecutorPortRefusalError", code: "unknown-attempt" });
    await expect(adapter.resume(forged)).rejects.toMatchObject({ code: "unknown-attempt" });
    expect(await adapter.cancel(forged)).toMatchObject({ status: "refused" });

    const prepared = await adapter.prepare(request(fx));
    expect((await adapter.cancel(prepared)).status).toBe("already-finished");
    await expect(adapter.execute(prepared)).rejects.toMatchObject({ code: "attempt-cancelled" });
    await expect(adapter.resume(prepared)).rejects.toMatchObject({ code: "attempt-cancelled" });
  });
});

describe("ZCode parsers and checks", () => {
  it("reads the live-shape trust record and names every managed hook that is not trusted", () => {
    const status = parseZcodeTrustStatus(trustStatus("pending_trust"))!;
    expect(status.items).toHaveLength(managedZcodeHooks().length);
    expect(untrustedManagedHooks(status)).toHaveLength(managedZcodeHooks().length);
    expect(untrustedManagedHooks(parseZcodeTrustStatus(trustStatus("trusted_persistent"))!)).toEqual([]);
    const oneMissing = { ...status, items: status.items.slice(1).map((item) => ({ ...item, trustState: "trusted_persistent" })) };
    expect(untrustedManagedHooks(oneMissing)).toEqual(["PreToolUse block-git.js: not declared"]);
    expect(parseZcodeTrustStatus("not json")).toBeNull();
  });

  it("reads the summary object and keeps absent counters undefined", () => {
    expect(parseZcodeSummary(SUMMARY)).toMatchObject({ sessionId: expect.stringMatching(/^sess_/), response: "DONE", projectionStatus: "completed" });
    expect(parseZcodeSummary(JSON.stringify({ sessionId: "sess_x", response: "" }))!.usage).toEqual({});
    expect(parseZcodeSummary("garbage")).toBeNull();
  });

  it("a write-capable run with no snapshot is unverified, and an empty grant writes nothing", () => {
    const base = { role: "r", cwd: "/w", definitionPath: "d", prompt: "p" } as const;
    expect(verifyZcodeRunWrites({ ...base, autonomy: "edit", guards: GUARDS }, undefined)[0]).toMatch(/cannot be verified/);
    expect(verifyZcodeRunWrites({ ...base, autonomy: "read-only", guards: NO_GUARDS }, undefined)).toEqual([]);
    expect(verifyZcodeRunWrites({ ...base, autonomy: "edit", guards: NO_GUARDS }, ["a.ts"])[0]).toMatch(/outside the grant/);
    expect(verifyZcodeRunWrites({ ...base, autonomy: "edit", guards: GUARDS }, [".env"])[0]).toMatch(/outside the grant/);
    expect(verifyZcodeRunWrites({ ...base, autonomy: "edit", guards: GUARDS }, ["src/a.ts"])).toEqual([]);
  });
});
