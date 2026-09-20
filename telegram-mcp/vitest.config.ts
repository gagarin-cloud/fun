import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts only wires the pieces together, types.ts is types, logger.ts is
      // three lines of pino configuration. Everything with behaviour is covered.
      exclude: ["src/index.ts", "src/logger.ts", "src/telegram/types.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
