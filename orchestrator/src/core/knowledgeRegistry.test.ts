import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCoreHome, makeKnowledgeRoot, makeRepo, type CoreTestHome } from "./coreFixture.testSupport.js";
import {
  addKnowledge,
  KnowledgeRegistryError,
  listKnowledge,
  listModules,
  removeKnowledgeRegistration,
  resolveKnowledge,
  setDefaultKnowledge,
  validateKnowledge,
} from "./knowledgeRegistry.js";
import { parseMachineConfig } from "./machineConfig.js";

describe("STA Core — multiple Knowledge roots", () => {
  let env: CoreTestHome;
  let timetable: string;
  let companyA: string;
  beforeEach(() => {
    env = makeCoreHome();
    timetable = makeKnowledgeRoot(env.base, "timetable-knowledge", { modules: ["timetableai", "shared"], targets: [{ id: "timetable-api", remote: "https://github.com/acme/timetable-api.git" }] });
    companyA = makeKnowledgeRoot(env.base, "company-a-knowledge", { modules: ["billing", "shared"], targets: [{ id: "billing-api", remote: "https://github.com/acme/billing-api.git" }] });
  });
  afterEach(() => env.cleanup());

  const add = (name: string, p: string, makeDefault = false) => addKnowledge(name, p, { makeDefault, configPath: env.installationConfig });

  it("multiple roots load, the first becomes default, and an explicit selection wins", () => {
    add("timetable", timetable);
    add("company-a", companyA);
    const all = listKnowledge({ configPath: env.installationConfig });
    expect(all.map((k) => k.name)).toEqual(["company-a", "timetable"]);
    expect(all.find((k) => k.name === "timetable")!.isDefault).toBe(true);
    expect(resolveKnowledge(undefined, env.installationConfig).name).toBe("timetable");
    expect(resolveKnowledge("company-a", env.installationConfig).path).toBe(companyA);
    setDefaultKnowledge("company-a", env.installationConfig);
    expect(resolveKnowledge(undefined, env.installationConfig).name).toBe("company-a");
  });

  it("modules and targets come only from the selected root (the Web selector's filter)", () => {
    add("timetable", timetable);
    add("company-a", companyA);
    expect(listModules(timetable)).toEqual(["shared", "timetableai"]);
    expect(listModules(companyA)).toEqual(["billing", "shared"]);
    const t = listKnowledge({ configPath: env.installationConfig }).find((k) => k.name === "timetable")!;
    expect(t.targets.map((x) => x.targetId)).toEqual(["timetable-api"]);
    expect(t.modules).not.toContain("billing");
  });

  it("an invalid Knowledge root is rejected (missing, not a repo, not a Knowledge workspace)", () => {
    expect(() => add("ghost", path.join(env.base, "nope"))).toThrow(KnowledgeRegistryError);
    const plain = path.join(env.base, "plain");
    fs.mkdirSync(plain);
    expect(() => add("plain", plain)).toThrow(/standalone Git repository/);
    const bare = makeRepo(path.join(env.base, "bare-repo"));
    expect(() => add("bare", bare)).toThrow(/does not look like a Knowledge workspace/);
    expect(() => add("Bad_Name", timetable)).toThrow(/must match/);
  });

  it("duplicate name or path is refused", () => {
    add("timetable", timetable);
    expect(() => add("timetable2", timetable)).toThrow(/already registered as Knowledge "timetable"/);
    expect(() => add("timetable", companyA)).toThrow(/already registered at/);
  });

  it("a Target cannot be implicitly owned by two Knowledge roots", () => {
    add("timetable", timetable);
    const thief = makeKnowledgeRoot(env.base, "thief-knowledge", { modules: ["x"], targets: [{ id: "api", remote: "https://github.com/acme/timetable-api.git" }] });
    expect(() => add("thief", thief)).toThrow(/Target ownership would conflict/);
    expect(listKnowledge({ configPath: env.installationConfig }).map((k) => k.name)).toEqual(["timetable"]);
  });

  it("machine root encloses Knowledge and Target checkouts", () => {
    const machine = parseMachineConfig({ workspace: { allowed_roots: [path.join(env.base, "only-here")] } });
    fs.mkdirSync(path.join(env.base, "only-here"));
    expect(() => addKnowledge("timetable", timetable, { machine, configPath: env.installationConfig })).toThrow(/outside the machine root/);
    const inside = parseMachineConfig({ workspace: { allowed_roots: [env.base] } });
    const outsideTarget = path.join(path.dirname(env.base), "elsewhere-target");
    const k = makeKnowledgeRoot(env.base, "mapped-knowledge", { modules: ["m"], targets: [{ id: "web", remote: "https://github.com/acme/web.git", localPath: outsideTarget }] });
    const summary = addKnowledge("mapped", k, { machine: parseMachineConfig({ workspace: { allowed_roots: [] } }), configPath: env.installationConfig });
    expect(summary.state).not.toBe("INVALID");
    expect(validateKnowledge("mapped", { machine: inside, configPath: env.installationConfig }).problems.join(" ")).toMatch(/outside the machine root/);
  });

  it("remove drops the registration only — the repository stays on disk", () => {
    add("timetable", timetable);
    add("company-a", companyA);
    expect(() => removeKnowledgeRegistration("timetable", env.installationConfig)).toThrow(/default root/);
    removeKnowledgeRegistration("company-a", env.installationConfig);
    expect(listKnowledge({ configPath: env.installationConfig }).map((k) => k.name)).toEqual(["timetable"]);
    expect(fs.existsSync(path.join(companyA, "_docs", "module", "billing"))).toBe(true);
    expect(() => removeKnowledgeRegistration("timetable", env.installationConfig)).toThrow(/only registered/);
  });
});
