import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { declareInstallationConfigOverrideChannelForTest, resetInstallationConfigOverrideChannelForTest } from "../threeRepo/installation.js";

/**
 * Shared fixtures for STA Core tests: an isolated Core home (through the one
 * declared test channel, `STA_INSTALLATION_CONFIG`) and Knowledge roots that
 * pass the same standalone-repository and registry checks production does.
 */

export interface CoreTestHome {
  base: string;
  home: string;
  installationConfig: string;
  cleanup(): void;
}

export function makeCoreHome(): CoreTestHome {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sta-core-")));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const installationConfig = path.join(home, "installation.yaml");
  const previous = process.env.STA_INSTALLATION_CONFIG;
  declareInstallationConfigOverrideChannelForTest();
  process.env.STA_INSTALLATION_CONFIG = installationConfig;
  return {
    base,
    home,
    installationConfig,
    cleanup() {
      if (previous === undefined) delete process.env.STA_INSTALLATION_CONFIG;
      else process.env.STA_INSTALLATION_CONFIG = previous;
      resetInstallationConfigOverrideChannelForTest();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

export interface KnowledgeFixture {
  modules?: string[];
  targets?: Array<{ id: string; remote: string; localPath?: string }>;
  /** Free text written into each module's requirement.md — lets isolation tests look for leakage. */
  marker?: string;
}

/** A directory that passes `assertStandaloneRepositoryRoot` (a `.git` directory without `commondir`). */
export function makeRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return fs.realpathSync.native(dir);
}

export function makeKnowledgeRoot(parent: string, name: string, fixture: KnowledgeFixture = {}): string {
  const root = makeRepo(path.join(parent, name));
  fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-team", "config.yaml"), "role: ba\n", "utf8");
  for (const moduleName of fixture.modules ?? []) {
    const dir = path.join(root, "_docs", "module", moduleName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), `# ${moduleName}\n\n${fixture.marker ?? ""}\n`, "utf8");
  }
  if (fixture.targets) {
    const lines = ["schema_version: 2", "targets:"];
    for (const target of fixture.targets) {
      lines.push(`  - target_id: ${target.id}`, `    name: ${target.id}`, `    remote_url: ${target.remote}`, "    status: active", "    type: backend", "    ownership_state: owned", "    repository_aliases: []");
    }
    fs.writeFileSync(path.join(root, "targets.yaml"), `${lines.join("\n")}\n`, "utf8");
    const mapped = fixture.targets.filter((target) => target.localPath);
    if (mapped.length > 0) {
      fs.mkdirSync(path.join(root, ".workflow"), { recursive: true });
      const local = ["schema_version: 1", "targets:", ...mapped.flatMap((target) => [`  ${target.id}:`, `    path: ${JSON.stringify(target.localPath)}`])];
      fs.writeFileSync(path.join(root, ".workflow", "targets.local.yaml"), `${local.join("\n")}\n`, "utf8");
    }
  }
  return root;
}
