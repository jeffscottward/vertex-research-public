import type {
  OpenbbForm4Owner,
  OpenbbInsiderPurchase,
} from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import { OPENBB_INSIDER_CLUSTER_MAX } from "./contracts/openbb.ts";
import { insiderClusters } from "./insider-clusters.ts";

const DAY_MS = 86_400_000;
const END = new Date("2026-11-20T21:00:00Z");
const daysAgo = (days: number): Date => new Date(END.getTime() - days * DAY_MS);

const purchase = (
  accessionNumber: string,
  acceptedAt: Date,
  extra: Partial<OpenbbInsiderPurchase> = {}
): OpenbbInsiderPurchase => ({
  acceptedAt,
  accessionNumber,
  issuerCik: "800001",
  issuerName: "Example Widgets Inc",
  issuerSymbol: "EXW",
  plan10b51: false,
  price: 10,
  shares: 100,
  url: `https://www.sec.gov/${accessionNumber}`,
  ...extra,
});
const owner = (
  accessionNumber: string,
  ownerCik: string,
  officerTitle: string | null = null
): OpenbbForm4Owner => ({
  accessionNumber,
  officerTitle,
  ownerCik,
  ownerName: `Person ${ownerCik}`,
});

describe("insiderClusters", () => {
  it("finds 3 persons within 10 days and lists every filing of the window", () => {
    const clusters = insiderClusters(
      [
        purchase("a", daysAgo(9)),
        purchase("a", daysAgo(9), { price: null }),
        purchase("b", daysAgo(5)),
        purchase("c", daysAgo(1), { plan10b51: true }),
      ],
      [owner("a", "7"), owner("b", "8", "CEO"), owner("c", "9")],
      daysAgo(7)
    );
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    expect(cluster).toMatchObject({
      firstAcceptedAt: daysAgo(9).toISOString(),
      issuerCik: "800001",
      issuerSymbol: "EXW",
      lastAcceptedAt: daysAgo(1).toISOString(),
      persons: 3,
      shares: 400,
      value: 3000,
      valueIncomplete: true,
    });
    expect(cluster?.filings.map((filing) => filing.accessionNumber)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(cluster?.filings[1]?.owners).toEqual([
      { cik: "8", name: "Person 8", title: "CEO" },
    ]);
  });

  it("needs the 3 persons inside 10 days, counts joint filers once and skips filings without owners", () => {
    const spread = insiderClusters(
      [
        purchase("a", daysAgo(12)),
        purchase("b", daysAgo(5)),
        purchase("c", daysAgo(1)),
      ],
      [owner("a", "7"), owner("b", "8"), owner("c", "9")],
      daysAgo(7)
    );
    expect(spread).toEqual([]);
    const joint = insiderClusters(
      [
        purchase("a", daysAgo(3)),
        purchase("b", daysAgo(2)),
        purchase("c", daysAgo(1)),
        purchase("d", daysAgo(1)),
      ],
      // Filing a is joint (7 and 70): one person key "7"; filing b repeats person 7.
      [owner("a", "70"), owner("a", "7"), owner("b", "7"), owner("c", "9")],
      daysAgo(7)
    );
    expect(joint).toEqual([]);
  });

  it("counts a trust and its trustee once when they filed jointly before", () => {
    const owners = [
      owner("a", "70"),
      owner("a", "7"),
      owner("b", "70"),
      owner("c", "9"),
      owner("d", "11"),
    ];
    const purchases = ["a", "b", "c"].map((id, index) =>
      purchase(id, daysAgo(3 - index))
    );
    expect(insiderClusters(purchases, owners, daysAgo(7))).toEqual([]);
    const [cluster] = insiderClusters(
      [...purchases, purchase("d", daysAgo(0.5))],
      owners,
      daysAgo(7)
    );
    expect(cluster?.persons).toBe(3);
  });

  it("uses the newest qualifying window and ignores clusters older than the lookback", () => {
    const old = insiderClusters(
      [
        purchase("a", daysAgo(20)),
        purchase("b", daysAgo(19)),
        purchase("c", daysAgo(18)),
      ],
      [owner("a", "1"), owner("b", "2"), owner("c", "3")],
      daysAgo(7)
    );
    expect(old).toEqual([]);
    const newest = insiderClusters(
      [
        purchase("a", daysAgo(6)),
        purchase("b", daysAgo(5)),
        purchase("c", daysAgo(4)),
        purchase("d", daysAgo(4)),
        purchase("e", daysAgo(1), { issuerCik: "800002", shares: null }),
        purchase("f", daysAgo(1), { issuerCik: "800002" }),
        purchase("g", daysAgo(1), { issuerCik: "800002" }),
      ],
      [
        owner("a", "1"),
        owner("b", "2"),
        owner("c", "3"),
        owner("d", "4"),
        owner("e", "11"),
        owner("f", "12"),
        owner("g", "13"),
      ],
      daysAgo(7)
    );
    expect(newest.map((cluster) => cluster.issuerCik)).toEqual([
      "800002",
      "800001",
    ]);
    expect(newest[1]?.filings).toHaveLength(4);
    expect(newest[0]).toMatchObject({ shares: 200, valueIncomplete: true });
  });

  it("sorts ties by issuer, cuts long names and caps the list", () => {
    const purchases: OpenbbInsiderPurchase[] = [];
    const owners: OpenbbForm4Owner[] = [];
    for (let issuer = 0; issuer < OPENBB_INSIDER_CLUSTER_MAX + 1; issuer += 1)
      for (const person of ["1", "2", "3"]) {
        const accession = `${issuer}-${person}`;
        purchases.push(
          purchase(accession, daysAgo(1), {
            issuerCik: String(900_000 + issuer),
            issuerName: issuer === 0 ? "N".repeat(400) : null,
          })
        );
        owners.push({
          ...owner(accession, person, issuer === 0 ? "T".repeat(400) : null),
          ownerName: "x".repeat(400),
        });
      }
    const clusters = insiderClusters(purchases, owners, daysAgo(7));
    expect(clusters).toHaveLength(OPENBB_INSIDER_CLUSTER_MAX);
    expect(clusters[0]?.issuerCik).toBe("900000");
    expect(clusters[0]?.issuerName).toHaveLength(300);
    expect(clusters[0]?.filings[0]?.owners[0]?.title).toHaveLength(300);
    expect(clusters[1]?.issuerName).toBeNull();
  });

  it("orders persons by CIK number and filings with equal times by accession", () => {
    const at = daysAgo(1);
    const [cluster] = insiderClusters(
      [purchase("b", at), purchase("a", at), purchase("c", daysAgo(2))],
      [
        owner("a", "100"),
        owner("a", "99"),
        owner("a", "98"),
        owner("b", "5"),
        owner("c", "6"),
      ],
      daysAgo(7)
    );
    expect(cluster?.filings.map((filing) => filing.accessionNumber)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(cluster?.filings[1]?.owners.map((o) => o.cik)).toEqual([
      "98",
      "99",
      "100",
    ]);
  });

  it("filters clusters by optional symbol before capping results", () => {
    const at = daysAgo(1);
    const rows = [
      purchase("a1", at, { issuerCik: "1", issuerSymbol: "AAPL" }),
      purchase("a2", at, { issuerCik: "1", issuerSymbol: "AAPL" }),
      purchase("a3", at, { issuerCik: "1", issuerSymbol: "AAPL" }),
      purchase("m1", at, { issuerCik: "2", issuerSymbol: "MSFT" }),
      purchase("m2", at, { issuerCik: "2", issuerSymbol: "MSFT" }),
      purchase("m3", at, { issuerCik: "2", issuerSymbol: "MSFT" }),
    ];
    const owners = [
      owner("a1", "11"),
      owner("a2", "12"),
      owner("a3", "13"),
      owner("m1", "21"),
      owner("m2", "22"),
      owner("m3", "23"),
    ];
    const filtered = insiderClusters(rows, owners, daysAgo(7), "MSFT");
    expect(filtered.map((c) => c.issuerSymbol)).toEqual(["MSFT"]);
  });
});
