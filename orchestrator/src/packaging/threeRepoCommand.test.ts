import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { assertFrameworkManagedPaths } from "../threeRepo/ownership.js";
import { runThreeRepoInit, runThreeRepoUpgrade } from "./threeRepoCommand.js";

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-three-repo-packaging-"));
  roots.push(root);
  return root;
}
function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("three-repo packaging boundary", () => {
  it("rejects Target instructions from a strict framework manifest, while legacy mode is explicit", () => {
    expect(() => assertFrameworkManagedPaths(["CLAUDE.md"])).toThrow(/project-owned/);
    expect(() => assertFrameworkManagedPaths(["CLAUDE.md", "AGENTS.md", ".claude/settings.json"], "legacy-project")).not.toThrow();
  });

  it("initializes only missing Knowledge-owned directories and config without application source", () => {
    const knowledge = tmpRoot();
    write(knowledge, "_docs/module/sales/requirement.md", "# approved requirement\n");
    write(knowledge, "knowledge/_roles/ba.yaml", "human approval\n");
    write(knowledge, "AGENTS.md", "# Target instruction preserved\n");
    write(knowledge, "CLAUDE.md", "# Target instruction preserved\n");

    const result = runThreeRepoInit(knowledge);

    expect(result.createdDirectories).toEqual(expect.arrayContaining(["decisions"]));
    expect(result.createdDirectories).not.toContain("_docs");
    expect(fs.readFileSync(path.join(knowledge, "_docs/module/sales/requirement.md"), "utf8")).toBe("# approved requirement\n");
    expect(fs.readFileSync(path.join(knowledge, "knowledge/_roles/ba.yaml"), "utf8")).toBe("human approval\n");
    expect(fs.readFileSync(path.join(knowledge, "AGENTS.md"), "utf8")).toBe("# Target instruction preserved\n");
    expect(fs.readFileSync(path.join(knowledge, "CLAUDE.md"), "utf8")).toBe("# Target instruction preserved\n");
    expect(fs.existsSync(path.join(knowledge, "orchestrator", "package.json"))).toBe(false);
    expect(fs.readFileSync(path.join(knowledge, "targets.yaml"), "utf8")).toBe("schema_version: 1\ntargets: []\n");
    expect(fs.readFileSync(path.join(knowledge, ".gitignore"), "utf8")).toContain(".workflow/");
  });

  it("is non-overwriting and upgrade never traverses Knowledge or Target data", () => {
    const knowledge = tmpRoot();
    write(knowledge, "knowledge-policy.yaml", "custom: policy\n");
    write(knowledge, "targets.yaml", "schema_version: 1\ntargets:\n  - target_id: retained\n");
    write(knowledge, "_docs/module/sales/design.md", "# retained design\n");
    write(knowledge, "AGENTS.md", "# target-specific\n");
    runThreeRepoInit(knowledge);

    const result = runThreeRepoUpgrade(knowledge);

    expect(result.frameworkBindingsUpdated).toEqual([]);
    expect(result.knowledgePathsSkipped).toEqual(expect.arrayContaining(["knowledge", "_docs", "AGENTS.md", ".claude"]));
    expect(fs.readFileSync(path.join(knowledge, "knowledge-policy.yaml"), "utf8")).toBe("custom: policy\n");
    expect(fs.readFileSync(path.join(knowledge, "targets.yaml"), "utf8")).toContain("retained");
    expect(fs.readFileSync(path.join(knowledge, "_docs/module/sales/design.md"), "utf8")).toBe("# retained design\n");
    expect(fs.readFileSync(path.join(knowledge, "AGENTS.md"), "utf8")).toBe("# target-specific\n");
  });

  it("requires an explicit mode and does not infer one from existing directories", async () => {
    const knowledge = tmpRoot();
    fs.mkdirSync(path.join(knowledge, "knowledge"));
    await expect(runCli(["init", "--project-root", knowledge], knowledge)).rejects.toThrow(/--mode/);
    expect(await runCli(["init", "--mode", "three-repo", "--project-root", knowledge], knowledge)).toBe(0);
    await expect(runCli(["upgrade", "--project-root", knowledge], knowledge)).rejects.toThrow(/--mode/);
    expect(await runCli(["upgrade", "--mode", "three-repo", "--project-root", knowledge], knowledge)).toBe(0);
  });
});
