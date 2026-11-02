import { describe, expect, it } from "vitest";

import { AUTOPILOT_BREEDING, breedGeneration } from "./autopilot-breeding.ts";
import {
  type AutopilotGenome,
  genomeKey,
  randomGenome,
} from "./autopilot-genome.ts";
import { createRandom } from "./backtest-analytics.ts";

const parents = (count: number) => {
  const random = createRandom(7);
  return Array.from({ length: count }, (_, index) => ({
    fitness: index,
    genome: randomGenome(random),
    id: `p${index}`,
  }));
};

describe("autopilot breeding", () => {
  it("starts with random genomes when there are fewer than two parents", () => {
    const children = breedGeneration({
      count: 12,
      knownKeys: new Set(),
      parents: parents(1),
      random: createRandom(1),
    });
    expect(children).toHaveLength(12);
    expect(children.every((child) => child.origin === "random")).toBe(true);
    expect(children.every((child) => child.parentIds.length === 0)).toBe(true);
    expect(new Set(children.map((child) => child.key)).size).toBe(12);
  });

  it("breeds distinct children from the parent pool and skips known genomes", () => {
    const pool = parents(10);
    const known = new Set(pool.map((parent) => genomeKey(parent.genome)));
    const children = breedGeneration({
      count: 60,
      knownKeys: known,
      parents: pool,
      random: createRandom(3),
    });
    expect(children).toHaveLength(60);
    const origins = new Set(children.map((child) => child.origin));
    expect(origins).toEqual(new Set(["random", "crossover", "mutation"]));
    for (const child of children) {
      expect(known.has(child.key)).toBe(false);
      expect(child.key).toBe(genomeKey(child.genome));
      for (const id of child.parentIds)
        expect(pool.map((parent) => parent.id)).toContain(id);
    }
    expect(new Set(children.map((child) => child.key)).size).toBe(60);
    // Tournament selection favours fit parents: the fittest parent is used more than the least fit.
    const uses = (id: string) =>
      children.filter((child) => child.parentIds.includes(id)).length;
    expect(uses("p9")).toBeGreaterThan(uses("p0"));
  });

  it("records one parent when the tournament picks the same parent twice", () => {
    const one: AutopilotGenome = {
      entry: [{ block: "trendSma", params: [100] }],
      exit: [],
      stop: null,
      target: null,
    };
    const pool = [
      { fitness: 1, genome: one, id: "a" },
      { fitness: 0, genome: one, id: "b" },
    ];
    const children = breedGeneration({
      count: 30,
      knownKeys: new Set([genomeKey(one)]),
      parents: pool,
      random: createRandom(11),
    });
    expect(
      children.some(
        (child) => child.origin === "crossover" && child.parentIds.length === 1
      )
    ).toBe(true);
  });

  it("stops short when every attempt repeats a known genome", () => {
    const one: AutopilotGenome = {
      entry: [{ block: "trendSma", params: [100] }],
      exit: [],
      stop: null,
      target: null,
    };
    let calls = 0;
    // Random source that always returns 0.99: no immigrant, no crossover, the same mutation.
    const children = breedGeneration({
      count: 3,
      knownKeys: new Set(),
      parents: [
        { fitness: 1, genome: one, id: "a" },
        { fitness: 1, genome: one, id: "b" },
      ],
      random: () => {
        calls += 1;
        return 0.99;
      },
    });
    expect(children).toHaveLength(1);
    expect(calls).toBeGreaterThan(3 * AUTOPILOT_BREEDING.attemptsPerChild);
  });
});
