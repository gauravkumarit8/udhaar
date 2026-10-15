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
    // .tsx too: the primitives in src/components/ui.tsx are where the app's
    // formatting and its sheet behaviour live, and both are worth a test. Those
    // files opt into jsdom with a `@vitest-environment` comment of their own -
    // everything else stays in plain node, which is faster and truer to what
    // the server runs.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "tests/**/*.test.mjs"],
    // The EMI engine's date arithmetic must not depend on the host timezone.
    // The suite pins one timezone, and calculations.test.ts re-checks another.
    env: { TZ: "UTC" },
  },
});
