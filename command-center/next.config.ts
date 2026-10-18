import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // Compiled company data is read from disk at runtime by the API routes.
  outputFileTracingIncludes: { "/api/**": ["./data/compiled/**"] },
  // Native ONNX runtime for the local System One stand-in: load from node_modules, do not bundle.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

// Source-map upload only runs when SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are set.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
});
