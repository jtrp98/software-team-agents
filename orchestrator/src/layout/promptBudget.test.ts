import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_PROMPT_TARGET, CLAUDE_MD_BUDGET, PROMPT_BUDGETS, checkPromptBudget } from "./promptBudget.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * A minimal workspace with the two things this checker reads: `CLAUDE.md` and
 * `.claude/agents/*.md`. Policy pointers resolve against real `policies/`
 * copies so guard 4 is exercised against real headings, not a stub.
 */
function fixture(opts: { claudeMd?: string; agents?: Record<string, string>; policies?: Record<string, string> }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-prompt-budget-"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), opts.claudeMd ?? "# card\n", "utf8");
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "shared"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "shared", "agent-preamble.md"), "# Agent preamble\n", "utf8");
  for (const [name, body] of Object.entries(opts.agents ?? {})) {
    fs.writeFileSync(path.join(root, ".claude", "agents", name), body, "utf8");
  }
  fs.mkdirSync(path.join(root, "policies"), { recursive: true });
  for (const [name, body] of Object.entries(opts.policies ?? { "coding.md": "# Coding\n\n## 5c. Green before handoff\nbody\n" })) {
    fs.writeFileSync(path.join(root, "policies", name), body, "utf8");
  }
  return root;
}

function agentFile(tools: string, body = "You are an agent.\n"): string {
  return `---\nname: setup\ndescription: A role.\ntools: ${tools}\nmodel: sonnet\nversion: 1\n---\n\n${body}`;
}

describe("guard 1 — CLAUDE.md budget", () => {
  it("fails when CLAUDE.md exceeds its budget", () => {
    const root = fixture({ claudeMd: "x".repeat(CLAUDE_MD_BUDGET + 1), agents: { "setup.md": agentFile("Read, Write") } });
    const result = checkPromptBudget(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CLAUDE.md is") && p.includes("over its"))).toBe(true);
  });

  it("passes at exactly the budget — the boundary is inclusive", () => {
    const root = fixture({ claudeMd: "x".repeat(CLAUDE_MD_BUDGET), agents: { "setup.md": agentFile("Read, Write") } });
    expect(checkPromptBudget(root).problems.some((p) => p.startsWith("CLAUDE.md is"))).toBe(false);
  });

  it("adding fake bytes to a passing CLAUDE.md turns the check red", () => {
    const root = fixture({ claudeMd: "x".repeat(100), agents: { "setup.md": agentFile("Read, Write") } });
    expect(checkPromptBudget(root).ok).toBe(true);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "x".repeat(CLAUDE_MD_BUDGET + 500), "utf8");
    expect(checkPromptBudget(root).ok).toBe(false);
  });

  it("fails when CLAUDE.md is missing entirely", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write") } });
    fs.rmSync(path.join(root, "CLAUDE.md"));
    expect(checkPromptBudget(root).problems.some((p) => p.includes("CLAUDE.md is missing"))).toBe(true);
  });
});

describe("guard 2 — per-role prompt budgets", () => {
  it("fails a prompt over its declared budget", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "y".repeat(PROMPT_BUDGETS["setup.md"] + 1)) } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("setup.md is") && p.includes("over its"))).toBe(true);
  });

  it("refuses a prompt that has no declared budget rather than letting it through", () => {
    const root = fixture({ agents: { "unlisted-role.md": agentFile("Read, Write") } });
    const result = checkPromptBudget(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("has no declared budget"))).toBe(true);
  });

  it("says so when a prompt has already reached the shared target", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write") } });
    const result = checkPromptBudget(root);
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.includes(`at the ${AGENT_PROMPT_TARGET} B target`))).toBe(true);
  });

  it("fails when there are no agent prompts at all", () => {
    const root = fixture({});
    expect(checkPromptBudget(root).problems).toContain("no .claude/agents/*.md prompts found");
  });
});

describe("guard 3 — no global policies pre-read", () => {
  it("catches the directive in its bolded form", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "**Read every file in `policies/` before anything else.**\n") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("read every file in policies/"))).toBe(true);
  });

  it("catches it unbolded too — uxui-designer worded it differently", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "Read every file in policies/ first.\n") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("read every file in policies/"))).toBe(true);
  });

  it("allows a section-level pointer, which is the replacement", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "Read `policies/coding.md` §5c before handing off.\n") } });
    expect(checkPromptBudget(root).ok).toBe(true);
  });
});

describe("guard 4 — every policy pointer resolves", () => {
  it("fails a pointer at a heading that does not exist", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "See `policies/coding.md` §99.\n") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("§99"))).toBe(true);
  });

  it("passes a pointer at a heading that does", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "See `policies/coding.md` §5c.\n") } });
    expect(checkPromptBudget(root).ok).toBe(true);
  });
});

describe("structural guards — the reason R03/R12 may shrink in CLAUDE.md", () => {
  it("fails a prompt whose frontmatter grants the Agent tool", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write, Agent") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("grants the Agent tool"))).toBe(true);
  });

  it("fails a prompt whose body names the Agent tool", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "Hand off with the Agent tool.\n") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("mentions the Agent tool in its body"))).toBe(true);
  });

  it("fails an engineer prompt that grants AskUserQuestion", () => {
    const root = fixture({ agents: { "backend-engineer.md": agentFile("Read, Write, AskUserQuestion") } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("grants AskUserQuestion"))).toBe(true);
  });

  it("allows AskUserQuestion on a role that is meant to have it", () => {
    const root = fixture({ agents: { "business-analyst.md": agentFile("Read, Write, AskUserQuestion") } });
    expect(checkPromptBudget(root).ok).toBe(true);
  });

  it("fails a prompt with no frontmatter tools line", () => {
    const root = fixture({ agents: { "setup.md": "---\nname: setup\ndescription: x\n---\n\nbody\n" } });
    expect(checkPromptBudget(root).problems.some((p) => p.includes("no frontmatter tools: line"))).toBe(true);
  });

  it("does not mistake a word containing Agent for the tool", () => {
    const root = fixture({ agents: { "setup.md": agentFile("Read, Write", "This is the AgentClaude pipeline; agents hand off in writing.\n") } });
    expect(checkPromptBudget(root).ok).toBe(true);
  });
});

describe("this repository", () => {
  it("grants no role the Agent tool and no engineer AskUserQuestion", () => {
    // The structural half of R03/R12, checked against the files Claude Code
    // actually resolves subagents from — which --check-contracts never reads.
    const problems = checkPromptBudget(REPO_ROOT).problems;
    expect(problems.filter((p) => p.includes("Agent tool"))).toEqual([]);
    expect(problems.filter((p) => p.includes("AskUserQuestion"))).toEqual([]);
  });

  it("declares a budget for every prompt it ships", () => {
    const shipped = fs.readdirSync(path.join(REPO_ROOT, ".claude", "agents")).filter((f) => f.endsWith(".md")).sort();
    expect(Object.keys(PROMPT_BUDGETS).sort()).toEqual(shipped);
  });

  it("keeps every policy pointer in every prompt resolvable", () => {
    expect(checkPromptBudget(REPO_ROOT).problems.filter((p) => p.includes("which has no such heading"))).toEqual([]);
  });
});
