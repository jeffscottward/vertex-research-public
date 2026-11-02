import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import coverageBaseline from "./scripts/ci/coverage-baseline.json" with {
  type: "json",
};

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
