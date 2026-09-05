import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The setup playbook is an entry-point contract: both Claude Code and Codex
 * consume it as-is, and every flow inside it must route through the official
 * CLI rather than hand-rolling workspace changes. These tests protect that
 * contract against silent drift — a renamed command, a dropped role, or a
 * destructive instruction should fail here first.
 */

function findRepoRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "prompt-setup.md"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("prompt-setup.md not found above the orchestrator package");
    cursor = parent;
  }
}

const root = findRepoRoot();
const prompt = fs.readFileSync(path.join(root, "prompt-setup.md"), "utf8");

const REQUIRED_SECTIONS = [
  "Phase 0 — Initial inspection",
  "Role menu",
  "Flow: BA",
  "Flow: DEV",
  "Flow: QA",
  "Flow: Add Target",
  "Flow: Update Setup",
  "Flow: Inspect Setup",
  "Flow: Repair",
  "Safety rails",
  "Final report template",
];

describe("prompt-setup.md — AI-assisted setup entry point", () => {
  it("exists at the Framework root", () => {
    expect(fs.existsSync(path.join(root, "prompt-setup.md"))).toBe(true);
  });

  it("covers every role and mode of the setup checklist", () => {
    for (const section of REQUIRED_SECTIONS) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toMatch(/BA works in|works in the Knowledge repository/);
  });

  it("routes all mutations through the official CLI surface — never duplicated logic", () => {
    expect(prompt).toContain("software-team-agents status --json");
    expect(prompt).toContain("software-team-agents init");
    expect(prompt).toContain("software-team-agents sync");
    expect(prompt).toContain("sta configure knowledge-root");
    // The playbook must not tell the AI to fabricate managed state by hand.
    expect(prompt).toContain("Never hand-craft");
  });

  it("is usable from any runtime and stays runtime-agnostic", () => {
    expect(prompt).toContain("Claude Code");
    expect(prompt).toContain("Codex");
    expect(prompt).not.toMatch(/claude -p --agent/); // no provider-specific plumbing
  });

  it("keeps the safety rails intact — inspect-first and nothing destructive", () => {
    expect(prompt).toContain("Inspect before asking");
    expect(prompt).toContain("never run `sync --force` unprompted");
    expect(prompt).toContain("never delete");
    expect(prompt).not.toMatch(/rm -rf|del \/s/i);
  });

  it("ships with the distributable so an installed .tgz carries the same setup model", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files?: string[] };
    expect(pkg.files ?? []).toContain("prompt-setup.md");
  });

  it("T-LV4 — Flow: DEV bootstraps a Target that doesn't exist locally yet, with confirmation before any git mutation", () => {
    // All three Target shapes: already checked out, remote-but-not-cloned, and
    // a genuinely new project with no remote at all.
    expect(prompt).toMatch(/Already exists/);
    expect(prompt).toMatch(/Has a remote, not cloned/);
    expect(prompt).toMatch(/genuinely new project/);
    expect(prompt).toContain("git clone <url> <path>");
    expect(prompt).toContain("git init <path>");
    // The confirmation rail: shown before running, explicit wait, and it's the
    // playbook's first (and only) state-changing git command.
    expect(prompt).toMatch(/never run a state-changing git command without showing it first/);
    expect(prompt).toMatch(/wait for the user's explicit confirmation|wait for the same explicit confirmation/);
    // The new-project branch routes to `setup`, not to this playbook, for scaffolding.
    expect(prompt).toMatch(/`setup` agent has to run/);
  });

  it("T-V3-13 — reads the Harness profile, asks only on ambiguity, and delegates managed merges to sync", () => {
    expect(prompt).toContain("`status --json` → `stack`");
    expect(prompt).toContain("do not detect the stack yourself");
    expect(prompt).toMatch(/Ask no stack question when `stack` is resolved/);
    expect(prompt).toContain("`--stack <name>`");
    expect(prompt).not.toContain("Merging with the project's existing Claude setup");
    expect(prompt).not.toContain("Fixed project stack");
    expect(prompt).toMatch(/sync.*merges|merges[\s\S]*\.claude\/settings\.json/);
    expect(prompt).toContain("Stack     : <resolved profile");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(23_171);
  });
});
