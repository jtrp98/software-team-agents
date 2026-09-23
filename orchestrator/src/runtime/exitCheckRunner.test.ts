import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runCodeGreenExitCheck, runExitChecks, runSecretExitCheck } from "./exitCheckRunner.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sta-exit-check-"));
}

describe("provider-neutral ExitCheckRunner", () => {
  it("fails closed when the post-run change set cannot be captured", async () => {
    const root = tempRoot();
    const report = await runExitChecks(
      [{ root, fingerprint: { files: {} } }],
      ["code-green", "no-hardcoded-secret"],
    );

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(2);
    expect(report.results.every((result) => result.status === "ERROR")).toBe(true);
    expect(report.results[0]?.diagnostic).toMatch(/cannot capture the post-run change set/);
  });

  it("reports only the location and pattern class for a hardcoded secret", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    // Assembled at runtime so this test's own source carries no secret-shaped literal.
    const fixtureValue = ["ABCDEF0123456789", "ABCDEF"].join("");
    fs.writeFileSync(path.join(root, "src", "config.ts"), `const api_key = '${fixtureValue}';\n`, "utf8");

    const result = runSecretExitCheck(root, ["src/config.ts"]);

    expect(result.status).toBe("FAIL");
    expect(result.diagnostic).toContain("src/config.ts:1");
    expect(result.diagnostic).not.toContain(fixtureValue);
  });

  it("passes code-green without spawning checks when the run changed docs only", async () => {
    const result = await runCodeGreenExitCheck(tempRoot(), ["_docs/module/orders/design.md"]);
    expect(result).toMatchObject({ status: "PASS", diagnostic: "no application-code changes in this run" });
  });
});
