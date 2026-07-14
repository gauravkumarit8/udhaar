import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: Do NOT use `output: "export"` — our API routes require a server.
  // For Capacitor mobile builds, the app loads from a hosted URL
  // (set in capacitor.config.ts → server.url).
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
