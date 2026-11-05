# Data source: Investing.com ProPicks AI strategies

Updated: 2026-11-05. Status: **import format ready; automated capture not started**. Card `vertex-moby-propicks`.

ProPicks AI is a paid InvestingPro product. Each strategy is a list of stocks with weights that the vendor rebalances once per month. Vertex reads each featured strategy as one pick list (see [pick lists](../pick-lists.md)). The source slug is `investing-propicks`. Vendor names stay in data and documentation only.

## Public facts about the product

From public pages and search results read on 2026-11-05 (no login, no capture of paid content):

| Fact | Value | Where seen |
| --- | --- | --- |
| Strategy page path | `https://www.investing.com/pro/propicks/<strategy-slug>` | Public strategy landing pages |
| Example strategies and codes | Beat the S&P 500 (`beat-sp-500`, code SP20, Pro), Tech Titans (`tech-titans`, code IT15, Pro), Healthcare Heroes (`healthcare-heroes`, code HLTH15, Pro+) | Public strategy landing pages |
| Other named strategies | Mid-Cap Movers, Small-Cap Sprinters, Top Value Stocks; the vendor states 88 strategies in total | Vendor investor letters (July, September 2026) |
| Rebalance cadence | Monthly; the index page showed "Next Update Nov 1, 2026" | `https://www.investing.com/pro/propicks` |
| Holdings visibility | Holdings, weights and history are behind the paywall ("Unlock Stocks") | Strategy landing pages |

The code suffix (15, 20) appears to be the holding count. This is a hypothesis; confirm it from the Portfolio tab.

## Terms of use and automated access

Read on 2026-11-05 from `https://cdn.investing.com/about-us/terms_and_conditions.html` (the frame inside `/about-us/terms-and-conditions`):

| Clause | Text (quoted) | Effect on Vertex |
| --- | --- | --- |
| Use restrictions (a) | "Any use of the Platform shall be solely for your own personal use only." | Use stays private to the owner. |
| Use restrictions (c) | "You are expressly forbidden from employing any automated system or software to extract data or content from this website for any purpose. This includes, but is not limited to, scraping, data mining, robot or spider programs" | A scheduled scraper or a HAR-derived API client conflicts with this clause. |
| Use restrictions (e) | "You shall not disassemble, decompile or reverse engineer any part of the Platform" | Recovering the private API conflicts with this clause. |
| Data notice (site footer) | "It is prohibited to use, store, reproduce, display, modify, transmit or distribute the data contained in this website without the explicit prior written permission of Fusion Media" | Storing holdings needs care even for manual import; keep it private and personal. |
| Special conditions | Separate conditions apply to InvestingPro, InvestingPro+ and ProPicks AI | Read them before any automated route. |

`robots.txt` returned HTTP 403 to a plain request. No public API and no published rate limit were found.

Decision: the job stopped before any capture and asked the owner which route to use ([ask menu](owner Discord message (private))). Until the owner answers, this source runs only through manual import.

## Import route (available now)

One pick list per strategy. The list slug is the strategy URL slug, so a list maps back to its page.

```sh
bun run vertex:pick-lists -- import --adapter json --file propicks-2026-11.json --dry-run
bun run vertex:pick-lists -- import --adapter json --file propicks-2026-11.json
```

### Document format (dummy data)

```json
{
  "source": "investing-propicks",
  "sourceLabel": "Investing.com ProPicks",
  "lists": [
    {
      "slug": "tech-titans",
      "name": "Tech Titans",
      "asOf": "2026-11-01",
      "members": [
        { "symbol": "AAAA", "weight": 0.0667, "sector": "Technology", "addedOn": "2026-06-01" },
        { "symbol": "BBBB", "weight": 0.0667, "sector": "Technology" }
      ]
    },
    {
      "slug": "healthcare-heroes",
      "name": "Healthcare Heroes",
      "asOf": "2026-11-01",
      "members": [{ "symbol": "CCCC", "weight": 0.0667, "sector": "Health Care" }]
    }
  ]
}
```

### Field mapping (Portfolio tab)

| Portfolio tab column | Pick-list field | Rule |
| --- | --- | --- |
| Ticker | `symbol` | Upper case, one row per symbol per strategy. |
| Weight % | `weight` | Fraction 0 to 1 (6.67% becomes `0.0667`). Stored for research; the bucket still uses equal weights. |
| Date added | `addedOn` | `YYYY-MM-DD`. |
| Sector | `sector` | GICS sector name; mapped to the sector ETF for the rotation quadrant. |
| Rebalance date | `asOf` | The vendor's rebalance date (first trading day of the month). One snapshot per rebalance gives the history. |

Holding history: import each past rebalance as its own `asOf` snapshot. The snapshot count and the dates are the strategy history inside Vertex.

## Endpoint inventory

Not captured. It stays empty until the owner chooses a route that allows capture. If the owner chooses the full plan, the capture and rate-limit rules in [moby.md](moby.md#endpoint-inventory) apply here too (relay or native CDP only, headers and tokens stripped, raw HAR files private on the rig with mode `0600`, one request at a time, 3 s spacing, 429 backoff, 24 h cache).

## Refresh schedule

- The vendor rebalances once per month. Manual route: import after the first trading day of each month.
- An automated adapter (only if the owner approves) would run once on the first and second trading day of each month, inside the rate limits.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Document fails validation | The import command stops before any request; nothing is stored. |
| Strategy renamed by the vendor | The slug stays the same; the import updates the list name. A new slug creates a new list. |
| Strategy removed by the vendor | The list keeps its last snapshot. Remove its bucket by hand on `/baskets`. |
| More than 50 holdings | The bucket keeps the first 50 by rank (then symbol) and reports the rest as omitted. |
| Ticker unknown to the price source | The screen marks the member `unknown` with the reason. |
