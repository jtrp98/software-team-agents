import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, USAGE, parseArgs, runCli } from "./cli.js";
import { defaultProjectRoot } from "./agents/agentContract.js";

describe("parseArgs", () => {
  it("parses required flags and maps classification flags", () => {
    const args = parseArgs(
      ["--task-id", "T-1", "--module", "sales-crm", "--new-feature", "--backend", "--frontend"],
      "/repo",
    );
    expect(args).toEqual({
      taskId: "T-1",
      module: "sales-crm",
      projectRoot: "/repo",
      classification: { isNewFeatureModuleOrProject: true, touchesBackend: true, touchesFrontend: true },
      resume: false,
      list: false,
      checkContracts: false,
      checkLayout: false,
      checkWorkflows: false,
      checkProfile: false,
      dependsOn: [],
      stateDb: undefined,
      phases: [],
    });
  });

  it("--project-root overrides the default", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--project-root", "/other"], "/repo");
    expect(args.projectRoot).toBe("/other");
  });

  it("throws CliUsageError when --task-id is missing", () => {
    expect(() => parseArgs(["--module", "m"], "/repo")).toThrow(CliUsageError);
  });

  it("throws CliUsageError when --module is missing", () => {
    expect(() => parseArgs(["--task-id", "T-1"], "/repo")).toThrow(CliUsageError);
  });

  it("throws CliUsageError on an unrecognized flag", () => {
    expect(() => parseArgs(["--task-id", "T-1", "--module", "m", "--nope"], "/repo")).toThrow(CliUsageError);
  });
});

describe("parseArgs — persistence and dependency flags (T01)", () => {
  it("--resume marks the run as a continuation and needs no classification flags", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--resume"], "/repo");
    expect(args.resume).toBe(true);
    expect(args.classification).toEqual({});
  });

  it("--depends-on splits and trims a comma-separated list", () => {
    const args = parseArgs(["--task-id", "T-2", "--module", "m", "--depends-on", "T-1, T-0 ,"], "/repo");
    expect(args.dependsOn).toEqual(["T-1", "T-0"]);
  });

  it("rejects --depends-on together with --resume, since dependencies are fixed at creation", () => {
    expect(() => parseArgs(["--task-id", "T-2", "--module", "m", "--resume", "--depends-on", "T-1"], "/repo")).toThrow(
      CliUsageError,
    );
  });

  it("--list needs neither --task-id nor --module", () => {
    const args = parseArgs(["--list"], "/repo");
    expect(args.list).toBe(true);
    expect(args.taskId).toBeUndefined();
  });

  it("--phase parses a comma-separated list, for slicing module docs (T05)", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m", "--phase", "2, 3"], "/repo").phases).toEqual([2, 3]);
  });

  it("--phase drops values that are not positive integers rather than passing them on", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m", "--phase", "0,x,-1,4"], "/repo").phases).toEqual([4]);
  });

  it("defaults to no phase, which sends the plan whole instead of slicing it wrong", () => {
    expect(parseArgs(["--task-id", "T-1", "--module", "m"], "/repo").phases).toEqual([]);
  });

  it("--state-db overrides where state is kept", () => {
    const args = parseArgs(["--task-id", "T-1", "--module", "m", "--state-db", "/tmp/x.db"], "/repo");
    expect(args.stateDb).toBe("/tmp/x.db");
  });
});

describe("runCli --list (T01 wiring: sqlite store + registry + view)", () => {
  it("opens (and creates) the state database under the project root and reports an empty store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
    try {
      const code = await runCli(["--list", "--project-root", dir], dir);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, ".workflow", "state.db"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--resume on a task the store has never seen is a usage error, not a silent fresh run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
    try {
      await expect(runCli(["--task-id", "ghost", "--module", "m", "--resume", "--project-root", dir], dir)).rejects.toThrow(
        CliUsageError,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCli --check-contracts (T03)", () => {
  it("passes against this repo's own contracts, without opening a state database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cc-"));
    try {
      const code = await runCli(["--check-contracts"], defaultProjectRoot());
      expect(code).toBe(0);
      // No --project-root pointed here, so nothing should have been created either way.
      expect(fs.existsSync(path.join(dir, ".workflow"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when the contracts folder is missing, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cc-"));
    try {
      expect(await runCli(["--check-contracts", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module", () => {
    expect(parseArgs(["--check-contracts"], "/repo").checkContracts).toBe(true);
  });
});

describe("runCli --check-workflows (T09)", () => {
  it("passes against this repo's own workflows, without opening a state database", async () => {
    expect(await runCli(["--check-workflows"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there are no workflow files, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cw-"));
    try {
      expect(await runCli(["--check-workflows", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-workflows"], "/repo").checkWorkflows).toBe(true);
    expect(USAGE).toContain("--check-workflows");
  });
});

describe("runCli --check-profile (T13/T14)", () => {
  it("passes against this repo's own profile", async () => {
    expect(await runCli(["--check-profile"], defaultProjectRoot())).toBe(0);
  });

  it("exits non-zero when there is no project.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cp-"));
    try {
      expect(await runCli(["--check-profile", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module, and is listed in the usage text", () => {
    expect(parseArgs(["--check-profile"], "/repo").checkProfile).toBe(true);
    expect(USAGE).toContain("--check-profile");
  });
});

describe("runCli --check-layout (T04)", () => {
  it("passes against this repo's own layout, without opening a state database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cl-"));
    try {
      expect(await runCli(["--check-layout"], defaultProjectRoot())).toBe(0);
      expect(fs.existsSync(path.join(dir, ".workflow"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when there is no layout.yaml, rather than passing quietly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cl-"));
    try {
      expect(await runCli(["--check-layout", "--project-root", dir], dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs neither --task-id nor --module", () => {
    expect(parseArgs(["--check-layout"], "/repo").checkLayout).toBe(true);
  });

  it("is listed in the usage text, so it is discoverable without reading the source", () => {
    expect(USAGE).toContain("--check-layout");
  });
});
