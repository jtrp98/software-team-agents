import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startEgressAllowlistProxy } from "./egressAllowlistProxy.js";

function connectLine(proxyUrl: string, request: string): Promise<string> {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => socket.write(request));
    socket.once("data", (data) => {
      resolve(String(data).split("\r\n")[0]!);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("TASK-031 egress allowlist proxy", () => {
  it("listens on loopback only and refuses every CONNECT outside the exact host:443 allowlist", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sta-egress-"));
    const proxy = await startEgressAllowlistProxy(["api.anthropic.com"], scratch);
    try {
      expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      for (const request of [
        "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n",
        "CONNECT api.anthropic.com:80 HTTP/1.1\r\n\r\n",
        "CONNECT api.anthropic.com.evil.example:443 HTTP/1.1\r\n\r\n",
        "GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n",
        "CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n",
      ]) {
        expect(await connectLine(proxy.url, request), request).toBe("HTTP/1.1 403 Forbidden");
      }
    } finally {
      proxy.stop();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an allowlist entry that is not an exact lowercase hostname", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sta-egress-"));
    try {
      await expect(startEgressAllowlistProxy(["*.anthropic.com"], scratch)).rejects.toThrow(/exact lowercase hostname/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
