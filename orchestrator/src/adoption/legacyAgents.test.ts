import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentContract } from "../agents/agentContract.js";
import { scanLegacyAgents, unmappedRecordsFrom } from "./legacyAgents.js";

/**
 * The rule this locks: a conversion may take from the legacy prompt only what a
 * prompt actually states, and every disagreement with this framework's role of
 * the same name has to be visible rather than smoothed over. A contract that
 * reads correct while describing an agent that behaves differently is the one
 * outcome worse than refusing to convert.
 */

const roots: string[] = [];

function project(agents: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-agents-"));
  roots.push(root);
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function agentFile(fields: Record<string, string>, body = "You are an agent.\n"): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("scanLegacyAgents — a role this framework knows", () => {
  it("takes the prompt's own description and tools, and this framework's contract for everything a prompt cannot state", () => {
    const root = project({
      "qa-engineer": agentFile({
        name: "qa-engineer",
        description: "Legacy QA agent, checks the work.",
        tools: "Read, Glob, Grep, Bash, AskUserQuestion, Write, Edit",
        model: "sonnet",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;
    const framework = loadAgentContract("qa-engineer");

    expect(conversion.contract?.agent.description).toBe("Legacy QA agent, checks the work.");
    expect(conversion.contract?.tools).toEqual(["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "Write", "Edit"]);
    // Not stated by a prompt, so taken from the role rather than invented.
    expect(conversion.contract?.constraints).toEqual(framework.constraints);
    expect(conversion.contract?.permissions).toEqual(framework.permissions);
    expect(conversion.contract?.states).toEqual(framework.states);
    expect(conversion.contract?.capability).toEqual(framework.capability);
  });

  it("reports a tool difference instead of normalising it away", () => {
    const root = project({
      "qa-engineer": agentFile({
        name: "qa-engineer",
        description: "Legacy QA.",
        tools: "Read, Bash",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.contract?.tools).toEqual(["Read", "Bash"]);
    expect(conversion.differences.some((d) => d.startsWith("tools:") && d.includes("lacks"))).toBe(true);
  });

  it("calls out an agent that can invoke the next agent, separately from the tool diff", () => {
    const root = project({
      "project-manager": agentFile({
        name: "project-manager",
        description: "Legacy PM that chains.",
        tools: "Read, Write, Edit, Agent",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.differences.some((d) => d.includes("holds the Agent/Task tool"))).toBe(true);
  });

  it("reports a model that differs from the one this framework runs for that role", () => {
    const root = project({
      "system-analyst": agentFile({
        name: "system-analyst",
        description: "Legacy SA.",
        tools: "Read, Glob, Grep, AskUserQuestion, Write, Edit",
        model: "haiku",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.differences.some((d) => d.includes('runs model "haiku"'))).toBe(true);
  });

  it("says nothing about the model when it matches", () => {
    const root = project({
      "system-analyst": agentFile({
        name: "system-analyst",
        description: "Legacy SA.",
        tools: "Read, Glob, Grep, AskUserQuestion, Write, Edit",
        model: "sonnet",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.differences.filter((d) => d.includes("model"))).toEqual([]);
  });

  it("treats the filename as the identity and reports a name field that disagrees", () => {
    const root = project({
      "qa-engineer": agentFile({
        name: "quality-assurance",
        description: "Legacy QA.",
        tools: "Read, Glob, Grep, Bash, AskUserQuestion, Write, Edit",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.definition.name).toBe("qa-engineer");
    expect(conversion.differences.some((d) => d.includes("the filename is the identity"))).toBe(true);
  });
});

describe("scanLegacyAgents — a role this framework has no name for", () => {
  it("writes no contract, because the schema has ten names in it and none of them is this one", () => {
    const root = project({
      "code-reviewer": agentFile({ name: "code-reviewer", description: "Reviews diffs.", tools: "Read, Grep" }),
    });

    const scan = scanLegacyAgents(root);

    expect(scan.conversions[0].contract).toBeNull();
    expect(unmappedRecordsFrom(scan)).toEqual([
      {
        name: "code-reviewer",
        relativePath: ".claude/agents/code-reviewer.md",
        description: "Reviews diffs.",
        tools: ["Read", "Grep"],
        note: expect.stringContaining("no role of this name"),
      },
    ]);
  });

  it("keeps a mapped and an unmapped agent apart in one scan", () => {
    const root = project({
      "code-reviewer": agentFile({ name: "code-reviewer", description: "Reviews diffs.", tools: "Read" }),
      devops: agentFile({ name: "devops", description: "Ships it.", tools: "Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion" }),
    });

    const scan = scanLegacyAgents(root);

    expect(scan.conversions.filter((c) => c.contract !== null).map((c) => c.definition.name)).toEqual(["devops"]);
    expect(unmappedRecordsFrom(scan).map((u) => u.name)).toEqual(["code-reviewer"]);
  });
});

describe("scanLegacyAgents — awkward input", () => {
  it("reads a description containing a colon, which a YAML parser would refuse", () => {
    const root = project({
      devops: agentFile({
        name: "devops",
        description: "Use this agent to deploy: Docker, CI, migrations — and nothing else.",
        tools: "Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion",
      }),
    });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.contract?.agent.description).toBe(
      "Use this agent to deploy: Docker, CI, migrations — and nothing else.",
    );
  });

  it("lists a file with no frontmatter as unreadable rather than converting half of it", () => {
    const root = project({ notes: "# just some notes, no frontmatter\n" });

    const scan = scanLegacyAgents(root);

    expect(scan.conversions).toEqual([]);
    expect(scan.unreadable).toEqual([".claude/agents/notes.md"]);
  });

  it("returns nothing at all for a project with no .claude/agents/ directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-agents-empty-"));
    roots.push(root);

    expect(scanLegacyAgents(root)).toEqual({ conversions: [], unreadable: [] });
  });

  it("falls back to this framework's tools when the legacy prompt declares none", () => {
    const root = project({ setup: agentFile({ name: "setup", description: "Scaffolds." }) });

    const [conversion] = scanLegacyAgents(root).conversions;

    expect(conversion.contract?.tools).toEqual(loadAgentContract("setup").tools);
  });
});
