import { verifyFigmaIdentity, type IdentityVerification } from "../threeRepo/identities.js";

/**
 * The Figma MCP posture (T-UX0/T-UX4) — one place that says which tools this
 * integration may use, so the allowlist the docs describe, the tests prove,
 * and any future wiring would consult cannot become three different lists.
 *
 * OWNERSHIP DECISION
 *
 * MCP connection config itself stays *manual consumer configuration*: today
 * neither Claude Code nor OpenCode gets an `.mcp.json`/`mcp` block from this
 * framework, and generating one would create a second owner for a file the
 * consumer legitimately customizes (transports, headers, other servers). What
 * the framework owns instead is the *policy* below — read-only tools only,
 * identity verified before use, PAT from the environment — and every runtime
 * setup doc points here as the thing to configure against.
 *
 * WHY READ-ONLY IS ENFORCED IN DEPTH
 *
 * No single layer carries the whole guarantee:
 *   1. this allowlist (a write tool is never one the integration may call),
 *   2. the PAT's scopes (created read-only server-side),
 *   3. the uxui-designer contract (its write paths cover nothing but its own
 *      lane artifacts and knowledge kind), and
 *   4. the prompt rule ("refuse any step needing another tool").
 * A future Figma remote server shipping write tools (Code-to-Canvas) changes
 * none of these layers' behavior.
 */

/**
 * The read-only tool surface uxui-designer may call. Grounded in the Figma
 * MCP read API surface (`get_me` identity, `get_metadata`, `get_code`,
 * `get_screenshot`, `get_variable_defs`) — each returns information about a
 * file; none mutates anything.
 */
export const FIGMA_MCP_READ_TOOLS: readonly string[] = [
  "get_me",
  "get_metadata",
  "get_code",
  "get_screenshot",
  "get_variable_defs",
] as const;

/** Substrings that mark a tool as mutating. Matched case-insensitively against the whole tool name. */
const WRITE_TOOL_MARKERS: readonly string[] = ["write", "post", "put", "patch", "delete", "create", "update", "edit", "publish", "send", "join", "comment", "dev_mode"];

export function isFigmaReadTool(toolName: string): boolean {
  return FIGMA_MCP_READ_TOOLS.includes(toolName);
}

/**
 * Whether a proposed tool selection stays inside the read-only surface.
 * Unknown tools are refused rather than ignored: an allowlist that silently
 * drops names would let a typo widen what runs while looking like it narrowed.
 */
export function isReadOnlyToolSelection(toolNames: readonly string[]): boolean {
  return toolNames.every((name) => isFigmaReadTool(name));
}

/** The write-capability check the negative tests exercise: anything whose name smells like mutation is not allowed even if someone adds it to the list above later. */
export function looksLikeWriteTool(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return WRITE_TOOL_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * The full connect-time verdict: identity first (fail closed), then the tool
 * selection. This is the function a runtime adapter calls once, when the MCP
 * session opens, before any design call goes out.
 */
export function figmaMcpConnectVerdict(params: {
  declaredEmail: string | undefined;
  getMeEmail: string | null;
  toolNames: readonly string[];
}): IdentityVerification & { readOnlyOk: boolean } {
  const identity = verifyFigmaIdentity(params.declaredEmail, params.getMeEmail);
  if (!identity.allowed) {
    return { ...identity, readOnlyOk: false };
  }
  const readOnlyOk = isReadOnlyToolSelection(params.toolNames) && params.toolNames.every((t) => !looksLikeWriteTool(t));
  if (!readOnlyOk) {
    return {
      allowed: false,
      reason:
        "the Figma MCP tool list contains tools outside the read-only allowlist (get_me/get_metadata/get_code/get_screenshot/get_variable_defs) — " +
        "this integration never writes to the canvas; reconfigure the server's exposed tools",
      readOnlyOk,
    };
  }
  return { ...identity, readOnlyOk };
}
