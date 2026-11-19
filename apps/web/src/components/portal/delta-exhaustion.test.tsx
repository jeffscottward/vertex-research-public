import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeltaSeries } from "../../features/order-flow/delta.ts";
import { DeltaChart } from "./order-flow-views.tsx";

const series: DeltaSeries = {
  bucketSeconds: 60,
  buckets: [
    {
      buy: 10,
      cvd: 10,
      delta: 10,
      end: 60,
      sell: 0,
      start: 0,
      unsigned: 0,
      volume: 10,
    },
  ],
  cvd: 10,
  maxAbsDelta: 10,
  maxCvd: 10,
  minCvd: 0,
  points: [{ cvd: 10, t: 0 }],
};

describe("DeltaChart exhaustion", () => {
  it("lists exhaustion runs under the delta bars", () => {
    const html = renderToStaticMarkup(
      <DeltaChart
        exhaustion={[
          {
            buckets: 4,
            direction: "up",
            end: 180,
            firstDelta: 820,
            firstVolume: 820,
            lastDelta: 180,
            lastVolume: 180,
            start: 0,
          },
        ]}
        series={series}
        timeZone="UTC"
      />
    );
    expect(html).toContain("data-exhaustion");
    expect(html).toContain("Exhaustion up");
    expect(html).toContain("4 buckets");
  });

  it("shows no list without runs", () => {
    const html = renderToStaticMarkup(
      <DeltaChart series={series} timeZone="UTC" />
    );
    expect(html).not.toContain("data-exhaustion");
  });
});
