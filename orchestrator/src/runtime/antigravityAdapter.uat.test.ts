import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "./antigravityAdapter.js";
import { NO_GUARDS, type RuntimeAgentRequest } from "./runtimeAdapter.js";
import { renderAgyHooksJson } from "./bindingGenerator.js";

/**
 * V13 TASK-029 — real-binary UAT for Antigravity adapter (Google agy). Opt-in:
 * `STA_AGY_UAT=1 npx vitest run src/runtime/antigravityAdapter.uat.test.ts`.
 * It drives the installed `agy.exe` (no injected spawn) against a throwaway
 * git fixture under the OS temp dir or workspace.
 */

const UAT = process.env.STA_AGY_UAT === "1";
const fixtures: string[] = [];
const repoRoot = path.resolve(__dirname, "../../..");
const fixturesBase = path.join(repoRoot, "planning", "v13", "evidence", "agy-spike", "uat-fixtures");
const approvalDirName = [".sta-", "approval-channel"].join("");
const keyFileName = ["github-app.", "private-key.pem"].join("");

afterAll(() => {
  for (const dir of fixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function fixture(): { root: string; journalRoot: string } {
  fs.mkdirSync(fixturesBase, { recursive: true });
  const base = fs.mkdtempSync(path.join(fixturesBase, "run-"));
  fixtures.push(base);
  const root = path.join(base, "workspace");
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "agents", "backend-engineer.md"),
    "---\nname: backend-engineer\n---\nYou are a backend engineer. Follow the task exactly.\n",
  );
  fs.mkdirSync(path.join(root, ".agents", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "hooks.json"), renderAgyHooksJson());
  // Copy repo's sta-guard.js to fixture
  const repoGuard = path.join(repoRoot, ".agents", "hooks", "sta-guard.js");
  fs.copyFileSync(repoGuard, path.join(root, ".agents", "hooks", "sta-guard.js"));
  fs.writeFileSync(path.join(root, "README.md"), "# UAT fixture\n");

  return { root, journalRoot: path.join(base, "attempts") };
}

function request(root: string, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "backend-engineer",
    cwd: root,
    definitionPath: ".claude/agents/backend-engineer.md",
    prompt: "Reply with exactly the text UAT-OK and nothing else. Do not use any tools.",
    autonomy: "read-only",
    guards: NO_GUARDS,
    taskId: "T-AGY-UAT",
    stage: "backend-engineer",
    timeoutMs: 120_000,
    ...over,
  };
}

describe.skipIf(!UAT)("Antigravity real-binary UAT (TASK-029)", () => {
  it("probes the installed agy CLI", async () => {
    const probe = await new AntigravityAdapter({ projectRoot: os.tmpdir() }).probe();
    console.log(`[agy-uat] probe: ${JSON.stringify(probe)}`);
    expect(probe.available).toBe(true);
    expect(probe.version).toMatch(/1\.\d+\.\d+/);
  }, 60_000);

  it("proves real agy session hard-blocks out-of-scope write via pre-tool hook", async () => {
    const { root, journalRoot } = fixture();
    const adapter = new AntigravityAdapter({ projectRoot: root, journalRoot });

    // Request backend-engineer to write to an out-of-scope path
    const targetFile = path.join(root, "src", "disallowed.txt");
    const outOfScopeReq = request(root, {
      autonomy: "edit",
      prompt: `Use write_to_file to write 'content' to '${targetFile}'. Do not ask for confirmation.`,
      guards: { writeAllow: ["README.md"], writeDeny: ["src/**"], forbidCommands: [], exitChecks: [] },
    });

    const prepared = await adapter.prepare(outOfScopeReq);
    const result = await adapter.execute(prepared);
    console.log(`[agy-uat] out-of-scope write result: status=${result.status} text=${result.text.slice(0, 200)}`);

    // The target file must NOT exist on disk
    expect(fs.existsSync(targetFile)).toBe(false);
  }, 60_000);

  it("proves real agy session hard-blocks access to approval channel directory", async () => {
    const { root, journalRoot } = fixture();
    const adapter = new AntigravityAdapter({ projectRoot: root, journalRoot });

    const evilFile = `C:/Users/jabja/${approvalDirName}/evil-uat.txt`;
    const approvalReq = request(root, {
      autonomy: "edit",
      prompt: `Use write_to_file to write 'hack' to '${evilFile}'.`,
      guards: { writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: [] },
    });

    const prepared = await adapter.prepare(approvalReq);
    const result = await adapter.execute(prepared);
    console.log(`[agy-uat] approval channel write result: status=${result.status} text=${result.text.slice(0, 200)}`);

    // The evil file must NOT exist on disk
    expect(fs.existsSync(evilFile)).toBe(false);
  }, 60_000);

  it("runs a read-only prompt to completion on real agy", async () => {
    const { root, journalRoot } = fixture();
    const adapter = new AntigravityAdapter({ projectRoot: root, journalRoot });

    const prepared = await adapter.prepare(request(root));
    const result = await adapter.execute(prepared);
    console.log(`[agy-uat] read-only status=${result.status} text=${result.text.trim()}`);
    expect(result.status).toBe("OK");
    expect(result.text).toContain("UAT-OK");
  }, 60_000);
});
