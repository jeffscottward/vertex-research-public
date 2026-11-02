import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";

// The standalone Better Auth CLI loads this file outside the Worker runtime, so
// it cannot build the request-scoped production factory. This Node-only mirror
// contains no runtime binding or connection. The stale check and integration schema
// comparison keep its generated contract aligned with the production factory.
const toolingDatabase = drizzle.mock();

export const auth = betterAuth({
  baseURL: "https://darkfactory.localhost",
  secret: "schema-generation-only-secret-32-characters",
  trustedOrigins: ["https://darkfactory.localhost"],
  database: drizzleAdapter(toolingDatabase, {
    provider: "pg",
    schema: {},
    transaction: true,
  }),
  advanced: {
    useSecureCookies: true,
    disableCSRFCheck: false,
    disableOriginCheck: false,
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
    },
  },
  rateLimit: {
    storage: "database",
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },
  user: {
    additionalFields: {
      role: {
        type: ["member", "admin"],
        required: true,
        input: false,
        returned: true,
        defaultValue: "member",
      },
      status: {
        type: ["active", "suspended", "deactivated"],
        required: true,
        input: false,
        returned: true,
        defaultValue: "active",
      },
    },
  },
  // Mirrors the production agent API key plugin options in src/server.ts
  // (createAgentApiKeyPlugin). Only the per-key rate-limit defaults change the
  // generated schema; keep both copies aligned.
  plugins: [
    apiKey({
      apiKeyHeaders: "x-api-key",
      defaultPrefix: "vrk_",
      requireName: true,
      maximumNameLength: 64,
      enableMetadata: false,
      enableSessionForAPIKeys: false,
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
    }),
  ],
});
