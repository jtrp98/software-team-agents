import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { sampleKnowledge } from "./sampleKnowledge.js";
import { writeKnowledgeItem } from "./knowledgeStore.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-get-"));
  roots.push(root);
  for (const item of sampleKnowledge()) {
    const amended = item.id === "DB-Shift"
      ? { ...item, title: "private schedule model", body: "secret shift schedule" }
      : item;
    writeKnowledgeItem(amended, root);
  }
  fs.writeFileSync(path.join(root, "knowledge-policy.yaml"), [
    "version: 1",
    "defaults:",
    "  sensitive: full",
    "  hide_fields: []",
    "roles:",
    "  backend-engineer: { sensitive: redacted }",
    "  frontend-engineer: { sensitive: redacted }",
    "  qa-engineer: { sensitive: redacted }",
    "  security: { sensitive: redacted }",
    "  devops: { sensitive: redacted }",
    "freshness:",
    "  default: { aging_after_days: 90, stale_after_days: 180 }",
    "  by_kind: {}",
    "",
  ].join("\n"), "utf8");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function captured(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    return { code: await run(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("knowledge get (T-V3TOK-080)", () => {
  it("renders only permitted fields in JSON and roles context --full", async () => {
    const root = fixtureRoot();
    const getText = await captured(() => runCli(["knowledge", "get", "DB-Shift", "--lane", "dev", "--project-root", root], root));
    const get = await captured(() => runCli(["knowledge", "get", "DB-Shift", "--lane", "dev", "--json", "--project-root", root], root));
    const fullText = await captured(() => runCli(["roles", "context", "dev", "DB-Shift", "--full", "--project-root", root], root));
    const full = await captured(() => runCli(["roles", "context", "dev", "DB-Shift", "--full", "--json", "--project-root", root], root));
    expect(getText.code).toBe(0);
    expect(get.code).toBe(0);
    expect(fullText.code).toBe(0);
    expect(full.code).toBe(0);
    for (const output of [getText.out, get.out, fullText.out, full.out]) {
      expect(output).not.toContain("secret shift schedule");
      expect(output).not.toContain("staff Staff");
      expect(output).toContain("body");
      expect(output).toContain("payload");
    }
    expect(get.out).toContain("withheld_fields");
    expect(full.out).toContain("withheld_fields");
    expect(getText.out).toContain("withheld:");
    expect(fullText.out).toContain("withheld:");
  });

  it("keeps not-found and withheld exit semantics distinct", async () => {
    const root = fixtureRoot();
    const withheld = await captured(() => runCli(["knowledge", "get", "BE-014", "--lane", "ba", "--project-root", root], root));
    const missing = await captured(() => runCli(["knowledge", "get", "REQ-999", "--lane", "ba", "--project-root", root], root));
    expect(withheld.code).toBe(0);
    expect(withheld.out).toContain("withheld");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no knowledge item with id REQ-999");
  });
});
