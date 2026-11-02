import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import rootConfig from "../vitest.config.ts";

const configurations = [{ name: "root", configuration: rootConfig }] as const;

type TurboEnvironmentPolicy = Readonly<{
  globalEnv?: readonly string[];
  globalPassThroughEnv?: readonly string[];
}>;

// Config-shape regression only. Real dotenv-read proof uses a separate synthetic
// VITE_-prefixed sentinel and positive control; this suite never reads dotenv.
describe("verification environment configuration", () => {
  it.each(configurations)(
    "disables Vite dotenv loading for $name",
    ({ configuration }) => {
      expect(configuration.envDir).toBe(false);
    }
  );

  it("does not propagate Bun loader options globally into verification or deployment tasks", async () => {
    const policy = JSON.parse(
      await readFile(new URL("../turbo.json", import.meta.url), "utf8")
    ) as TurboEnvironmentPolicy;
    for (const forbidden of ["BUN_OPTIONS", "BUN_*", "*"]) {
      expect(policy.globalEnv ?? []).not.toContain(forbidden);
      expect(policy.globalPassThroughEnv ?? []).not.toContain(forbidden);
    }
  });
});
