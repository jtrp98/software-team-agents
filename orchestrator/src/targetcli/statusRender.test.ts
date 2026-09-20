import { describe, expect, it } from "vitest";
import { renderStatus, type TargetStatus } from "./statusCommand.js";
import { workspaceShapeOf } from "./roleWorkspace.js";
import type { WorkspaceKind } from "./roleWorkspace.js";

const base = {
  targetRoot: "C:\\src\\company-knowledge",
  frameworkRoot: "C:\\src\\software-team-agents",
  frameworkVersion: "3.0.0+test",
  workspaceKind: "knowledge" as WorkspaceKind,
  syncState: "UP_TO_DATE" as const,
  syncChanges: [],
  conflictCount: 0,
  projectOwnedPaths: [],
  instructionSurface: [],
  managedFileCount: 0,
  hooksInstalled: 8,
  hooksRegistered: 8,
  claude: { ready: true, detail: "5 agent(s); all six guards wired" },
  codex: { ready: false, detail: "UNGUARDED" },
  opencode: { ready: true, detail: "ok" },
  antigravity: { ready: false, detail: "unguarded" },
  v3Configuration: { configured: false, detail: "not configured — defaults apply" },
};

function status(overrides: Partial<TargetStatus>): TargetStatus {
  return { ...base, ...overrides } as TargetStatus;
}

describe("V10 — status text keys on what the workspace IS, never the recorded role", () => {
  it("the Knowledge workspace prints no role line and marks Targets optional/read-only", () => {
    const text = renderStatus(
      status({
        role: "ba",
        targetId: "company-knowledge",
        targetBinding: { targetRoot: "D:\\src\\sb-web-helper", via: "local-mapping" },
        knowledgeBinding: { knowledgeRoot: "C:\\src\\company-knowledge", via: "workspace" },
      }),
    );
    expect(text).toContain("Workspace: Knowledge");
    expect(text).not.toContain("Workspace role:");
    expect(text).not.toContain("not needed for BA work");
    expect(text).toContain("Target (optional, read-only):");
    expect(text).not.toContain("required for DEV");
  });

  it("a Target checkout (legacy role recorded) prints no role line and keeps its Knowledge/stack picture", () => {
    const text = renderStatus(
      status({
        role: "dev",
        workspaceKind: "target",
        knowledgeBinding: { knowledgeRoot: "C:\\src\\company-knowledge", via: "workspace-config" },
      }),
    );
    expect(text).toContain("Workspace: Target");
    expect(text).not.toContain("Workspace role:");
    expect(text).not.toContain("required for DEV");
    expect(text).toContain("Knowledge:");
    expect(text).toContain("Target stack: UNRESOLVED");
  });

  it("a legacy markerless checkout classified only by its recorded role still renders through the shape, not the role", () => {
    expect(workspaceShapeOf("unrecognized", "dev")).toBe("target");
    expect(workspaceShapeOf("ambiguous", "ba")).toBe("knowledge");
    expect(workspaceShapeOf("unrecognized", undefined)).toBe("other");
    // Markers outrank nothing a role records: `detectWorkspaceKind` already lets
    // a recorded role win, so an app-marker checkout without a role is a Target.
    expect(workspaceShapeOf("target", undefined)).toBe("target");
    const text = renderStatus(status({ role: "dev", workspaceKind: "target" }));
    expect(text).toContain("Workspace: Target");
    expect(text).toContain("Knowledge: NOT BOUND");
  });

  it("an unrecognized roleless root keeps today's minimal picture (no Workspace line at all)", () => {
    const text = renderStatus(status({ workspaceKind: "unrecognized" }));
    expect(text).not.toContain("Workspace:");
    expect(text).toContain("Target:");
  });
});

describe("V11 TASK-025 — status names the session's Knowledge-root selection (DR §7.4)", () => {
  it("prints selected name, canonical path, source and the default — and never claims to change the default", () => {
    const text = renderStatus(
      status({
        workspaceKind: "target" as WorkspaceKind,
        role: "dev",
        knowledgeSelection: { name: "work", path: "C:/src/work-root", source: "default", defaultRootName: "work", defaultPath: "C:/src/work-root" },
      }),
    );
    expect(text).toContain(`Knowledge root: "work" → C:/src/work-root (selected via default; default: work — status never re-selects)`);
    expect(text).toContain("status never re-selects");
  });

  it("keeps the line out of a legacy status with no installation selection", () => {
    const text = renderStatus(status({ workspaceKind: "target" as WorkspaceKind, role: "dev" }));
    expect(text).not.toContain("Knowledge root: \"");
    expect(text).not.toContain("selected via");
  });

  it("shows the flagged selection in a Knowledge workspace too — same line, both shapes", () => {
    const text = renderStatus(
      status({
        knowledgeSelection: { name: "other", path: "D:/kf/other", source: "flag", defaultRootName: "work", defaultPath: "C:/src/work-root" },
      }),
    );
    expect(text).toContain(`Knowledge root: "other" → D:/kf/other (selected via flag; default: work — status never re-selects)`);
  });
});
