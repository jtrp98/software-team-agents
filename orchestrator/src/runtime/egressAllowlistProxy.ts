import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * V13 TASK-031 — the only network path out of a network-disabled OS sandbox.
 *
 * `codex sandbox` on Windows enforces network all-or-nothing: `enabled=false`
 * blocks every outbound socket (EACCES) but still permits loopback, while
 * `enabled=true` opens everything — its profile `domains` allowlist is not
 * enforced by the sandbox subcommand (R14F probe). A wrapped runtime that must
 * reach its model API therefore runs with network OFF and gets this proxy:
 * a separate process (the adapter's own spawnSync would otherwise block its
 * event loop) listening on 127.0.0.1 that tunnels HTTP CONNECT only to an exact
 * `host:443` allowlist and answers 403 to everything else.
 *
 * Isolation never depends on this proxy: if it is absent or misbehaves, the OS
 * still blocks egress and the run simply fails to reach its API.
 */
const PROXY_SCRIPT = String.raw`'use strict';
const net = require('net');
const allowed = new Set(process.argv.slice(2).map((h) => h.toLowerCase() + ':443'));
const server = net.createServer((client) => {
  client.on('error', () => {});
  client.setTimeout(30000, () => client.destroy());
  client.once('data', (buf) => {
    client.setTimeout(0);
    const line = String(buf).split('\r\n')[0];
    const m = /^CONNECT ([A-Za-z0-9.-]+):(\d+) HTTP\/1\.[01]$/.exec(line);
    const target = m ? m[1].toLowerCase() + ':' + m[2] : null;
    if (!target || !allowed.has(target)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(443, m[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\n'));
process.on('disconnect', () => process.exit(0));
`;

export interface EgressAllowlistProxy {
  /** `http://127.0.0.1:<port>` — the value for HTTPS_PROXY/HTTP_PROXY. */
  readonly url: string;
  stop(): void;
}

export type StartEgressAllowlistProxy = (hosts: readonly string[], scratchDir: string) => Promise<EgressAllowlistProxy>;

const HOST_PATTERN = /^[a-z0-9.-]+$/;

/** Start the proxy as its own process; resolves once it reports its loopback port. */
export const startEgressAllowlistProxy: StartEgressAllowlistProxy = (hosts, scratchDir) =>
  new Promise((resolve, reject) => {
    for (const host of hosts) {
      if (!HOST_PATTERN.test(host)) {
        reject(new Error(`egress allowlist host ${JSON.stringify(host)} must be an exact lowercase hostname`));
        return;
      }
    }
    const script = path.join(scratchDir, "egress-proxy.cjs");
    fs.writeFileSync(script, PROXY_SCRIPT, "utf8");
    const child = spawn(process.execPath, [script, ...hosts], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const stop = () => {
      if (child.exitCode === null && !child.killed) child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error("egress proxy did not report a port within 10s"));
    }, 10_000);
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += String(chunk);
      const match = /PORT (\d+)/.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      resolve({ url: `http://127.0.0.1:${match[1]}`, stop });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`egress proxy exited early (code ${code ?? "null"})`));
    });
  });
