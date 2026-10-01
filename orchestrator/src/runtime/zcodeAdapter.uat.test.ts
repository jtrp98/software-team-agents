import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { renderZcodeConfigJson } from "./bindingGenerator.js";
import { NO_GUARDS, type RuntimeAgentRequest } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { untrustedManagedHooks, ZcodeAdapter } from "./zcodeAdapter.js";

/**
 * V13 TASK-015 — real-binary UAT for the governed ZCode adapter. Opt-in:
 * `STA_ZCODE_UAT=1 npx vitest run src/runtime/zcodeAdapter.uat.test.ts`.
 * It drives the ZCode CLI installed on this machine (no injected spawn) in a
 * throwaway git fixture under the OS temp dir, never this repository.
 *
 * The first group needs no model call (probe, hook-trust refusal, cancel and
 * forged references). The second group runs a real prompt and so needs a
 * working ZCode sign-in on this machine; its result is evidence either way.
 */

const UAT = process.env.STA_ZCODE_UAT === "1";
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fixture(): { root: string; journalRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sta-zcode-uat-"));
  fixtures.push(base);
  const root = path.join(base, "workspace");
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\nYou are a careful reviewer. Follow the task exactly.\n");
  fs.mkdirSync(path.join(root, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zcode", "config.json"), renderZcodeConfigJson());
  fs.writeFileSync(path.join(root, ".gitignore"), ".zcode/*\n!.zcode/config.json\n");
  fs.writeFileSync(path.join(root, "README.md"), "UAT fixture\n");
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "uat@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UAT"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "uat fixture"], { cwd: root });
  return { root, journalRoot: path.join(base, "attempts") };
}

function request(root: string, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "reviewer",
    cwd: root,
    definitionPath: ".claude/agents/reviewer.md",
    prompt: "Reply with exactly the text UAT-OK and nothing else. Do not use any tools.",
    autonomy: "read-only",
    guards: NO_GUARDS,
    taskId: "T-ZCODE-UAT",
    stage: "reviewer",
    timeoutMs: 240_000,
    ...over,
  };
}

describe.skipIf(!UAT)("ZCode real-binary UAT — no model call", () => {
  it("probes the installed CLI", async () => {
    const probe = await new ZcodeAdapter({ projectRoot: os.tmpdir() }).probe();
    console.log(`[zcode-uat] probe ${JSON.stringify(probe)}`);
    expect(probe.available).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("refuses a guarded run before spawn while the STA hooks are pending trust (real trust record)", async () => {
    const { root, journalRoot } = fixture();
    const adapter = new ZcodeAdapter({ projectRoot: root, journalRoot });
    const trust = adapter.inspectHookTrust(root);
    expect("error" in trust).toBe(false);
    if ("error" in trust) return;
    console.log(`[zcode-uat] trust reason=${trust.reasonCode} untrusted=${untrustedManagedHooks(trust).length}`);
    expect(untrustedManagedHooks(trust).length).toBeGreaterThan(0);

    const prepared = await adapter.prepare(request(root, { autonomy: "edit", guards: { writeAllow: ["src/**"], writeDeny: [], forbidCommands: ["git"], exitChecks: [] } }));
    const result = await adapter.execute(prepared);
    console.log(`[zcode-uat] guarded-untrusted status=${result.status} diag=${result.diagnostics.join(" | ").slice(0, 300)}`);
    expect(result.status).toBe("ERROR");
    expect(result.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(result.diagnostics.join(" ")).toMatch(/zcode hooks trust grant --workspace .+ --all-current --bundle-digest [0-9a-f]{64}/);
    expect(result.diagnostics.join(" ")).toMatch(/zcode hooks trust review/);
    const evidence = await adapter.collectEvidence(prepared);
    expect(evidence.result?.status).toBe("ERROR");
    expect(evidence.changedFiles).toEqual([]);
  });

  it("cancel before execute is durable across instances; forged references are refused", async () => {
    const { root, journalRoot } = fixture();
    const first = new ZcodeAdapter({ projectRoot: root, journalRoot });
    const prepared = await first.prepare(request(root, { prompt: "cancelled before it ran" }));
    expect((await first.cancel(prepared)).status).toBe("already-finished");
    const second = new ZcodeAdapter({ projectRoot: root, journalRoot });
    await expect(second.execute(prepared)).rejects.toMatchObject({ code: "attempt-cancelled" });
    await expect(second.resume(prepared)).rejects.toMatchObject({ code: "attempt-cancelled" });
    await expect(second.collectEvidence({ runtimeId: "zcode", attemptId: `atm_${"0".repeat(32)}` })).rejects.toMatchObject({ code: "unknown-attempt" });
  });
});

describe.skipIf(!UAT)("ZCode real-binary UAT — real session (needs a working ZCode sign-in)", () => {
  it("runs a read-only attempt, then a fresh instance recovers an interrupted one with a real session", async () => {
    const { root, journalRoot } = fixture();
    const adapter = new ZcodeAdapter({ projectRoot: root, journalRoot });
    const prepared = await adapter.prepare(request(root));
    const result = await adapter.execute(prepared);
    const evidence = await adapter.collectEvidence(prepared);
    console.log(
      `[zcode-uat] read-only status=${result.status} exit=${result.exitCode} session=${evidence.sessionRef ?? "none"} ` +
        `text=${JSON.stringify(result.text.slice(0, 80))} diag=${result.diagnostics.join(" | ").slice(0, 400)}`,
    );
    expect(result.status).toBe("OK");
    expect(evidence.sessionRef).toMatch(/^sess_/);
    expect(evidence.changedFiles).toEqual([]);

    // Recovery: prepared in one instance, never executed (owner "crashed"),
    // resumed in a new instance as a fresh real session.
    const interrupted = await adapter.prepare(request(root, { prompt: "Reply with exactly the text UAT-RECOVERED and nothing else. Do not use any tools." }));
    const recovered = await new ZcodeAdapter({ projectRoot: root, journalRoot }).resume(interrupted);
    const recoveredEvidence = await adapter.collectEvidence(interrupted);
    console.log(`[zcode-uat] recovered status=${recovered.status} session=${recoveredEvidence.sessionRef ?? "none"}`);
    expect(recovered.status).toBe("OK");
    expect(recoveredEvidence.logs.join("\n")).toContain("fresh-session resume");
  }, 600_000);
});
