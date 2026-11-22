// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { returnStats } from "../../features/charts/bar-analysis.ts";
import {
  ReturnHistogram,
  ReturnStatsTable,
  SessionTable,
} from "./charts-analysis-panels.tsx";

const cells = (markup: string) => {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return [...host.querySelectorAll("tbody td")].map((cell) => ({
    text: cell.textContent,
    title: cell.getAttribute("title"),
  }));
};

const statsCells = (values: readonly number[]) =>
  cells(renderToStaticMarkup(<ReturnStatsTable stats={returnStats(values)} />));

describe("ReturnStatsTable", () => {
  it("shows every statistic of a full sample without a title", () => {
    expect(statsCells([0.01, -0.02, 0.03])).toEqual([
      { text: "3", title: null },
      { text: "+0.667%", title: null },
      { text: "+2.517%", title: null },
      { text: "-0.586", title: null },
      { text: "-2.000%", title: null },
      { text: "+3.000%", title: null },
    ]);
  });

  it("names the cause of every empty statistic when there are no returns", () => {
    expect(statsCells([])).toEqual([
      { text: "0", title: null },
      {
        text: "no returns",
        title: "0 returns in range; mean needs at least 1",
      },
      {
        text: "too few bars",
        title: "0 returns in range; stdev needs at least 2",
      },
      {
        text: "too few bars",
        title: "0 returns in range; skew needs at least 3",
      },
      { text: "no returns", title: "0 returns in range; min needs at least 1" },
      { text: "no returns", title: "0 returns in range; max needs at least 1" },
    ]);
  });

  it("says too few bars for stdev and skew of one or two returns", () => {
    const one = statsCells([0.01]);
    expect(one[2]).toEqual({
      text: "too few bars",
      title: "1 return in range; stdev needs at least 2",
    });
    expect(one[3]).toEqual({
      text: "too few bars",
      title: "1 return in range; skew needs at least 3",
    });
    const two = statsCells([0.01, 0.02]);
    expect(two[2]?.title).toBeNull();
    expect(two[3]).toEqual({
      text: "too few bars",
      title: "2 returns in range; skew needs at least 3",
    });
  });

  it("says zero variance for the skew of equal returns", () => {
    expect(statsCells([0.01, 0.01, 0.01])[3]).toEqual({
      text: "zero variance",
      title: "all 3 returns are equal",
    });
    expect(statsCells([0.1, 0.1, 0.1])[3]).toEqual({
      text: "zero variance",
      title: "all 3 returns are equal",
    });
  });

  it("claims zero variance only for the skew; another null statistic says it was not computed", () => {
    const stats = {
      count: 4,
      max: null,
      mean: null,
      min: null,
      skew: null,
      stdev: null,
    };
    expect(
      cells(renderToStaticMarkup(<ReturnStatsTable stats={stats} />))
    ).toEqual([
      { text: "4", title: null },
      {
        text: "not computed",
        title: "4 returns in range; mean was not computed",
      },
      {
        text: "not computed",
        title: "4 returns in range; stdev was not computed",
      },
      { text: "zero variance", title: "all 4 returns are equal" },
      {
        text: "not computed",
        title: "4 returns in range; min was not computed",
      },
      {
        text: "not computed",
        title: "4 returns in range; max was not computed",
      },
    ]);
  });

  it("names a skew that is not finite instead of printing it", () => {
    const stats = { ...returnStats([0.01, -0.02, 0.03]), skew: Number.NaN };
    const row = cells(renderToStaticMarkup(<ReturnStatsTable stats={stats} />));
    expect(row[3]).toEqual({ text: "not finite", title: null });
    const infinite = { ...stats, skew: Number.POSITIVE_INFINITY };
    expect(
      cells(renderToStaticMarkup(<ReturnStatsTable stats={infinite} />))[3]
    ).toEqual({ text: "not finite", title: null });
  });

  it("never shows a dash", () => {
    for (const values of [[], [0.01], [0.01, 0.01, 0.01]]) {
      for (const cell of statsCells(values)) {
        expect(cell.text).not.toContain("\u2014");
      }
    }
  });
});

describe("ReturnHistogram and SessionTable", () => {
  it("formats finite bin edges and names an edge that is not finite", () => {
    const markup = renderToStaticMarkup(
      <ReturnHistogram
        bins={[
          { from: -0.01, to: 0.02, count: 3 },
          { from: Number.NEGATIVE_INFINITY, to: Number.NaN, count: 1 },
        ]}
      />
    );
    const host = document.createElement("div");
    host.innerHTML = markup;
    const heads = [...host.querySelectorAll("tbody th")].map(
      (head) => head.textContent
    );
    expect(heads).toEqual(["-1.00% to +2.00%", "not finite to not finite"]);
  });

  it("names a session mean that is not finite", () => {
    const markup = renderToStaticMarkup(
      <SessionTable
        keyLabel="Weekday"
        kind="weekday"
        title="By weekday"
        rows={[
          {
            key: 1,
            label: "Mon",
            count: 2,
            meanReturn: 0.001,
            positiveShare: 0.5,
          },
          {
            key: 2,
            label: "Tue",
            count: 1,
            meanReturn: Number.NaN,
            positiveShare: 1,
          },
        ]}
      />
    );
    const texts = cells(markup).map((cell) => cell.text);
    expect(texts).toEqual([
      "2",
      "+0.100%",
      "50.0%",
      "1",
      "not finite",
      "100.0%",
    ]);
  });
});
