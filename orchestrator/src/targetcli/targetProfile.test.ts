import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Of } from "../packaging/templateManifest.js";
import { detectTargetProfileEvidence } from "./targetProfile.js";

const roots: string[] = [];
function target(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-target-profile-"));
  roots.push(root);
  return root;
}
function write(root: string, relative: string, content = "\n"): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function treeHash(root: string): string {
  const rows: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        rows.push(`${relative}/${entry.name}:symlink`);
        continue;
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, child);
      else rows.push(`${child}:${sha256Of(fs.readFileSync(absolute))}`);
    }
  };
  walk(root, "");
  return sha256Of(rows.sort().join("\n"));
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("deterministic Target profile evidence (T-V3-03)", () => {
  it.each([
    ["dotnet sln", "Acme.sln", "dotnet"],
    ["dotnet project", "Acme.csproj", "dotnet"],
    ["dotnet props", "Directory.Build.props", "dotnet"],
    ["java maven", "pom.xml", "java"],
    ["java gradle", "build.gradle", "java"],
    ["java gradle kts", "build.gradle.kts", "java"],
    ["python pyproject", "pyproject.toml", "python"],
    ["python requirements", "requirements.txt", "python"],
    ["python setup", "setup.py", "python"],
  ])("classifies %s evidence", (_name, marker, expected) => {
    const root = target();
    write(root, marker);
    expect(detectTargetProfileEvidence(root).candidates).toEqual([expected]);
  });

  it("requires a real lockfile for Node and derives frontend deterministically from declared dependencies", () => {
    const root = target();
    write(root, "package.json", JSON.stringify({ dependencies: { react: "1" } }));
    expect(detectTargetProfileEvidence(root).candidates).toEqual([]);
    write(root, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    expect(detectTargetProfileEvidence(root).candidates).toEqual(["frontend"]);
  });

  it("reports mixed families as candidates and Go/Rust as unsupported rather than Node", () => {
    const root = target();
    write(root, "package.json", "{}\n");
    write(root, "package-lock.json", "{}\n");
    write(root, "App.csproj");
    write(root, "go.mod", "module acme\n");
    write(root, "Cargo.toml", "[package]\nname='acme'\n");
    const evidence = detectTargetProfileEvidence(root);
    expect(evidence.candidates).toEqual(["dotnet", "node"]);
    expect(evidence.unsupported).toEqual(["go", "rust"]);
  });

  it("orders every detected family by the declared evidence precedence", () => {
    const root = target();
    write(root, "package.json", "{}\n");
    write(root, "yarn.lock", "v1\n");
    write(root, "requirements.txt", "pytest\n");
    write(root, "pom.xml", "<project/>\n");
    write(root, "App.csproj");
    expect(detectTargetProfileEvidence(root).candidates).toEqual(["dotnet", "java", "python", "node"]);
  });

  it("walks only root and one level down, prunes skip dirs, never follows symlinks, and writes zero bytes", () => {
    const root = target();
    const outside = target();
    write(root, "ClassOnlineWeb/App.csproj");
    write(root, "too/deep/App.csproj");
    write(root, "node_modules/Hidden.csproj");
    write(outside, "Outside.csproj");
    fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    const before = treeHash(root);
    const evidence = detectTargetProfileEvidence(root);
    expect(evidence.evidenceFiles).toEqual(["ClassOnlineWeb/App.csproj"]);
    expect(evidence.sourceRootsByProfile.dotnet).toEqual(["ClassOnlineWeb"]);
    expect(treeHash(root)).toBe(before);
  });

  it("keeps fingerprints stable for an unchanged tree and changes them for lockfile or script edits", () => {
    const root = target();
    write(root, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    write(root, "bun.lock", "v1\n");
    const first = detectTargetProfileEvidence(root).fingerprint;
    expect(detectTargetProfileEvidence(root).fingerprint).toBe(first);
    write(root, "bun.lock", "v2\n");
    const lockChanged = detectTargetProfileEvidence(root).fingerprint;
    expect(lockChanged).not.toBe(first);
    write(root, "package.json", JSON.stringify({ scripts: { build: "tsc --build" } }));
    expect(detectTargetProfileEvidence(root).fingerprint).not.toBe(lockChanged);
  });
});
