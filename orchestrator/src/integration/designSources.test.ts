import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import {
  DESIGN_SOURCES_DIRNAME,
  designSourceDir,
  designSourceIsCurrent,
  digestDesignSource,
  listDesignSources,
} from "./designSources.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "design-sources-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function place(moduleName: string, relative: string, content: string): void {
  const file = path.join(designSourceDir(root, moduleName), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe("the _sources/design convention (T-UX5 Path B)", () => {
  it("lives under the knowledge model's reserved _sources directory", () => {
    const dir = designSourceDir(root, "sales-crm");
    expect(path.relative(root, dir).replace(/\\/g, "/")).toBe(`_sources/${DESIGN_SOURCES_DIRNAME}/sales-crm`);
  });

  it("lists nothing when no one has placed material yet", () => {
    expect(listDesignSources(root, "empty-module")).toEqual([]);
  });

  it("lists placed exports recursively, sorted, relative to the project root", () => {
    place("sales-crm", "export.html", "<html>home</html>");
    place("sales-crm", "handoff/bundle.md", "# handoff");
    expect(listDesignSources(root, "sales-crm")).toEqual([
      `_sources/${DESIGN_SOURCES_DIRNAME}/sales-crm/export.html`,
      `_sources/${DESIGN_SOURCES_DIRNAME}/sales-crm/handoff/bundle.md`,
    ]);
  });
});

describe("digests reuse the framework's one digest definition", () => {
  it("records the same sha256 freshness will recompute", () => {
    place("billing", "screen.html", "<html>invoice</html>");
    const recorded = digestDesignSource(root, "billing", `_sources/${DESIGN_SOURCES_DIRNAME}/billing/screen.html`);
    expect(recorded.digest).toBe(
      digestOfSource(`_sources/${DESIGN_SOURCES_DIRNAME}/billing/screen.html`, root),
    );
    expect(recorded.digest?.startsWith("sha256:")).toBe(true);
  });

  it("records null for an unreadable locator instead of inventing a value", () => {
    const recorded = digestDesignSource(root, "billing", "_sources/design/billing/missing.html");
    expect(recorded.digest).toBeNull();
  });
});

describe("designSourceIsCurrent (freshness of an export)", () => {
  const locator = `_sources/${DESIGN_SOURCES_DIRNAME}/billing/plan.html`;

  it("holds while the file is unchanged", () => {
    place("billing", "plan.html", "<html>v1</html>");
    const recorded = digestDesignSource(root, "billing", locator);
    expect(designSourceIsCurrent(recorded, root)).toBe(true);
  });

  it("breaks the moment the export changes — the derived conclusion is about different text now", () => {
    const recorded = digestDesignSource(root, "billing", locator);
    place("billing", "plan.html", "<html>v2 — redesigned</html>");
    expect(designSourceIsCurrent(recorded, root)).toBe(false);
  });

  it("refuses a record that was never hashable — unverifiable is not current", () => {
    expect(designSourceIsCurrent({ locator, digest: null }, root)).toBe(false);
  });
});
