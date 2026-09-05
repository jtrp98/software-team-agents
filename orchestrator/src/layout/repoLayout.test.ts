import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTED_AGENTS } from "../agents/agentContract.js";
import {
  LayoutError,
  LayoutMismatchError,
  allHomes,
  assertLayout,
  checkLayout,
  conceptOf,
  homesOf,
  layoutPath,
  loadLayout,
  type RepoLayout,
} from "./repoLayout.js";

/** Writes a throwaway repo with `layout.yaml` at its root, plus whatever directories the case needs. */
function fixtureRoot(layout: unknown, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-layout-"));
  // JSON is valid YAML, which is enough to build a fixture without a serializer.
  fs.writeFileSync(path.join(root, "layout.yaml"), JSON.stringify(layout, null, 2), "utf8");
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  return root;
}

/** A minimal valid manifest: one concept, one active home that the fixture creates. */
function minimalLayout(overrides: Partial<RepoLayout> = {}): RepoLayout {
  return {
    version: 1,
    concepts: {
      orchestrator: {
        answers: "ใครทำต่อ",
        why: "no agent can invoke the next one, so something else must",
        homes: [{ path: "orchestrator", status: "active", holds: "the package" }],
      },
    },
    ...overrides,
  } as RepoLayout;
}

describe("the shipped layout.yaml", () => {
  it("exists, parses, and validates against the schema", () => {
    expect(fs.existsSync(layoutPath())).toBe(true);
    const layout = loadLayout();
    expect(layout.version).toBe(1);
    expect(Object.keys(layout.concepts).length).toBeGreaterThan(0);
  });

  /** The five separated concepts, plus the two support concepts the repo actually has. */
  it("declares each of the five separated concepts exactly once", () => {
    const layout = loadLayout();
    for (const concept of ["agent", "skill", "policy", "workflow", "orchestrator"]) {
      expect(homesOf(layout, concept).length).toBeGreaterThan(0);
    }
    expect(Object.keys(layout.concepts)).toContain("runtime");
    expect(Object.keys(layout.concepts)).toContain("docs");
  });

  /** The reason this task exists: the declared boundaries and the real repo must agree. */
  it("agrees with the repo as it is actually laid out", () => {
    const result = checkLayout();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertLayout()).not.toThrow();
  });

  it("keeps the agent prompt and the agent contract as two homes of one concept", () => {
    const homes = homesOf(loadLayout(), "agent").map((h) => h.path);
    expect(homes).toContain(".claude/agents");
    expect(homes).toContain("contracts");
  });

  it("does not relocate the two paths that would break something to move", () => {
    const layout = loadLayout();
    // Claude Code resolves subagents from exactly this path; the orchestrator shells out to it.
    expect(homesOf(layout, "agent").some((h) => h.path === ".claude/agents")).toBe(true);
    // The store writes to .workflow/ directly; renaming buys a synonym and breaks state.
    expect(homesOf(layout, "runtime").some((h) => h.path === ".workflow")).toBe(true);
  });

  it("marks every reserved home with the task that will fill it", () => {
    for (const home of allHomes(loadLayout())) {
      if (home.status === "reserved") expect(home.filled_by).toMatch(/^T\d{2}$/);
    }
  });
});

describe("conceptOf", () => {
  const layout = loadLayout();

  it("resolves a file to the concept that owns its directory", () => {
    expect(conceptOf(layout, ".claude/agents/backend-engineer.md")).toBe("agent");
    expect(conceptOf(layout, "contracts/backend-engineer.yaml")).toBe("agent");
    expect(conceptOf(layout, ".claude/hooks/block-git.js")).toBe("policy");
    expect(conceptOf(layout, ".claude/shared/conventions.md")).toBe("policy");
    expect(conceptOf(layout, ".claude/scripts/check-status-sync.js")).toBe("skill");
    expect(conceptOf(layout, "orchestrator/src/cli.ts")).toBe("orchestrator");
    expect(conceptOf(layout, ".workflow/state.db")).toBe("runtime");
    expect(conceptOf(layout, "_docs/module/sales-crm/design.md")).toBe("docs");
  });

  it("accepts a Windows-style path, since callers get paths from both the shell and node", () => {
    expect(conceptOf(layout, ".claude\\agents\\security.md")).toBe("agent");
    expect(conceptOf(layout, "./contracts/security.yaml")).toBe("agent");
  });

  it("returns null for a path no concept claims, rather than guessing", () => {
    expect(conceptOf(layout, "CLAUDE.md")).toBeNull();
    expect(conceptOf(layout, "layout.yaml")).toBeNull();
  });

  it("gives the directory itself to its own concept", () => {
    expect(conceptOf(layout, "contracts")).toBe("agent");
  });

  /** A future home claiming a parent directory must not outrank a specific one. */
  it("lets the most specific home win", () => {
    const nested: RepoLayout = {
      version: 1,
      concepts: {
        broad: { answers: "a", why: "b", homes: [{ path: "x", status: "planned", holds: "everything" }] },
        narrow: { answers: "c", why: "d", homes: [{ path: "x/y", status: "planned", holds: "something" }] },
      },
    };
    expect(conceptOf(nested, "x/y/file.ts")).toBe("narrow");
    expect(conceptOf(nested, "x/other.ts")).toBe("broad");
  });
});

describe("homesOf", () => {
  it("throws on an unknown concept instead of reading as 'no homes'", () => {
    expect(() => homesOf(loadLayout(), "polices")).toThrow(LayoutError);
  });
});

describe("loadLayout", () => {
  it("fails when there is no layout file at all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-layout-"));
    expect(() => loadLayout(root)).toThrow(LayoutError);
  });

  it("fails on malformed YAML rather than returning a partial object", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-layout-"));
    fs.writeFileSync(path.join(root, "layout.yaml"), "concepts:\n  - [unclosed\n", "utf8");
    expect(() => loadLayout(root)).toThrow(LayoutError);
  });

  it("rejects an unknown key, so a typo'd field is never silently ignored", () => {
    const layout = minimalLayout();
    (layout.concepts.orchestrator.homes[0] as unknown as Record<string, unknown>).patern = "*.ts";
    expect(() => loadLayout(fixtureRoot(layout))).toThrow(LayoutError);
  });

  it("rejects a reserved home that does not say what will fill it", () => {
    const layout = minimalLayout();
    layout.concepts.orchestrator.homes[0] = { path: "workflows", status: "reserved", holds: "later" };
    expect(() => loadLayout(fixtureRoot(layout))).toThrow(LayoutError);
  });

  it("rejects a path written in a form it could not compare", () => {
    for (const bad of ["/abs/path", "trailing/", ".claude\\agents"]) {
      const layout = minimalLayout();
      layout.concepts.orchestrator.homes[0].path = bad;
      expect(() => loadLayout(fixtureRoot(layout)), bad).toThrow(LayoutError);
    }
  });
});

describe("checkLayout", () => {
  it("passes when every declared home is really there", () => {
    const root = fixtureRoot(minimalLayout(), { "orchestrator/package.json": "{}" });
    expect(checkLayout(root)).toEqual({ ok: true, problems: [] });
  });

  it("reports an active home that does not exist", () => {
    const result = checkLayout(fixtureRoot(minimalLayout()));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain('"orchestrator" is declared active but does not exist');
  });

  it("accepts a missing optional home — runtime state and docs appear only once something runs", () => {
    const layout = minimalLayout();
    layout.concepts.orchestrator.homes[0] = { path: ".workflow", status: "active", optional: true, holds: "state" };
    expect(checkLayout(fixtureRoot(layout)).ok).toBe(true);
  });

  it("ignores a planned home entirely — it is named so nobody invents a second one", () => {
    const layout = minimalLayout();
    layout.concepts.orchestrator.homes[0] = { path: "someday", status: "planned", holds: "nothing yet" };
    expect(checkLayout(fixtureRoot(layout)).ok).toBe(true);
  });

  it("collects every problem in one run rather than stopping at the first", () => {
    const layout = minimalLayout();
    layout.concepts.orchestrator.homes = [
      { path: "gone-a", status: "active", holds: "x" },
      { path: "gone-b", status: "active", holds: "y" },
    ];
    expect(checkLayout(fixtureRoot(layout)).problems).toHaveLength(2);
  });

  describe("overlap", () => {
    it("rejects two concepts claiming the same directory", () => {
      const layout = minimalLayout();
      layout.concepts.other = {
        answers: "q",
        why: "w",
        homes: [{ path: "orchestrator", status: "active", holds: "also this" }],
      };
      const problems = checkLayout(fixtureRoot(layout, { "orchestrator/x": "" })).problems.join("\n");
      expect(problems).toContain("claimed by both");
    });

    it("rejects one concept's home nested inside another's", () => {
      const layout = minimalLayout();
      layout.concepts.other = {
        answers: "q",
        why: "w",
        homes: [{ path: "orchestrator/src", status: "active", holds: "inside" }],
      };
      const problems = checkLayout(fixtureRoot(layout, { "orchestrator/src/x": "" })).problems.join("\n");
      expect(problems).toContain("ambiguous");
    });

    it("allows one concept to own two homes of its own", () => {
      const layout = minimalLayout();
      layout.concepts.orchestrator.homes.push({ path: "orchestrator/src", status: "active", holds: "sources" });
      expect(checkLayout(fixtureRoot(layout, { "orchestrator/src/x": "" })).ok).toBe(true);
    });
  });

  describe("per_agent homes", () => {
    function perAgentLayout(): RepoLayout {
      const layout = minimalLayout();
      layout.concepts.orchestrator.homes[0] = {
        path: "contracts",
        status: "active",
        pattern: "*.yaml",
        per_agent: true,
        holds: "one contract per agent",
      };
      return layout;
    }

    function everyAgentFile(): Record<string, string> {
      return Object.fromEntries(CONTRACTED_AGENTS.map((a) => [`contracts/${a}.yaml`, "{}"]));
    }

    it("passes when there is exactly one file per agent", () => {
      expect(checkLayout(fixtureRoot(perAgentLayout(), everyAgentFile())).ok).toBe(true);
    });

    /** The drift this catches: a role whose prompt exists but whose contract never got written. */
    it("reports the agent whose file is missing", () => {
      const files = everyAgentFile();
      delete files["contracts/security.yaml"];
      const problems = checkLayout(fixtureRoot(perAgentLayout(), files)).problems.join("\n");
      expect(problems).toContain("no file for agent security");
    });

    it("reports a file that belongs to no agent", () => {
      const files = { ...everyAgentFile(), "contracts/architect.yaml": "{}" };
      const problems = checkLayout(fixtureRoot(perAgentLayout(), files)).problems.join("\n");
      expect(problems).toContain("architect");
      expect(problems).toContain("orphan");
    });

    it("ignores files of another extension living alongside", () => {
      const files = { ...everyAgentFile(), "contracts/README.md": "notes" };
      expect(checkLayout(fixtureRoot(perAgentLayout(), files)).ok).toBe(true);
    });
  });

  describe("reserved homes", () => {
    function reservedLayout(): RepoLayout {
      const layout = minimalLayout();
      layout.concepts.orchestrator.homes[0] = {
        path: "workflows",
        status: "reserved",
        filled_by: "T09",
        holds: "one YAML per kind of change",
      };
      return layout;
    }

    it("passes with only a README explaining the reservation", () => {
      expect(checkLayout(fixtureRoot(reservedLayout(), { "workflows/README.md": "# soon" })).ok).toBe(true);
    });

    it("requires the README — otherwise the directory is just empty", () => {
      const root = fixtureRoot(reservedLayout());
      fs.mkdirSync(path.join(root, "workflows"));
      expect(checkLayout(root).problems.join("\n")).toContain("no README.md");
    });

    /** Content arriving before the task that owns it means the status is now a lie. */
    it("reports content that arrived before the task that reserved it", () => {
      const files = { "workflows/README.md": "# soon", "workflows/feature.yml": "steps: []" };
      const problems = checkLayout(fixtureRoot(reservedLayout(), files)).problems.join("\n");
      expect(problems).toContain("feature.yml");
      expect(problems).toContain("T09");
    });
  });

  describe("enforced_by_settings homes", () => {
    function hookLayout(): RepoLayout {
      const layout = minimalLayout();
      layout.concepts.orchestrator.homes[0] = {
        path: ".claude/hooks",
        status: "active",
        pattern: "*.js",
        enforced_by_settings: true,
        holds: "guards",
      };
      return layout;
    }

    const wired = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .claude/hooks/block-git.js" }] }] },
    });

    it("passes when every hook present is wired up", () => {
      const files = { ".claude/settings.json": wired, ".claude/hooks/block-git.js": "//" };
      expect(checkLayout(fixtureRoot(hookLayout(), files)).ok).toBe(true);
    });

    /** The fail-open this repo has already shipped: present, looking installed, enforcing nothing. */
    it("reports a hook the settings file never references", () => {
      const files = {
        ".claude/settings.json": wired,
        ".claude/hooks/block-git.js": "//",
        ".claude/hooks/block-everything.js": "//",
      };
      const problems = checkLayout(fixtureRoot(hookLayout(), files)).problems.join("\n");
      expect(problems).toContain("block-everything.js");
      expect(problems).toContain("enforces nothing");
    });

    it("reports an unreadable settings file rather than passing quietly", () => {
      const files = { ".claude/hooks/block-git.js": "//" };
      expect(checkLayout(fixtureRoot(hookLayout(), files)).problems.join("\n")).toContain("unreadable");
    });
  });
});

describe("assertLayout", () => {
  it("throws with every problem attached, for a caller that wants to fail hard", () => {
    const root = fixtureRoot(minimalLayout());
    try {
      assertLayout(root);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LayoutMismatchError);
      expect((e as LayoutMismatchError).problems.length).toBeGreaterThan(0);
    }
  });
});
