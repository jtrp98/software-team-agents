import "../cli.js";
import { describe, expect, it } from "vitest";
import { parseBoundedRunArgs } from "../cli/verbs/boundedRun.js";
import { childEnvironment } from "./processes.js";

describe("STA Core boundaries", () => {
  it("bounded-run accepts --core-run (set only by STA Core) and keeps every other rule", () => {
    const args = parseBoundedRunArgs(["--module", "m", "--all", "--autonomy", "edit", "--root", "timetable", "--core-run", "C:/x/overlay.json"], "/repo");
    expect(args.coreRun).toBe("C:/x/overlay.json");
    expect(args.rootName).toBe("timetable");
    expect(() => parseBoundedRunArgs(["--module", "m", "--all", "--core-run", "o.json"], "/repo")).toThrow(/--autonomy edit/);
  });

  it("a Core child never inherits another run's identity or Knowledge selection from the service environment", () => {
    const env = childEnvironment({ PATH: "p", STA_KNOWLEDGE_ROOT: "C:/other", STA_KNOWLEDGE_ROOT_NAME: "company-a", STA_RUN_ID: "r", STA_ROLE: "qa-engineer" });
    expect(env).toEqual({ PATH: "p" });
  });
});
