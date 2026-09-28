import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // V13 TASK-027: keeps every test away from the real approval-channel configuration.
    setupFiles: ["./src/testSetup/humanChannel.setup.ts"],
  },
});
