import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseModelFromFrontmatter, resolveAgentModel } from "./agentModel.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-"));
}

function writeAgentFile(root: string, role: string, frontmatter: string) {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${role}.md`), frontmatter, "utf8");
}

describe("resolveAgentModel (T26)", () => {
  it("reads the model straight out of the agent's own frontmatter", () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "---\nname: backend-engineer\nmodel: sonnet\neffort: medium\n---\n\nbody\n");
    expect(resolveAgentModel(root, "backend-engineer")).toBe("sonnet");
  });

  it("returns null when the agent file doesn't exist, rather than throwing", () => {
    const root = tmpProject();
    expect(resolveAgentModel(root, "nonexistent-agent")).toBeNull();
  });

  it("returns null when the file has no frontmatter block at all", () => {
    const root = tmpProject();
    writeAgentFile(root, "loose", "just a body, no frontmatter\n");
    expect(resolveAgentModel(root, "loose")).toBeNull();
  });

  it("returns null when frontmatter exists but has no model: line", () => {
    const root = tmpProject();
    writeAgentFile(root, "no-model", "---\nname: no-model\n---\n\nbody\n");
    expect(resolveAgentModel(root, "no-model")).toBeNull();
  });

  it("resolves 'inherit' literally — CLAUDE.md defines it as following the session's /model, which this static reader cannot know", () => {
    const root = tmpProject();
    writeAgentFile(root, "flexible", "---\nname: flexible\nmodel: inherit\n---\n\nbody\n");
    expect(resolveAgentModel(root, "flexible")).toBe("inherit");
  });
});

describe("parseModelFromFrontmatter", () => {
  it("tolerates extra whitespace around the colon", () => {
    expect(parseModelFromFrontmatter("---\nmodel:    opus  \n---\n")).toBe("opus");
  });

  it("only reads the frontmatter block, not a model: mention in the body", () => {
    const text = "---\nname: x\n---\n\nDon't confuse this with a model: reference in prose.\n";
    expect(parseModelFromFrontmatter(text)).toBeNull();
  });
});
