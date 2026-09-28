import { vi } from "vitest";

/**
 * No test may reach the real, human-owned approval channel (V13 TASK-027).
 *
 * `resolveHumanDecisionChannel()` reads a fixed directory under the OS
 * account's home. Once a person configures the github-app channel on a
 * machine, any test that goes through production composition (CLI verbs,
 * `createStaApi`, a bounded run) would otherwise authenticate as the real
 * App and open real Issues. Every test file therefore sees the unconfigured
 * channel from the resolver; tests of the resolver itself load the actual
 * module with `vi.importActual`, and channel tests pass a fixture transport.
 */
vi.mock("../gates/humanChannelConfig.js", async (importActual) => {
  const actual = await importActual<typeof import("../gates/humanChannelConfig.js")>();
  const { UNCONFIGURED_HUMAN_CHANNEL } = await import("../gates/humanDecision.js");
  return { ...actual, resolveHumanDecisionChannel: vi.fn(() => UNCONFIGURED_HUMAN_CHANNEL) };
});
