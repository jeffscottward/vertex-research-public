import { defineConfig } from "drizzle-kit";
import { normalizePlanetScaleSystemRoot } from "./src/server/connection-string.ts";

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle commands");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: normalizePlanetScaleSystemRoot(databaseUrl),
  },
  strict: true,
  verbose: true,
});
