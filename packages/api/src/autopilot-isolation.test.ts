import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Autopilot is research only. Breeding, the gate, the runner and the scheduler client must not
// reach a broker, order, execution, Quant VPS, native or gateway module, directly or indirectly.
// The paper hand-off (server/autopilot.ts) only calls the existing deployment-request repository.
describe("autopilot broker isolation", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, "autopilot-genome.ts"),
    resolve(here, "autopilot-breeding.ts"),
    resolve(here, "autopilot-gate.ts"),
    resolve(here, "autopilot-handoff.ts"),
    resolve(here, "server/autopilot-runner.ts"),
    resolve(here, "../../../scripts/vertex-autopilot-tick.ts"),
  ];
  const FORBIDDEN = /broker|ibkr|order|execution|quant-?vps|native|gateway/iu;
  // `@darkfactory/shared/universes` is constants only: its own test proves it imports nothing.
  const ALLOWED_PACKAGES = new Set([
    "@darkfactory/db/server",
    "@darkfactory/shared/universes",
    "@orpc/contract",
    "zod",
  ]);

  const reachable = (): Map<string, string[]> => {
    const seen = new Map<string, string[]>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...source.matchAll(
          /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu
        ),
        ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu),
      ].map((match) => match[1] as string);
      seen.set(file, specifiers);
      for (const specifier of specifiers)
        if (specifier.startsWith("."))
          queue.push(resolve(dirname(file), specifier));
    }
    return seen;
  };

  it("imports no broker, order or execution module, directly or indirectly", () => {
    const graph = reachable();
    expect(graph.size).toBeGreaterThanOrEqual(roots.length);
    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        expect(FORBIDDEN.test(specifier), `${file} imports ${specifier}`).toBe(
          false
        );
        if (!specifier.startsWith("."))
          expect(
            ALLOWED_PACKAGES.has(specifier),
            `${file} imports package ${specifier}`
          ).toBe(true);
      }
    }
  });
});
