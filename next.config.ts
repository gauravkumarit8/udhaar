import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker / containerized deployments.
  // Also works fine for regular `npm run build` + `npm run start`.
  output: "standalone",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
