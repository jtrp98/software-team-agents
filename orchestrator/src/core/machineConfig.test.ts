import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertAcceptableMachineRoot,
  assertInsideMachineRoots,
  defaultMachineConfig,
  isInsideRoot,
  loadMachineConfig,
  MachineConfigError,
  parseMachineConfig,
  saveMachineConfig,
} from "./machineConfig.js";

describe("STA Core machine config", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-machine-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("defaults to Thai, edit autonomy and configurable (not hard-coded) role orders", () => {
    const config = defaultMachineConfig();
    expect(config.language).toBe("th");
    expect(config.runtime.default_autonomy).toBe("edit");
    expect(config.commander.order).toEqual(["claude-code", "codex", "antigravity", "zcode"]);
    expect(config.roles.engineer.order[0]).toBe("codex");
    expect(config.intent.provider).toBe("gemini");
  });

  it("accepts the agy alias and stores the canonical runtime id", () => {
    const config = parseMachineConfig({ commander: { order: ["agy", "codex"] } });
    expect(config.commander.order).toEqual(["antigravity", "codex"]);
  });

  it("refuses an unknown runtime and a duplicated entry", () => {
    expect(() => parseMachineConfig({ commander: { order: ["gpt-runner"] } })).toThrow(MachineConfigError);
    expect(() => parseMachineConfig({ roles: { engineer: { order: ["codex", "codex"] } } })).toThrow(/at most once/);
  });

  it("never takes a whole drive or filesystem root as the machine boundary", () => {
    expect(() => assertAcceptableMachineRoot(path.parse(process.cwd()).root)).toThrow(/drive root/);
    expect(() => assertAcceptableMachineRoot("relative/dir")).toThrow(/absolute/);
    expect(assertAcceptableMachineRoot(dir)).toBe(path.resolve(dir));
  });

  it("round-trips through disk with validation and keeps unknown keys out", () => {
    const file = path.join(dir, "machine.yaml");
    saveMachineConfig({ workspace: { allowed_roots: [dir] }, language: "en" }, file);
    expect(loadMachineConfig(file).language).toBe("en");
    fs.writeFileSync(file, "language: th\nsurprise: true\n", "utf8");
    expect(() => loadMachineConfig(file)).toThrow(/surprise|Unrecognized/);
  });

  it("machine root is an outer fence: inside passes, a sibling with the same prefix does not", () => {
    const root = path.join(dir, "src");
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src-other"), { recursive: true });
    const config = parseMachineConfig({ workspace: { allowed_roots: [root] } });
    expect(isInsideRoot(path.join(root, "app"), root)).toBe(true);
    expect(() => assertInsideMachineRoots(config, path.join(root, "app"), "Target")).not.toThrow();
    expect(() => assertInsideMachineRoots(config, path.join(dir, "src-other"), "Target")).toThrow(/outside the machine root/);
  });
});
