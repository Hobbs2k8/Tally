import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compiled company data is read from disk at runtime by the API routes.
  outputFileTracingIncludes: { "/api/**": ["./data/compiled/**"] },
};

export default nextConfig;
