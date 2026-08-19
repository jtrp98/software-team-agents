import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "./cli.js";

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
