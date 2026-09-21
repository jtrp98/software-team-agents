import { describe, expect, it } from "vitest";
import { canonicalRepositoryCoordinate, RepositoryCoordinateError } from "./repositoryIdentity.js";

/**
 * The canonical repository coordinate (DT §2.3/§6): one pure function every
 * ownership layer will import, so a repository registered through HTTPS,
 * `ssh://`, an SCP-like remote or a declared SSH host alias always lands on
 * the same machine-comparable key. Transport, SSH username, default ports,
 * separator style and the terminal `.git` are access details, never identity.
 */

describe("canonicalRepositoryCoordinate — the DT §2.3 table", () => {
  it.each([
    ["https://github.com/Acme/App.git", undefined, "github.com/acme/app"],
    ["ssh://git@github.com/Acme/App.git", undefined, "github.com/acme/app"],
    ["git@github.com:Acme/App.git", undefined, "github.com/acme/app"],
    ["git@github-work:Acme/App.git", { "github-work": "github.com" }, "github.com/acme/app"],
    ["https://gitlab.com/Acme/App.git", undefined, "gitlab.com/acme/app"],
    ["https://github.com/ForkOwner/App.git", undefined, "github.com/forkowner/app"],
  ])("canonicalizes %s", (remote, aliases, expected) => {
    expect(canonicalRepositoryCoordinate(remote, aliases)).toBe(expected);
  });

  it("yields one coordinate for the HTTPS, ssh:// and SCP-like forms of the same repository", () => {
    const https = canonicalRepositoryCoordinate("https://github.com/acme/api.git");
    const sshUrl = canonicalRepositoryCoordinate("ssh://git@github.com/acme/api");
    const scp = canonicalRepositoryCoordinate("git@github.com:acme/api.git");
    expect(https).toBe(sshUrl);
    expect(https).toBe(scp);
  });

  it("ignores the SSH username — it is an access identity, not a repository identity", () => {
    expect(canonicalRepositoryCoordinate("ssh://ubuntu@github.com/acme/api.git")).toBe(
      canonicalRepositoryCoordinate("ssh://git@github.com/acme/api.git"),
    );
  });

  it.each([
    ["https://github.com:443/acme/api.git", "github.com/acme/api"],
    ["ssh://git@github.com:22/acme/api.git", "github.com/acme/api"],
    ["http://github.com:80/acme/api.git", "github.com/acme/api"],
    ["ssh://git@github.com:2222/acme/api.git", "github.com:2222/acme/api"],
    ["https://github.com:8443/acme/api.git", "github.com:8443/acme/api"],
  ])("keeps a non-default port and strips the default one: %s -> %s", (remote, expected) => {
    expect(canonicalRepositoryCoordinate(remote)).toBe(expected);
  });

  it("lowercases host and path so case-only spellings collapse into one coordinate", () => {
    expect(canonicalRepositoryCoordinate("https://GitHub.COM/Acme/App.GIT")).toBe("github.com/acme/app");
    expect(canonicalRepositoryCoordinate("https://github.com/acme/app/")).toBe("github.com/acme/app");
    expect(canonicalRepositoryCoordinate("https://github.com/Acme\\App.git")).toBe("github.com/acme/app");
  });

  it("resolves a declared alias for a dotless host without consulting anything machine-global", () => {
    expect(
      canonicalRepositoryCoordinate("git@github-work:acme/api.git", { "github-work": "github.com" }),
    ).toBe("github.com/acme/api");
  });

  it("keeps a fork at a different owner/path a distinct coordinate", () => {
    expect(canonicalRepositoryCoordinate("https://github.com/ForkOwner/api.git")).not.toBe(
      canonicalRepositoryCoordinate("https://github.com/acme/api.git"),
    );
  });
});

describe("canonicalRepositoryCoordinate — refuses fail-closed (DT §6)", () => {
  it.each([
    "",
    "   ",
    "file:///srv/git/repo.git",
    "/srv/git/repo.git",
    "C:\\src\\repo",
    "../relative/repo.git",
    "github.com/acme/api.git",
    "git://github.com/acme/api.git",
    "https://user:pass@github.com/acme/api.git",
    "https://token@github.com/acme/api.git",
    "ssh://git:secret@github.com/acme/api.git",
    "https://github.com/acme/api?token=x",
    "https://github.com/acme/api#readme",
    "https://github.com/acme/../api.git",
    "ssh://git@github.com/acme/./x",
    "git@github.com:acme/api.git:x",
    "ssh://git@[2001:db8::1]/acme/api.git",
    "https://github.com",
  ])("refuses %s", (remote) => {
    expect(() => canonicalRepositoryCoordinate(remote)).toThrow(RepositoryCoordinateError);
  });

  it("refuses an SSH host alias that has no machine-local mapping instead of guessing", () => {
    expect(() => canonicalRepositoryCoordinate("git@github-work:acme/api.git")).toThrow(/github-work/);
    expect(() => canonicalRepositoryCoordinate("git@github-work:acme/api.git")).toThrow(RepositoryCoordinateError);
  });

  it("refuses an alias mapping that points at another dotless alias instead of a canonical host", () => {
    expect(() => canonicalRepositoryCoordinate("git@a:acme/api.git", { a: "b" })).toThrow(/canonical dotted host/);
    expect(() => canonicalRepositoryCoordinate("git@a:acme/api.git", { a: "  " })).toThrow(RepositoryCoordinateError);
  });

  it("never reads ~/.ssh/config or the network — the mapping argument is the only alias source", () => {
    // A mapping unrelated to the host leaves a canonical dotted host untouched:
    expect(canonicalRepositoryCoordinate("git@github.com:acme/api.git", { elsewhere: "example.com" })).toBe(
      "github.com/acme/api",
    );
  });
});
