/**
 * The canonical repository coordinate (DT §2.3): one pure function that turns
 * a Git remote into the machine-comparable endpoint identity
 * `host[:non-default-port]/path`. Register, preflight and doctor must all
 * import this helper — a copied normalization would let one repository
 * register twice under different spellings.
 *
 * Parse first, normalize second: scheme/transport, the SSH username, default
 * ports, separator style and the terminal `.git` are transport/access
 * details, never repository identity. An SSH host alias is never guessed —
 * no ~/.ssh/config, Git include or DNS lookup happens here — a dotless host
 * is refused unless the machine declares its canonical host through the
 * `machineAliases` mapping (targets.local.yaml `remote_host_aliases`).
 * Path comparison is conservative lowercase, so two repositories that differ
 * only by case cannot both register on one machine.
 */

export type RemoteHostAliases = Readonly<Record<string, string>>;

export class RepositoryCoordinateError extends Error {}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443", ssh: "22" };

function refuse(remoteUrl: string, reason: string): never {
  throw new RepositoryCoordinateError(`cannot canonicalize remote "${remoteUrl}": ${reason}`);
}

function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

function canonicalHost(host: string, aliases: RemoteHostAliases | undefined, remoteUrl: string): string {
  const lowered = host.toLowerCase();
  if (!lowered) refuse(remoteUrl, "the remote has no host");
  if (lowered.includes("[")) refuse(remoteUrl, `host "${host}" is a bracketed IPv6 literal; the coordinate grammar does not define it`);
  const mapped = aliases?.[lowered];
  if (mapped !== undefined) {
    const canonical = mapped.trim().toLowerCase();
    if (!canonical || !canonical.includes(".") || canonical.includes("[") || /[:/@]/.test(canonical)) {
      refuse(remoteUrl, `the machine-local alias "${lowered}" maps to "${mapped}", which is not a canonical dotted host`);
    }
    return canonical;
  }
  // A dotless host is an SSH alias (github-work, gitserver): its resolution
  // depends on this machine, so an unmapped one would make the coordinate
  // ambiguous — refuse fail-closed rather than guess.
  if (!lowered.includes(".")) {
    refuse(remoteUrl, `host "${lowered}" has no machine-local canonical-host mapping; declare the alias or use a canonical remote_url`);
  }
  return lowered;
}

function canonicalRepositoryPath(rawPath: string, remoteUrl: string): string {
  const segments = rawPath.replace(/\\/g, "/").split("/");
  for (const segment of segments) {
    if (isDotSegment(segment)) refuse(remoteUrl, `the path contains the dot segment "${segment}"`);
  }
  const meaningful = segments.filter((segment) => segment.length > 0);
  if (meaningful.length === 0) refuse(remoteUrl, "the remote does not name a repository path");
  if (meaningful[meaningful.length - 1]!.toLowerCase() === ".git") refuse(remoteUrl, "the path ends at a bare .git entry");
  return meaningful.join("/").toLowerCase().replace(/\.git$/, "");
}

/** The raw path portion of a URL-form remote, taken from the input rather
 * than the parsed URL: WHATWG parsing resolves `.`/`..` segments silently,
 * and they must be refused, not resolved. */
function rawUrlPath(trimmed: string): string {
  const rest = trimmed.slice(trimmed.indexOf("://") + 3);
  const authorityEnd = rest.search(/[/?#]/);
  return authorityEnd === -1 ? "" : rest.slice(authorityEnd);
}

export function canonicalRepositoryCoordinate(remoteUrl: string, machineAliases?: RemoteHostAliases): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) refuse(remoteUrl, "the remote is empty");

  const scpLike = /^([A-Za-z0-9._~-]+)@([^@:/\\[\]]+):(.+)$/.exec(trimmed);
  if (scpLike) {
    const host = scpLike[2] as string;
    const rawPath = scpLike[3] as string;
    if (rawPath.includes(":")) refuse(trimmed, "the SCP-like path contains a colon; the form is ambiguous");
    if (/[?#]/.test(rawPath)) refuse(trimmed, "the remote carries a query or fragment");
    return `${canonicalHost(host, machineAliases, trimmed)}/${canonicalRepositoryPath(rawPath, trimmed)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    refuse(trimmed, "it is neither an http(s)/ssh URL nor an SCP-like git remote");
  }
  const transport = parsed.protocol.replace(/:$/, "");
  if (!(transport in DEFAULT_PORTS)) refuse(trimmed, `transport "${transport}" is not supported — only http(s), ssh:// and SCP-like remotes are`);
  if (parsed.password || (transport !== "ssh" && parsed.username)) refuse(trimmed, "the URL carries credentials");
  if (parsed.search) refuse(trimmed, "the URL carries a query");
  if (parsed.hash) refuse(trimmed, "the URL carries a fragment");
  for (const segment of rawUrlPath(trimmed).split(/[/?#\\]/)) {
    if (isDotSegment(segment)) refuse(trimmed, `the path contains the dot segment "${segment}"`);
  }
  const port = parsed.port && parsed.port !== DEFAULT_PORTS[transport] ? `:${parsed.port}` : "";
  return `${canonicalHost(parsed.hostname, machineAliases, trimmed)}${port}/${canonicalRepositoryPath(parsed.pathname, trimmed)}`;
}
