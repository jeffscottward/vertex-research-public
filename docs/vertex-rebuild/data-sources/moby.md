# Data source: Moby stock picks

Updated: 2026-11-05. Status: **import format ready; automated capture not started**. Card `vertex-moby-propicks`.

Moby is a paid investment-research site (the owner has an account). Vertex reads its stock picks as a pick list (see [pick lists](../pick-lists.md)). The source slug is `moby`. Vendor names stay in data and documentation only. Code uses the generic pick-list port.

## Terms of use and automated access

Read on 2026-11-05 from the public page `https://moby.co/terms` ("Last updated: January 1st, 2026"):

| Clause | Text (quoted) | Effect on Vertex |
| --- | --- | --- |
| Section 1.4, restrictions | "You shall not use any manual or automated software, devices or other processes to "scrape" or download data from any web pages contained in the Website" | A scheduled scraper or a HAR-derived API client conflicts with this clause. |
| Section 1.4, restrictions | "You shall not modify, translate, adapt, merge, make derivative works of, disassemble, decompile, reverse compile or reverse engineer any part of the Company Properties" | Recovering the private API from captured traffic conflicts with this clause. |
| License | "solely for your own personal or internal business purposes" | Use stays private to the owner. Do not publish Moby content in public pages or repositories. |
| `robots.txt` | `User-agent: *` `Allow: /`; `Content-Signal: search=yes,ai-train=no,use=reference`; GPTBot and CCBot disallowed | No training on the content. |

No public API and no published rate limit were found.

Decision: the job stopped before any capture and asked the owner which route to use ([ask menu](owner Discord message (private))). Options: manual import (recommended, ToS-safe), on-demand page reading at human pace, the full HAR plus API-client plan, or a permission request to the vendor. Until the owner answers, this source runs only through manual import.

## Import route (available now)

The owner exports or copies a list. An operator converts it to the pick-list JSON document and imports it:

```sh
bun run vertex:pick-lists -- import --adapter json --file moby-picks.json --dry-run
bun run vertex:pick-lists -- import --adapter json --file moby-picks.json
```

The command posts each list to `pickLists.import` with the operator's agent API key (`VERTEX_AGENT_API_KEY`, never printed). Import method is stored as `manual`.

### Document format (dummy data)

```json
{
  "source": "moby",
  "sourceLabel": "Moby",
  "lists": [
    {
      "slug": "stock-picks",
      "name": "Moby stock picks",
      "asOf": "2026-11-05",
      "members": [
        {
          "symbol": "AAAA",
          "rank": 1,
          "sector": "Technology",
          "rating": "Buy",
          "targetPrice": 123.45,
          "addedOn": "2026-10-01",
          "thesis": "Dummy thesis text. Replace with the pick's summary."
        },
        { "symbol": "BBBB", "rank": 2, "sector": "Health Care" }
      ]
    }
  ]
}
```

### Field mapping

| Moby page field (as the owner sees it) | Pick-list field | Rule |
| --- | --- | --- |
| Ticker | `symbol` | Upper case, `^[A-Z][A-Z0-9.-]{0,9}$`. One row per symbol per list. |
| Position in the list | `rank` | 1 = first. Omit when the page has no order. |
| Recommendation (for example Buy, Strong Buy) | `rating` | Free text, at most 40 characters. |
| Price target | `targetPrice` | Positive number in USD. |
| Pick date | `addedOn` | `YYYY-MM-DD`. |
| Thesis or summary | `thesis` | At most 2000 characters. Paraphrase or shorten; keep it private. |
| Sector | `sector` | GICS sector name. Vertex maps it to the sector ETF for the rotation quadrant. |
| Page date | `asOf` | The date the list was read. Re-importing the same date replaces that snapshot. |

Suggested list slugs: `stock-picks` (main picks), one slug per themed list or dashboard list (for example `top-picks-<theme>`). Each list becomes its own bucket.

## Endpoint inventory

Not captured. The inventory (method, path, parameters, fields, authentication, observed rate limit, sanitized sample) stays empty until the owner chooses a route that allows capture. If the owner chooses the full plan, capture rules are:

- Capture only through the OMP Browser Relay or native CDP on the Mac Chrome tab the owner opened. Never through JEV or a classifier (paid account content).
- Strip `Authorization`, `Cookie`, `Set-Cookie` and token fields before saving. Raw HAR files stay under a private, git-ignored path on the rig with mode `0600`. Repository fixtures are dummy data.
- One request at a time, at least 3 s between requests, exponential backoff on HTTP 429 (start 30 s, double, stop after 3), cache every response for 24 h.

## Refresh schedule

- Manual route: the owner refreshes when Moby publishes new picks. No timer.
- An automated adapter (only if the owner approves) would run at most once per day after the US close, inside the rate limits above.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Document fails validation (bad symbol, duplicate symbol, more than 200 members) | The import command stops before any request and names the field. Nothing is stored. |
| API key missing or not an operator | The import returns 401/403; nothing is stored. |
| Same list and date imported twice | The second import replaces the first snapshot of that date. Older dates stay as history. |
| Ticker unknown to the price source | The screen marks the member `unknown` with the reason. The bucket still lists it; the basket valuation lists it as unavailable. |
| Moby changes its page layout | Manual route: no effect. Automated route: the adapter would fail closed and alert; it never stores partial lists. |
