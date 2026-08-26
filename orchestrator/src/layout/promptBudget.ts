import * as fs from "node:fs";
import * as path from "node:path";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { policyPointerResolves } from "../docs/policyIndex.js";

/**
 * T-V3TOK-014 — the static-context floor cannot grow back silently.
 *
 * The reason it grew 8.4x in the first place is that nothing measured it.
 * `CLAUDE.md` went 7,888 -> 42,232 B across 22 commits without one of them
 * going down, and every agent prompt did the same, because adding prose to an
 * auto-loaded file was free at review time and expensive on every run
 * afterwards. This checker makes that trade visible where it is made.
 *
 * Two design rules, both learned from the allowlist being the obvious escape:
 *
 *   1. Every budget here is a number a person chose, with the reason next to
 *      it. There is no "current size + slack" default, because that turns the
 *      guard into a ratchet that only ever loosens.
 *   2. A file allowed above the general budget gets its own target, not an
 *      exemption. `PROMPT_BUDGETS` below carries per-file entries whose value
 *      is the ceiling that file must stay under *now*, and a comment saying
 *      which task brings it down next.
 *
 * Structural guards (no `Agent` tool, no `AskUserQuestion` for engineers) sit
 * here rather than in `--check-contracts` on purpose: that checker compares a
 * contract to the registry, and neither of them is the file Claude Code reads
 * when it resolves a subagent. The prompt frontmatter is. Nothing checked it
 * before this task.
 */

export interface PromptBudgetCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * `CLAUDE.md` is auto-loaded into every session and every subagent, on both the
 * orchestrated and the interactive path.
 *
 * The T-V3TOK-010 gate approved option B — keep the eight rules the
 * rule-enforcement matrix classifies `PROMPT-ONLY`/`PARTIAL-KEEP` (5,547 B, no
 * deterministic backup) in the card, and defer the 6,144 B target to
 * T-V3TOK-020, which creates `.claude/shared/agent-preamble.md` to hold them.
 * The number named at that gate was 12,288 B.
 *
 * It is 13,312 B here, and the 1,024 B difference is one specific thing: the
 * three-repo/T-LV3 block, which the gate's inventory missed and which
 * `targetcli/roleWorkspace.test.ts:292-303` pins as having to ship in the
 * synced payload. It states where `qa-engineer`'s verdict may be written when
 * `plan.md` lives in another repository — dropping it would not have saved a
 * byte honestly, it would have deleted a boundary.
 *
 * This is the budget being *set* once from a corrected inventory, which is not
 * the same as raising it later to fit a file that grew. Nothing here may be
 * raised again: a prompt that needs more space needs its rationale in `docs/`.
 * 42,232 -> 13,312 is a 68.5% reduction; the 6,144 B target still stands for
 * after T-V3TOK-020.
 */
export const CLAUDE_MD_BUDGET = 13_312;

/** The general per-role prompt ceiling P2 drives every file down to. */
export const AGENT_PROMPT_TARGET = 4_096;

/**
 * Per-role ceilings in force *today*. Each is the size that role's prompt must
 * not exceed before its own P2 thinning task runs; the comment names that task.
 * A number here is never raised to accommodate a prompt that grew — a prompt
 * that needs more space is a prompt that needs its rationale moved to `docs/`.
 */
export const PROMPT_BUDGETS: Record<string, number> = {
  // Thinned by T-V3TOK-022.
  "setup.md": 9_395,
  "test-planner.md": 7_837,
  "uxui-designer.md": 9_531,
  // Thinned by T-V3TOK-023 / 024.
  "backend-engineer.md": 13_641,
  "frontend-engineer.md": 13_546,
  // Thinned by T-V3TOK-025 / 026.
  "business-analyst.md": 18_614,
  "project-manager.md": 18_128,
  // Thinned by T-V3TOK-027 / 028; these two keep a raised final target
  // (6,144) because a design contract and a verification checklist carry more
  // irreducible content than the other nine.
  "system-analyst.md": 26_279,
  "qa-engineer.md": 30_458,
  // Thinned by T-V3TOK-029 / 030.
  "security.md": 11_879,
  "devops.md": 14_277,
};

/** Guard 3: the global policy pre-read directive, in either of the two forms the prompts used. */
const POLICY_PREREAD = /Read\s+every\s+file\s+in\s+`?policies\//i;

/** Guard 4: `policies/<area>.md §<n>` written anywhere in a prompt. */
const POLICY_POINTER = /`?policies\/([a-z-]+)\.md`?\s*(?:§|#)\s*([0-9]+[a-z]?)/gi;

/** Guard: no prompt may hand an agent the tool that would let it chain to the next one. */
const AGENT_TOOL = /(^|[,\s])Agent([,\s]|$)/;

/** Engineers deliberately have no way to settle a rule in chat — see the matrix, R12. */
const NO_ASK_ROLES = ["backend-engineer.md", "frontend-engineer.md"];

function frontmatterTools(markdown: string): string[] | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!fm) return null;
  const line = /^tools:\s*(.+)$/m.exec(fm[1]);
  if (!line) return null;
  return line[1].split(",").map((tool) => tool.trim()).filter(Boolean);
}

function agentPromptFiles(projectRoot: string): string[] {
  const dir = path.join(projectRoot, ".claude", "agents");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function byteSize(file: string): number | null {
  try {
    return fs.readFileSync(file).length;
  } catch {
    return null;
  }
}

export function checkPromptBudget(projectRoot: string = defaultProjectRoot()): PromptBudgetCheckResult {
  const problems: string[] = [];
  const notes: string[] = [];

  // --- guard 1: CLAUDE.md -----------------------------------------------
  const claudeMd = byteSize(path.join(projectRoot, "CLAUDE.md"));
  if (claudeMd === null) {
    problems.push("CLAUDE.md is missing — it is the operating card every session loads");
  } else if (claudeMd > CLAUDE_MD_BUDGET) {
    problems.push(`CLAUDE.md is ${claudeMd} B, over its ${CLAUDE_MD_BUDGET} B budget by ${claudeMd - CLAUDE_MD_BUDGET} B — move rationale to docs/, do not raise the budget`);
  } else {
    notes.push(`CLAUDE.md ${claudeMd} B / ${CLAUDE_MD_BUDGET} B`);
  }

  const files = agentPromptFiles(projectRoot);
  if (files.length === 0) problems.push("no .claude/agents/*.md prompts found");

  for (const file of files) {
    const abs = path.join(projectRoot, ".claude", "agents", file);
    const markdown = fs.readFileSync(abs, "utf8");

    // --- guard 2: per-role prompt budget --------------------------------
    const budget = PROMPT_BUDGETS[file];
    const size = markdown.length;
    if (budget === undefined) {
      problems.push(`.claude/agents/${file} has no declared budget — add one to PROMPT_BUDGETS with the task that brings it down`);
    } else if (size > budget) {
      problems.push(`.claude/agents/${file} is ${size} B, over its ${budget} B budget by ${size - budget} B`);
    } else if (size <= AGENT_PROMPT_TARGET) {
      notes.push(`.claude/agents/${file} ${size} B — at the ${AGENT_PROMPT_TARGET} B target`);
    } else {
      notes.push(`.claude/agents/${file} ${size} B / ${budget} B (target ${AGENT_PROMPT_TARGET} B)`);
    }

    // --- guard 3: no global policy pre-read -----------------------------
    if (POLICY_PREREAD.test(markdown)) {
      problems.push(`.claude/agents/${file} still tells the agent to read every file in policies/ — point at the sections that role uses (T-V3TOK-012)`);
    }

    // --- guard 4: every policy pointer resolves -------------------------
    const seen = new Set<string>();
    for (const match of markdown.matchAll(POLICY_POINTER)) {
      const key = `${match[1]}§${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!policyPointerResolves(projectRoot, match[1], match[2])) {
        problems.push(`.claude/agents/${file} points at policies/${match[1]}.md §${match[2]}, which has no such heading`);
      }
    }

    // --- structural guards (approved at the T-V3TOK-010 gate, item c) ---
    // These are why R03/R12 may be reduced to one line in CLAUDE.md at all.
    // `--check-contracts` compares contract to registry; neither is this file,
    // and this file is the one Claude Code reads to resolve the subagent.
    const tools = frontmatterTools(markdown);
    if (tools === null) {
      problems.push(`.claude/agents/${file} has no frontmatter tools: line — the role's tool surface must be stated, not inherited`);
    } else {
      if (tools.some((tool) => AGENT_TOOL.test(tool))) {
        problems.push(`.claude/agents/${file} grants the Agent tool — no agent chains to the next one, and that is structural, not a prompt rule`);
      }
      if (NO_ASK_ROLES.includes(file) && tools.includes("AskUserQuestion")) {
        problems.push(`.claude/agents/${file} grants AskUserQuestion — an engineer that settles a rule in chat never gets it into requirement.md or design.md`);
      }
    }
    if (AGENT_TOOL.test(markdown.replace(/^---[\s\S]*?\n---/, ""))) {
      // The prompt body naming the tool is how an agent learns it has one.
      problems.push(`.claude/agents/${file} mentions the Agent tool in its body — no role may be told it can invoke another`);
    }
  }

  return { ok: problems.length === 0, problems, notes };
}
