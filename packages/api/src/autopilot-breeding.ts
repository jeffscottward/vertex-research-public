// Autopilot breeding: one generation of new, distinct genomes from the current parent pool.
// Tournament selection on in-sample fitness, uniform crossover, mutation and a share of random
// immigrants that keeps the pool diverse. Pure and deterministic for a given random source.

import {
  type AutopilotGenome,
  crossover,
  genomeKey,
  mutate,
  type Random,
  randomGenome,
} from "./autopilot-genome.ts";

export const AUTOPILOT_BREEDING = Object.freeze({
  tournamentSize: 3,
  crossoverRate: 0.7,
  /** Chance that a crossover child is also mutated. */
  mutationRate: 0.35,
  immigrantRate: 0.1,
  /** Tries per wanted child before the generation stops short (all nearby genomes known). */
  attemptsPerChild: 20,
});

export type BreedingParent = Readonly<{
  id: string;
  genome: AutopilotGenome;
  fitness: number;
}>;

export type Offspring = Readonly<{
  genome: AutopilotGenome;
  key: string;
  origin: "random" | "crossover" | "mutation";
  parentIds: readonly string[];
}>;

const tournament = (
  pool: readonly BreedingParent[],
  random: Random
): BreedingParent => {
  let best: BreedingParent | null = null;
  for (let round = 0; round < AUTOPILOT_BREEDING.tournamentSize; round += 1) {
    const entrant = pool[Math.floor(random() * pool.length)] as BreedingParent;
    if (best === null || entrant.fitness > best.fitness) best = entrant;
  }
  return best as BreedingParent;
};

const child = (
  pool: readonly BreedingParent[],
  random: Random
): Omit<Offspring, "key"> => {
  if (pool.length < 2 || random() < AUTOPILOT_BREEDING.immigrantRate)
    return { genome: randomGenome(random), origin: "random", parentIds: [] };
  const left = tournament(pool, random);
  if (random() < AUTOPILOT_BREEDING.crossoverRate) {
    const right = tournament(pool, random);
    const genome = crossover(left.genome, right.genome, random);
    return {
      genome:
        random() < AUTOPILOT_BREEDING.mutationRate
          ? mutate(genome, random)
          : genome,
      origin: "crossover",
      parentIds: left.id === right.id ? [left.id] : [left.id, right.id],
    };
  }
  return {
    genome: mutate(left.genome, random),
    origin: "mutation",
    parentIds: [left.id],
  };
};

/**
 * Breeds up to `count` genomes whose keys are not in `knownKeys` (or repeated in the batch). With
 * fewer than two parents every child is random. Returns fewer when the attempts run out.
 */
export const breedGeneration = (
  input: Readonly<{
    parents: readonly BreedingParent[];
    count: number;
    knownKeys: ReadonlySet<string>;
    random: Random;
  }>
): Offspring[] => {
  const seen = new Set(input.knownKeys);
  const result: Offspring[] = [];
  const attempts = input.count * AUTOPILOT_BREEDING.attemptsPerChild;
  for (
    let tries = 0;
    tries < attempts && result.length < input.count;
    tries += 1
  ) {
    const next = child(input.parents, input.random);
    const key = genomeKey(next.genome);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...next, key });
    }
  }
  return result;
};
