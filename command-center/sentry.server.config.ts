// Server-side Sentry: tracing (one span per pipeline stage) and Logs.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: 1.0,
  enableLogs: true,
  environment: process.env.NODE_ENV,
});
