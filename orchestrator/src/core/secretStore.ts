import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { corePaths } from "./corePaths.js";

/**
 * User-level secret storage for the Intent API key.
 *
 * Where the key may live: the Core home's `secrets/` directory (machine-local,
 * outside every repository), protected on Windows with DPAPI under the
 * current user (`ConvertFrom-SecureString`), so the file is useless to another
 * account or machine. Elsewhere it is a 0600 file. An environment variable
 * (`STA_INTENT_API_KEY`) may supply it instead and is never written anywhere.
 *
 * Where it never goes: a repository, run state, logs, the overlay, the Web
 * bundle, an API response, a URL. The secret crosses into PowerShell on stdin,
 * never argv, so it does not appear in a process listing.
 */

export type SecretSource = "dpapi" | "file" | "env" | "none";

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
}

export interface SecretProtector {
  readonly kind: "dpapi" | "file";
  protect(plain: string): string;
  unprotect(stored: string): string;
}

const ENV_KEY = "STA_INTENT_API_KEY";

function runPowerShell(script: string, input: string): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) throw new Error(`DPAPI helper failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`DPAPI helper failed (exit ${result.status}): ${(result.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
  return (result.stdout ?? "").trim();
}

/** Windows DPAPI (CurrentUser scope) through PowerShell's SecureString cmdlets. */
export const DPAPI_PROTECTOR: SecretProtector = {
  kind: "dpapi",
  protect(plain) {
    return runPowerShell("$s = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString", plain);
  },
  unprotect(stored) {
    return runPowerShell(
      "$e = [Console]::In.ReadToEnd().Trim(); $ss = ConvertTo-SecureString -String $e; " +
        "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); " +
        "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
      stored,
    );
  },
};

/** Non-Windows: a 0600 file in the Core home. Honest about what it is: file-permission protection, not encryption. */
export const FILE_PROTECTOR: SecretProtector = {
  kind: "file",
  protect: (plain) => plain,
  unprotect: (stored) => stored,
};

export function defaultProtector(): SecretProtector {
  return process.platform === "win32" ? DPAPI_PROTECTOR : FILE_PROTECTOR;
}

export class SecretStore {
  constructor(
    private readonly dir = corePaths().secretsDir,
    private readonly protector: SecretProtector = defaultProtector(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private file(name: string): string {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid secret name ${name}`);
    return path.join(this.dir, `${name}.${this.protector.kind === "dpapi" ? "dpapi" : "secret"}`);
  }

  set(name: string, value: string): SecretStatus {
    const trimmed = value.trim();
    if (trimmed.length < 8 || /\s/.test(trimmed)) throw new Error("the API key looks malformed (too short or contains whitespace)");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this.protector.protect(trimmed), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs govern */ }
    return { configured: true, source: this.protector.kind };
  }

  get(name: string): string | undefined {
    if (name === "intent-api-key" && this.env[ENV_KEY]?.trim()) return this.env[ENV_KEY]!.trim();
    const file = this.file(name);
    if (!fs.existsSync(file)) return undefined;
    return this.protector.unprotect(fs.readFileSync(file, "utf8"));
  }

  status(name: string): SecretStatus {
    if (name === "intent-api-key" && this.env[ENV_KEY]?.trim()) return { configured: true, source: "env" };
    return fs.existsSync(this.file(name)) ? { configured: true, source: this.protector.kind } : { configured: false, source: "none" };
  }

  delete(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }
}
