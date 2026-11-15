import { describe, expect, it } from "vitest";

import {
  rehearseRequests,
  runDeployRehearsalRequestsCli,
} from "./deploy-rehearsal-requests.ts";

const limits = {
  dailyLossLimit: 3600,
  maxOrderSize: 10,
  maxOrdersPerMinute: 2,
  maxPosition: 10,
};
const request = (extra: Record<string, unknown> = {}) => ({
  limits,
  mode: "paper",
  strategyId: "strategy-1",
  symbol: "SPY",
  timeframe: "1d",
  ...extra,
});

describe("deployment-request step of the deployability rehearsal", () => {
  it("lets a paper request reach approved and stops it at dispatch", () => {
    const report = rehearseRequests([request(), request({ symbol: "tqqq" })]);
    expect(report.requests.map((item) => item.reached)).toEqual([
      "approve",
      "approve",
    ]);
    expect(report.requests.map((item) => item.status)).toEqual([
      "approved",
      "approved",
    ]);
    expect(report.requests.map((item) => item.refusedAt)).toEqual([
      "dispatch",
      "dispatch",
    ]);
    expect(report.requests[1]?.symbol).toBe("TQQQ");
    expect(report.lock).toEqual({
      brokerSubmissionAllowed: false,
      dispatchReason: report.requests[0]?.refusal,
      dispatchState: "not-dispatched",
      executionAuthorized: false,
    });
  });

  it("refuses a live request at the contract", () => {
    const [outcome] = rehearseRequests([request({ mode: "live" })]).requests;
    expect(outcome?.refusedAt).toBe("contract");
    expect(outcome?.refusal).toContain("input.mode: ");
    expect(outcome?.status).toBeNull();
  });

  it("refuses an input that is not an object", () => {
    const [outcome] = rehearseRequests([null]).requests;
    expect(outcome?.refusedAt).toBe("contract");
    expect(outcome?.refusal).toMatch(/^input: /u);
    expect(outcome?.reached).toBeNull();
  });

  it("refuses a request that names more than one symbol", () => {
    const [list, joined] = rehearseRequests([
      request({ symbol: ["SPY", "QQQ"] }),
      request({ symbol: "SPY,QQQ" }),
    ]).requests;
    expect(list?.refusedAt).toBe("contract");
    expect(joined?.refusedAt).toBe("fields");
    expect(joined?.refusal).toContain("symbol must be 1-32");
  });

  it("refuses limits the repository rules refuse", () => {
    const [outcome] = rehearseRequests([
      request({ limits: { ...limits, maxOrderSize: 11 } }),
    ]).requests;
    expect(outcome?.refusedAt).toBe("fields");
    expect(outcome?.refusal).toBe(
      "limits.maxOrderSize must not exceed limits.maxPosition"
    );
  });

  it("has no limit that reads the account value", () => {
    // A request with absurd limits still reaches approved: the 2% of account rule is not in this step.
    const [outcome] = rehearseRequests([
      request({
        limits: {
          ...limits,
          dailyLossLimit: 1e12,
          maxOrderSize: 1e9,
          maxPosition: 1e9,
        },
      }),
    ]).requests;
    expect(outcome?.reached).toBe("approve");
  });

  it("prints one report for a JSON array and refuses anything else", () => {
    const run = (text: string) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = runDeployRehearsalRequestsCli({
        readInput: () => text,
        stderr: { write: (chunk) => err.push(chunk) },
        stdout: { write: (chunk) => out.push(chunk) },
      });
      return { code, err: err.join(""), out: out.join("") };
    };
    const good = run(JSON.stringify([request()]));
    expect(good.code).toBe(0);
    expect(good.err).toBe("");
    expect(JSON.parse(good.out)).toEqual(rehearseRequests([request()]));
    expect(run("{}")).toEqual({
      code: 1,
      err: "stdin must be a JSON array\n",
      out: "",
    });
  });
});
