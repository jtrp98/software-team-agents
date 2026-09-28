import { sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { ApprovalType, type ApprovalRecord, type HumanDecisionRecord } from "./approval.js";
import type { LaneApprovalRecord } from "./laneApproval.js";
import {
  HumanChannelUnavailableError,
  UntrustedHumanDecisionError,
  type ApprovalAnnouncement,
  type ApprovalPublication,
  type HumanDecisionContext,
  type HumanDecisionRequest,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
  type VerifiedDecisionFor,
} from "./humanDecision.js";

/**
 * The `github-app` trusted human channel (V13 TASK-027).
 *
 * STA — never a role agent — authenticates as a GitHub App that holds only
 * `issues: read & write` and `metadata: read`, with no webhook. For every
 * pending approval request it opens one Issue in the configured approval
 * repository and persists where (`approval-publication` evidence). A person
 * answers with a new comment whose first line is exactly
 * `sta-approve: <requestId>` or `sta-reject: <requestId>`.
 *
 * A comment counts only when every check holds, each one read from GitHub's
 * own record, never from the submission:
 *   - it is on the Issue STA recorded for this request (`issue_url`);
 *   - its first line names this exact request id;
 *   - it was created after the request was opened;
 *   - its author is a `User`, never a `Bot` or App;
 *   - the author's numeric user id is on this gate type's approver list;
 *   - it was never edited (`updated_at === created_at`).
 *
 * The API base is a constant. Nothing here reads the environment, and the
 * human-owned configuration (`humanChannelConfig.ts`) has no field that can
 * move it: a proxy, mirror or fixture server cannot be substituted by an
 * agent. The transport is injectable only in code, which is how the fixture
 * tests run without a network.
 *
 * What the App's own key can do is bounded by the same rules: anything the
 * App posts is authored by a Bot and never counts, so holding the key cannot
 * approve anything. The approver list is the authority, which is why it sits
 * outside every role agent's roots and behind the guard floor.
 */

export const GITHUB_APP_CHANNEL = "github-app";
/** Fixed. Not configurable by environment or file — see the header. */
export const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_ORIGIN = new URL(GITHUB_API_BASE).origin;
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "software-team-agents-sta";
const DEFAULT_TIMEOUT_MS = 15_000;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 10;

/** `fetch`'s shape. Production passes `globalThis.fetch`; tests pass a fixture. */
export type GithubTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubRepository {
  owner: string;
  name: string;
}

export interface GithubAppChannelOptions {
  appId: number;
  repository: GithubRepository;
  /** Numeric GitHub user ids allowed to decide each gate type. A missing type has no approver. */
  approvers: Partial<Record<ApprovalType, readonly number[]>>;
  privateKey: KeyObject;
  transport?: GithubTransport;
  /** Wall clock for the App JWT only; decisions are timed by the orchestrator's `now`. */
  clock?: () => number;
  timeoutMs?: number;
}

const DECISION_LINE = /^sta-(approve|reject):[ \t]*(\S+)[ \t]*$/;

const InstallationSchema = z.object({ id: z.number().int().positive() });
const AccessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.string().min(1) });
const CreatedIssueSchema = z.object({ number: z.number().int().positive(), html_url: z.string().min(1) });
const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const CommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  user: z.object({ id: z.number().int().positive(), login: z.string().min(1), type: z.string().min(1) }).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  issue_url: z.string().min(1),
});
type GithubComment = z.infer<typeof CommentSchema>;

class ChannelCallError extends Error {}

/** Parses `owner/repo#123`, the publication ref this channel writes. */
export function parseIssueRef(ref: string): { repository: GithubRepository; issue: number } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(ref);
  if (!match) return null;
  return { repository: { owner: match[1]!, name: match[2]! }, issue: Number(match[3]) };
}

function sameRepository(a: GithubRepository, b: GithubRepository): boolean {
  // GitHub owner and repository names are case-insensitive.
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/** What a candidate comment failed, for the refusal message. */
export type CommentRejection = "other-request" | "wrong-issue" | "before-request" | "not-a-user" | "not-an-approver" | "edited" | "no-author";

export function createGithubAppChannel(options: GithubAppChannelOptions): HumanDecisionVerifier {
  const transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const repo = options.repository;
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  let cachedToken: { token: string; expiresAt: number } | null = null;

  async function call(method: string, pathname: string, auth: string, body?: unknown): Promise<unknown> {
    const url = new URL(pathname, GITHUB_API_BASE);
    if (url.origin !== GITHUB_API_ORIGIN) throw new ChannelCallError(`refusing to call ${url.origin}; the channel only talks to ${GITHUB_API_ORIGIN}`);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${auth}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await transport(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ChannelCallError(`${method} ${url.pathname} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    if (!response.ok) throw new ChannelCallError(`${method} ${url.pathname} answered HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (e) {
      throw new ChannelCallError(`${method} ${url.pathname} returned a body that is not JSON`);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ChannelCallError(`GitHub returned an unexpected ${what}: ${result.error.message}`);
    return result.data;
  }

  function appJwt(): string {
    const nowSeconds = Math.floor(clock() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    // Backdated a minute for clock drift; GitHub caps the lifetime at ten.
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: options.appId })}`;
    return `${unsigned}.${sign("sha256", Buffer.from(unsigned), options.privateKey).toString("base64url")}`;
  }

  async function installationToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt - 60_000 > clock()) return cachedToken.token;
    const jwt = appJwt();
    let installation: z.infer<typeof InstallationSchema>;
    try {
      installation = parse(InstallationSchema, await call("GET", `${repoPath}/installation`, jwt), "installation");
    } catch (e) {
      if (e instanceof ChannelCallError && /HTTP 404/.test(e.message)) {
        throw new ChannelCallError(`the GitHub App ${options.appId} is not installed on ${repo.owner}/${repo.name}`);
      }
      throw e;
    }
    // Narrowed to the one repository and the two permissions this channel uses.
    const granted = parse(
      AccessTokenSchema,
      await call("POST", `/app/installations/${installation.id}/access_tokens`, jwt, {
        repositories: [repo.name],
        permissions: { issues: "write", metadata: "read" },
      }),
      "installation token",
    );
    const expiresAt = Date.parse(granted.expires_at);
    cachedToken = { token: granted.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : clock() };
    return granted.token;
  }

  async function guarded<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChannelCallError) throw new HumanChannelUnavailableError(requestId, `${GITHUB_APP_CHANNEL}: ${e.message}`);
      throw e;
    }
  }

  async function listComments(token: string, issue: number): Promise<GithubComment[]> {
    const comments: GithubComment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const batch = parse(
        z.array(CommentSchema),
        await call("GET", `${repoPath}/issues/${issue}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`, token),
        "comment list",
      );
      comments.push(...batch);
      if (batch.length < COMMENTS_PER_PAGE) return comments;
    }
    throw new ChannelCallError(`Issue #${issue} has more than ${MAX_COMMENT_PAGES * COMMENTS_PER_PAGE} comments; refusing to guess which one decides`);
  }

  function issueApiUrl(issue: number): string {
    return `${GITHUB_API_BASE}${repoPath}/issues/${issue}`;
  }

  function judge(comment: GithubComment, request: HumanDecisionRequest, issue: number): CommentRejection | null {
    const line = (comment.body ?? "").split(/\r?\n/, 1)[0]!.trim();
    const match = DECISION_LINE.exec(line);
    if (!match || match[2] !== request.requestId) return "other-request";
    if (comment.issue_url !== issueApiUrl(issue)) return "wrong-issue";
    const created = Date.parse(comment.created_at);
    if (!Number.isFinite(created) || created <= request.requestedAt) return "before-request";
    if (!comment.user) return "no-author";
    if (comment.user.type !== "User") return "not-a-user";
    if (!(options.approvers[request.scope.type] ?? []).includes(comment.user.id)) return "not-an-approver";
    if (comment.updated_at !== comment.created_at) return "edited";
    return null;
  }

  return {
    channel: GITHUB_APP_CHANNEL,

    async publish({ request, artifacts }: ApprovalAnnouncement): Promise<ApprovalPublication> {
      return guarded(request.requestId, async () => {
        const token = await installationToken();
        const created = parse(
          CreatedIssueSchema,
          await call("POST", `${repoPath}/issues`, token, { title: issueTitle(request), body: issueBody(request, artifacts) }),
          "created issue",
        );
        return { channel: GITHUB_APP_CHANNEL, ref: `${repo.owner}/${repo.name}#${created.number}`, url: created.html_url };
      });
    },

    async verify<R extends HumanDecisionRequest>(request: R, submission: HumanDecisionSubmission, context: HumanDecisionContext): Promise<VerifiedDecisionFor<R>> {
      const publication = context.publication;
      if (!publication || publication.channel !== GITHUB_APP_CHANNEL) {
        throw new UntrustedHumanDecisionError(
          `${GITHUB_APP_CHANNEL}: request ${request.requestId} has no Issue STA opened for it — a decision is read only from that Issue (publish it first)`,
        );
      }
      const bound = parseIssueRef(publication.ref);
      if (!bound || !sameRepository(bound.repository, repo)) {
        throw new UntrustedHumanDecisionError(
          `${GITHUB_APP_CHANNEL}: request ${request.requestId} was published as ${publication.ref}, not on the configured ${repo.owner}/${repo.name}`,
        );
      }
      const { issue, comments } = await guarded(request.requestId, async () => {
        const token = await installationToken();
        const found = parse(IssueSchema, await call("GET", `${repoPath}/issues/${bound.issue}`, token), "issue");
        return { issue: found, comments: await listComments(token, bound.issue) };
      });
      if (issue.number !== bound.issue || issue.pull_request !== undefined || !`${issue.title}\n${issue.body ?? ""}`.includes(request.requestId)) {
        throw new UntrustedHumanDecisionError(`${GITHUB_APP_CHANNEL}: ${publication.ref} is not the Issue announcing request ${request.requestId}`);
      }

      const rejected: string[] = [];
      const valid: GithubComment[] = [];
      for (const comment of comments) {
        const line = (comment.body ?? "").split(/\r?\n/, 1)[0]!.trim();
        if (!DECISION_LINE.test(line)) continue; // conversation, not a decision attempt
        const why = judge(comment, request, bound.issue);
        if (why === null) valid.push(comment);
        else rejected.push(`comment ${comment.id} (${comment.user?.login ?? "no author"}): ${why}`);
      }
      if (valid.length === 0) {
        throw new UntrustedHumanDecisionError(
          `${GITHUB_APP_CHANNEL}: no valid decision for ${request.requestId} on ${publication.ref}` +
            (rejected.length > 0 ? ` — ignored ${rejected.join("; ")}` : " — no sta-approve/sta-reject comment yet"),
        );
      }
      const verbs = new Set(valid.map((c) => DECISION_LINE.exec((c.body ?? "").split(/\r?\n/, 1)[0]!.trim())![1]));
      if (verbs.size > 1) {
        throw new UntrustedHumanDecisionError(
          `${GITHUB_APP_CHANNEL}: approvers disagree on ${request.requestId} (${valid.map((c) => c.id).join(", ")}) — a person must settle it; nothing is recorded`,
        );
      }
      const chosen = [...valid].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)[0]!;
      const approved = verbs.has("approve");
      if (submission.approved !== undefined && submission.approved !== approved) {
        throw new UntrustedHumanDecisionError(
          `${GITHUB_APP_CHANNEL}: the approver's comment ${chosen.id} says ${approved ? "approve" : "reject"}, not what this submission expected`,
        );
      }
      const user = chosen.user!;
      const note = (chosen.body ?? "").split(/\r?\n/).slice(1).join("\n").trim();
      return {
        requestId: request.requestId,
        scope: request.scope,
        decision: {
          decisionId: `github-comment:${chosen.id}`,
          approved,
          actor: { kind: "human", id: `github-user:${user.id}` },
          source: {
            channel: GITHUB_APP_CHANNEL,
            evidenceRef:
              `github:${repo.owner}/${repo.name}/issues/${bound.issue}/comments/${chosen.id}` +
              `?user_id=${user.id}&login=${encodeURIComponent(user.login)}&created_at=${encodeURIComponent(chosen.created_at)}`,
          },
          decidedAt: context.now,
          note: note === "" ? null : note,
        },
      };
    },

    async settle(request: HumanDecisionRequest, decision: HumanDecisionRecord, publication: ApprovalPublication | null): Promise<void> {
      const bound = publication ? parseIssueRef(publication.ref) : null;
      if (!bound || !sameRepository(bound.repository, repo)) return;
      await guarded(request.requestId, async () => {
        const token = await installationToken();
        await call("POST", `${repoPath}/issues/${bound.issue}/comments`, token, {
          body:
            `STA recorded this decision: **${decision.approved ? "approved" : "rejected"}** ` +
            `(decision \`${decision.decisionId}\`). Request \`${request.requestId}\` is settled; further comments are not read.`,
        });
        await call("PATCH", `${repoPath}/issues/${bound.issue}`, token, {
          state: "closed",
          state_reason: decision.approved ? "completed" : "not_planned",
        });
      });
    },
  };
}

function isLaneRequest(request: HumanDecisionRequest): request is LaneApprovalRecord {
  return "kind" in request.scope && request.scope.kind === "lane";
}

function issueTitle(request: HumanDecisionRequest): string {
  if (isLaneRequest(request)) {
    const { scope } = request;
    return `STA approval: ${scope.type} for module ${scope.module} (${request.requestId})`;
  }
  return `STA approval: ${request.scope.type} for ${request.scope.taskId} (${request.requestId})`;
}

function decisionInstructions(request: HumanDecisionRequest): string[] {
  return [
    "An authorized approver decides by posting a **new** comment whose first line is exactly one of:",
    "",
    "```",
    `sta-approve: ${request.requestId}`,
    `sta-reject: ${request.requestId}`,
    "```",
    "",
    "Anything after the first line is recorded as the note. Edited comments, comments by bots or apps,",
    "comments by anyone not on this gate's approver list, and comments naming another request are ignored.",
  ];
}

function laneIssueBody(request: LaneApprovalRecord): string {
  const { scope } = request;
  const act =
    scope.action === "signoff"
      ? `Sign off the ${scope.lane.toUpperCase()} lane: the items below become binding at exactly these versions and the lane is finished.`
      : `Acknowledge for the ${scope.lane.toUpperCase()} lane that you have seen the items below at exactly these versions.`;
  return [
    "STA is waiting for a human decision.",
    "",
    `- Request: \`${request.requestId}\``,
    `- Module: \`${scope.module}\``,
    `- Lane: \`${scope.lane}\` (${scope.action})`,
    `- Gate: \`${scope.type}\``,
    `- Reason: ${request.reason}`,
    "",
    act,
    "",
    "Items at the time of asking:",
    ...scope.items.map((item) => `- ${item.id} v${item.version} (\`sha256:${item.digest}\`)`),
    "",
    "If any of these items changes before you answer, STA withdraws this request and asks again.",
    "",
    ...decisionInstructions(request),
  ].join("\n");
}

function issueBody(request: HumanDecisionRequest, artifacts: ApprovalAnnouncement["artifacts"]): string {
  if (isLaneRequest(request)) return laneIssueBody(request);
  const task: ApprovalRecord = request;
  const edge = task.scope.from && task.scope.to ? `${task.scope.from} → ${task.scope.to}` : "none (escalation)";
  const artifactLines =
    artifacts.length === 0
      ? ["- none recorded yet"]
      : artifacts.map((a) => `- ${a.artifactType}: \`sha256:${a.contentDigest}\` (evidence \`${a.evidenceId}\`)`);
  return [
    "STA is waiting for a human decision.",
    "",
    `- Request: \`${task.requestId}\``,
    `- Task: \`${task.scope.taskId}\``,
    `- Gate: \`${task.scope.type}\``,
    `- Edge: ${edge}`,
    `- Reason: ${task.reason}`,
    "",
    "Artifacts at the time of asking:",
    ...artifactLines,
    "",
    ...decisionInstructions(task),
  ].join("\n");
}
