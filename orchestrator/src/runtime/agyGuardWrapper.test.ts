import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The AGY guard wrapper, exercised as a real child process against the real
 * `.agents/hooks/sta-guard.js` sync ships — because the thing under test is a
 * process contract, not a function: AGY reads stdout and treats *anything but*
 * `{"decision":"allow"}` as a denial, so an in-process call would prove nothing
 * about the outcome that actually matters.
 *
 * The acceptance case is the deliberately broken wrapper: a guard whose own
 * code is wrong must still deny. On Claude Code that failure mode allows
 * (exit 1 reads as allow), and this repository has been bitten by it twice.
 */

const WRAPPER = path.resolve(import.meta.dirname, "../../../.agents/hooks/sta-guard.js");
const ALLOW_PAYLOAD = '{"decision":"allow"}';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(options: { role?: "ba" | "dev"; contracts?: Record<string, string> } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-agy-guard-"));
  roots.push(root);
  if (options.role) {
    fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-team", "config.yaml"), `schema_version: 1\nrole: ${options.role}\n`, "utf8");
  }
  for (const [name, content] of Object.entries(options.contracts ?? {})) {
    fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
    fs.writeFileSync(path.join(root, "contracts", `${name}.yaml`), content, "utf8");
  }
  return root;
}

interface Verdict {
  allowed: boolean;
  stdout: string;
  reason?: string;
}

function invoke(script: string, root: string, payload: string, env: Record<string, string> = {}): Verdict {
  const proc = spawnSync(process.execPath, [script], {
    input: payload,
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, AGENTCLAUDE_WORKSPACE_ROOT: root, AGENTCLAUDE_ROLE: "", ...env },
  });
  const stdout = proc.stdout ?? "";
  let reason: string | undefined;
  try {
    reason = (JSON.parse(stdout) as { reason?: string }).reason;
  } catch {
    reason = undefined;
  }
  // The AGY contract, stated exactly once, here: allow is the payload, nothing else.
  return { allowed: stdout.trim() === ALLOW_PAYLOAD, stdout, reason };
}

function writeCall(filePath: string, tool = "write_to_file"): string {
  return JSON.stringify({ tool_name: tool, tool_info: { parameters: { TargetFile: filePath } } });
}

const QA_CONTRACT = 'permissions:\n  write: ["review.md", "review/**"]\n  deny: ["_docs/**"]\n  read: ["**"]\n';

describe("AGY guard wrapper — allow is emitted on exactly one path", () => {
  it("allows a write the role's contract grants", () => {
    const root = workspace({ role: "dev", contracts: { "qa-engineer": QA_CONTRACT } });
    const verdict = invoke(WRAPPER, root, writeCall("review.md"), { AGENTCLAUDE_ROLE: "qa-engineer" });
    expect(verdict.allowed).toBe(true);
  });

  it("denies a write outside the role's contract", () => {
    const root = workspace({ role: "dev", contracts: { "qa-engineer": QA_CONTRACT } });
    const verdict = invoke(WRAPPER, root, writeCall("server/index.ts"), { AGENTCLAUDE_ROLE: "qa-engineer" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/outside this role's declared paths/);
  });

  it("denies the universal floor with no role at all", () => {
    const root = workspace();
    expect(invoke(WRAPPER, root, writeCall(".git/config")).allowed).toBe(false);
    expect(invoke(WRAPPER, root, writeCall("node_modules/x/index.js")).allowed).toBe(false);
  });

  it("denies a BA artifact from a dev workspace, identity-independent", () => {
    const root = workspace({ role: "dev" });
    const verdict = invoke(WRAPPER, root, writeCall("_docs/module/billing/design.md"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/Knowledge repository/);
  });

  it("denies a write that resolves outside the workspace root", () => {
    const root = workspace();
    expect(invoke(WRAPPER, root, writeCall(path.join(os.tmpdir(), "elsewhere.txt"))).allowed).toBe(false);
  });

  it("allows a tool it does not guard, rather than blocking unrelated work", () => {
    const root = workspace();
    const verdict = invoke(WRAPPER, root, JSON.stringify({ tool_name: "view_file", tool_info: { parameters: { TargetFile: ".git/config" } } }));
    expect(verdict.allowed).toBe(true);
  });
});

describe("AGY guard wrapper — every non-allow path withholds the payload", () => {
  it("denies unparseable stdin", () => {
    const root = workspace();
    expect(invoke(WRAPPER, root, "{ not json").allowed).toBe(false);
  });

  it("denies empty stdin", () => {
    const root = workspace();
    expect(invoke(WRAPPER, root, "").allowed).toBe(false);
  });

  it("denies a payload with no identifiable tool", () => {
    const root = workspace();
    expect(invoke(WRAPPER, root, JSON.stringify({ something: "else" })).allowed).toBe(false);
  });

  it("denies a guarded tool whose parameters carry no recognisable path", () => {
    const root = workspace();
    const verdict = invoke(WRAPPER, root, JSON.stringify({ tool_name: "write_to_file", tool_info: { parameters: { Contents: "hi" } } }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/no recognisable destination path/);
  });

  it("[CRITICAL] a deliberately broken wrapper denies", () => {
    const root = workspace({ role: "dev", contracts: { "qa-engineer": QA_CONTRACT } });
    const broken = path.join(root, "broken-guard.js");
    // Same file, one line corrupted: the rule data the guard reads is gone, so
    // every code path that touches it throws. Under Claude Code's contract this
    // exits 1 and the tool call proceeds; under AGY's it must deny.
    fs.writeFileSync(
      broken,
      fs.readFileSync(WRAPPER, "utf8").replace(/^const UNIVERSAL_DENY = .*$/m, "const UNIVERSAL_DENY = undefined;"),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");

    const verdict = invoke(broken, root, writeCall("review.md"), { AGENTCLAUDE_ROLE: "qa-engineer" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.stdout).not.toContain('"allow"');
  });

  it("[CRITICAL] a wrapper that cannot even load denies — no output is not allow", () => {
    const root = workspace();
    const broken = path.join(root, "unloadable-guard.js");
    fs.writeFileSync(broken, "this is not valid javascript ((( \n", "utf8");
    const verdict = invoke(broken, root, writeCall("review.md"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.stdout.trim()).toBe("");
  });
});
