import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Market notes are research context only. This test reads the source text of the four
// market-notes modules and fails when one of them imports, directly, a module of the order side:
// orders and order intents, arming, IBKR recovery, sizing, policy, autopilot or deployment. It
// checks direct imports only: server/market-notes.ts imports the app contract aggregate
// (../contract.ts), like every procedure file, and that aggregate also holds the order contracts.
const FORBIDDEN_IMPORT =
  /order-intents|ibkr-recovery|arm-switch-audit|vertex-runtime-policy|vertex-orders|nautilus-arm|risk-allocator|vertex-policy|autopilot|deployment-requests|final-order-gate/u;

const repository = join(import.meta.dirname, "..", "..", "..", "..");
const sources = [
  "packages/api/src/contracts/market-notes.ts",
  "packages/api/src/market-notes.ts",
  "packages/api/src/server/market-notes.ts",
  "packages/db/src/server/market-notes.ts",
].map((name) => ({ name, path: join(repository, name) }));
// `from "x"`, `from 'x'`, bare side-effect imports such as `import "x";` and `import("x")`.
const SPECIFIER =
  /(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gmu;

const forbiddenImports = (source: string): string[] =>
  [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] as string)
    .filter((specifier) => FORBIDDEN_IMPORT.test(specifier));

describe("market notes boundaries", () => {
  it.each(sources)(
    "$name imports no order-side module directly",
    ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Every module here has imports, so an empty list is a real result.
      expect([...source.matchAll(SPECIFIER)].length).toBeGreaterThan(0);
      expect(forbiddenImports(source)).toEqual([]);
    }
  );

  it("detects each forbidden module in every import form", () => {
    const sample = [
      'import { place } from "./vertex-orders.ts";',
      "import { arm } from '../contracts/nautilus-arm.ts';",
      'import "../risk-allocator.ts";',
      'export * from "@darkfactory/api/vertex-policy";',
      'const autopilot = await import("./autopilot.ts");',
      'const requests = require("./deployment-requests.ts");',
      'import { gate } from "./final-order-gate.ts";',
      'import type { OrderIntent } from "./order-intents.ts";',
      'import { recover } from "./ibkr-recovery.ts";',
      'import { audit } from "@darkfactory/db/server/arm-switch-audit";',
      'import { policy } from "./vertex-runtime-policy.ts";',
      'import { z } from "zod";',
      'import { sha256Hex } from "./canonical-json.ts";',
    ].join("\n");
    expect(forbiddenImports(sample)).toEqual([
      "./vertex-orders.ts",
      "../contracts/nautilus-arm.ts",
      "../risk-allocator.ts",
      "@darkfactory/api/vertex-policy",
      "./autopilot.ts",
      "./deployment-requests.ts",
      "./final-order-gate.ts",
      "./order-intents.ts",
      "./ibkr-recovery.ts",
      "@darkfactory/db/server/arm-switch-audit",
      "./vertex-runtime-policy.ts",
    ]);
  });
});
