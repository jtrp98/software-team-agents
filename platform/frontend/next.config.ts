import path from "node:path";
import type { NextConfig } from "next";

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:5000";

const nextConfig: NextConfig = {
  // This frontend lives inside the STA monorepo; pin the workspace root so
  // Turbopack does not guess from the repo-root lockfile.
  turbopack: {
    root: path.join(import.meta.dirname ?? "."),
  },
  // Same-origin proxy: the browser talks to Next, Next talks to the .NET backend.
  // Cookies stay first-party — no CORS and no third-party cookie problems.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
