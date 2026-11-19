// Chart geometry of the dossier payoff lab (merge plan P1-6). Pure: it maps the selected payoffs
// to a unit square (x and y from 0 to 100, as percentages of the plot box), so the component can
// draw one stretched SVG and place HTML labels by percentage at any page width. Research only.
import { scaleLinear } from "d3-scale";

import type { AvailablePayoff } from "./payoff.ts";

export type ChartLine = Readonly<{
  key: string;
  /** The line number that the picker and the table show. */
  number: number;
  payoff: AvailablePayoff;
}>;

export type ChartTick = Readonly<{ position: number; value: number }>;

export type PayoffGeometry = Readonly<{
  paths: readonly Readonly<{
    key: string;
    number: number;
    /** SVG path data in the unit square. */
    d: string;
    /** The y of the number badge at the right edge, kept apart from the other badges. */
    badgeY: number;
  }>[];
  /** The y of zero profit. */
  zeroY: number;
  /** The x of the price at expiry; `null` when there is no price or it is outside the axis. */
  markerX: number | null;
  xTicks: readonly ChartTick[];
  yTicks: readonly ChartTick[];
}>;

const UNIT = 100;
const TICKS = 5;
const BADGE_GAP = 7;

const round = (value: number): number => Math.round(value * 100) / 100;

/** The points of one line: the axis ends and every knot between them. The payoff is linear between. */
const linePoints = (
  payoff: AvailablePayoff,
  min: number,
  max: number
): readonly Readonly<{ price: number; value: number }>[] =>
  [
    min,
    ...payoff.knots.filter((knot) => knot > min && knot < max),
    max,
  ].flatMap((price) => {
    const value = payoff.at(price);
    return value === null ? [] : [{ price, value }];
  });

/**
 * Gives every item its badge y: its end y, placed top to bottom at least `BADGE_GAP` apart. Badges
 * that would pass the bottom of the plot are then moved up, bottom to top, with the same gap.
 */
const withBadges = <T extends Readonly<{ endY: number }>>(
  items: readonly T[]
): readonly (T & Readonly<{ badgeY: number }>)[] => {
  let floor = Number.NEGATIVE_INFINITY;
  let ceiling = UNIT;
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.endY - b.item.endY)
    .map(({ item, order }) => {
      floor = Math.max(item.endY, floor + BADGE_GAP);
      return { badgeY: floor, item, order };
    })
    .reverse()
    .map(({ badgeY, item, order }) => {
      const placed = Math.min(badgeY, ceiling);
      ceiling = placed - BADGE_GAP;
      return { order, placed: { ...item, badgeY: placed } };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ placed }) => placed);
};

export const payoffGeometry = (
  input: Readonly<{
    lines: readonly ChartLine[];
    min: number;
    max: number;
    price: number | null;
  }>
): PayoffGeometry => {
  const { lines, max, min, price } = input;
  const series = lines.map((line) => ({
    line,
    points: linePoints(line.payoff, min, max),
  }));
  const values = series.flatMap(({ points }) =>
    points.map((point) => point.value)
  );
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const x = scaleLinear().domain([min, max]).range([0, UNIT]);
  const y = scaleLinear()
    .domain(low === high ? [low - 1, high + 1] : [low, high])
    .nice(TICKS)
    .range([UNIT, 0]);
  const drawn = withBadges(
    series.map(({ line, points }) => ({
      d: points
        .map(
          (point, position) =>
            `${position === 0 ? "M" : "L"}${round(x(point.price))} ${round(y(point.value))}`
        )
        .join(" "),
      endY: y(points.at(-1)?.value ?? 0),
      key: line.key,
      number: line.number,
    }))
  );
  return {
    markerX:
      price === null || price < min || price > max ? null : round(x(price)),
    paths: drawn.map(({ badgeY, d, key, number }) => ({
      badgeY: round(badgeY),
      d,
      key,
      number,
    })),
    xTicks: x
      .ticks(TICKS)
      .map((value) => ({ position: round(x(value)), value })),
    yTicks: y
      .ticks(TICKS)
      .map((value) => ({ position: round(y(value)), value })),
    zeroY: round(y(0)),
  };
};
