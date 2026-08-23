import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSource } from "./sourceResolver.js";

const NOW = "2026-08-22T09:00:00Z";

function source(locator: string, origin?: { root: "knowledge" | "target" | "external"; target_id: string | null }) {
  return { type: "file", locator, captured_at: NOW, digest: null, ...(origin ? { origin } : {}) } as Parameters<typeof resolveSource>[0];
}

function sandbox(): { root: string; knowledgeRoot: string; targetRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-resolver-"));
  const knowledgeRoot = path.join(root, "knowledge");
  const targetRoot = path.join(root, "target");
  fs.mkdirSync(path.join(knowledgeRoot, "_docs"), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(knowledgeRoot, "_docs", "a.md"), "knowledge material");
  fs.writeFileSync(path.join(targetRoot, "src", "b.ts"), "target material");
  return { root, knowledgeRoot, targetRoot };
}

/** Windows grants symlink creation only to privileged/dev-mode processes; the
 * traversal guarantee it exercises is additionally covered by the absolute and
 * lexical escape cases that run everywhere. */
const canSymlink = (() => {
  const probe = path.join(os.tmpdir(), `resolver-probe-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(__filename, probe, "file");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

describe("resolveSource — v2 source origins (T143/T149)", () => {
  it("resolves a knowledge-origin locator inside the Knowledge root", () => {
    const { knowledgeRoot } = sandbox();
    const r = resolveSource(source("_docs/a.md"), knowledgeRoot);
    expect(r.state).toBe("resolved");
    if (r.state === "resolved") expect(r.path).toContain(path.join("_docs", "a.md"));
  });

  it("defaults to the knowledge origin when an item carries none (v1 compatibility)", () => {
    const { knowledgeRoot } = sandbox();
    expect(resolveSource(source("_docs/a.md"), knowledgeRoot).state).toBe("resolved");
  });

  it("reports external sources instead of inventing a path for them", () => {
    const r = resolveSource(source("https://example.com/spec.yaml", { root: "external", target_id: null }), os.tmpdir());
    expect(r.state).toBe("external");
  });

  it("reports unavailable when a target-origin source has no local mapping", () => {
    const { knowledgeRoot } = sandbox();
    const r = resolveSource(source("src/b.ts", { root: "target", target_id: "backend" }), knowledgeRoot);
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") expect(r.reason).toMatch(/backend/);
  });

  it("resolves a mapped target-origin locator inside that Target's own root", () => {
    const { knowledgeRoot, targetRoot } = sandbox();
    const mappings = new Map([["backend", targetRoot]]);
    const r = resolveSource(source("src/b.ts", { root: "target", target_id: "backend" }), knowledgeRoot, mappings);
    expect(r.state).toBe("resolved");
    if (r.state === "resolved") expect(r.path).toContain(path.join("src", "b.ts"));
  });

  it("rejects an absolute locator outright", () => {
    const { knowledgeRoot } = sandbox();
    const absolute = process.platform === "win32" ? "C:\\abs\\a.md" : "/abs/a.md";
    const r = resolveSource(source(absolute), knowledgeRoot);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.reason).toMatch(/absolute/);
  });

  it.each([
    ["../escaped.md", "sibling"],
    ["_docs/../../escaped.md", "nested climb"],
  ])("rejects lexical escapes through %s (%s)", (locator) => {
    const { knowledgeRoot } = sandbox();
    const outside = path.join(path.dirname(knowledgeRoot), "escaped.md");
    fs.writeFileSync(outside, "outside");
    const r = resolveSource(source(locator), knowledgeRoot);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.reason).toMatch(/escapes knowledge root/);
  });

  it("treats percent-encoded climbs as literal filenames, not traversal — the filesystem has no URL layer", () => {
    const { knowledgeRoot } = sandbox();
    const r = resolveSource(source("_docs/%2e%2e/escaped.md"), knowledgeRoot);
    // path.resolve never URL-decodes, so this is a weird filename inside the
    // root, not a climb — it resolves to a location that simply does not exist.
    expect(r.state).toBe("resolved");
  });

  it.runIf(canSymlink)("refuses a locator that resolves through an in-root symlink pointing outside", () => {
    const { root, knowledgeRoot } = sandbox();
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "leak.md"), "leak");
    fs.symlinkSync(outsideDir, path.join(knowledgeRoot, "_docs", "link"), "junction");
    // Lexically inside the root (_docs/link/leak.md), physically outside it —
    // the realpath check is what catches this, not the prefix comparison.
    const r = resolveSource(source("_docs/link/leak.md"), knowledgeRoot);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.reason).toMatch(/resolves outside|escapes/);
  });

  it("returns resolved for a not-yet-existing path — resolution is about location, not existence", () => {
    const { knowledgeRoot } = sandbox();
    const r = resolveSource(source("_docs/later.md"), knowledgeRoot);
    expect(r.state).toBe("resolved");
    if (r.state === "resolved") expect(fs.existsSync(r.path)).toBe(false);
  });
});
