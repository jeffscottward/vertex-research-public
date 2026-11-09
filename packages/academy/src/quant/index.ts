// What: Quant scene dispatcher. A quant scene ({ type: "quant", mode }) is built by the group file
// that owns the mode (quant/<group>.ts); this file routes a mode to its group and merges the groups'
// default element colors and model notes.
import type { ParamValues } from "../position.ts";
import type { DataTable, SceneCtx, SceneData } from "../scene-kit.ts";
import type { ColorToken, QuantMode } from "../schema.ts";
import { GROWTH_COLORS, GROWTH_ELEMENTS, GROWTH_MODELS } from "./growth-ids.ts";
import { growthScene, growthTables } from "./growth.ts";
import { optionsScene, optionsTables } from "./options.ts";
import {
  OPTIONS_COLORS,
  OPTIONS_ELEMENTS,
  OPTIONS_MODELS,
} from "./options-ids.ts";
import { portfolioScene, portfolioTables } from "./portfolio.ts";
import {
  PORTFOLIO_COLORS,
  PORTFOLIO_ELEMENTS,
  PORTFOLIO_MODELS,
} from "./portfolio-ids.ts";
import { processScene, processTables } from "./process.ts";
import {
  PROCESS_COLORS,
  PROCESS_ELEMENTS,
  PROCESS_MODELS,
} from "./process-ids.ts";
import { statisticsScene, statisticsTables } from "./statistics.ts";
import {
  STATISTICS_COLORS,
  STATISTICS_ELEMENTS,
  STATISTICS_MODELS,
} from "./statistics-ids.ts";
import {
  TESTING_COLORS,
  TESTING_ELEMENTS,
  TESTING_MODELS,
} from "./testing-ids.ts";
import { testingScene, testingTables } from "./testing.ts";
import { tradingScene, tradingTables } from "./trading.ts";
import {
  TRADING_COLORS,
  TRADING_ELEMENTS,
  TRADING_MODELS,
} from "./trading-ids.ts";
import { volatilityScene, volatilityTables } from "./volatility.ts";
import {
  VOLATILITY_COLORS,
  VOLATILITY_ELEMENTS,
  VOLATILITY_MODELS,
} from "./volatility-ids.ts";

type GroupScene = (mode: QuantMode, ctx: SceneCtx) => SceneData;
type GroupTables = (
  mode: QuantMode,
  values: ParamValues,
  t: number
) => DataTable[];

type Group = Readonly<{
  colors: Readonly<Record<string, ColorToken>>;
  elements: Readonly<Record<string, readonly string[]>>;
  models: Readonly<Record<string, string>>;
  scene: GroupScene;
  tables: GroupTables;
}>;

const GROUPS: readonly Group[] = [
  {
    colors: PROCESS_COLORS,
    elements: PROCESS_ELEMENTS,
    models: PROCESS_MODELS as Readonly<Record<string, string>>,
    scene: processScene as GroupScene,
    tables: processTables as GroupTables,
  },
  {
    colors: GROWTH_COLORS,
    elements: GROWTH_ELEMENTS,
    models: GROWTH_MODELS as Readonly<Record<string, string>>,
    scene: growthScene as GroupScene,
    tables: growthTables as GroupTables,
  },
  {
    colors: PORTFOLIO_COLORS,
    elements: PORTFOLIO_ELEMENTS,
    models: PORTFOLIO_MODELS as Readonly<Record<string, string>>,
    scene: portfolioScene as GroupScene,
    tables: portfolioTables as GroupTables,
  },
  {
    colors: STATISTICS_COLORS,
    elements: STATISTICS_ELEMENTS,
    models: STATISTICS_MODELS as Readonly<Record<string, string>>,
    scene: statisticsScene as GroupScene,
    tables: statisticsTables as GroupTables,
  },
  {
    colors: TESTING_COLORS,
    elements: TESTING_ELEMENTS,
    models: TESTING_MODELS as Readonly<Record<string, string>>,
    scene: testingScene as GroupScene,
    tables: testingTables as GroupTables,
  },
  {
    colors: VOLATILITY_COLORS,
    elements: VOLATILITY_ELEMENTS,
    models: VOLATILITY_MODELS as Readonly<Record<string, string>>,
    scene: volatilityScene as GroupScene,
    tables: volatilityTables as GroupTables,
  },
  {
    colors: TRADING_COLORS,
    elements: TRADING_ELEMENTS,
    models: TRADING_MODELS as Readonly<Record<string, string>>,
    scene: tradingScene as GroupScene,
    tables: tradingTables as GroupTables,
  },
  {
    colors: OPTIONS_COLORS,
    elements: OPTIONS_ELEMENTS,
    models: OPTIONS_MODELS as Readonly<Record<string, string>>,
    scene: optionsScene as GroupScene,
    tables: optionsTables as GroupTables,
  },
];

const groupOf = (mode: QuantMode): Group =>
  GROUPS.find((group) => Object.hasOwn(group.elements, mode)) as Group;

/** Default colors of every quant element id (first group to name an id wins). */
export const QUANT_COLORS: Readonly<Record<string, ColorToken>> = Object.assign(
  {},
  ...[...GROUPS].reverse().map((group) => group.colors)
) as Record<string, ColorToken>;

/** Model and assumptions line of a quant mode for the constants table. */
export const quantModel = (mode: QuantMode): string =>
  groupOf(mode).models[mode] as string;

/** Scene of a quant mode at param values and time fraction ctx.t. */
export const quantScene = (mode: QuantMode, ctx: SceneCtx): SceneData =>
  groupOf(mode).scene(mode, ctx);

/** Mode-specific tables of a quant lesson. */
export const quantTables = (
  mode: QuantMode,
  values: ParamValues,
  t: number
): DataTable[] => groupOf(mode).tables(mode, values, t);
