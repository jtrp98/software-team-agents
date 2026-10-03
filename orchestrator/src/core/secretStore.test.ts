import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DPAPI_PROTECTOR, FILE_PROTECTOR, SecretStore } from "./secretStore.js";

/** Obvious placeholders, not credentials. */
const PLACEHOLDER = ["changeme", "placeholder", "file"].join("-");
const ENV_PLACEHOLDER = ["changeme", "placeholder", "env"].join("-");
const DPAPI_PLACEHOLDER = ["changeme", "placeholder", "dpapi"].join("-");

describe("STA Core secret storage", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-secret-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stores and reads the key; status never reveals it", () => {
    const store = new SecretStore(dir, FILE_PROTECTOR, {});
    expect(store.status("intent-api-key")).toEqual({ configured: false, source: "none" });
    store.set("intent-api-key", PLACEHOLDER);
    expect(store.get("intent-api-key")).toBe(PLACEHOLDER);
    expect(JSON.stringify(store.status("intent-api-key"))).not.toContain("changeme");
    store.delete("intent-api-key");
    expect(store.get("intent-api-key")).toBeUndefined();
  });

  it("refuses a malformed key and an environment key wins without being written", () => {
    const store = new SecretStore(dir, FILE_PROTECTOR, { STA_INTENT_API_KEY: ENV_PLACEHOLDER });
    expect(() => store.set("intent-api-key", "short")).toThrow(/malformed/);
    expect(store.get("intent-api-key")).toBe(ENV_PLACEHOLDER);
    expect(store.status("intent-api-key").source).toBe("env");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("Windows: DPAPI protects the file (ciphertext on disk, plaintext only through the current user)", () => {
    const store = new SecretStore(dir, DPAPI_PROTECTOR, {});
    store.set("intent-api-key", DPAPI_PLACEHOLDER);
    const onDisk = fs.readFileSync(path.join(dir, "intent-api-key.dpapi"), "utf8");
    expect(onDisk).not.toContain("changeme");
    expect(store.get("intent-api-key")).toBe(DPAPI_PLACEHOLDER);
  }, 30_000);
});
