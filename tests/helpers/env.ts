// Populated BEFORE @/config is imported anywhere — keep this file top of import graph.
// vitest runs tests per-file in its own worker, so this runs once per file.
process.env["NODE_ENV"] = "test";
process.env["XAI_API_KEY"] = "test-xai-key";
process.env["X_CLIENT_ID"] = "test-x-client-id";
process.env["X_CLIENT_SECRET"] = "test-x-client-secret";
process.env["DATABASE_PATH"] = ":memory:";
process.env["STRAND_MODE"] = "shadow";
process.env["LOG_LEVEL"] = "fatal"; // silence pino in tests
