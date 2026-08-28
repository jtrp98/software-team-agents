import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultTargetConfig,
  inspectTargetConfigAsPreV3,
  loadTargetConfig,
  targetConfigPath,
  writeTargetConfig,
} from "./targetMeta.js";

const roots: string[] = [];
function targetRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-target-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("TargetConfig V3 compatibility", () => {
  it("keeps a pre-V3 schema_version 1 config unchanged", () => {
    const root = targetRoot();
    const config = { ...defaultTargetConfig("target", "now", "dev"), overrides: ["README.local.md"] };
    writeTargetConfig(root, config);
    const before = fs.readFileSync(targetConfigPath(root));

    expect(loadTargetConfig(root)).toEqual(config);
    expect(fs.readFileSync(targetConfigPath(root))).toEqual(before);
  });

  it("accepts the additive execution block while retaining overrides", () => {
    const root = targetRoot();
    writeTargetConfig(root, {
      ...defaultTargetConfig("target", "now", "dev"),
      execution: { mode: "single", runner: "claude-code", allow_paid_fallback: false },
      overrides: ["README.local.md"],
    });

    expect(loadTargetConfig(root)).toMatchObject({
      schema_version: 1,
      execution: { mode: "single", runner: "claude-code", allow_paid_fallback: false },
      overrides: ["README.local.md"],
    });
  });

  it("an older schema warns about execution and never errors", () => {
    const root = targetRoot();
    writeTargetConfig(root, {
      ...defaultTargetConfig("target", "now", "dev"),
      execution: { mode: "auto", allow_paid_fallback: false },
    });

    expect(inspectTargetConfigAsPreV3(root)).toEqual({
      problems: [],
      warnings: [expect.stringMatching(/execution.*ignored/)],
    });
  });
});
