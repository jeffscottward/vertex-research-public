import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMarketBarsRepository,
  createNodeDatabase,
  type MarketBarRow,
  type MarketBarSeriesInput,
  type MarketBarsRepository,
} from "@darkfactory/db/server";
import type { Page } from "@playwright/test";

import { e2eEnvironment } from "./env.ts";
import { E2E_IDENTITIES, expect, signInAs, test } from "./fixtures.ts";
import { resetDatabase } from "./helpers/database.ts";

// Evidence run, not a gate: measures browser latency of the instant backtest on real stored
// history. It runs only when INSTANT_BACKTEST_EVIDENCE_DIR names a folder with the normalized
// bar files (<symbol>-<timeframe>.csv plus .manifest.json, see scripts/vertex-market-bars-import.ts)
// and writes browser-latency.json there. Latency = parameter change to rendered result.
//   warm: bars already cached on the server; each run changes one parameter
//   cold: the series is re-imported before each run, so the server reloads all bars from Postgres

const EVIDENCE_DIR = process.env["INSTANT_BACKTEST_EVIDENCE_DIR"] ?? "";
const SERIES = ["SPY-1d", "BTCUSDT-1m"] as const;
const RUNS = 10;

test.skip(
  EVIDENCE_DIR === "",
  "Evidence run only (INSTANT_BACKTEST_EVIDENCE_DIR)"
);

const readSeries = (name: string) => {
  const manifest = JSON.parse(
    readFileSync(join(EVIDENCE_DIR, `${name}.manifest.json`), "utf8")
  ) as MarketBarSeriesInput;
  const rows = readFileSync(join(EVIDENCE_DIR, `${name}.csv`), "utf8")
    .trim()
    .split("\n")
    .slice(1);
  const bars: MarketBarRow[] = rows.map((line) => {
    const [t, o, h, l, c, v] = line.split(",");
    return {
      t: Number(t),
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: v === undefined || v === "" ? null : Number(v),
    };
  });
  const series: MarketBarSeriesInput = {
    symbol: manifest.symbol,
    timeframe: manifest.timeframe,
    source: manifest.source,
    sourceSha256: manifest.sourceSha256,
  };
  return { series, bars };
};

const withRepository = async <Result>(
  work: (repository: MarketBarsRepository) => Promise<Result>
): Promise<Result> => {
  const resource = createNodeDatabase({
    connectionString: e2eEnvironment().databaseUrl,
    maxConnections: 1,
  });
  try {
    return await work(createMarketBarsRepository(resource.db));
  } finally {
    await resource.close();
  }
};

/** Changes one number field in the page and returns ms until the new result is rendered. */
const measureChange = (page: Page, label: string, value: number) =>
  page.evaluate(
    async ({ fieldLabel, nextValue }) => {
      const target = [...document.querySelectorAll("label")].find(
        (node) => node.textContent === fieldLabel
      );
      const input = document.getElementById(target?.htmlFor ?? "");
      const status = document.querySelector("[data-instant-status]");
      if (
        !(input instanceof HTMLInputElement && status instanceof HTMLElement)
      ) {
        throw new Error("instant backtest controls not found");
      }
      const done = new Promise<number>((resolve) => {
        let sawRunning = false;
        const observer = new MutationObserver(() => {
          const state = status.dataset["instantStatus"];
          if (state === "running") sawRunning = true;
          if (sawRunning && state === "ready") {
            observer.disconnect();
            resolve(performance.now());
          }
        });
        observer.observe(status, { attributes: true });
      });
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      const started = performance.now();
      setter?.call(input, String(nextValue));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return (await done) - started;
    },
    { fieldLabel: label, nextValue: value }
  );

const summarize = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  const middle = sorted.length / 2;
  return {
    samplesMs: samples.map(round),
    medianMs: round(
      ((sorted[Math.floor((sorted.length - 1) / 2)] as number) +
        (sorted[Math.floor(middle)] as number)) /
        2
    ),
    p95Ms: round(
      sorted[
        Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
      ] as number
    ),
  };
};

test("browser latency on real stored history", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await resetDatabase();
  const loaded = SERIES.map(readSeries);
  await withRepository(async (repository) => {
    for (const entry of loaded)
      await repository.replaceSeries(entry.series, entry.bars);
  });
  await signInAs(page, E2E_IDENTITIES.alice);
  await page.goto("/instant-backtest");
  const status = page.locator("[data-instant-status]");
  const results: Record<string, unknown>[] = [];
  for (const entry of loaded) {
    const key = `${entry.series.symbol}:${entry.series.timeframe}`;
    await page.getByLabel("Bars", { exact: true }).selectOption(key);
    await expect(status).toHaveAttribute("data-instant-status", "ready", {
      timeout: 60_000,
    });
    await expect(page.locator('[data-stat="Trades"]')).toBeVisible();
    const warm: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      warm.push(await measureChange(page, "Fast average (bars)", 20 + index));
    }
    const cold: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      await withRepository((repository) =>
        repository.replaceSeries(entry.series, entry.bars)
      );
      cold.push(await measureChange(page, "Fast average (bars)", 40 + index));
    }
    results.push({
      series: key,
      bars: entry.bars.length,
      warm: summarize(warm),
      cold: summarize(cold),
    });
  }
  writeFileSync(
    join(EVIDENCE_DIR, "browser-latency.json"),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browser: page.context().browser()?.version() ?? "unknown",
        runsPerCase: RUNS,
        percentile: "p95 nearest rank",
        definition:
          "parameter change (input event) to rendered result (status ready), measured in the page",
        results,
      },
      null,
      2
    )}\n`
  );
});
