#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");

// TypeScript does not remove outputs for source files that were deleted. A
// release build must start from an empty, package-local outDir or retired code
// can survive in the shipped tarball indefinitely.
if (path.dirname(distRoot) !== packageRoot || path.basename(distRoot) !== "dist") {
  throw new Error(`refusing to clean unexpected output directory: ${distRoot}`);
}

fs.rmSync(distRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
