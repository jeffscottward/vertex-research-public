// Insider cluster buys (docs/vertex-rebuild/designs/smart-money/plan-pr3.md, design Glossary): an
// issuer with open-market purchases (code P) by at least 3 distinct reporting persons whose filings
// were accepted within 10 calendar days. Joint filers on one filing count as one person: owners
// that file together are joined, and each group of joined owner CIKs in the window is one person
// (so a trust and its trustee that file jointly once and alone later still count once).
// Amendments are excluded by the reader.
// A pure function over the purchase rows the repository returns, so the rule has unit tests
// without a database. Research only.
import type {
  OpenbbForm4Owner,
  OpenbbInsiderPurchase,
} from "@darkfactory/db/server";

import {
  OPENBB_INSIDER_CLUSTER_MAX,
  OPENBB_INSIDER_CLUSTER_MIN_PERSONS,
  OPENBB_INSIDER_CLUSTER_SPAN_DAYS,
  type OpenbbInsiderCluster,
} from "./contracts/openbb.ts";

const DAY_MS = 86_400_000;
const TITLE_MAX = 300;

interface Filing {
  acceptedAt: Date;
  accessionNumber: string;
  issuerCik: string;
  issuerName: string | null;
  issuerSymbol: string | null;
  owners: { cik: string; name: string; title: string | null }[];
  plan10b51: boolean | null;
  shares: number;
  url: string;
  value: number;
  valueIncomplete: boolean;
}

const cut = (text: string): string =>
  text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;

/** Smaller CIK first (CIKs are digit strings without leading zeros). */
const byCik = (a: string, b: string): number =>
  a.length - b.length || a.localeCompare(b);

const filingsOf = (
  purchases: readonly OpenbbInsiderPurchase[],
  owners: readonly OpenbbForm4Owner[]
): Filing[] => {
  const ownersBy = new Map<string, Filing["owners"]>();
  for (const owner of owners) {
    const list = ownersBy.get(owner.accessionNumber) ?? [];
    list.push({
      cik: owner.ownerCik,
      name: cut(owner.ownerName),
      title: owner.officerTitle === null ? null : cut(owner.officerTitle),
    });
    ownersBy.set(owner.accessionNumber, list);
  }
  const filings = new Map<string, Filing>();
  for (const row of purchases) {
    const sorted = [...(ownersBy.get(row.accessionNumber) ?? [])].sort((a, b) =>
      byCik(a.cik, b.cik)
    );
    if (sorted.length === 0) continue;
    let filing = filings.get(row.accessionNumber);
    if (filing === undefined) {
      filing = {
        acceptedAt: row.acceptedAt,
        accessionNumber: row.accessionNumber,
        issuerCik: row.issuerCik,
        issuerName: row.issuerName === null ? null : cut(row.issuerName),
        issuerSymbol: row.issuerSymbol,
        owners: sorted,
        plan10b51: row.plan10b51,
        shares: 0,
        url: row.url,
        value: 0,
        valueIncomplete: false,
      };
      filings.set(row.accessionNumber, filing);
    }
    const shares = row.shares ?? 0;
    filing.shares += shares;
    if (row.price === null || row.shares === null)
      filing.valueIncomplete = true;
    else filing.value += shares * row.price;
  }
  return [...filings.values()];
};

/** Persons in `window`: groups of owner CIKs joined by filing together (union-find). */
const personsIn = (window: readonly Filing[]): number => {
  const parent = new Map<string, string>();
  const root = (cik: string): string => {
    let node = cik;
    for (
      let next = parent.get(node);
      next !== undefined && next !== node;
      next = parent.get(node)
    )
      node = next;
    parent.set(cik, node);
    return node;
  };
  for (const filing of window) {
    for (const owner of filing.owners)
      if (!parent.has(owner.cik)) parent.set(owner.cik, owner.cik);
    const [first, ...rest] = filing.owners.map((owner) => root(owner.cik));
    for (const other of rest) parent.set(other, first as string);
  }
  return new Set([...parent.keys()].map(root)).size;
};

const clusterOf = (window: readonly Filing[]): OpenbbInsiderCluster => {
  const first = window[0] as Filing;
  const last = window.at(-1) as Filing;
  return {
    filings: window.map((filing) => ({
      acceptedAt: filing.acceptedAt.toISOString(),
      accessionNumber: filing.accessionNumber,
      owners: filing.owners,
      plan10b51: filing.plan10b51,
      shares: filing.shares,
      url: filing.url,
      value: filing.value,
      valueIncomplete: filing.valueIncomplete,
    })),
    firstAcceptedAt: first.acceptedAt.toISOString(),
    issuerCik: last.issuerCik,
    issuerName: last.issuerName,
    issuerSymbol: last.issuerSymbol,
    lastAcceptedAt: last.acceptedAt.toISOString(),
    persons: personsIn(window),
    shares: window.reduce((sum, filing) => sum + filing.shares, 0),
    value: window.reduce((sum, filing) => sum + filing.value, 0),
    valueIncomplete: window.some((filing) => filing.valueIncomplete),
  };
};

/**
 * Cluster buys whose newest filing was accepted at or after `since`. For each issuer, the newest
 * filing in the lookback whose 10-day window (acceptance minus 10 days to acceptance) holds at
 * least 3 person keys gives the cluster; it lists every purchase filing in that window. Sorted by
 * newest acceptance, at most OPENBB_INSIDER_CLUSTER_MAX.
 */
export const insiderClusters = (
  purchases: readonly OpenbbInsiderPurchase[],
  owners: readonly OpenbbForm4Owner[],
  since: Date
): OpenbbInsiderCluster[] => {
  const byIssuer = new Map<string, Filing[]>();
  for (const filing of filingsOf(purchases, owners)) {
    const list = byIssuer.get(filing.issuerCik) ?? [];
    list.push(filing);
    byIssuer.set(filing.issuerCik, list);
  }
  const span = OPENBB_INSIDER_CLUSTER_SPAN_DAYS * DAY_MS;
  const clusters: OpenbbInsiderCluster[] = [];
  for (const filings of byIssuer.values()) {
    filings.sort(
      (a, b) =>
        a.acceptedAt.getTime() - b.acceptedAt.getTime() ||
        (a.accessionNumber < b.accessionNumber ? -1 : 1)
    );
    for (let end = filings.length - 1; end >= 0; end -= 1) {
      const newest = filings[end] as Filing;
      if (newest.acceptedAt.getTime() < since.getTime()) break;
      const start = newest.acceptedAt.getTime() - span;
      const window = filings
        .slice(0, end + 1)
        .filter((filing) => filing.acceptedAt.getTime() >= start);
      if (personsIn(window) >= OPENBB_INSIDER_CLUSTER_MIN_PERSONS) {
        clusters.push(clusterOf(window));
        break;
      }
    }
  }
  return clusters
    .sort(
      (a, b) =>
        b.lastAcceptedAt.localeCompare(a.lastAcceptedAt) ||
        a.issuerCik.localeCompare(b.issuerCik)
    )
    .slice(0, OPENBB_INSIDER_CLUSTER_MAX);
};
