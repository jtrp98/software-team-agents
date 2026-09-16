import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_INTEL_ENV } from "../runtime/codeIntelAssembly.js";
import { readMetadata } from "./freshness.js";
import {
  buildCodeIntelIndex,
  consentPath,
  readConsent,
  resolveIndexConsent,
  type IndexConsentDeps,
} from "./consent.js";

/**
 * V10 TASK-015 — ask-before-indexing at run start (ADR-006 Option A):
 * fresh is silent, an answered revision is silent, unattended never blocks,
 * and the record is bound to `targetId + revision` — not to the machine
 * forever, and not to a single run.
 */

const TARGET = { targetId: "consent-fixture-target", targetRoot: "C:/src/fixture-target" };

function deps(overrides: Partial<IndexConsentDeps> & { cacheRoot: string; status?: "stale" | "missing" | "error" | "fresh"; revision?: string }): IndexConsentDeps {
  const { status = "stale", revision = "a".repeat(40), ...rest } = overrides;
  return {
    revisionOf: async () => revision,
    getStatus: () => ({
      status,
      targetRevision: revision,
      indexedRevision: status === "fresh" ? revision : "b".repeat(40),
      indexedAt: null,
    }),
    ...rest,
  };
}

function tempCacheRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sta-consent-"));
}

describe("resolveIndexConsent — V10 TASK-015", () => {
  it("fresh index → never asks", async () => {
    let asked = false;
    const outcome = await resolveIndexConsent(TARGET, deps({
      cacheRoot: tempCacheRoot(),
      status: "fresh",
      prompt: async () => {
        asked = true;
        return "y";
      },
    }));
    expect(outcome).toEqual({ asked: false, record: null, built: false, skip: "fresh" });
    expect(asked).toBe(false);
  });

  it("stale + interactive → asks with target id, indexed revision and current revision; a no records the decline and the run continues", async () => {
    const cacheRoot = tempCacheRoot();
    const questions: string[] = [];
    let built = false;
    const outcome = await resolveIndexConsent(TARGET, deps({
      cacheRoot,
      prompt: async (question) => {
        questions.push(question);
        return "n";
      },
      buildIndex: async () => {
        built = true;
        return { ok: true, detail: "should not run" };
      },
    }));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(TARGET.targetId);
    expect(questions[0]).toContain("b".repeat(40));
    expect(questions[0]).toContain("a".repeat(40));
    expect(outcome.asked).toBe(true);
    expect(outcome.record?.answer).toBe("declined");
    expect(outcome.record?.freshness).toBe("stale");
    expect(outcome.built).toBe(false);
    expect(built).toBe(false);
    // A recorded answer is a fact on disk, so the next run in this revision does not ask again.
    expect(readConsent(cacheRoot, TARGET.targetId, "a".repeat(40))?.answer).toBe("declined");
  });

  it("unattended run with no consent record → never stops, proceeds on fallback", async () => {
    const outcome = await resolveIndexConsent(TARGET, deps({ cacheRoot: tempCacheRoot() }));
    expect(outcome).toEqual({ asked: false, record: null, built: false, skip: "unattended" });
  });

  it("a consent record is reused within the same revision — approved or declined", async () => {
    for (const answer of ["y", "n"] as const) {
      const cacheRoot = tempCacheRoot();
      await resolveIndexConsent(TARGET, deps({ cacheRoot, prompt: async () => answer }));
      let asked = false;
      const outcome = await resolveIndexConsent(TARGET, deps({
        cacheRoot,
        prompt: async () => {
          asked = true;
          return answer;
        },
      }));
      expect(outcome.skip).toBe("already-answered");
      expect(outcome.record?.answer).toBe(answer === "y" ? "approved" : "declined");
      expect(asked).toBe(false);
    }
  });

  it("a consent record is not consulted across revisions — a new revision asks again", async () => {
    const cacheRoot = tempCacheRoot();
    const oldRevision = "a".repeat(40);
    await resolveIndexConsent(TARGET, deps({ cacheRoot, revision: oldRevision, prompt: async () => "n" }));
    const newRevision = "c".repeat(40);
    expect(readConsent(cacheRoot, TARGET.targetId, newRevision)).toBeNull();
    let asked = false;
    const outcome = await resolveIndexConsent(TARGET, deps({
      cacheRoot,
      revision: newRevision,
      prompt: async () => {
        asked = true;
        return "n";
      },
    }));
    expect(readConsent(cacheRoot, TARGET.targetId, oldRevision)?.revision).toBe(oldRevision);
    expect(outcome.asked).toBe(true);
    expect(asked).toBe(true);
    expect(readConsent(cacheRoot, TARGET.targetId, newRevision)?.revision).toBe(newRevision);
  });

  it("a yes records approval and builds once; a failed build is reported, never thrown", async () => {
    const cacheRoot = tempCacheRoot();
    const outcome = await resolveIndexConsent(TARGET, deps({
      cacheRoot,
      prompt: async () => "yes",
      buildIndex: async () => ({ ok: false, detail: "extract exploded" }),
    }));
    expect(outcome.asked).toBe(true);
    expect(outcome.record?.answer).toBe("approved");
    expect(outcome.built).toBe(false);
    expect(outcome.buildDetail).toBe("extract exploded");
  });

  it("feature explicitly off on this machine → silent, no record", async () => {
    const cacheRoot = tempCacheRoot();
    const outcome = await resolveIndexConsent(TARGET, deps({
      cacheRoot,
      env: { [CODE_INTEL_ENV]: "off" },
      prompt: async () => "y",
    }));
    expect(outcome).toEqual({ asked: false, record: null, built: false, skip: "disabled" });
  });

  it("a checkout with no resolvable revision stays silent", async () => {
    const cacheRoot = tempCacheRoot();
    const outcome = await resolveIndexConsent(TARGET, {
      cacheRoot,
      revisionOf: async () => {
        throw new Error("no git");
      },
    });
    expect(outcome).toEqual({ asked: false, record: null, built: false, skip: "no-revision" });
  });

  it("the consent file lives beside the revision directory and never reads as an index", () => {
    const cacheRoot = tempCacheRoot();
    expect(consentPath(cacheRoot, TARGET.targetId, "a".repeat(40))).toBe(
      path.join(cacheRoot, TARGET.targetId, `${"a".repeat(40)}.consent.json`),
    );
    expect(readConsent(cacheRoot, TARGET.targetId, "a".repeat(40))).toBeNull();
  });
});

describe("buildCodeIntelIndex — the consented build", () => {
  const input = { cacheRoot: "", targetId: "build-fixture-target", targetRoot: "C:/src/fixture-target", revision: "d".repeat(40) };

  it("runs the same code-only extract path as the manual script and writes the freshness sidecar", async () => {
    input.cacheRoot = tempCacheRoot();
    const calls: string[][] = [];
    const result = await buildCodeIntelIndex(input, {
      run: async (command, args) => {
        calls.push([command, ...args]);
        return args[0] === "--version" ? "graphify 1.2.3" : "extracted";
      },
    });
    expect(result.ok).toBe(true);
    expect(calls[0].slice(1)).toEqual(["--version"]);
    expect(calls[1].slice(1)).toEqual([
      "extract", input.targetRoot, "--code-only", "--no-cluster", "--out", path.join(input.cacheRoot, input.targetId, input.revision),
    ]);
    const metadata = readMetadata(input.cacheRoot, input.targetId, input.revision);
    expect(metadata?.indexed_revision).toBe(input.revision);
    expect(metadata?.target_revision).toBe(input.revision);
    expect(metadata?.code_only).toBe(true);
  });

  it("an unrunnable tool answers not-ok instead of throwing", async () => {
    const result = await buildCodeIntelIndex(input, {
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("spawn ENOENT");
  });

  it("a failed extract answers not-ok and writes no sidecar", async () => {
    input.cacheRoot = tempCacheRoot();
    const result = await buildCodeIntelIndex(input, {
      run: async (_command, args) => {
        if (args[0] === "extract") throw new Error("exit 1");
        return "graphify 1.2.3";
      },
    });
    expect(result.ok).toBe(false);
    expect(readMetadata(input.cacheRoot, input.targetId, input.revision)).toBeNull();
  });
});
