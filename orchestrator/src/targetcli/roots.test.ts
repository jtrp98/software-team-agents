import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContextDocsRoot } from "./roots.js";

/**
 * T-V6-006: `resolveContextDocsRoot` must resolve the Knowledge root even
 * from a desktop session, which never runs through `software-team-agents
 * ba|dev` and so never has `AGENTCLAUDE_KNOWLEDGE_ROOT`. Precedence:
 * env > installation.yaml > projectRoot. Isolation channel per
 * `installation.test.ts`: never read this machine's real binding.
 */
const ENV_KEY = "AGENTCLAUDE_INSTALLATION_CONFIG";
const originalConfigEnv = process.env[ENV_KEY];

const roots: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sta-roots-${prefix}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  if (originalConfigEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalConfigEnv;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function writeInstallationConfig(dir: string, knowledgeRoot: string): string {
  const configPath = path.join(dir, "installation.yaml");
  fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`, "utf8");
  process.env[ENV_KEY] = configPath;
  return configPath;
}

describe("resolveContextDocsRoot — env > installation.yaml > projectRoot", () => {
  it("env wins even when installation.yaml names a different root", () => {
    const projectRoot = tmpDir("project");
    const configuredKnowledge = tmpDir("configured-knowledge");
    const envKnowledge = tmpDir("env-knowledge");
    writeInstallationConfig(tmpDir("cfg"), configuredKnowledge);
    expect(resolveContextDocsRoot(projectRoot, { AGENTCLAUDE_KNOWLEDGE_ROOT: envKnowledge })).toBe(
      path.resolve(envKnowledge),
    );
  });

  it("env unset, installation.yaml present — falls back to its knowledge_root (the desktop-session case)", () => {
    const projectRoot = tmpDir("project");
    const configuredKnowledge = tmpDir("configured-knowledge");
    writeInstallationConfig(tmpDir("cfg"), configuredKnowledge);
    expect(resolveContextDocsRoot(projectRoot, {})).toBe(path.resolve(configuredKnowledge));
  });

  it("env unset, installation.yaml missing — falls back to projectRoot, exactly like today", () => {
    const projectRoot = tmpDir("project");
    process.env[ENV_KEY] = path.join(tmpDir("cfg"), "no-such-installation.yaml");
    expect(resolveContextDocsRoot(projectRoot, {})).toBe(path.resolve(projectRoot));
  });

  it("env unset, installation.yaml present but invalid — degrades to projectRoot, never throws", () => {
    const projectRoot = tmpDir("project");
    const cfgDir = tmpDir("cfg");
    const configPath = path.join(cfgDir, "installation.yaml");
    fs.writeFileSync(configPath, "not: [valid, installation, config\n", "utf8");
    process.env[ENV_KEY] = configPath;
    expect(() => resolveContextDocsRoot(projectRoot, {})).not.toThrow();
    expect(resolveContextDocsRoot(projectRoot, {})).toBe(path.resolve(projectRoot));
  });

  it("a launcher session (env set) is byte-identical to today's behaviour regardless of installation.yaml", () => {
    const projectRoot = tmpDir("project");
    const envKnowledge = tmpDir("env-knowledge");
    delete process.env[ENV_KEY];
    expect(resolveContextDocsRoot(projectRoot, { AGENTCLAUDE_KNOWLEDGE_ROOT: envKnowledge })).toBe(
      path.resolve(envKnowledge),
    );
  });
});
