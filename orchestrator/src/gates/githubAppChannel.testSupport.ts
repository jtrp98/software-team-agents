import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { GITHUB_API_BASE, type GithubTransport } from "./githubAppChannel.js";

/**
 * Test-only HTTP fixture of the GitHub REST endpoints the `github-app`
 * channel calls (V13 TASK-027). It answers the channel's transport the way
 * api.github.com does — JSON bodies, status codes, the App JWT checked
 * against the App's public key, installation tokens required everywhere
 * else — and records every call so a test can assert where the channel went.
 *
 * Nothing in production composes it: the channel's only production transport
 * is `globalThis.fetch` against the fixed `https://api.github.com`.
 */

export interface FixtureUser {
  id: number;
  login: string;
  type: "User" | "Bot" | "Organization";
}

export interface FixtureComment {
  id: number;
  issue: number;
  body: string;
  user: FixtureUser | null;
  created_at: string;
  updated_at: string;
  /** Overrides the comment's `issue_url`, to simulate a comment GitHub reports for another issue. */
  issue_url?: string;
}

export interface FixtureIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  pull_request?: unknown;
}

export interface FixtureCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

export const FIXTURE_APP_ID = 424242;
export const FIXTURE_INSTALLATION_ID = 99;
/** The installation credential the fixture issues (built, not a literal, so secret scanners do not mistake a fixture for a leak). */
export const FIXTURE_TOKEN = ["fixture", "installation", "credential"].join("-");
export const FIXTURE_APP_BOT: FixtureUser = { id: 777001, login: "sta-approvals[bot]", type: "Bot" };

let sharedKeys: { privateKey: KeyObject; publicKey: KeyObject } | null = null;
/** One RSA key pair per test process — generating 2048-bit keys per test is slow. */
export function fixtureAppKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  sharedKeys ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return sharedKeys;
}

export class GithubFixture {
  readonly owner: string;
  readonly repo: string;
  installed = true;
  readonly issues = new Map<number, FixtureIssue>();
  readonly comments: FixtureComment[] = [];
  readonly calls: FixtureCall[] = [];
  /** Every URL the channel asked for that is not under api.github.com. Must stay empty. */
  readonly foreignCalls: string[] = [];
  /** Role names returned by GitHub's collaborator-permission endpoint. */
  readonly repositoryRoles = new Map<number, string>();
  /** Override the identity in the permission response to test login/id binding. */
  readonly permissionIdentity = new Map<number, FixtureUser>();
  /** Makes the next matching call fail: an HTTP status, a thrown transport error, or a non-JSON body. */
  failures: Array<{ match: RegExp; status?: number; throws?: Error; notJson?: boolean; once?: boolean }> = [];
  private nextIssue = 1;
  private nextComment = 5000;
  private readonly publicKey: KeyObject;

  constructor(opts: { owner?: string; repo?: string; publicKey?: KeyObject } = {}) {
    this.owner = opts.owner ?? "acme";
    this.repo = opts.repo ?? "approvals";
    this.publicKey = opts.publicKey ?? fixtureAppKeys().publicKey;
  }

  /** A person (or a bot) posting a comment on an issue, as GitHub would record it. */
  comment(issue: number, body: string, user: FixtureUser | null, at: string, extra: Partial<FixtureComment> = {}): FixtureComment {
    const comment: FixtureComment = { id: this.nextComment++, issue, body, user, created_at: at, updated_at: at, ...extra };
    this.comments.push(comment);
    return comment;
  }

  readonly transport: GithubTransport = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, authorization: headers.get("authorization"), body });
    if (!url.startsWith(`${GITHUB_API_BASE}/`)) {
      this.foreignCalls.push(url);
      throw new TypeError(`fixture: ${url} is not api.github.com`);
    }
    const failure = this.failures.find((f) => f.match.test(`${method} ${url}`));
    if (failure) {
      if (failure.once) this.failures = this.failures.filter((f) => f !== failure);
      if (failure.throws) throw failure.throws;
      if (failure.notJson) return new Response("<html>oops</html>", { status: 200 });
      return json({ message: "fixture failure" }, failure.status ?? 500);
    }
    const parsed = new URL(url);
    return this.route(method, parsed, headers.get("authorization"), body);
  };

  private route(method: string, url: URL, authorization: string | null, body: any): Response {
    const repoPath = `/repos/${this.owner}/${this.repo}`;
    const p = url.pathname;
    if (method === "GET" && p === `${repoPath}/installation`) {
      if (!this.jwtValid(authorization)) return json({ message: "Bad credentials" }, 401);
      return this.installed ? json({ id: FIXTURE_INSTALLATION_ID }) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`) {
      if (!this.jwtValid(authorization)) return json({ message: "Bad credentials" }, 401);
      if (!this.installed) return json({ message: "Not Found" }, 404);
      return json({ token: FIXTURE_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    // Uninstalling the App revokes every installation token it was issued.
    if (authorization !== `Bearer ${FIXTURE_TOKEN}` || !this.installed) return json({ message: "Bad credentials" }, 401);
    const permissionMatch = new RegExp(`^${repoPath}/collaborators/([^/]+)/permission$`).exec(p);
    if (method === "GET" && permissionMatch) {
      const login = decodeURIComponent(permissionMatch[1]!);
      const user = this.comments.map((comment) => comment.user).find((author) => author?.login.toLowerCase() === login.toLowerCase());
      if (!user) return json({ message: "Not Found" }, 404);
      const role = this.repositoryRoles.get(user.id) ?? "admin";
      const responseUser = this.permissionIdentity.get(user.id) ?? user;
      return json({ permission: role === "maintain" ? "write" : role, role_name: role, user: responseUser });
    }
    if (method === "POST" && p === `${repoPath}/issues`) {
      const issue: FixtureIssue = { number: this.nextIssue++, title: body.title, body: body.body, state: "open", state_reason: null };
      this.issues.set(issue.number, issue);
      return json({ number: issue.number, html_url: `https://github.com/${this.owner}/${this.repo}/issues/${issue.number}` }, 201);
    }
    const issueMatch = new RegExp(`^${repoPath}/issues/(\\d+)(/comments)?$`).exec(p);
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      const issue = this.issues.get(number);
      if (!issue) return json({ message: "Not Found" }, 404);
      if (!issueMatch[2]) {
        if (method === "GET") return json(issue);
        if (method === "PATCH") {
          issue.state = body.state ?? issue.state;
          issue.state_reason = body.state_reason ?? issue.state_reason;
          return json(issue);
        }
      } else {
        if (method === "GET") {
          const perPage = Number(url.searchParams.get("per_page") ?? 30);
          const page = Number(url.searchParams.get("page") ?? 1);
          const all = this.comments.filter((c) => c.issue === number).map((c) => this.render(c));
          return json(all.slice((page - 1) * perPage, page * perPage));
        }
        if (method === "POST") {
          const now = new Date().toISOString();
          return json(this.render(this.comment(number, body.body, FIXTURE_APP_BOT, now)), 201);
        }
      }
    }
    return json({ message: `fixture: no route for ${method} ${p}` }, 404);
  }

  private render(c: FixtureComment) {
    return {
      id: c.id,
      body: c.body,
      user: c.user,
      created_at: c.created_at,
      updated_at: c.updated_at,
      issue_url: c.issue_url ?? `${GITHUB_API_BASE}/repos/${this.owner}/${this.repo}/issues/${c.issue}`,
      html_url: `https://github.com/${this.owner}/${this.repo}/issues/${c.issue}#issuecomment-${c.id}`,
      author_association: "OWNER",
    };
  }

  /** RS256 over `header.payload` with the App's public key, `iss` = the App id, and a live window. */
  private jwtValid(authorization: string | null): boolean {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!token) return false;
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return false;
    const ok = verify("sha256", Buffer.from(`${header}.${payload}`), this.publicKey, Buffer.from(signature, "base64url"));
    if (!ok) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: number | string; iat?: number; exp?: number };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === FIXTURE_APP_ID && typeof claims.exp === "number" && claims.exp > now && claims.exp - (claims.iat ?? 0) <= 600;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
