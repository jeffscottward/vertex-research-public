import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import coverageBaseline from "./scripts/ci/coverage-baseline.json" with {
  type: "json",
};
import {
  FILE_SHARDS,
  NATIVE_EVIDENCE_SHARDS,
} from "./scripts/lib/coverage-shards.ts";
import {
  publishLoadFloor,
  resolveTimeoutScale,
  scaledDefaults,
  TIMEOUT_SCALE_ENV,
} from "./scripts/lib/test-timeout-scale.ts";

// Load-aware deadlines (card prepush-timeouts-runner-load, 2026-11-03): under
// host load or a CPU quota the default 5 s test / 10 s hook timeouts scale
// with the measured CPU shortage. Nested Vitest runs inherit the value.
// Card vertex-timeout-scale-stale-under-load (2026-11-20): the plugin below
// adds the run's own workers once Vitest knows their number, and the setup
// file measures again before each test file.
const timeouts = resolveTimeoutScale(process.env);
process.env[TIMEOUT_SCALE_ENV] = String(timeouts.scale);
const loadAwareTimeouts: Plugin = {
  name: "vertex:load-aware-timeouts",
  configureVitest: ({ vitest }) => {
    const line = publishLoadFloor(process.env, timeouts, vitest.config);
    if (line !== undefined) {
      console.error(line);
    }
  },
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
  path.replace(/[\\()[\]{}*?!+@,|]/gu, "\\$&");
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

// The files of the named shards as absolute paths. Vitest resolves a relative
// include or exclude entry against the directory it starts in. The
// packages/api test:unit script starts it in packages/api, where a path
// relative to the repository root matches no file. With absolute paths the
// shard projects match these files from every start directory, so a start in
// another package must select its projects.
const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
// tinyglobby makes an absolute pattern relative to its escaped start
// directory. The prefix needs the same escaping to match, so this is the
// POSIX escapePath of tinyglobby 0.2.17 (POSIX paths only). escapeGlob also
// escapes + @ , ! and the patterns then fail in such a path.
const shardFile = (file: string): string =>
  join(repositoryRoot, file).replace(/[\\()[\]{}*?|]|^!|[!+@](?=\()/gu, "\\$&");

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
  plugins: [loadAwareTimeouts],
  test: {
    environment: "node",
    ...scaledDefaults(timeouts.scale),
    setupFiles: [
      fileURLToPath(
        new URL("./scripts/lib/test-timeout-setup.ts", import.meta.url)
      ),
    ],
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
            // Named coverage shards (scripts/lib/coverage-shards.ts) run these.
            ...Object.values(FILE_SHARDS).flat().map(shardFile),
          ],
        },
      },
      ...Object.entries(FILE_SHARDS).map(([name, include]) => ({
        extends: true,
        test: {
          name,
          include: include.map(shardFile),
          // The JavaScript main thread of the worker limits the
          // native-evidence tests. Vitest runs the groups one after the other,
          // so these files never run at the same time as the projects of a
          // lower group (every other project). With more than one worker they
          // start when those projects have ended. The five-turn debate file
          // stays in the group of the unit project, where it ran before it had
          // its own project.
          sequence: {
            groupOrder: Object.hasOwn(NATIVE_EVIDENCE_SHARDS, name) ? 1 : 0,
          },
        },
      })),
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
