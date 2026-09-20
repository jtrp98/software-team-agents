import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface CommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
}

interface HookGroup {
  hooks: CommandHook[];
}

const projectRoot = path.resolve(import.meta.dirname, "../..");
const hooksPath = path.join(projectRoot, ".codex", "hooks.json");

function commandHooks(): CommandHook[] {
  const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
    hooks: Record<string, HookGroup[]>;
  };
  return Object.values(parsed.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
}

describe("Codex project hook wiring", () => {
  it("resolves every hook from the active git root instead of a machine-local checkout", () => {
    const handlers = commandHooks();
    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      expect(handler.command).toContain("git rev-parse --show-toplevel");
      expect(handler.command).toContain("CLAUDE_PROJECT_DIR");
      expect(handler.command).not.toMatch(/[A-Za-z]:[\\/]/);

      expect(handler.commandWindows).toContain("git rev-parse --show-toplevel");
      expect(handler.commandWindows).toContain("CLAUDE_PROJECT_DIR");
      expect(handler.commandWindows).toContain("exit $LASTEXITCODE");
      expect(handler.commandWindows).not.toMatch(/[A-Za-z]:[\\/]/);
    }
  });

  it.runIf(process.platform === "win32")("keeps blocking exit code 2 when launched from a subdirectory on Windows", () => {
    const blockGit = commandHooks().find((handler) => handler.commandWindows?.includes("block-git.js"));
    expect(blockGit?.commandWindows).toBeDefined();

    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", blockGit!.commandWindows!], {
      cwd: path.join(projectRoot, "orchestrator", "src"),
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m test" } }),
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Blocked: `git commit`");
  });
});
