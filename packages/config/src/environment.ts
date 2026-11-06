// What: The APP_ENV values. A leaf module, so server.ts and database.ts share them without a cycle.
export const APP_ENVIRONMENTS = ["development", "test", "production"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
