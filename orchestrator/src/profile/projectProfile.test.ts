import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { Capability } from "../agents/capabilities.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import {
  ProfileError,
  agentsForCurrentStack,
  checkProfile,
  commandsFor,
  listStacks,
  loadProjectProfile,
  loadStackProfile,
  projectProfilePath,
} from "./projectProfile.js";

/** Builds a throwaway project with a project.yaml and whatever stacks the case needs. */
function fixtureRoot(project: unknown, stacks: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-profile-"));
  // JSON is valid YAML, which is enough to build a fixture without a serializer.
  fs.writeFileSync(path.join(root, "project.yaml"), JSON.stringify(project, null, 2), "utf8");
  for (const [name, body] of Object.entries(stacks)) {
    fs.mkdirSync(path.join(root, "stacks", name), { recursive: true });
    fs.writeFileSync(path.join(root, "stacks", name, "stack.yaml"), JSON.stringify(body, null, 2), "utf8");
  }
  return root;
}

const nodeStack = {
  stack: "node",
  kind: "backend",
  language: "typescript",
  runtime: "node",
  frameworks: ["express"],
  database: ["postgresql"],
  api: ["rest"],
  package_manager: "npm",
  commands: { install: "npm install", build: "npm run build", test: "npm test", lint: "npm run lint", typecheck: "tsc" },
  capabilities: [Capability.REST_API],
};

const frontStack = { ...nodeStack, stack: "frontend", kind: "frontend", frameworks: ["nextjs"] };

const okProject = {
  project: { name: "p", description: "d" },
  current: {
    backend: { stack: "node", language: "typescript", framework: "express" },
    frontend: { stack: "frontend", language: "typescript", framework: "nextjs" },
    database: { type: "postgresql" },
    api: ["rest"],
  },
};

describe("the shipped profiles", () => {
  it("has a project.yaml that loads and validates", () => {
    expect(fs.existsSync(projectProfilePath())).toBe(true);
    expect(loadProjectProfile().project.name).toBe("software-team-agents");
  });

  it("ships the five stack profiles T13 names", () => {
    expect(listStacks()).toEqual(["dotnet", "frontend", "java", "node", "python"]);
    for (const stack of listStacks()) expect(loadStackProfile(stack).stack).toBe(stack);
  });

  it("passes its own check", () => {
    const result = checkProfile();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * The reason current and target are separate fields. Declaring only the target
   * would let every capability lookup return an agent that cannot build the thing,
   * with the checker green while it happened.
   */
  it("declares the stack the agents really implement as current", () => {
    const profile = loadProjectProfile();
    expect(profile.current.backend.language).toBe("typescript");
    expect(profile.current.backend.orm).toBe("prisma");
  });

  it("records the .NET target from TASKS.md, with what blocks it", () => {
    const target = loadProjectProfile().target!;
    expect(target.backend.language).toBe("csharp");
    expect(target.api).toContain("grpc");
    expect(target.blocked_on).toContain("confirm");
  });

  /** Not a failure — a fact the check is expected to surface rather than hide. */
  it("reports the unbuildable target as a note, not a problem", () => {
    const result = checkProfile();
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("csharp");
    expect(result.notes.join("\n")).toContain("Blocked on");
  });

  it("resolves the real build commands for each side", () => {
    expect(commandsFor("backend", defaultProjectRoot()).typecheck).toContain("npm");
    expect(commandsFor("frontend", defaultProjectRoot()).build).toContain("npm");
  });

  it("names the agents that can take work on the current stack", () => {
    expect(agentsForCurrentStack("backend", defaultProjectRoot())).toContain(AgentStage.BACKEND_ENGINEER);
    expect(agentsForCurrentStack("frontend", defaultProjectRoot())).toContain(AgentStage.FRONTEND_ENGINEER);
  });

  it("gives the dotnet profile the gRPC capability nothing implements yet", () => {
    expect(loadStackProfile("dotnet").capabilities).toContain(Capability.GRPC);
    expect(loadStackProfile("node").capabilities).not.toContain(Capability.GRPC);
  });
});

describe("loadProjectProfile", () => {
  it("fails when the file is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-profile-"));
    expect(() => loadProjectProfile(root)).toThrow(ProfileError);
  });

  it("rejects a target that does not say what blocks it — a target nobody can act on is a wish", () => {
    const root = fixtureRoot({
      ...okProject,
      target: { ...okProject.current },
    });
    expect(() => loadProjectProfile(root)).toThrow(ProfileError);
  });
});

describe("loadStackProfile", () => {
  it("rejects a profile whose declared name disagrees with its folder", () => {
    const root = fixtureRoot(okProject, { node: { ...nodeStack, stack: "other" } });
    expect(() => loadStackProfile("node", root)).toThrow(/the folder is the identity/);
  });

  it("fails on a stack that does not exist", () => {
    expect(() => loadStackProfile("cobol", fixtureRoot(okProject))).toThrow(ProfileError);
  });
});

describe("checkProfile", () => {
  it("passes a consistent fixture", () => {
    const result = checkProfile(fixtureRoot(okProject, { node: nodeStack, frontend: frontStack }));
    expect(result.problems).toEqual([]);
  });

  it("reports a stack the project names but stacks/ does not have", () => {
    const root = fixtureRoot(okProject, { frontend: frontStack });
    expect(checkProfile(root).problems.join()).toContain('stack "node"');
  });

  it("reports a language the project and the stack profile disagree about", () => {
    const root = fixtureRoot(okProject, { node: { ...nodeStack, language: "go" }, frontend: frontStack });
    expect(checkProfile(root).problems.join()).toContain("go");
  });

  it("reports a backend profile used as the frontend", () => {
    const root = fixtureRoot(okProject, { node: nodeStack, frontend: { ...frontStack, kind: "backend" } });
    expect(checkProfile(root).problems.join()).toContain('kind "backend"');
  });

  /** The check that keeps current honest: a profile describing a team this project does not have. */
  it("reports a current language no agent on the roster can write", () => {
    const project = {
      ...okProject,
      current: { ...okProject.current, backend: { stack: "node", language: "cobol", framework: "express" } },
    };
    const root = fixtureRoot(project, { node: { ...nodeStack, language: "cobol" }, frontend: frontStack });
    const problems = checkProfile(root).problems.join("\n");
    expect(problems).toContain("cobol");
    expect(problems).toContain("does not have");
  });

  it("reports a current framework no agent declares", () => {
    const project = {
      ...okProject,
      current: { ...okProject.current, backend: { stack: "node", language: "typescript", framework: "koa" } },
    };
    const root = fixtureRoot(project, { node: nodeStack, frontend: frontStack });
    expect(checkProfile(root).problems.join()).toContain("koa");
  });

  it("reports an empty stacks folder rather than passing quietly", () => {
    expect(checkProfile(fixtureRoot(okProject)).problems.join()).toContain("no stack profiles");
  });

  /** A target is allowed to be unbuildable — that is what makes it a target rather than a lie. */
  it("does not fail a target no agent can build", () => {
    const project = {
      ...okProject,
      target: {
        backend: { stack: "node", language: "typescript", framework: "express" },
        frontend: { stack: "frontend", language: "typescript", framework: "nextjs" },
        database: { type: "postgresql" },
        api: ["rest", "grpc"],
        blocked_on: "needs a decision",
      },
    };
    const result = checkProfile(fixtureRoot(project, { node: nodeStack, frontend: frontStack }));
    expect(result.ok).toBe(true);
    expect(result.notes.join()).toContain("grpc");
  });
});
