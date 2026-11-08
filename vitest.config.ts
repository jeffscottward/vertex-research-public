import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import coverageBaseline from "./scripts/ci/coverage-baseline.json" with {
  type: "json",
};
import {
  resolveTimeoutScale,
  TIMEOUT_SCALE_ENV,
} from "./scripts/lib/test-timeout-scale.ts";

// Load-aware deadlines (card prepush-timeouts-runner-load, 2026-11-03): under
// host load or a CPU quota the default 5 s test / 10 s hook timeouts scale
// with the measured CPU shortage. Nested Vitest runs inherit the value.
const timeouts = resolveTimeoutScale(process.env);
process.env[TIMEOUT_SCALE_ENV] = String(timeouts.scale);
if (timeouts.supply !== undefined && timeouts.scale > 1) {
  const { hostCpus, loadAverage, quotaCpus } = timeouts.supply;
  console.error(
    `[vitest] timeouts x${timeouts.scale}: load ${loadAverage.toFixed(1)} on ${hostCpus} CPUs, CPU quota ${quotaCpus}`
  );
}

// Coverage ratchet (owner decision 2026-10-11, reconfirmed 2026-10-16): files listed in
// scripts/ci/coverage-baseline.json keep their recorded minimums; every other
// measured file must stay at 100%. Vitest's global threshold counts every
// file, so the 100% rule is a glob that excludes the listed files instead.
const FULL_COVERAGE = {
  lines: 100,
  branches: 100,
  functions: 100,
  statements: 100,
} as const;
const escapeGlob = (path: string): string =>
  path.replace(/[()[\]{}*?!+@,|]/gu, "\\$&");
const legacyFiles = Object.keys(coverageBaseline.files);
export const coverageThresholds = {
  [`!(${legacyFiles.map(escapeGlob).join("|")})`]: FULL_COVERAGE,
  ...Object.fromEntries(
    Object.entries(coverageBaseline.files).map(([file, minimums]) => [
      escapeGlob(file),
      minimums,
    ])
  ),
};

// Vitest keeps transformed modules on disk (fsModuleCache, on by default) in
// one cache under the workspace root. `turbo run test:unit` starts one Vitest
// per package at the same time. When the lockfile hash stored in the cache
// differs from the current lockfile (after a lockfile change, or when a new
// worktree starts with a cache copied from another checkout), every process
// clears the same directory and the runs fail with ENOTEMPTY (card
// vitest-cache-copy-race, 2026-11-08). A cache per working directory gives
// each turbo task its own.
const fsModuleCachePath = join(process.cwd(), "node_modules", ".vitest-cache");

export default defineConfig({
  // Verification never reads local dotenv files; tests receive explicit env only.
  envDir: false,
  resolve: {
    alias: {
      "next/link": fileURLToPath(
        new URL("./apps/web/src/test/next-link.tsx", import.meta.url)
      ),
      "next/navigation": fileURLToPath(
        new URL("./tests/fixtures/next-navigation.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    testTimeout: Math.round(5000 * timeouts.scale),
    hookTimeout: Math.round(10_000 * timeouts.scale),
    fsModuleCachePath,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary"],
      // A CI coverage shard measures only part of the suite; the coverage lane
      // merges the shards and checks these thresholds once.
      thresholds:
        process.env["VITEST_COVERAGE_THRESHOLDS"] === "off"
          ? {}
          : coverageThresholds,
      include: [
        "apps/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "packages/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "scripts/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      ],
      exclude: [
        "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "**/*.d.ts",
        "**/generated/**",
        "apps/web/src/features/generated-navigation.ts",
        "scripts/*.ts",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // CopilotKit's public v2 entry imports CSS. Transform this exact UI
          // dependency through Vite rather than handing its CSS to Node.
          server: {
            deps: { inline: ["@copilotkit/react-core"] },
          },
          include: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
            "**/tests/e2e/**",
            "**/tests/integration/**",
            "**/*contract.test.ts",
            "**/scripts/**",
            // Git-ignored local evidence keeps preimage copies of test files.
            "private/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          include: ["**/*contract.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
            "**/tests/e2e/**",
            "**/tests/integration/**",
            "private/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "operations",
          include: ["scripts/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
            "scripts/**/*.acceptance.test.ts",
            // Contract tests under scripts/ belong to the contract project only.
            "scripts/**/*contract.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          // Clone-and-install acceptance tests: CI coverage lane only, not pre-push.
          name: "acceptance",
          include: ["scripts/**/*.acceptance.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e-helpers",
          include: ["tests/e2e/helpers/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.turbo/**",
            "**/dist/**",
            "**/tests/e2e/**",
          ],
        },
      },
    ],
  },
});
