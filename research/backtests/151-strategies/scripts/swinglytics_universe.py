"""Write the Swinglytics sector/theme membership as a small JSON snapshot.

This script reuses the parser of the market-watch-swing timer
(market-watch-bot, ``market_watch/swing/parse.py``). It does not make a network
request. It reads the page that the timer already cached
(``market-watch-bot/state/swing/page.html``), so the site sees no extra traffic.

Usage:
  python3 swinglytics_universe.py --market-watch-bot ~/Github/trading/market-watch-bot \
      --out ../swinglytics-snapshot.json

Only names, tickers and the snapshot time are written. Prices, scores and
scanner setups are left out because they change every day.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--market-watch-bot", type=Path, required=True, help="market-watch-bot checkout")
    ap.add_argument("--page", type=Path, help="saved page (default: <bot>/state/swing/page.html)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    bot = args.market_watch_bot.expanduser().resolve()
    sys.path.insert(0, str(bot))
    from market_watch.swing.parse import dashboard_data  # noqa: E402  (reused parser)

    page = (args.page or bot / "state" / "swing" / "page.html").read_text(encoding="utf-8")
    data = dashboard_data(page)
    snapshot = {
        "source": "https://www.swinglytics.com/ (Market Intelligence Dashboard)",
        "parser": "market-watch-bot market_watch/swing/parse.py dashboard_data()",
        "generated_at": data.get("generated_at"),
        "indexes": [{"ticker": k, "name": v.get("name", "")} for k, v in (data.get("indexes") or {}).items()],
        "sectors": [{"etf": k, "name": v.get("name", "")} for k, v in (data.get("sectors") or {}).items()],
        "themes": [{"name": t.get("name", ""), "tickers": list(t.get("tickers") or [])}
                   for t in (data.get("themes") or []) if isinstance(t, dict)],
    }
    args.out.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(snapshot['sectors'])} sectors, {len(snapshot['themes'])} themes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
