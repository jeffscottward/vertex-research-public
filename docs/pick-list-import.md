# Pick-list manual import

The owner copies a stock-pick list by hand and imports it on `/pick-lists`. Vertex never contacts the source sites. There is no scraper, no private API client, no browser automation and no schedule for these sources (owner decision, 2026-11-05).

## Supported input

- **Plain tickers:** tickers separated by spaces or new lines, for example `AAPL MSFT $NVDA NASDAQ:AMD`.
- **CSV or tab table:** a header row with a `Symbol` or `Ticker` column. Optional columns: `Weight` (`5%`, `5` or `0.05`), `Rank` or `#`, `Date added` (`YYYY-MM-DD` or `M/D/YYYY`), `Rating`, `Sector`, `Target price`.
- **Table without a header:** when every cell looks like a ticker (for example `AAPL, MSFT, NVDA`), each cell is a ticker. Otherwise the first column is the ticker and the other cells are shown as ignored. A weight column uses one scale: when the header or any cell has `%`, or any value is above 1, every value is a percent.

A line that starts with `#` and has no comma, tab or semicolon is a comment. A list holds at most 200 tickers.

**Preview** shows the tickers that are ready and every rejected row with its line and reason (not a ticker, duplicate, bad weight, bad date, bad target price, bad rank, an extra column without a header, more than 200). Only the ready tickers are saved.

## Steps on /pick-lists

1. In **Import list**, select the source (Moby, ProPicks or Other).
2. Type the list name, for example `Moby Top Picks`. The list slug comes from the name.
3. Set **As of** to the date the list was shown on the site.
4. Paste the list, or select a `.csv` file.
5. Select **Preview** and read the rejected rows.
6. Select **Save list**. A second save with the same name and date replaces that snapshot.
7. On the list card, select **Make bucket**. The bucket is an equal-weight basket on `/baskets`. Use the basket page for a buy proposal. A proposal is not an order.

## Copy a Moby list

1. Sign in to Moby in your own browser.
2. Open the picks page (for example the stock picks or watch list page).
3. Select the table rows from the first ticker to the last ticker and copy them. If the page has an export or download button, download the CSV instead.
4. Paste the text into **Import list**. Select source **Moby**.

## Copy a ProPicks strategy (Investing.com)

1. Sign in to Investing.com in your own browser.
2. Open ProPicks and select one strategy (for example "Tech Titans").
3. Select the holdings table (symbol and weight columns) and copy it. Paste it into a spreadsheet first if the copy loses the column breaks, then copy the spreadsheet cells (they paste as a tab table).
4. Paste the text into **Import list**. Select source **ProPicks**. Use the strategy name as the list name.

Repeat the steps for each strategy. Research only: a pick, a gate or a bucket never authorizes a trade.
