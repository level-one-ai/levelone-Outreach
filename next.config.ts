import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    // Type-safety is enforced by `tsc` during the build; linting is a
    // dev-time concern and must not depend on machine-global ESLint config.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
