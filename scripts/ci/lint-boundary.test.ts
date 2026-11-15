import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scaledTimeout } from "../lib/test-timeout-scale.ts";

// Import boundary (owner 2026-11-14, card orochi-gitlab, D3): biome.jsonc forbids
// server-only modules in apps/web/src/components/**. The test lints probe files with
// the real biome.jsonc in a temporary copy of the repository layout, so nothing is
// written into the checkout and a parallel `bun run lint` never sees a probe.
// Biome 2.5 does not report diagnostics for --stdin-file-path input, so the probes
// are real files.
const root = fileURLToPath(new URL("../..", import.meta.url));
const biome = join(root, "node_modules", ".bin", "biome");
const RULE = "lint/style/noRestrictedImports";
const TIMEOUT = scaledTimeout(60_000);

let workspace = "";

const lintProbe = (
  directory: string,
  specifier: string
): { status: number | null; output: string } => {
  const file = join(
    directory,
    `probe-${Math.random().toString(36).slice(2)}.tsx`
  );
  writeFileSync(
    join(workspace, file),
    `import { x } from "${specifier}";\n\nexport const y = x;\n`
  );
  const result = spawnSync(biome, ["lint", "--vcs-enabled=false", file], {
    cwd: workspace,
    encoding: "utf8",
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
};

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lint-boundary-"));
  copyFileSync(join(root, "biome.jsonc"), join(workspace, "biome.jsonc"));
  // biome.jsonc extends a shared preset that resolves from node_modules.
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"));
  for (const directory of [
    "apps/web/src/components/trading",
    "apps/web/src/app",
  ]) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }
});

afterAll(() => {
  if (workspace) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("web component import boundary (biome.jsonc)", () => {
  it.each([
    "@darkfactory/api/server",
    "@darkfactory/db/server",
    "@darkfactory/api/server/vertex-trading",
    "../../../../../packages/api/src/server",
    "../../../../../packages/api/src/server/orders.ts",
  ])(
    "rejects %s in a UI component",
    (specifier) => {
      const result = lintProbe("apps/web/src/components/trading", specifier);
      expect(result.status).toBe(1);
      expect(result.output).toContain(RULE);
    },
    TIMEOUT
  );

  it.each(["@darkfactory/api/client", "@darkfactory/api/vertex"])(
    "accepts %s in a UI component",
    (specifier) => {
      const result = lintProbe("apps/web/src/components/trading", specifier);
      expect(result.output).not.toContain(RULE);
      expect(result.status).toBe(0);
    },
    TIMEOUT
  );

  it(
    "leaves server imports outside apps/web/src/components to other guards",
    () => {
      const result = lintProbe("apps/web/src/app", "@darkfactory/api/server");
      expect(result.output).not.toContain(RULE);
      expect(result.status).toBe(0);
    },
    TIMEOUT
  );
});
