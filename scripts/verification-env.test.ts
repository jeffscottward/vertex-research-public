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

  // The web build writes .wrangler/deploy/config.json next to dist, and `vite preview`
  // (the E2E app server) cannot start without it. Turbo shares its cache across git
  // worktrees and a cache hit restores only the declared outputs, so a fresh worktree
  // got dist without that file (card vertex-e2e-browser-fails-1103).
  it("restores the Cloudflare deploy pointer with a cached web build", async () => {
    const { tasks } = JSON.parse(
      await readFile(new URL("../turbo.json", import.meta.url), "utf8")
    ) as Readonly<{ tasks: Record<string, { outputs?: readonly string[] }> }>;
    // A package task replaces the generic one for that package.
    const webBuild = tasks["@darkfactory/web#build"] ?? tasks["build"];
    expect(webBuild?.outputs).toContain(".wrangler/deploy/**");
  });
});
