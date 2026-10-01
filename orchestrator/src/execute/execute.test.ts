import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntimeAdapter, okResult } from "../runtime/mockAdapter.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import type { RuntimeAgentRequest, RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import { createSta, RUN_ID_ENV, RUN_STORE_ENV, type ExecuteRequest, type ExecuteResult, type Sta } from "./execute.js";
import { WritableTargetRequestError } from "../targetcli/roleWorkspace.js";

/**
 * The composition contract: controller → sta.execute() → executor → result →
 * controller, and nested execution as the same call again. Runtimes are mock
 * adapters named after the real runtime ids; what is under test is STA's run
 * model, not vendor availability.
 */

const RUNTIMES = ["claude-code", "codex", "antigravity", "zcode"] as const;
type Respond = (req: RuntimeAgentRequest, call: number) => RuntimeAgentResult | Promise<RuntimeAgentResult>;

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

interface Harness {
  sta: Sta;
  workspace: string;
  adapters: Record<string, MockRuntimeAdapter>;
  /** Replace what a runtime does when invoked. */
  on(runtime: string, respond: Respond): void;
}

function harness(opts: { capabilities?: Partial<Record<string, RuntimeCapability[]>> } = {}): Harness {
  const workspace = tmp("sta-exec-ws-");
  const behaviour = new Map<string, Respond>();
  const adapters: Record<string, MockRuntimeAdapter> = {};
  for (const id of RUNTIMES) {
    adapters[id] = new MockRuntimeAdapter({
      id,
      ...(opts.capabilities?.[id] ? { capabilities: opts.capabilities[id] } : {}),
      respond: (req, call) => (behaviour.get(id) ?? (() => okResult({ text: `${id} did it` })))(req, call),
    });
  }
  const sta = createSta({
    registry: new RuntimeRegistry(Object.values(adapters)),
    runStore: path.join(tmp("sta-exec-store-"), "runs"),
    env: {},
    cwd: workspace,
  });
  return { sta, workspace, adapters, on: (id, respond) => behaviour.set(id, respond) };
}

/** The run id STA handed the executor — what an in-process executor names as its children's parent. */
const runIdOf = (req: RuntimeAgentRequest): string => req.env![RUN_ID_ENV];

function expectStatus<S extends ExecuteResult["status"]>(result: ExecuteResult, status: S): Extract<ExecuteResult, { status: S }> {
  if (result.status !== status) throw new Error(`expected ${status}, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
  return result as Extract<ExecuteResult, { status: S }>;
}

describe("sta.execute — controller → STA → executor", () => {
  it("1. Desktop controller → STA → CLI executor → result returns to the caller", async () => {
    const h = harness();
    h.on("claude-code", () => okResult({ text: "implemented" }));

    const result = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "rename the helper" }), "completed");

    expect(result.output).toBe("implemented");
    expect(result.run).toMatchObject({ parentRunId: null, depth: 0, runtime: "claude-code" });
    expect(result.run.rootRunId).toBe(result.run.runId);
    const req = h.adapters["claude-code"].requests[0];
    expect(req.role).toBeUndefined();
    expect(req.definitionPath).toBeUndefined();
    expect(req.cwd).toBe(h.workspace);
    expect(req.prompt).toContain("rename the helper");
    // A direct run is the caller prompting the runtime itself: no OS wrapper.
    expect(req.osIsolation).toBe(false);
    expect(req.env).toMatchObject({ [RUN_ID_ENV]: result.run.runId, [RUN_STORE_ENV]: h.sta.store.dir, STA_ROLE: "" });
    expect(h.sta.run(result.run.runId)).toMatchObject({ status: "completed", attempts: 1, output: "implemented" });
  });

  it("2. Desktop controller → STA → a different runtime's executor → result returns", async () => {
    const h = harness();
    h.on("antigravity", () => okResult({ text: "agy answer" }));

    const result = expectStatus(await h.sta.execute({ runtime: "antigravity", task: "summarize the module" }), "completed");

    expect(result.output).toBe("agy answer");
    expect(result.run.runtime).toBe("antigravity");
    expect(h.adapters["claude-code"].requests).toHaveLength(0);
  });

  it("3. controller → STA → child controller → executor, result propagates up through the parent", async () => {
    const h = harness();
    h.on("claude-code", async (req) => {
      const child = await h.sta.execute({ runtime: "codex", task: "split into two parts", parentRunId: runIdOf(req) });
      return okResult({ text: `root saw: ${child.status === "completed" ? child.output : child.status}` });
    });
    h.on("codex", async (req) => {
      const leaf = await h.sta.execute({ runtime: "zcode", task: "part one", parentRunId: runIdOf(req) });
      return okResult({ text: `codex merged [${leaf.status === "completed" ? leaf.output : leaf.status}]` });
    });
    h.on("zcode", () => okResult({ text: "leaf work" }));

    const result = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "do the feature" }), "completed");

    expect(result.output).toBe("root saw: codex merged [leaf work]");
    const tree = h.sta.tree(result.run.runId);
    expect(tree.map((r) => [r.runtime, r.depth, r.status])).toEqual([
      ["claude-code", 0, "completed"],
      ["codex", 1, "completed"],
      ["zcode", 2, "completed"],
    ]);
    expect(tree[1].parentRunId).toBe(tree[0].runId);
    expect(tree[2].parentRunId).toBe(tree[1].runId);
    expect(result.evidence.children).toEqual([{ runId: tree[1].runId, runtime: "codex", status: "completed" }]);
  });

  it("4. a controller may start a child run on its own runtime", async () => {
    const h = harness();
    h.on("claude-code", async (req, call) => {
      if (call > 0) return okResult({ text: "inner claude" });
      const child = await h.sta.execute({ runtime: "claude-code", task: "sub-task", parentRunId: runIdOf(req) });
      return okResult({ text: `outer claude + ${child.status === "completed" ? child.output : child.status}` });
    });

    const result = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "task" }), "completed");

    expect(result.output).toBe("outer claude + inner claude");
    expect(h.sta.tree(result.run.runId).map((r) => r.runtime)).toEqual(["claude-code", "claude-code"]);
  });

  it("5. an executor delegates and becomes the controller of its own child", async () => {
    const h = harness();
    let executorRunId = "";
    h.on("codex", async (req) => {
      executorRunId = runIdOf(req);
      const grandchild = await h.sta.execute({ runtime: "claude-code", task: "write the tests", parentRunId: executorRunId });
      return okResult({ text: `codex delegated: ${grandchild.status}` });
    });
    h.on("claude-code", async (req, call) => {
      if (call > 0) return okResult({ text: "tests written" });
      const child = await h.sta.execute({ runtime: "codex", task: "implement", parentRunId: runIdOf(req) });
      return okResult({ text: child.status === "completed" ? child.output : child.status });
    });

    const result = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "ship it" }), "completed");

    expect(result.output).toBe("codex delegated: completed");
    const executor = h.sta.run(executorRunId)!;
    // Executor relative to its parent …
    expect(executor.parentRunId).toBe(result.run.runId);
    // … and the controller of its own child.
    const children = h.sta.tree(result.run.runId).filter((r) => r.parentRunId === executorRunId);
    expect(children.map((c) => [c.runtime, c.status])).toEqual([["claude-code", "completed"]]);
  });

  it("6. a nested STA invocation keeps independent run state — no collision", async () => {
    const h = harness();
    // The executor calls STA back the way a spawned `sta execute` would: a
    // fresh STA instance built only from the environment it was given.
    h.on("codex", async (req) => {
      const nested = createSta({ registry: new RuntimeRegistry(Object.values(h.adapters)), env: { ...req.env } });
      expect(nested.store.dir).toBe(h.sta.store.dir);
      const [a, b] = await Promise.all([
        nested.execute({ runtime: "claude-code", task: "sibling A" }),
        nested.execute({ runtime: "zcode", task: "sibling B" }),
      ]);
      return okResult({ text: `${a.status}/${b.status}` });
    });

    const [first, second] = await Promise.all([
      h.sta.execute({ runtime: "codex", task: "tree one" }),
      h.sta.execute({ runtime: "codex", task: "tree two" }),
    ]);

    for (const result of [first, second]) {
      expect(expectStatus(result, "completed").output).toBe("completed/completed");
      const tree = h.sta.tree(result.run.runId);
      expect(tree).toHaveLength(3);
      expect(tree.every((r) => r.rootRunId === result.run.runId)).toBe(true);
      expect(tree.filter((r) => r.parentRunId === result.run.runId).map((r) => r.task).sort()).toEqual(["sibling A", "sibling B"]);
    }
    expect(first.run.rootRunId).not.toBe(second.run.rootRunId);
    const ids = [...h.sta.tree(first.run.runId), ...h.sta.tree(second.run.runId)].map((r) => r.runId);
    expect(new Set(ids).size).toBe(6);
  });
});

describe("sta.execute — recursion limits", () => {
  it("7. recursion past max_depth is refused cleanly and the parent still returns", async () => {
    const h = harness();
    let refusal: ExecuteResult | undefined;
    h.on("claude-code", async (req) => {
      const r = await h.sta.execute({ runtime: "claude-code", task: "go deeper", parentRunId: runIdOf(req) });
      if (r.status === "failed") refusal ??= r;
      return okResult({ text: r.status });
    });

    const result = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "recurse", limits: { maxDepth: 2 } }), "completed");

    const refused = expectStatus(refusal!, "failed");
    expect(refused.error.code).toBe("max_depth_exceeded");
    expect(refused.run.depth).toBe(3);
    // Depths 0..2 ran; the refused depth-3 run was never recorded or spawned.
    expect(h.sta.tree(result.run.runId).map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(h.adapters["claude-code"].requests).toHaveLength(3);
  });

  it("8. a tree that exceeds its run budget or child limit is refused cleanly", async () => {
    const h = harness();
    const outcomes: string[] = [];
    h.on("codex", async (req) => {
      for (let i = 0; i < 3; i++) {
        const r = await h.sta.execute({ runtime: "zcode", task: `child ${i}`, parentRunId: runIdOf(req) });
        outcomes.push(r.status === "failed" ? r.error.code : r.status);
      }
      return okResult({ text: "done" });
    });

    await h.sta.execute({ runtime: "codex", task: "fan out", limits: { maxTotalRuns: 3 } });
    expect(outcomes).toEqual(["completed", "completed", "budget_exceeded"]);

    outcomes.length = 0;
    await h.sta.execute({ runtime: "codex", task: "fan out", limits: { maxChildren: 1 } });
    expect(outcomes).toEqual(["completed", "max_children_exceeded", "max_children_exceeded"]);
  });

  it("a child cannot loosen the root's limits", async () => {
    const h = harness();
    let childLimits: unknown;
    h.on("codex", async (req) => {
      const r = await h.sta.execute({ runtime: "zcode", task: "t", parentRunId: runIdOf(req), limits: { maxDepth: 50, maxTotalRuns: 999 } });
      childLimits = h.sta.run(r.run.runId)?.limits;
      return okResult();
    });
    await h.sta.execute({ runtime: "codex", task: "t", limits: { maxDepth: 2, maxTotalRuns: 5 } });
    expect(childLimits).toMatchObject({ maxDepth: 2, maxTotalRuns: 5 });
  });
});

describe("sta.execute — no ceremony, real safety", () => {
  it("9. a low-risk implementation task runs directly — no BA/SA/PM, workflow, module docs or role", async () => {
    const h = harness();
    const request: ExecuteRequest = { runtime: "codex", task: "fix the off-by-one in paginate()", permissions: { write: true } };

    const result = expectStatus(await h.sta.execute(request), "completed");

    const [req] = h.adapters.codex.requests;
    expect(h.adapters.codex.requests).toHaveLength(1);
    expect(req.role).toBeUndefined();
    expect(req.stage).toBeUndefined();
    expect(req.autonomy).toBe("edit");
    expect(req.guards.writeAllow).toEqual(["**"]);
    expect(fs.existsSync(path.join(h.workspace, "_docs"))).toBe(false);
    expect(h.sta.tree(result.run.runId)).toHaveLength(1);
  });

  it("10a. a declared dangerous action waits for a human approval before anything runs", async () => {
    const h = harness();

    const waiting = expectStatus(
      await h.sta.execute({ runtime: "claude-code", task: "deploy to production", permissions: { write: true }, actions: ["production-deploy"] }),
      "needs_approval",
    );
    expect(waiting.request).toMatchObject({ runId: waiting.run.runId, actions: ["production-deploy"], chain: [waiting.run.runId] });
    expect(h.adapters["claude-code"].requests).toHaveLength(0);

    // Resuming before a decision still waits; nothing spawns.
    expect((await h.sta.resume(waiting.run.runId)).status).toBe("needs_approval");
    expect(h.adapters["claude-code"].requests).toHaveLength(0);

    expect(h.sta.approve({ runId: waiting.run.runId, requestId: waiting.request.requestId, approved: true, by: "golf" })).toEqual({
      ok: true,
      runId: waiting.run.runId,
      approved: true,
    });
    const done = expectStatus(await h.sta.resume(waiting.run.runId), "completed");
    expect(done.run.runId).toBe(waiting.run.runId);
    expect(h.sta.run(waiting.run.runId)).toMatchObject({ attempts: 1, approval: { decision: { approved: true, by: "golf" } } });
  });

  it("10b. a denied approval fails the run; it never spawns", async () => {
    const h = harness();
    const waiting = expectStatus(await h.sta.execute({ runtime: "codex", task: "drop the table", actions: ["irreversible-migration"] }), "needs_approval");
    h.sta.approve({ runId: waiting.run.runId, requestId: waiting.request.requestId, approved: false, by: "golf" });
    expect(expectStatus(await h.sta.resume(waiting.run.runId), "failed").error.code).toBe("approval_denied");
    expect(h.adapters.codex.requests).toHaveLength(0);
  });

  it("10c. every run carries the safety floor: no state-changing git, no write to VCS/runtime state", async () => {
    const h = harness();
    await h.sta.execute({ runtime: "claude-code", task: "t", permissions: { write: true } });
    await h.sta.execute({ runtime: "claude-code", task: "t" });
    const [writing, reading] = h.adapters["claude-code"].requests;
    for (const req of [writing, reading]) {
      expect(req.guards.forbidCommands).toContain("git");
      expect(req.guards.writeDeny).toEqual(expect.arrayContaining([".git/**", ".workflow/**"]));
    }
    expect(writing.guards.exitChecks).toContain("no-hardcoded-secret");
    expect(reading.autonomy).toBe("read-only");
    expect(reading.guards.writeAllow).toEqual([]);
    expect(reading.env!.STA_WRITABLE_WORK_ROOTS).toBe("[]");
    expect(writing.env!.STA_WRITABLE_WORK_ROOTS).toBe(JSON.stringify([h.workspace]));
  });

  it("10d. a child can neither leave its parent's workspace nor gain permissions the parent lacks", async () => {
    const h = harness();
    const codes: string[] = [];
    h.on("codex", async (req) => {
      const parentRunId = runIdOf(req);
      const attempts: ExecuteRequest[] = [
        { runtime: "zcode", task: "escape", parentRunId, workspace: tmp("sta-elsewhere-") },
        { runtime: "zcode", task: "write", parentRunId, permissions: { write: true } },
        { runtime: "zcode", task: "full", parentRunId, permissions: { autonomy: "full" } },
      ];
      for (const r of attempts) {
        const out = await h.sta.execute(r);
        codes.push(out.status === "failed" ? out.error.code : out.status);
      }
      return okResult();
    });
    await h.sta.execute({ runtime: "codex", task: "read-only parent" });
    expect(codes).toEqual(["workspace_outside_parent", "permission_escalation", "permission_escalation"]);
  });

  it("10e. a run that forbids delegation cannot start children; one on a subdirectory may", async () => {
    const h = harness();
    const sub = path.join(h.workspace, "docs");
    fs.mkdirSync(sub);
    const seen: string[] = [];
    h.on("codex", async (req) => {
      const out = await h.sta.execute({ runtime: "zcode", task: "child", parentRunId: runIdOf(req), workspace: sub });
      seen.push(out.status === "failed" ? out.error.code : `${out.status}@${h.sta.run(out.run.runId)!.workspace}`);
      return okResult();
    });
    await h.sta.execute({ runtime: "codex", task: "t", permissions: { delegate: false } });
    await h.sta.execute({ runtime: "codex", task: "t", permissions: { write: true } });
    expect(seen).toEqual(["delegation_not_permitted", `completed@${sub}`]);
  });

  it("10f. a writing run on a runtime that cannot guard tool calls is refused", async () => {
    const h = harness({ capabilities: { antigravity: [RuntimeCapability.NAMED_AGENTS] } });
    const out = expectStatus(await h.sta.execute({ runtime: "antigravity", task: "edit", permissions: { write: true } }), "failed");
    expect(out.error.code).toBe("write_guard_unavailable");
    // Read-only work on the same runtime is fine.
    expect((await h.sta.execute({ runtime: "antigravity", task: "read" })).status).toBe("completed");
  });

  it("an approval cannot be decided from inside the run tree that asked for it", async () => {
    const h = harness();
    let verdict: unknown;
    h.on("codex", async (req) => {
      const child = await h.sta.execute({ runtime: "zcode", task: "deploy", parentRunId: runIdOf(req), actions: ["production-deploy"] });
      if (child.status === "needs_approval") {
        verdict = h.sta.approve({ runId: child.request.runId, requestId: child.request.requestId, approved: true, by: "codex", callerRunId: runIdOf(req) });
      }
      return okResult();
    });
    await h.sta.execute({ runtime: "codex", task: "t" });
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("same run tree") });
  });
});

describe("sta.execute — cross-runtime routing", () => {
  const pairs: Array<[string, string]> = [
    ["claude-code", "codex"],
    ["codex", "claude-code"],
    ["antigravity", "claude-code"],
    ["zcode", "codex"],
  ];
  it.each(pairs)("11. %s controller → STA → %s executor", async (controller, executor) => {
    const h = harness();
    h.on(executor, (req, call) => okResult({ text: `${executor} result #${call}` }));
    h.on(controller, async (req) => {
      const r = await h.sta.execute({ runtime: executor, task: "delegated", parentRunId: runIdOf(req) });
      return okResult({ text: r.status === "completed" ? `${controller} got ${r.output}` : r.status });
    });

    const result = expectStatus(await h.sta.execute({ runtime: controller, task: "coordinate" }), "completed");

    expect(result.output).toBe(`${controller} got ${executor} result #0`);
    expect(h.sta.tree(result.run.runId).map((r) => r.runtime)).toEqual([controller, executor]);
  });
});

describe("sta.execute — results across the tree", () => {
  it("a child's approval request propagates to the root and the tree resumes after approval", async () => {
    const h = harness();
    let bId = "";
    let cId = "";
    h.on("claude-code", async (req, call) => {
      const me = runIdOf(req);
      const b = call === 0 ? await h.sta.execute({ runtime: "codex", task: "release", parentRunId: me }) : await h.sta.resume(bId, { parentRunId: me });
      bId = b.run.runId;
      return okResult({ text: `A: ${b.status}` });
    });
    h.on("codex", async (req, call) => {
      const me = runIdOf(req);
      const c = call === 0
        ? await h.sta.execute({ runtime: "zcode", task: "deploy", parentRunId: me, permissions: { write: true }, actions: ["production-deploy"] })
        : await h.sta.resume(cId, { parentRunId: me });
      cId = c.run.runId;
      return okResult({ text: `B: ${c.status}` });
    });
    h.on("zcode", () => okResult({ text: "deployed" }));

    const root = await h.sta.execute({ runtime: "claude-code", task: "ship", permissions: { write: true } });
    const waiting = expectStatus(root, "needs_approval");
    expect(waiting.request.runId).toBe(cId);
    expect(waiting.request.chain).toEqual([root.run.runId, bId, cId]);
    expect(h.sta.run(bId)).toMatchObject({ status: "needs_approval", blockedOn: cId });
    expect(h.adapters.zcode.requests).toHaveLength(0);

    expect(h.sta.approve({ runId: cId, requestId: waiting.request.requestId, approved: true, by: "golf" }).ok).toBe(true);
    const done = expectStatus(await h.sta.resume(root.run.runId), "completed");

    expect(done.output).toBe("A: completed");
    expect(h.sta.tree(root.run.runId).map((r) => [r.runId, r.status])).toEqual([
      [root.run.runId, "completed"],
      [bId, "completed"],
      [cId, "completed"],
    ]);
    expect(h.sta.run(cId)!.output).toBe("deployed");
  });

  it("a nested failure keeps which run, runtime and task failed, and its output", async () => {
    const h = harness();
    h.on("claude-code", async (req) => {
      const b = await h.sta.execute({ runtime: "codex", task: "middle", parentRunId: runIdOf(req) });
      return b.status === "failed" ? okResult({ status: "ERROR", exitCode: 1, text: "gave up", diagnostics: [] }) : okResult();
    });
    h.on("codex", async (req) => {
      const c = await h.sta.execute({ runtime: "zcode", task: "leaf that breaks", parentRunId: runIdOf(req) });
      return c.status === "failed" ? okResult({ status: "ERROR", exitCode: 2, text: "leaf failed", diagnostics: [] }) : okResult();
    });
    h.on("zcode", () => okResult({ status: "ERROR", exitCode: 3, text: "", diagnostics: ["TypeError: x is undefined"] }));

    const failed = expectStatus(await h.sta.execute({ runtime: "claude-code", task: "top" }), "failed");

    expect(failed.error).toMatchObject({ code: "error", runtime: "claude-code", task: "top", detail: "gave up", exitCode: 1 });
    expect(failed.error.cause).toMatchObject({
      runtime: "zcode",
      task: "leaf that breaks",
      detail: "TypeError: x is undefined",
      exitCode: 3,
    });
    const leaf = h.sta.run(failed.error.cause!.runId)!;
    expect(h.sta.run(leaf.parentRunId!)!.task).toBe("middle");
    expect(failed.evidence.children).toEqual([expect.objectContaining({ runtime: "codex", status: "failed" })]);
  });

  it("an executor that could not finish returns partial with the remaining work", async () => {
    const h = harness();
    h.on("codex", () => okResult({ text: "did the parser\nREMAINING: wire the CLI flag" }));
    const out = expectStatus(await h.sta.execute({ runtime: "codex", task: "parser + flag" }), "partial");
    expect(out.remainingWork).toBe("wire the CLI flag");

    h.on("codex", (req) => {
      expect(req.prompt).toContain("Previously remaining: wire the CLI flag");
      return okResult({ text: "flag wired" });
    });
    expect(expectStatus(await h.sta.resume(out.run.runId), "completed").output).toBe("flag wired");
  });

  it("a parent that finishes while its child is unfinished completes with a warning — the caller decides", async () => {
    const h = harness();
    h.on("zcode", () => okResult({ text: "half\nREMAINING: the other half" }));
    h.on("codex", async (req) => {
      await h.sta.execute({ runtime: "zcode", task: "both halves", parentRunId: runIdOf(req) });
      return okResult({ text: "moving on" });
    });
    const out = expectStatus(await h.sta.execute({ runtime: "codex", task: "t" }), "completed");
    expect(out.warnings).toEqual([expect.stringMatching(/child run run-\S+ on zcode is still partial/)]);
  });

  it("an unknown runtime or parent is refused before anything runs", async () => {
    const h = harness();
    expect(expectStatus(await h.sta.execute({ runtime: "nope", task: "t" }), "failed").error.code).toBe("runtime_not_registered");
    expect(expectStatus(await h.sta.execute({ runtime: "codex", task: "t", parentRunId: "run-missing" }), "failed").error.code).toBe("parent_not_found");
  });

  it("only the run's parent, or a caller outside its tree, may resume it", async () => {
    const h = harness();
    const ids: string[] = [];
    h.on("codex", async (req) => {
      const me = runIdOf(req);
      const a = await h.sta.execute({ runtime: "zcode", task: "a", parentRunId: me, actions: ["external-side-effect"] });
      const b = await h.sta.execute({ runtime: "zcode", task: "b", parentRunId: me });
      ids.push(a.run.runId, b.run.runId);
      return okResult();
    });
    await h.sta.execute({ runtime: "codex", task: "t" });
    const [a, b] = ids;
    const sibling = await h.sta.resume(a, { parentRunId: b });
    expect(expectStatus(sibling, "failed").error.code).toBe("not_run_owner");
  });
});

describe("sta.execute — writable Targets: a role from the Knowledge workspace writes a Target", () => {
  /** A Knowledge workspace with one mapped Target beside it; the mapping is the resolver seam. */
  function targetHarness() {
    const workspace = tmp("sta-exec-kb-");
    const target = tmp("sta-exec-target-");
    const other = tmp("sta-exec-other-");
    const mapped = [{ targetId: "backend", path: target, access: "write" as const }];
    const behaviour: { respond: Respond } = { respond: () => okResult({ text: "done" }) };
    const adapters: Record<string, MockRuntimeAdapter> = {};
    for (const id of RUNTIMES) adapters[id] = new MockRuntimeAdapter({ id, respond: (req, call) => behaviour.respond(req, call) });
    const sta = createSta({
      registry: new RuntimeRegistry(Object.values(adapters)),
      runStore: path.join(tmp("sta-exec-store-"), "runs"),
      env: {},
      cwd: workspace,
      resolveWritableTargets: ({ requests }) =>
        requests.map((name) => {
          const found = mapped.find((m) => m.targetId === name || m.path === name);
          if (!found) throw new WritableTargetRequestError(`"${name}" names no mapped Target`);
          return found;
        }),
    });
    return { sta, workspace, target, other, adapters, on: (respond: Respond) => (behaviour.respond = respond) };
  }

  it("runs in the workspace, writes only the Target, and hands the guard the Target and the Knowledge root", async () => {
    const h = targetHarness();

    const result = expectStatus(
      await h.sta.execute({ runtime: "claude-code", task: "BE-005", role: "backend-engineer", writableTargets: ["backend"] }),
      "completed",
    );

    const req = h.adapters["claude-code"].requests[0];
    expect(req.cwd).toBe(h.workspace);
    expect(req.role).toBe("backend-engineer");
    expect(req.workRoots).toEqual([{ targetId: "backend", path: h.target, access: "write" }]);
    expect(req.knowledgeRoot).toBe(h.workspace);
    expect(req.autonomy).toBe("edit");
    // The workspace is read-only: no workspace glob, and it is not a write root.
    expect(req.guards.writeAllow).toEqual([]);
    expect(req.guards.exitChecks).toContain("no-hardcoded-secret");
    expect(req.env!.STA_WRITABLE_WORK_ROOTS).toBe(JSON.stringify([h.target]));
    expect(JSON.parse(req.env!.STA_TARGET_WORK_ROOTS)).toEqual([{ targetId: "backend", path: h.target, access: "write" }]);
    expect(req.env!.STA_KNOWLEDGE_ROOT).toBe(h.workspace);
    expect(req.env!.STA_ROLE).toBe("backend-engineer");
    expect(req.prompt).toContain(`backend: ${h.target}`);
    expect(h.sta.run(result.run.runId)!.workRoots).toEqual([{ targetId: "backend", path: h.target, access: "write" }]);
  });

  it("is refused without a role, for an unmapped Target, for an explicit read-only run, or for a Target that is the workspace", async () => {
    const h = targetHarness();
    const code = async (r: Partial<ExecuteRequest>) => {
      const out = await h.sta.execute({ runtime: "claude-code", task: "t", ...r });
      return out.status === "failed" ? out.error.code : out.status;
    };

    expect(await code({ writableTargets: ["backend"] })).toBe("invalid_permissions");
    expect(await code({ role: "backend-engineer", writableTargets: ["nope"] })).toBe("target_not_mapped");
    expect(await code({ role: "backend-engineer", writableTargets: ["backend"], permissions: { write: false } })).toBe("invalid_permissions");
    const inside = createSta({
      registry: new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code" })]),
      runStore: path.join(tmp("sta-exec-store-"), "runs"),
      env: {},
      cwd: h.workspace,
      resolveWritableTargets: () => [{ targetId: "self", path: h.workspace, access: "write" }],
    });
    const self = await inside.execute({ runtime: "claude-code", task: "t", role: "backend-engineer", writableTargets: ["self"] });
    expect(expectStatus(self, "failed").error.code).toBe("invalid_permissions");
    expect(h.adapters["claude-code"].requests).toHaveLength(0);
  });

  it("a child inherits its parent's Targets, may not name one the parent lacks, and a read-only child gets none", async () => {
    const h = targetHarness();
    const seen: unknown[] = [];
    h.on(async (req) => {
      if (!req.prompt.startsWith("parent")) return okResult();
      const parentRunId = runIdOf(req);
      const inherit = await h.sta.execute({ runtime: "codex", task: "c1", parentRunId, role: "backend-engineer", permissions: { write: true } });
      seen.push(inherit.status === "completed" ? h.sta.run(inherit.run.runId)!.workRoots : inherit.status);
      const escalate = await h.sta.execute({ runtime: "codex", task: "c2", parentRunId, role: "backend-engineer", writableTargets: [h.other] });
      seen.push(escalate.status === "failed" ? escalate.error.code : escalate.status);
      const reader = await h.sta.execute({ runtime: "codex", task: "c3", parentRunId, permissions: { write: false } });
      seen.push(reader.status === "completed" ? h.sta.run(reader.run.runId)!.workRoots ?? "none" : reader.status);
      return okResult();
    });

    await h.sta.execute({ runtime: "claude-code", task: "parent", role: "backend-engineer", writableTargets: ["backend"] });

    expect(seen).toEqual([[{ targetId: "backend", path: h.target, access: "write" }], "permission_escalation", "none"]);
    expect(h.adapters.codex.requests[0].env!.STA_WRITABLE_WORK_ROOTS).toBe(JSON.stringify([h.target]));
  });
});
