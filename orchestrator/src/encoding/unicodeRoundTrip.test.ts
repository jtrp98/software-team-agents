import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("Unicode, Thai, and Emoji round-trip encoding integrity", () => {
  const SAMPLE_THAI = "ภาษาไทย ทดสอบ UTF-8 ข้อความภาษาไทยต้องไม่เสีย";
  const SAMPLE_PUNCTUATION = "— – “Hello” ‘World’ … · § ∩ ✓ ✗";
  const SAMPLE_EMOJI = "✅ ❌ ⚠️ ⛔ ⏸️ 🚫 ⏳ 🔄 📌 🔒 🚧";
  const COMPOSITE_SAMPLE = [
    "# Unicode Integrity Test Document",
    "",
    `## Thai Text: ${SAMPLE_THAI}`,
    `## Punctuation: ${SAMPLE_PUNCTUATION}`,
    `## Emojis: ${SAMPLE_EMOJI}`,
    "",
    "STATUS_EMOJI mapping:",
    '  DEPLOYED: "✅"',
    '  RUNNING: "🔄"',
    '  WAITING: "⏳"',
    '  BLOCKED: "❌"',
    '  PAUSED: "⏸️"',
    '  CANCELLED: "🚫"',
  ].join("\n");

  const MOJIBAKE_DETECTORS = [
    /\uFFFD/,
    /ðŸ/,
    /โ€”/,
    /โ€“/,
    /เน€เธ/,
    /เธขเธ/,
    /โ Œ/,
    /โ ธ๏ธ /,
    /๐Ÿšซ/,
  ];

  it("round-trips Thai, emoji, and smart punctuation identically via UTF-8", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-unicode-test-"));
    const filePath = path.join(tmpDir, "sample-utf8.txt");

    try {
      // 1. Write explicitly as UTF-8
      fs.writeFileSync(filePath, COMPOSITE_SAMPLE, "utf8");

      // 2. Read back as raw buffer and as UTF-8 string
      const rawBytes = fs.readFileSync(filePath);
      const readBack = rawBytes.toString("utf8");

      // 3. String and byte equality
      expect(readBack).toBe(COMPOSITE_SAMPLE);
      expect(Buffer.compare(rawBytes, Buffer.from(COMPOSITE_SAMPLE, "utf8"))).toBe(0);

      // 4. Assert no UTF-8 BOM was prepended
      expect(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf).toBe(false);

      // 5. Assert zero mojibake indicators
      for (const detector of MOJIBAKE_DETECTORS) {
        expect(detector.test(readBack)).toBe(false);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects and flags CP874 / Windows-1252 transcoding corruption", () => {
    // Prove the detector catches the exact mojibake pattern
    const corruptedStatus = 'BLOCKED: "โ Œ", PAUSED: "โ ธ๏ธ ", CANCELLED: "๐Ÿšซ"';
    const corruptedThai = "เน€เธŸเธช 01 — เน€เธขเธ—";

    expect(MOJIBAKE_DETECTORS.some((re) => re.test(corruptedStatus))).toBe(true);
    expect(MOJIBAKE_DETECTORS.some((re) => re.test(corruptedThai))).toBe(true);
  });
});