/**
 * The Claude Design MCP policy module — the read/write allowlist for
 * Anthropic's official Claude Design MCP server, made checkable instead of remembered.
 *
 * This is a **verdict-only** module: it never performs a network call or talks
 * to an MCP client. The runtime adapter consults it before exposing/invoking
 * tools; this file only decides what is permitted, so every branch can be
 * tested without a credential or a login.
 *
 * Two modes exist because the uxui-designer lane uses Claude Design in two
 * directions: `read` ingests a design into the pipeline, `write` pushes
 * knowledge out onto a project's canvas as a draft mockup. A write-mode
 * selection may also use read tools (a project must be inspected before it's
 * iterated on); a read-mode selection may never touch a write tool.
 *
 * FROZEN ALLOWLISTS (2026-08-25) — the tool names below were read off the live
 * official server during UAT and frozen to match. Extending either list after
 * this point is a deliberate constant change with a reason in the diff, never
 * a convenience. Deliberately EXCLUDED (always refused, even in write mode):
 *   `delete_files`, `finalize_plan` — destructive/publishing acts a draft lane
 *     has no business doing;
 *   `put_conversation`, `ack_comments` — the lane drives the canvas through
 *     files, not chat turns;
 *   `add_member`, `remove_member`, `update_member_role`, `update_sharing` —
 *     membership/sharing is outward-facing and never an agent decision;
 *   `render_preview`, `create_support_js` — not needed for ingest/draft work;
 *     reconsider only with a concrete task that requires them.
 */

/** The only Claude Design MCP endpoint this framework ever configures. Official server only — unofficial Chrome-driving proxies are out of scope by design. */
export const CLAUDE_DESIGN_MCP_SERVER_URL = "https://api.anthropic.com/v1/design/mcp";

/**
 * Tools allowed in BOTH modes — inspect-only. Frozen against the live official
 * server on 2026-08-25.
 */
export const CLAUDE_DESIGN_READ_TOOLS: readonly string[] = [
  "get_claude_design_prompt",
  "get_conversation",
  "get_project",
  "list_comments",
  "list_design_systems",
  "list_files",
  "list_projects",
  "read_design_skill",
  "read_file",
];

/**
 * Canvas/project-mutating tools, usable ONLY when the run was explicitly launched in
 * write mode. Frozen against the live official server on 2026-08-25.
 * `delete_files`/`finalize_plan` are deliberately absent — see the module header.
 */
export const CLAUDE_DESIGN_WRITE_TOOLS: readonly string[] = [
  "copy_files",
  "create_project",
  "write_files",
];

/** Which direction a uxui-designer run uses Claude Design for. */
export type ClaudeDesignMode = "read" | "write";

export interface ClaudeDesignToolRefusal {
  tool: string;
  reason: string;
}

export interface ClaudeDesignToolSelection {
  /** Tools the caller may invoke under this mode, preserving requested order. */
  allowed: string[];
  /** Everything else, each with a one-line reason naming the fix/policy. */
  refused: ClaudeDesignToolRefusal[];
}

function refusalReason(tool: string, mode: ClaudeDesignMode): string {
  if (mode === "read" && (CLAUDE_DESIGN_WRITE_TOOLS as readonly string[]).includes(tool)) {
    return `"${tool}" mutates the canvas and this run is read-only — relaunch the stage explicitly in write mode if a draft mockup is wanted`;
  }
  return (
    `"${tool}" is not on the claude-design ${mode} allowlist — unknown tools are refused fail-closed` +
    " (allowlists were frozen against the live server on 2026-08-25; extend the constant deliberately if this tool is verified)"
  );
}

/**
 * Split a requested tool list into allowed/refused for the given mode. Pure:
 * no I/O, no side effects, deterministic order. An empty request is valid and
 * returns an empty selection — refusing nothing is not a failure.
 */
export function selectClaudeDesignTools(requested: readonly string[], mode: ClaudeDesignMode): ClaudeDesignToolSelection {
  const writable = mode === "write";
  const allowed = new Set<string>(
    writable ? [...CLAUDE_DESIGN_READ_TOOLS, ...CLAUDE_DESIGN_WRITE_TOOLS] : CLAUDE_DESIGN_READ_TOOLS,
  );
  const selection: ClaudeDesignToolSelection = { allowed: [], refused: [] };
  for (const tool of requested) {
    if (allowed.has(tool)) {
      selection.allowed.push(tool);
    } else {
      selection.refused.push({ tool, reason: refusalReason(tool, mode) });
    }
  }
  return selection;
}
