import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Of } from "../packaging/templateManifest.js";
import { loadStackProfile, type StackProfile } from "../profile/projectProfile.js";
import type { TargetStackConfig } from "./targetMeta.js";

export const TARGET_PROFILE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".workflow", ".next", "build"]);

const LOCKFILES = [
  { name: "bun.lock", manager: "bun" },
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "package-lock.json", manager: "npm" },
] as const;

type ProfileName = "dotnet" | "java" | "python" | "node" | "frontend";
type ProfileFamily = "dotnet" | "java" | "python" | "node";
export const TARGET_PROFILE_PRECEDENCE: readonly ProfileName[] = ["dotnet", "java", "python", "node", "frontend"];

interface EvidenceFile {
  path: string;
  absolutePath: string;
  profile?: ProfileName;
  unsupported?: "go" | "rust";
}

export interface TargetProfileEvidence {
  candidates: ProfileName[];
  unsupported: ("go" | "rust")[];
  evidenceFiles: string[];
  fingerprint: string;
  sourceRootsByProfile: Partial<Record<ProfileName, string[]>>;
}

export interface TargetProfilePlan {
  stack: TargetStackConfig;
  changed: boolean;
  humanEdited: boolean;
  mismatch?: string;
}

export class TargetProfileError extends Error {}
export class TargetProfileAmbiguousError extends TargetProfileError {}
export class TargetProfileUnresolvedError extends TargetProfileError {}
export class TargetProfileFamilyChangeError extends TargetProfileError {}

function profileFamily(profile: string): ProfileFamily | string {
  return profile === "frontend" ? "node" : profile;
}

function rootLabel(relativePath: string): string {
  const directory = path.posix.dirname(relativePath);
  return directory === "." ? "." : directory.split("/")[0]!;
}

function classifyPackageJson(file: string): "node" | "frontend" {
  let body: unknown;
  try {
    body = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new TargetProfileError(`cannot read package.json for deterministic stack detection: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = body as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  const dependencies = new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]);
  return ["next", "react", "vue", "@angular/core", "svelte", "vite"].some((name) => dependencies.has(name))
    ? "frontend"
    : "node";
}

function directEvidence(targetRoot: string): EvidenceFile[] {
  const directories: { absolute: string; relative: string }[] = [{ absolute: targetRoot, relative: "" }];
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || TARGET_PROFILE_SKIP_DIRS.has(entry.name)) continue;
    directories.push({ absolute: path.join(targetRoot, entry.name), relative: entry.name });
  }

  const evidence: EvidenceFile[] = [];
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory.absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      const file: EvidenceFile = { path: relative, absolutePath: path.join(directory.absolute, entry.name) };
      if (entry.name.endsWith(".sln") || entry.name.endsWith(".csproj") || entry.name === "Directory.Build.props") file.profile = "dotnet";
      else if (["pom.xml", "build.gradle", "build.gradle.kts"].includes(entry.name)) file.profile = "java";
      else if (["pyproject.toml", "requirements.txt", "setup.py"].includes(entry.name)) file.profile = "python";
      else if (entry.name === "go.mod") file.unsupported = "go";
      else if (entry.name === "Cargo.toml") file.unsupported = "rust";
      else if (entry.name === "package.json") file.profile = classifyPackageJson(file.absolutePath);
      else if (!LOCKFILES.some((lock) => lock.name === entry.name)) continue;
      evidence.push(file);
    }
  }
  return evidence.sort((a, b) => a.path.localeCompare(b.path));
}

function packageEvidenceWithLock(evidence: EvidenceFile[]): EvidenceFile[] {
  const locksByDirectory = new Set(
    evidence
      .filter((item) => LOCKFILES.some((lock) => item.path.endsWith(lock.name)))
      .map((item) => path.posix.dirname(item.path)),
  );
  return evidence.filter((item) => {
    if (item.profile !== "node" && item.profile !== "frontend") return true;
    return locksByDirectory.has(path.posix.dirname(item.path));
  });
}

function fingerprintOf(evidence: readonly EvidenceFile[]): string {
  const bytes = evidence
    .map((item) => `${item.path}\0${fs.readFileSync(item.absolutePath).toString("base64")}`)
    .join("\0");
  return `sha256:${sha256Of(bytes)}`;
}

export function detectTargetProfileEvidence(targetRoot: string): TargetProfileEvidence {
  const evidence = packageEvidenceWithLock(directEvidence(path.resolve(targetRoot)));
  const detected = new Set(evidence.flatMap((item) => (item.profile ? [item.profile] : [])));
  const candidates = TARGET_PROFILE_PRECEDENCE.filter((profile) => detected.has(profile));
  const unsupported = [...new Set(evidence.flatMap((item) => (item.unsupported ? [item.unsupported] : [])))].sort() as ("go" | "rust")[];
  const sourceRootsByProfile: Partial<Record<ProfileName, string[]>> = {};
  for (const candidate of candidates) {
    sourceRootsByProfile[candidate] = [...new Set(evidence.filter((item) => item.profile === candidate).map((item) => rootLabel(item.path)))].sort();
  }
  return {
    candidates,
    unsupported,
    evidenceFiles: evidence.map((item) => item.path),
    fingerprint: fingerprintOf(evidence),
    sourceRootsByProfile,
  };
}

function packageManager(targetRoot: string, sourceRoot: string): string | undefined {
  const directory = sourceRoot === "." ? targetRoot : path.join(targetRoot, sourceRoot);
  for (const lock of LOCKFILES) if (fs.existsSync(path.join(directory, lock.name))) return lock.manager;
  return undefined;
}

function nodeCommands(
  targetRoot: string,
  sourceRoot: string,
  manager: string,
  defaults: StackProfile["commands"],
): StackProfile["commands"] {
  const packageFile = path.join(sourceRoot === "." ? targetRoot : path.join(targetRoot, sourceRoot), "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { scripts?: Record<string, string> };
  const commands = { ...defaults, install: `${manager} install` };
  for (const command of ["build", "test", "lint", "typecheck"] as const) {
    if (typeof parsed.scripts?.[command] === "string") commands[command] = `${manager} run ${command}`;
    else commands[command] = defaults[command].replace(/^npm(?=\s)/, manager);
  }
  return commands;
}

function schemaPaths(targetRoot: string): string[] {
  const found = new Set<string>();
  const walk = (directory: string, relative: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "migrations") found.add(childRelative);
        if (!TARGET_PROFILE_SKIP_DIRS.has(entry.name)) walk(absolute, childRelative);
      } else if (entry.isFile() && (entry.name === "schema.prisma" || entry.name.endsWith(".edmx"))) {
        found.add(childRelative);
      }
    }
  };
  walk(targetRoot, "");
  return [...found].sort();
}

function contentForHash(stack: TargetStackConfig): object {
  const { fingerprint: _fingerprint, detected_at: _detectedAt, generated_hash: _generatedHash, ...content } = stack as TargetStackConfig;
  return content;
}

export function targetStackContentHash(stack: TargetStackConfig): string {
  return `sha256:${sha256Of(JSON.stringify(contentForHash(stack)))}`;
}

export function targetStackWasHumanEdited(stack: TargetStackConfig): boolean {
  return stack.generated_hash === undefined || stack.generated_hash !== targetStackContentHash(stack);
}

function selectProfile(evidence: TargetProfileEvidence, explicitProfile?: string): ProfileName {
  if (explicitProfile) return explicitProfile as ProfileName;
  if (evidence.candidates.length > 1) {
    throw new TargetProfileAmbiguousError(
      `Target stack is ambiguous (${evidence.candidates.join(", ")}) — nothing was written; re-run init with --stack <name>`,
    );
  }
  if (evidence.candidates.length === 1) return evidence.candidates[0]!;
  if (evidence.unsupported.length > 0) {
    throw new TargetProfileUnresolvedError(
      `Target uses ${evidence.unsupported.join("/")}, but no shipped stack profile supports it — choose or add a profile, then re-run init --stack <name>`,
    );
  }
  throw new TargetProfileUnresolvedError(
    "Target stack could not be resolved from recognized project files — nothing was written; re-run init with --stack <name>",
  );
}

function renderResolvedStack(options: {
  targetRoot: string;
  templatesDir: string;
  evidence: TargetProfileEvidence;
  explicitProfile?: string;
  now: string;
}): TargetStackConfig {
  const selected = selectProfile(options.evidence, options.explicitProfile);
  let shipped: StackProfile;
  try {
    shipped = loadStackProfile(selected, options.templatesDir);
  } catch (error) {
    throw new TargetProfileUnresolvedError(error instanceof Error ? error.message : String(error));
  }
  const sourceRoots = options.evidence.sourceRootsByProfile[selected] ?? ["."];
  const sourceRoot = sourceRoots[0] ?? ".";
  const manager = selected === "node" || selected === "frontend"
    ? packageManager(options.targetRoot, sourceRoot) ?? shipped.package_manager
    : shipped.package_manager;
  const base: TargetStackConfig = {
    profile: selected,
    package_manager: manager,
    commands:
      selected === "node" || selected === "frontend"
        ? nodeCommands(options.targetRoot, sourceRoot, manager, shipped.commands)
        : shipped.commands,
    schema_paths: schemaPaths(options.targetRoot),
    source_roots: sourceRoots,
    detected_at: options.now,
    fingerprint: options.evidence.fingerprint,
  };
  return { ...base, generated_hash: targetStackContentHash(base) };
}

/** Pure reconciliation plan: reads evidence and shipped profiles, but never writes. */
export function planTargetProfile(options: {
  targetRoot: string;
  templatesDir: string;
  existing?: TargetStackConfig;
  explicitProfile?: string;
  now: string;
}): TargetProfilePlan {
  const evidence = detectTargetProfileEvidence(options.targetRoot);
  if (options.existing && !options.explicitProfile && options.existing.fingerprint === evidence.fingerprint) {
    return {
      stack: options.existing,
      changed: false,
      humanEdited: targetStackWasHumanEdited(options.existing),
      ...(targetStackWasHumanEdited(options.existing) ? { mismatch: "stack config differs from the last detected profile" } : {}),
    };
  }
  const resolved = renderResolvedStack({ ...options, evidence });
  if (options.existing && profileFamily(options.existing.profile) !== profileFamily(resolved.profile)) {
    throw new TargetProfileFamilyChangeError(
      `Target profile family changed from ${options.existing.profile} to ${resolved.profile} — STOP: review and re-resolve prompts and gates before any agent runs`,
    );
  }
  if (options.existing && targetStackWasHumanEdited(options.existing)) {
    return {
      stack: { ...options.existing, fingerprint: evidence.fingerprint },
      changed: options.existing.fingerprint !== evidence.fingerprint,
      humanEdited: true,
      mismatch: "stack config differs from deterministic detection; human-edited values were preserved",
    };
  }
  return { stack: resolved, changed: true, humanEdited: false };
}
