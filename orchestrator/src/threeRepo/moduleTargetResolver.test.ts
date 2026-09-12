import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";
import { resolveModuleTargets } from "./moduleTargetResolver.js";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function initRepository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}

function fixture(): { root: string; knowledge: string; framework: string; paths: Record<string, string> } {
  const root = tempRoot("v9-module-targets-");
  const knowledge = path.join(root, "knowledge");
  const framework = path.join(root, "framework");
  initRepository(knowledge);
  initRepository(framework);
  const paths: Record<string, string> = {};
  for (const id of ["sales-api", "sales-worker", "sales-web"]) {
    paths[id] = path.join(root, id);
    initRepository(paths[id]);
  }
  fs.writeFileSync(
    path.join(knowledge, "targets.yaml"),
    [
      "schema_version: 1",
      "targets:",
      "  - target_id: sales-api",
      "    name: Sales API",
      "    remote_url: https://github.com/acme/sales-api.git",
      "    status: active",
      "    type: backend",
      "  - target_id: sales-worker",
      "    name: Sales Worker",
      "    remote_url: https://github.com/acme/sales-worker.git",
      "    status: retired",
      "  - target_id: sales-web",
      "    name: Sales Web",
      "    remote_url: https://github.com/acme/sales-web.git",
      "    status: active",
      "    type: frontend",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(knowledge, ".workflow"));
  fs.writeFileSync(
    path.join(knowledge, ".workflow", "targets.local.yaml"),
    [
      "schema_version: 1",
      "targets:",
      ...Object.entries(paths).flatMap(([id, targetPath]) => [`  ${id}:`, `    path: ${JSON.stringify(targetPath)}`]),
      "",
    ].join("\n"),
  );
  return { root, knowledge, framework, paths };
}

function writeModule(knowledge: string, name: string, design?: string): void {
  const directory = path.join(knowledge, "_docs", "module", name);
  fs.mkdirSync(directory, { recursive: true });
  if (design === undefined) fs.writeFileSync(path.join(directory, "requirement.md"), "# Requirement\n");
  else fs.writeFileSync(path.join(directory, "design.md"), design);
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("T-V9-007 module to Target resolver", () => {
  it("resolves one or three declarations with registry entries and local paths without inferring from type", () => {
    const { knowledge, framework, paths } = fixture();
    writeModule(knowledge, "single", "# Design\n\n## Targets\n\n- sales-api (backend-engineer)\n");
    writeModule(
      knowledge,
      "multi",
      "# Design\n\n## Targets\n\n- sales-api (backend-engineer)\n- sales-worker (backend-engineer)\n- sales-web (frontend-engineer)\n",
    );

    const single = resolveModuleTargets("single", knowledge, { frameworkRoot: framework });
    expect(single.targets).toHaveLength(1);
    expect(single.targets[0]).toMatchObject({ target_id: "sales-api", localPath: paths["sales-api"] });
    expect(single.targets[0].registryEntry.type).toBe("backend");

    const multi = resolveModuleTargets("multi", knowledge, { frameworkRoot: framework });
    expect(multi.targets.map((entry) => entry.target_id)).toEqual(["sales-api", "sales-worker", "sales-web"]);
  });

  it("reports unscoped and design-missing modules as notes, never errors", () => {
    const { knowledge, framework } = fixture();
    writeModule(knowledge, "unscoped", "# Design\n\n## Risks\n\nNone.\n");
    writeModule(knowledge, "empty", "# Design\n\n## Targets\n");
    writeModule(knowledge, "requirements-only");

    for (const moduleName of ["unscoped", "empty", "requirements-only"]) {
      const result = resolveModuleTargets(moduleName, knowledge, { frameworkRoot: framework });
      expect(result.targets).toEqual([]);
      expect(result.problems.some((problem) => problem.severity === "error")).toBe(false);
      expect(result.problems.some((problem) => problem.severity === "note")).toBe(true);
    }
  });

  it("distinguishes unknown, retired, duplicate and missing-local-mapping outcomes", () => {
    const { knowledge, framework } = fixture();
    writeModule(
      knowledge,
      "broken",
      "# Design\n\n## Targets\n\n- sales-api\n- sales-api\n- sales-worker\n- missing-target\n- sales-web\n",
    );
    const local = path.join(knowledge, ".workflow", "targets.local.yaml");
    fs.writeFileSync(local, fs.readFileSync(local, "utf8").replace(/  sales-web:[\s\S]*$/, ""));

    const result = resolveModuleTargets("broken", knowledge, { frameworkRoot: framework });
    const text = result.problems.map((problem) => `${problem.severity}: ${problem.message}`).join("\n");
    expect(text).toMatch(/error:.*missing-target.*targets\.yaml/i);
    expect(text).toMatch(/error:.*sales-worker.*retired.*reactivate/i);
    expect(text).toMatch(/error:.*sales-api.*duplicate.*remove/i);
    expect(text).toMatch(/warning:.*sales-web.*targets\.local\.yaml/i);
    expect(result.targets.map((entry) => entry.target_id)).toEqual(["sales-api", "sales-worker", "sales-web"]);
  });

  it("extends doctor with unresolved module Target references", async () => {
    const { root, knowledge, framework } = fixture();
    writeModule(knowledge, "doctor-broken", "# Design\n\n## Targets\n\n- absent-from-registry\n");
    const configPath = path.join(root, "installation.yaml");
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);

    const report = await runDoctor({
      projectRoot: framework,
      installationConfigPath: configPath,
      probe: () => Promise.resolve({ available: true, version: "test" }),
    });
    const references = report.checks.find((entry) => entry.name === "Module Target references");
    expect(references).toMatchObject({ status: "FAIL" });
    expect(references?.detail).toContain("absent-from-registry");
    expect(references?.detail).toContain("targets.yaml");
  });
});
