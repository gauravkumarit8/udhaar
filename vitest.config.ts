import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // .mjs as well: the migration scripts are plain ESM node, and their
    // helpers are worth testing without a TypeScript build step.
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    // The EMI engine's date arithmetic must not depend on the host timezone.
    // The suite pins one timezone, and calculations.test.ts re-checks another.
    env: { TZ: "UTC" },
  },
});
