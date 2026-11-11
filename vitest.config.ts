import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    // Tests never touch a real database: DB-backed tests use PGlite (pipeline/test-db.ts), and this
    // stops AI-call logging from writing to whatever DATABASE_URL the shell happens to export.
    env: { DATABASE_URL: "" },
  },
});
