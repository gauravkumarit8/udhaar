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
    include: ["tests/**/*.test.ts"],
    // The EMI engine's date arithmetic must not depend on the host timezone.
    // The suite pins one timezone, and calculations.test.ts re-checks another.
    env: { TZ: "UTC" },
  },
});
