import { vi } from "vitest";

/**
 * No test may reach the real, human-owned approval channel (V13 TASK-027).
 *
 * Production resolves only the Controller chat relay: a human answers in chat
 * and the Controller relays the answer to STA. Any test that goes through
 * production composition (CLI verbs, `createStaApi`, a bounded run) must not
 * depend on a real chat or pretend to be the Controller, so every test file
 * sees the unconfigured channel from the resolver; tests of the resolver
 * itself load the actual module with `vi.importActual`, and channel tests
 * construct their own verifier directly.
 */
vi.mock("../gates/humanChannelConfig.js", async (importActual) => {
  const actual = await importActual<typeof import("../gates/humanChannelConfig.js")>();
  const { UNCONFIGURED_HUMAN_CHANNEL } = await import("../gates/humanDecision.js");
  return { ...actual, resolveHumanDecisionChannel: vi.fn(() => UNCONFIGURED_HUMAN_CHANNEL) };
});
