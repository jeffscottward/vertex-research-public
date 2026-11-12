import { describe, expect, it } from "vitest";

import {
  rehearsePaperPathRequests,
  runPaperPathRequestsCli,
} from "./paper-path-requests.ts";

const limits = {
  dailyLossLimit: 3600,
  maxOrderSize: 10,
  maxOrdersPerMinute: 2,
  maxPosition: 10,
};
const options = {
  anchorDelta: 0.5,
  budgetPctOfAccount: 1,
  dte: { min: 45, target: 60 },
  maxLossPctOfAccount: 2,
  structure: "callDebitVertical",
  width: { unit: "sigma", value: 1 },
};
const input = (extra: Record<string, unknown> = {}) => ({
  limits,
  mode: "paper",
  options,
  strategyId: "strategy-1",
  symbol: "SPY",
  timeframe: "1d",
  ...extra,
});
const group = () => {
  const { symbol: _symbol, ...rest } = input();
  return { ...rest, symbols: ["SPY", "QQQ", "IWM"] };
};

describe("deployment-request step of the paper path rehearsal", () => {
  it("returns an approved paper record with the options block and its legs", () => {
    const report = rehearsePaperPathRequests([
      { input: input(), kind: "single" },
    ]);
    expect(report.refusals).toEqual([]);
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({
      brokerSubmissionAllowed: false,
      executionAuthorized: false,
      mode: "paper",
      status: "approved",
      symbol: "SPY",
    });
    expect(report.records[0]?.options?.legs).toEqual([
      { action: "buy", right: "call", role: "anchor" },
      { action: "sell", right: "call", role: "wing" },
    ]);
    expect(report.lock.dispatchState).toBe("not-dispatched");
  });

  it("refuses a request above the 2% max-loss ceiling", () => {
    const report = rehearsePaperPathRequests([
      {
        input: input({ options: { ...options, maxLossPctOfAccount: 2.5 } }),
        kind: "single",
      },
    ]);
    expect(report.records).toEqual([]);
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.refusal).toMatch(/maxLossPctOfAccount/);
  });

  it("refuses mode live", () => {
    const report = rehearsePaperPathRequests([
      { input: input({ mode: "live" }), kind: "single" },
    ]);
    expect(report.records).toEqual([]);
    expect(report.refusals[0]?.refusedAt).toBe("contract");
  });

  it("still reads an old-format request without an options block", () => {
    const { options: _options, ...old } = input();
    const report = rehearsePaperPathRequests([{ input: old, kind: "single" }]);
    expect(report.records).toHaveLength(1);
    expect(report.records[0]?.options).toBeNull();
  });

  it("makes one request per symbol for a group, with one group key", () => {
    const report = rehearsePaperPathRequests([
      { input: group(), kind: "group" },
    ]);
    expect(report.records.map((record) => record.symbol)).toEqual([
      "SPY",
      "QQQ",
      "IWM",
    ]);
    expect(
      new Set(report.records.map((record) => record.options?.group?.key)).size
    ).toBe(1);
    expect(report.records[0]?.options?.group?.symbols).toEqual([
      "SPY",
      "QQQ",
      "IWM",
    ]);
  });

  it("reports probes apart from the records", () => {
    const report = rehearsePaperPathRequests(
      [{ input: input(), kind: "single" }],
      [
        { input: input({ mode: "live" }), kind: "single", probe: "mode live" },
        { input: input(), kind: "single", probe: "accepted" },
      ]
    );
    expect(report.records).toHaveLength(1);
    expect(report.probes).toEqual([
      {
        approved: 0,
        options: false,
        probe: "mode live",
        refusal: expect.any(String),
      },
      { approved: 1, options: true, probe: "accepted", refusal: null },
    ]);
  });

  it("refuses a group without an options block at the contract, and bad fields after it", () => {
    const { options: _options, ...bare } = group();
    const report = rehearsePaperPathRequests(
      [
        { input: bare, kind: "group" },
        { input: input({ timeframe: "7x" }), kind: "single" },
      ],
      [{ input: input({ timeframe: "7x" }), kind: "single" }]
    );
    expect(report.records).toEqual([]);
    expect(report.refusals.map((item) => item.refusedAt)).toEqual([
      "contract",
      "fields",
    ]);
    expect(report.refusals[1]?.refusal).toMatch(/^timeframe must be/u);
    expect(report.probes).toEqual([
      {
        approved: 0,
        options: false,
        probe: null,
        refusal: expect.stringMatching(/^timeframe must be/u),
      },
    ]);
  });

  it("runs as a command over stdin and refuses input without an items array", () => {
    const run = (text: string) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = runPaperPathRequestsCli({
        readInput: () => text,
        stderr: { write: (chunk) => err.push(chunk) },
        stdout: { write: (chunk) => out.push(chunk) },
      });
      return { code, err: err.join(""), out: out.join("") };
    };
    const good = run(
      JSON.stringify({ items: [{ input: input(), kind: "single" as const }] })
    );
    expect(good.code).toBe(0);
    expect(good.err).toBe("");
    expect(JSON.parse(good.out)).toEqual(
      JSON.parse(
        JSON.stringify(
          rehearsePaperPathRequests(
            [{ input: input(), kind: "single" as const }],
            []
          )
        )
      )
    );
    for (const bad of ["{}", "null", "[]"])
      expect(run(bad)).toEqual({
        code: 1,
        err: "stdin needs an items array\n",
        out: "",
      });
  });
});
