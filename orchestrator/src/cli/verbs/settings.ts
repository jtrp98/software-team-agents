import * as fs from "node:fs";
import { CliUsageError } from "../../cli.js";
import { corePaths } from "../../core/corePaths.js";
import { loadMachineConfig } from "../../core/machineConfig.js";
import { SecretStore } from "../../core/secretStore.js";

/**
 * `sta settings` — machine-level configuration, home of what the retired STA
 * Web UI used to edit. `machine.yaml` stays the source of truth: this verb
 * shows its path and content and hands over for edits (the next load
 * validates). The Intent provider key goes through the machine-local secret
 * store — never a repo, a log, or another user's eyes.
 *
 *   sta settings                       show machine.yaml (path + content)
 *   sta settings intent-key            show whether an Intent API key is stored
 *   sta settings intent-key <key>      store the Intent provider key
 *   sta settings intent-key --clear    remove the stored key
 */

export const SETTINGS_USAGE =
  "sta settings                                show machine.yaml (path + content; edit the file, the next load validates)\n" +
  "sta settings intent-key                     show whether an Intent API key is stored\n" +
  "sta settings intent-key <api-key>           store the Intent provider key (machine-local secret store)\n" +
  "sta settings intent-key --clear             remove the stored key";

export async function runSettingsVerb(rest: string[]): Promise<number> {
  const paths = corePaths();
  const th = loadMachineConfig().language === "th";

  if (rest[0] === undefined) {
    console.log(`${th ? "ไฟล์ machine config" : "machine config"}: ${paths.machineConfig}`);
    if (fs.existsSync(paths.machineConfig)) {
      console.log(fs.readFileSync(paths.machineConfig, "utf8").trimEnd());
    } else {
      console.log(th ? "(ยังไม่มีไฟล์ — ใช้ค่า default ทั้งหมด · แก้ค่าผ่าน sta setup-machine หรือสร้างไฟล์นี้)" : "(no file yet — all defaults apply · change values via sta setup-machine or create this file)");
    }
    return 0;
  }

  if (rest[0] === "intent-key") {
    const clear = rest.includes("--clear");
    const value = rest.slice(1).find((argument) => !argument.startsWith("--"));
    const secrets = new SecretStore(paths.secretsDir);
    if (clear) {
      secrets.delete("intent-api-key");
      console.log(JSON.stringify(secrets.status("intent-api-key")));
      return 0;
    }
    if (value === undefined) {
      console.log(JSON.stringify(secrets.status("intent-api-key")));
      return 0;
    }
    console.log(JSON.stringify(secrets.set("intent-api-key", value)));
    return 0;
  }

  throw new CliUsageError(`settings: unknown usage\n${SETTINGS_USAGE}`);
}
