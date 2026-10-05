import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10000,
    fileParallelism: false,
    // Isolate ~/.perp per test file (never touch the developer's real settings/quarantine).
    setupFiles: ["src/__tests__/helpers/isolate-home.ts"],
  },
});
