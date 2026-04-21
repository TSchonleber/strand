// Populated BEFORE @/config is imported anywhere — keep this file top of import graph.
// vitest runs tests per-file in its own worker, so this runs once per file.
Object.assign(process.env, {
  NODE_ENV: "test",
  XAI_API_KEY: "test-xai-key",
  X_CLIENT_ID: "test-x-client-id",
  X_CLIENT_SECRET: "test-x-client-secret",
  DATABASE_PATH: ":memory:",
  STRAND_MODE: "shadow",
  LOG_LEVEL: "fatal", // silence pino in tests
});
