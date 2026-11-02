// Autopilot genome: a strategy definition (see strategy-dsl.ts) built from fixed building blocks
// with numeric parameters on a grid. Breeding (random generation, crossover, mutation) and the
// parameter neighbourhood used by the refine step work on genomes; the backtest engine sees only the
// compiled definition. Pure and deterministic for a given random source. Research only.

import { at } from "./quant-arrays.ts";
import {
  STRATEGY_DSL_VERSION,
  type StrategyCondition,
  type StrategyDefinition,
  StrategyDefinitionSchema,
  type StrategyExpr,
} from "./strategy-dsl.ts";

export type Random = () => number;

export const AUTOPILOT_ENTRY_MAX = 3;
export const AUTOPILOT_EXIT_MAX = 2;
const AUTOPILOT_NEIGHBOURS_MAX = 12;

type ParamSpec = Readonly<{
  name: string;
  min: number;
  max: number;
  step: number;
}>;
type Role = "entry" | "exit" | "stop" | "target";

const length = (
  name: string,
  min: number,
  max: number,
  step = 1
): ParamSpec => ({
  max,
  min,
  name,
  step,
});

const close: StrategyExpr = { field: "close", type: "price" };
const indicator = (
  name: "sma" | "ema" | "rsi" | "atr" | "highest" | "lowest",
  value: number
): StrategyExpr => ({
  length: value,
  name,
  source: "close",
  type: "indicator",
});
const constant = (value: number): StrategyExpr => ({ type: "const", value });

type ConditionBlock = Readonly<{
  role: "entry" | "exit";
  title: string;
  params: readonly ParamSpec[];
  /** Two length parameters where the first must be shorter than the second. */
  ordered?: true;
  condition: (params: readonly number[]) => StrategyCondition;
}>;
type LevelBlock = Readonly<{
  role: "stop" | "target";
  title: string;
  params: readonly ParamSpec[];
  level: (params: readonly number[]) => StrategyDefinition["stopLoss"];
}>;

const p = (params: readonly number[], index: number): number =>
  at(params, index);

const CONDITION_BLOCKS = {
  breakout: {
    condition: (v) => ({
      left: close,
      op: ">",
      right: indicator("highest", p(v, 0)),
    }),
    params: [length("length", 10, 120, 5)],
    role: "entry",
    title: "Close above prior high",
  },
  dip: {
    condition: (v) => ({
      left: close,
      op: "<",
      right: indicator("lowest", p(v, 0)),
    }),
    params: [length("length", 5, 60, 5)],
    role: "entry",
    title: "Close below prior low",
  },
  emaCross: {
    condition: (v) => ({
      left: indicator("ema", p(v, 0)),
      op: "crossesAbove",
      right: indicator("sma", p(v, 1)),
    }),
    ordered: true,
    params: [length("fast", 5, 60, 5), length("slow", 20, 250, 10)],
    role: "entry",
    title: "EMA crosses above SMA",
  },
  exitAboveSma: {
    condition: (v) => ({
      left: close,
      op: ">",
      right: indicator("sma", p(v, 0)),
    }),
    params: [length("length", 3, 50, 1)],
    role: "exit",
    title: "Exit: close above SMA",
  },
  exitBelowEma: {
    condition: (v) => ({
      left: close,
      op: "crossesBelow",
      right: indicator("ema", p(v, 0)),
    }),
    params: [length("length", 5, 100, 5)],
    role: "exit",
    title: "Exit: close crosses below EMA",
  },
  exitBelowSma: {
    condition: (v) => ({
      left: close,
      op: "<",
      right: indicator("sma", p(v, 0)),
    }),
    params: [length("length", 5, 200, 5)],
    role: "exit",
    title: "Exit: close below SMA",
  },
  exitLow: {
    condition: (v) => ({
      left: close,
      op: "<",
      right: indicator("lowest", p(v, 0)),
    }),
    params: [length("length", 5, 60, 5)],
    role: "exit",
    title: "Exit: close below prior low",
  },
  exitRsiHigh: {
    condition: (v) => ({
      left: indicator("rsi", p(v, 0)),
      op: ">",
      right: constant(p(v, 1)),
    }),
    params: [length("length", 2, 21, 1), length("level", 55, 95, 5)],
    role: "exit",
    title: "Exit: RSI above level",
  },
  maStack: {
    condition: (v) => ({
      left: indicator("ema", p(v, 0)),
      op: ">",
      right: indicator("sma", p(v, 1)),
    }),
    ordered: true,
    params: [length("fast", 5, 60, 5), length("slow", 20, 250, 10)],
    role: "entry",
    title: "EMA above SMA",
  },
  rsiDip: {
    condition: (v) => ({
      left: indicator("rsi", p(v, 0)),
      op: "<",
      right: constant(p(v, 1)),
    }),
    params: [length("length", 2, 21, 1), length("level", 5, 45, 5)],
    role: "entry",
    title: "RSI below level",
  },
  rsiMomentum: {
    condition: (v) => ({
      left: indicator("rsi", p(v, 0)),
      op: ">",
      right: constant(p(v, 1)),
    }),
    params: [length("length", 5, 30, 1), length("level", 50, 75, 5)],
    role: "entry",
    title: "RSI above level",
  },
  trendEma: {
    condition: (v) => ({
      left: close,
      op: ">",
      right: indicator("ema", p(v, 0)),
    }),
    params: [length("length", 20, 250, 10)],
    role: "entry",
    title: "Close above EMA",
  },
  trendSma: {
    condition: (v) => ({
      left: close,
      op: ">",
      right: indicator("sma", p(v, 0)),
    }),
    params: [length("length", 20, 250, 10)],
    role: "entry",
    title: "Close above SMA",
  },
  volExpansion: {
    condition: (v) => ({
      left: indicator("atr", p(v, 0)),
      op: ">",
      right: indicator("atr", p(v, 1)),
    }),
    ordered: true,
    params: [length("fast", 3, 20, 1), length("slow", 20, 100, 5)],
    role: "entry",
    title: "Short ATR above long ATR",
  },
} as const satisfies Record<string, ConditionBlock>;

const LEVEL_BLOCKS = {
  stopAtr: {
    level: (v) => ({ kind: "atr", length: p(v, 0), multiple: p(v, 1) }),
    params: [length("length", 5, 30, 1), length("multiple", 1, 6, 0.25)],
    role: "stop",
    title: "ATR stop",
  },
  stopPct: {
    level: (v) => ({ kind: "pct", pct: p(v, 0) }),
    params: [length("pct", 1, 15, 0.5)],
    role: "stop",
    title: "Percent stop",
  },
  targetAtr: {
    level: (v) => ({ kind: "atr", length: p(v, 0), multiple: p(v, 1) }),
    params: [length("length", 5, 30, 1), length("multiple", 1, 10, 0.5)],
    role: "target",
    title: "ATR target",
  },
  targetPct: {
    level: (v) => ({ kind: "pct", pct: p(v, 0) }),
    params: [length("pct", 2, 40, 1)],
    role: "target",
    title: "Percent target",
  },
} as const satisfies Record<string, LevelBlock>;

type ConditionBlockId = keyof typeof CONDITION_BLOCKS;
type LevelBlockId = keyof typeof LEVEL_BLOCKS;
export type AutopilotBlockId = ConditionBlockId | LevelBlockId;

export const AUTOPILOT_BLOCKS: Readonly<
  Record<AutopilotBlockId, ConditionBlock | LevelBlock>
> = { ...CONDITION_BLOCKS, ...LEVEL_BLOCKS };
export const AUTOPILOT_BLOCK_IDS = Object.keys(AUTOPILOT_BLOCKS).sort() as [
  AutopilotBlockId,
  ...AutopilotBlockId[],
];

export type AutopilotGene = Readonly<{
  block: AutopilotBlockId;
  params: readonly number[];
}>;
export type AutopilotGenome = Readonly<{
  entry: readonly AutopilotGene[];
  exit: readonly AutopilotGene[];
  stop: AutopilotGene | null;
  target: AutopilotGene | null;
}>;

const blocksFor = (role: Role): AutopilotBlockId[] =>
  AUTOPILOT_BLOCK_IDS.filter((id) => AUTOPILOT_BLOCKS[id].role === role);

const pick = <T>(values: readonly T[], random: Random): T =>
  at(values, Math.floor(random() * values.length));

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

const quantize = (spec: ParamSpec, value: number): number => {
  const steps = Math.round((value - spec.min) / spec.step);
  const maxSteps = Math.round((spec.max - spec.min) / spec.step);
  return round(spec.min + Math.min(maxSteps, Math.max(0, steps)) * spec.step);
};

/** Clamps every parameter to its grid and keeps ordered pairs strictly increasing. */
export const normalizeGene = (gene: AutopilotGene): AutopilotGene => {
  const block = AUTOPILOT_BLOCKS[gene.block];
  const params = block.params.map((spec, index) =>
    quantize(spec, gene.params[index] ?? spec.min)
  );
  if ("ordered" in block) {
    const slowSpec = block.params[1] as ParamSpec;
    const fast = p(params, 0);
    let slow = p(params, 1);
    // Every ordered block has fast.max < slow.max, so moving the slow length up always works.
    if (fast >= slow) slow = quantize(slowSpec, fast + slowSpec.step);
    return { block: gene.block, params: [fast, slow] };
  }
  return { block: gene.block, params };
};

const randomGene = (block: AutopilotBlockId, random: Random): AutopilotGene =>
  normalizeGene({
    block,
    params: AUTOPILOT_BLOCKS[block].params.map((spec) =>
      quantize(spec, spec.min + random() * (spec.max - spec.min))
    ),
  });

const uniqueBlocks = (genes: readonly AutopilotGene[]): AutopilotGene[] => {
  const seen = new Set<AutopilotBlockId>();
  return genes.filter((gene) => {
    if (seen.has(gene.block)) return false;
    seen.add(gene.block);
    return true;
  });
};

const randomGenes = (role: "entry" | "exit", count: number, random: Random) => {
  const pool = [...blocksFor(role)];
  const genes: AutopilotGene[] = [];
  for (let index = 0; index < count; index += 1) {
    const block = pick(pool, random);
    pool.splice(pool.indexOf(block), 1);
    genes.push(randomGene(block, random));
  }
  return genes;
};

export const randomGenome = (random: Random): AutopilotGenome => {
  const entryCount = random() < 0.5 ? 1 : random() < 0.7 ? 2 : 3;
  const exitCount = Math.floor(random() * (AUTOPILOT_EXIT_MAX + 1));
  return {
    entry: randomGenes("entry", entryCount, random),
    exit: randomGenes("exit", exitCount, random),
    stop:
      random() < 0.5
        ? randomGene(pick(blocksFor("stop"), random), random)
        : null,
    target:
      random() < 0.3
        ? randomGene(pick(blocksFor("target"), random), random)
        : null,
  };
};

const inheritGenes = (
  left: readonly AutopilotGene[],
  right: readonly AutopilotGene[],
  min: number,
  max: number,
  random: Random
): AutopilotGene[] => {
  const pool = uniqueBlocks(
    random() < 0.5 ? [...left, ...right] : [...right, ...left]
  );
  const low = Math.max(min, Math.min(left.length, right.length));
  const high = Math.min(max, pool.length);
  const count = low + Math.floor(random() * (high - low + 1));
  const chosen: AutopilotGene[] = [];
  const remaining = [...pool];
  while (chosen.length < count) {
    const gene = pick(remaining, random);
    remaining.splice(remaining.indexOf(gene), 1);
    chosen.push(gene);
  }
  return chosen;
};

/** Uniform crossover: genes of the child come from either parent; one block occurs once. */
export const crossover = (
  left: AutopilotGenome,
  right: AutopilotGenome,
  random: Random
): AutopilotGenome => ({
  entry: inheritGenes(left.entry, right.entry, 1, AUTOPILOT_ENTRY_MAX, random),
  exit: inheritGenes(left.exit, right.exit, 0, AUTOPILOT_EXIT_MAX, random),
  stop: random() < 0.5 ? left.stop : right.stop,
  target: random() < 0.5 ? left.target : right.target,
});

const shiftParam = (gene: AutopilotGene, random: Random): AutopilotGene => {
  const block = AUTOPILOT_BLOCKS[gene.block];
  const index = Math.floor(random() * block.params.length);
  const spec = block.params[index] as ParamSpec;
  const span = Math.max(
    1,
    Math.round((0.15 * (spec.max - spec.min)) / spec.step)
  );
  const steps = 1 + Math.floor(random() * span);
  const delta = (random() < 0.5 ? -steps : steps) * spec.step;
  const params = gene.params.map((value, position) =>
    position === index ? value + delta : value
  );
  return normalizeGene({ block: gene.block, params });
};

const replaceAt = <T>(values: readonly T[], index: number, value: T): T[] =>
  values.map((current, position) => (position === index ? value : current));

const mutateList = (
  genes: readonly AutopilotGene[],
  role: "entry" | "exit",
  min: number,
  max: number,
  random: Random
): AutopilotGene[] => {
  const roll = random();
  const unused = blocksFor(role).filter(
    (block) => !genes.some((gene) => gene.block === block)
  );
  if (roll < 0.2 && genes.length < max && unused.length > 0)
    return [...genes, randomGene(pick(unused, random), random)];
  if (roll < 0.35 && genes.length > min) {
    const index = Math.floor(random() * genes.length);
    return genes.filter((_, position) => position !== index);
  }
  if (genes.length === 0) return [...genes];
  const index = Math.floor(random() * genes.length);
  if (roll < 0.5 && unused.length > 0)
    return replaceAt(genes, index, randomGene(pick(unused, random), random));
  return replaceAt(
    genes,
    index,
    shiftParam(genes[index] as AutopilotGene, random)
  );
};

const mutateLevel = (
  gene: AutopilotGene | null,
  role: "stop" | "target",
  random: Random
): AutopilotGene | null => {
  const roll = random();
  if (gene === null) return randomGene(pick(blocksFor(role), random), random);
  if (roll < 0.25) return null;
  if (roll < 0.4) return randomGene(pick(blocksFor(role), random), random);
  return shiftParam(gene, random);
};

/** Changes one part of the genome: an entry gene, an exit gene, the stop or the target. */
export const mutate = (
  genome: AutopilotGenome,
  random: Random
): AutopilotGenome => {
  const roll = random();
  if (roll < 0.55)
    return {
      ...genome,
      entry: mutateList(genome.entry, "entry", 1, AUTOPILOT_ENTRY_MAX, random),
    };
  if (roll < 0.8)
    return {
      ...genome,
      exit: mutateList(genome.exit, "exit", 0, AUTOPILOT_EXIT_MAX, random),
    };
  if (roll < 0.9)
    return { ...genome, stop: mutateLevel(genome.stop, "stop", random) };
  return { ...genome, target: mutateLevel(genome.target, "target", random) };
};

const sortGenes = (genes: readonly AutopilotGene[]): AutopilotGene[] =>
  [...genes].sort((left, right) => left.block.localeCompare(right.block));

/** Canonical text of a genome: equal strategies get equal keys whatever the gene order. */
export const genomeKey = (genome: AutopilotGenome): string =>
  JSON.stringify({
    entry: sortGenes(genome.entry).map((gene) => [gene.block, ...gene.params]),
    exit: sortGenes(genome.exit).map((gene) => [gene.block, ...gene.params]),
    stop:
      genome.stop === null ? null : [genome.stop.block, ...genome.stop.params],
    target:
      genome.target === null
        ? null
        : [genome.target.block, ...genome.target.params],
  });

const geneLabel = (gene: AutopilotGene): string =>
  `${gene.block}(${gene.params.join(",")})`;

/** Short readable label, for example "trendSma(200) + rsiDip(2,10) / exitAboveSma(5)". */
export const genomeLabel = (genome: AutopilotGenome): string => {
  const entry = sortGenes(genome.entry).map(geneLabel).join(" + ");
  const exits = [
    ...sortGenes(genome.exit).map(geneLabel),
    ...(genome.stop === null ? [] : [geneLabel(genome.stop)]),
    ...(genome.target === null ? [] : [geneLabel(genome.target)]),
  ];
  return exits.length === 0 ? entry : `${entry} / ${exits.join(" + ")}`;
};

const conditionOf = (gene: AutopilotGene): StrategyCondition =>
  (AUTOPILOT_BLOCKS[gene.block] as ConditionBlock).condition(gene.params);
const levelOf = (gene: AutopilotGene | null): StrategyDefinition["stopLoss"] =>
  gene === null
    ? { kind: "none" }
    : (AUTOPILOT_BLOCKS[gene.block] as LevelBlock).level(gene.params);

/** Builds the strategy definition. Long only, all-in sizing, as every DSL definition. */
export const genomeDefinition = (
  genome: AutopilotGenome,
  name: string
): StrategyDefinition =>
  StrategyDefinitionSchema.parse({
    description: `Autopilot candidate: ${genomeLabel(genome)}`.slice(0, 2000),
    entry: { all: sortGenes(genome.entry).map(conditionOf) },
    exit: { any: sortGenes(genome.exit).map(conditionOf) },
    name: name.slice(0, 120),
    sizing: { mode: "allIn" },
    stopLoss: levelOf(genome.stop),
    takeProfit: levelOf(genome.target),
    version: STRATEGY_DSL_VERSION,
  });

const neighbourStep = (spec: ParamSpec, value: number): number =>
  Math.max(spec.step, quantize({ ...spec, min: 0 }, Math.abs(value) * 0.1));

type Slot = Readonly<
  | { kind: "entry" | "exit"; index: number; gene: AutopilotGene }
  | { kind: "stop" | "target"; gene: AutopilotGene }
>;

const withGene = (
  genome: AutopilotGenome,
  slot: Slot,
  gene: AutopilotGene
): AutopilotGenome => {
  if (slot.kind === "entry")
    return { ...genome, entry: replaceAt(genome.entry, slot.index, gene) };
  if (slot.kind === "exit")
    return { ...genome, exit: replaceAt(genome.exit, slot.index, gene) };
  return { ...genome, [slot.kind]: gene };
};

/**
 * Parameter neighbourhood for the refine step: each parameter moved down and up by about 10% (at
 * least one grid step), one parameter at a time. Distinct genomes only, at most `limit`.
 */
export const genomeNeighbours = (
  genome: AutopilotGenome,
  limit = AUTOPILOT_NEIGHBOURS_MAX
): AutopilotGenome[] => {
  const slots: Slot[] = [
    ...genome.entry.map((gene, index) => ({
      gene,
      index,
      kind: "entry" as const,
    })),
    ...genome.exit.map((gene, index) => ({
      gene,
      index,
      kind: "exit" as const,
    })),
    ...(genome.stop === null
      ? []
      : [{ gene: genome.stop, kind: "stop" as const }]),
    ...(genome.target === null
      ? []
      : [{ gene: genome.target, kind: "target" as const }]),
  ];
  const seen = new Set([genomeKey(genome)]);
  const result: AutopilotGenome[] = [];
  for (const slot of slots) {
    AUTOPILOT_BLOCKS[slot.gene.block].params.forEach((spec, index) => {
      const value = p(slot.gene.params, index);
      const step = neighbourStep(spec, value);
      for (const delta of [-step, step]) {
        const params = replaceAt(slot.gene.params, index, value + delta);
        const next = withGene(
          genome,
          slot,
          normalizeGene({ block: slot.gene.block, params })
        );
        const key = genomeKey(next);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(next);
        }
      }
    });
  }
  return result.slice(0, limit);
};
