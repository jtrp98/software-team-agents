import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../../classification/taskClassifier.js";
import { parseArgs } from "../../cli.js";
import { AgentStage } from "../../types.js";
import { runtimeTaskWorkRoots } from "./taskIntake.js";

const originalInstallation = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalInstallation === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
  else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = originalInstallation;
});

function repository(root: string, remote?: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
}

function fixture(): { knowledge: string; api: string; web: string; mvc: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-task-intake-"));
  roots.push(root);
  const knowledge = path.join(root, "knowledge");
  const api = path.join(root, "api");
  const web = path.join(root, "web");
  const mvc = path.join(root, "mvc");
  repository(knowledge);
  repository(api, "https://github.com/acme/api.git");
  repository(web, "https://github.com/acme/web.git");
  repository(mvc, "https://github.com/acme/mvc.git");
  fs.mkdirSync(path.join(knowledge, ".workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(knowledge, "targets.yaml"),
    [
      "schema_version: 1",
      "targets:",
      "  - target_id: api",
      "    name: API",
      "    remote_url: https://github.com/acme/api.git",
      "    status: active",
      "    type: backend",
      "  - target_id: web",
      "    name: Web",
      "    remote_url: https://github.com/acme/web.git",
      "    status: active",
      "    type: frontend",
      "  - target_id: mvc",
      "    name: MVC",
      "    remote_url: https://github.com/acme/mvc.git",
      "    status: active",
      "    type: fullstack",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(knowledge, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n  api:\n    path: ${JSON.stringify(api)}\n  web:\n    path: ${JSON.stringify(web)}\n  mvc:\n    path: ${JSON.stringify(mvc)}\n`,
    "utf8",
  );
  const installation = path.join(root, "installation.yaml");
  fs.writeFileSync(installation, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`, "utf8");
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG = installation;
  return { knowledge, api, web, mvc };
}

describe("runtimeTaskWorkRoots — T-V9-012 admitted binding shapes", () => {
  it("resolves one writable Target per engineer stage and de-duplicates a fullstack Target physically", () => {
    const { api, web, mvc } = fixture();
    const splitArgs = parseArgs(
      ["--task-id", "T-split", "--module", "orders", "--bug-fix", "--backend", "--frontend", "--backend-target", "api", "--frontend-target", "web"],
      api,
    );
    const split = runtimeTaskWorkRoots(splitArgs, "T-split", classifyTask(splitArgs.classification));
    expect(split.filter((root) => root.stage === AgentStage.BACKEND_ENGINEER || root.stage === AgentStage.FRONTEND_ENGINEER)).toEqual([
      { stage: AgentStage.BACKEND_ENGINEER, targetId: "api", path: api },
      { stage: AgentStage.FRONTEND_ENGINEER, targetId: "web", path: web },
    ]);

    const fullstackArgs = parseArgs(
      ["--task-id", "T-fullstack", "--module", "orders", "--bug-fix", "--backend", "--frontend", "--backend-target", "mvc", "--frontend-target", "mvc"],
      mvc,
    );
    const fullstack = runtimeTaskWorkRoots(fullstackArgs, "T-fullstack", classifyTask(fullstackArgs.classification));
    const engineerRoots = fullstack.filter((root) => root.stage === AgentStage.BACKEND_ENGINEER || root.stage === AgentStage.FRONTEND_ENGINEER);
    expect(engineerRoots).toEqual([
      { stage: AgentStage.BACKEND_ENGINEER, targetId: "mvc", path: mvc },
      { stage: AgentStage.FRONTEND_ENGINEER, targetId: "mvc", path: mvc },
    ]);
    expect(new Set(engineerRoots.map((root) => root.path))).toEqual(new Set([mvc]));
  });
});
