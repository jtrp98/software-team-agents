import * as fs from "node:fs";
import * as path from "node:path";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { workflowsDir } from "./workflowCatalog.js";

/**
 * Test-only: gives a temporary project the framework's generated
 * `workflows/*.yml`, the way `sta init` installs them from the templates.
 * Registering a task with its classification input compiles a
 * `workflow_plan` from `<projectRoot>/workflows` (V13 TASK-004), so a fixture
 * project that registers tasks needs the files a real project has.
 */
export function installFrameworkWorkflows(projectRoot: string): void {
  fs.cpSync(workflowsDir(defaultProjectRoot()), path.join(projectRoot, "workflows"), { recursive: true });
}
