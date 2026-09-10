import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "./provider.js";
import { extractTerms, NativeSearchProvider } from "./nativeSearchProvider.js";

function tmpTarget(): { root: string; targetId: string; revision: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-native-search-"));
  return { root, targetId: "t", revision: "r1" };
}

function write(root: string, relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("extractTerms", () => {
  it("lowercases, splits on non-word characters, drops short tokens, dedupes, and caps", () => {
    expect(extractTerms("Locate the CRM-Case Dashboard module")).toEqual([
      "locate", "the", "crm", "case", "dashboard", "module",
    ]);
    expect(extractTerms("ab a bb")).toEqual([]); // every token under MIN_TERM_LENGTH
    expect(extractTerms("one one two")).toEqual(["one", "two"]); // dedupe
  });
});

describe("NativeSearchProvider", () => {
  it("is always available and always fresh — there is no index to go stale", async () => {
    const provider = new NativeSearchProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
    const status = await provider.getStatus({ targetId: "t", rootPath: "/x", revision: "abc123" });
    expect(status).toEqual({ status: "fresh", targetRevision: "abc123", indexedRevision: "abc123", indexedAt: null });
  });

  it("scores a filename match and a content match, and returns a line-addressable location for content hits", async () => {
    const { root, targetId, revision } = tmpTarget();
    write(root, "src/crm-case-dashboard.ts", 'export const dashboard = "crm case dashboard";\n');
    write(root, "src/unrelated.ts", "export const nothing = 1;\n");

    const provider = new NativeSearchProvider();
    const candidates = await provider.findRelevantCode({
      target: { targetId, rootPath: root, revision },
      description: "crm case dashboard",
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].location.file).toBe("src/crm-case-dashboard.ts");
    expect(candidates[0].location.line).toBe(1);
    expect(candidates[0].provenance).toBe("inferred");
    expect(candidates.some((c) => c.location.file === "src/unrelated.ts")).toBe(false);
  });

  it("finds a content-only match (no filename overlap) by line", async () => {
    const { root, targetId, revision } = tmpTarget();
    write(root, "src/helpers.ts", "// nothing here\nconst widgetFactory = () => null;\n");

    const provider = new NativeSearchProvider();
    const candidates = await provider.findRelevantCode({
      target: { targetId, rootPath: root, revision },
      description: "widgetFactory",
    });

    expect(candidates[0].location.file).toBe("src/helpers.ts");
    expect(candidates[0].location.line).toBe(2);
  });

  it("returns [] when the description has no usable terms or nothing matches", async () => {
    const { root, targetId, revision } = tmpTarget();
    write(root, "src/a.ts", "export const a = 1;\n");
    const provider = new NativeSearchProvider();

    await expect(
      provider.findRelevantCode({ target: { targetId, rootPath: root, revision }, description: "ab a bb" }),
    ).resolves.toEqual([]);
    await expect(
      provider.findRelevantCode({ target: { targetId, rootPath: root, revision }, description: "nonexistentterm" }),
    ).resolves.toEqual([]);
  });

  it("skips well-known noise directories entirely", async () => {
    const { root, targetId, revision } = tmpTarget();
    write(root, "node_modules/some-pkg/dashboard.ts", "export const dashboard = 1;\n");
    write(root, ".git/dashboard-ref", "dashboard");
    write(root, "src/real.ts", "export const dashboard = 1;\n");

    const provider = new NativeSearchProvider();
    const candidates = await provider.findRelevantCode({
      target: { targetId, rootPath: root, revision },
      description: "dashboard",
    });

    expect(candidates.map((c) => c.location.file)).toEqual(["src/real.ts"]);
  });

  it("bounds the scan by file count — maxFilesScanned stops the walk", async () => {
    const { root, targetId, revision } = tmpTarget();
    for (let i = 0; i < 10; i += 1) {
      write(root, `src/dashboard-${i}.ts`, "export const dashboard = 1;\n");
    }
    const provider = new NativeSearchProvider({ maxFilesScanned: 3 });
    const candidates = await provider.findRelevantCode({
      target: { targetId, rootPath: root, revision },
      description: "dashboard",
    });
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("bounds the scan by wall-clock time — maxScanMs stops the walk even mid-directory", async () => {
    const { root, targetId, revision } = tmpTarget();
    for (let i = 0; i < 20; i += 1) {
      write(root, `src/dashboard-${i}.ts`, "export const dashboard = 1;\n");
    }
    let calls = 0;
    // now() ticks past the deadline on the very first check inside the walk.
    const provider = new NativeSearchProvider({ maxScanMs: 5, now: () => { calls += 1; return calls * 100; } });
    const candidates = await provider.findRelevantCode({
      target: { targetId, rootPath: root, revision },
      description: "dashboard",
    });
    expect(candidates.length).toBeLessThan(20);
  });

  it("relation/path/impact operations refuse rather than fabricate a graph answer", async () => {
    const provider = new NativeSearchProvider();
    const target = { targetId: "t", rootPath: "/x", revision: "r1" };
    await expect(provider.getDependencies({ target, symbol: "s" })).rejects.toThrow(ProviderUnavailableError);
    await expect(provider.getDependents({ target, symbol: "s" })).rejects.toThrow(ProviderUnavailableError);
    await expect(provider.findPath({ target, from: "a", to: "b" })).rejects.toThrow(ProviderUnavailableError);
    await expect(provider.getImpact({ target, symbol: "s" })).rejects.toThrow(ProviderUnavailableError);
  });

  it("a directory that cannot be read is skipped, not fatal", async () => {
    const provider = new NativeSearchProvider();
    await expect(
      provider.findRelevantCode({
        target: { targetId: "t", rootPath: path.join(os.tmpdir(), "sta-native-search-does-not-exist"), revision: "r1" },
        description: "dashboard",
      }),
    ).resolves.toEqual([]);
  });
});
