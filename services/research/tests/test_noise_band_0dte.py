"""Tests for the 0DTE option expression of the noise-band signal (synthetic quotes)."""
from datetime import date

from strategies.noise_band import BacktestResult, Params, Trade
from strategies.noise_band_0dte import OptionParams, last_exit_minute, nearest_strike, price_trade, run_options

D = date(2024, 3, 1)


class Book:
    def __init__(self, quotes, strikes=(495.0, 498.0, 499.0, 500.0, 501.0, 505.0)):
        self.q = quotes
        self.k = sorted(strikes)

    def strikes(self, day):
        return self.k if day == D else []

    def quote(self, day, minute, right, strike):
        return self.q.get((minute, right, strike))


def stock_trade(side=1, entry=30, exit_=120, reason="stop"):
    return Trade(D, side, 100, entry, 500.0, exit_, 501.0, reason, 100.0, 0.7)


def test_nearest_strike_ties_go_out_of_the_money():
    assert nearest_strike([499.0, 500.0, 501.0], 500.4, "C") == 500.0
    assert nearest_strike([499.0, 500.0], 499.5, "C") == 500.0
    assert nearest_strike([499.0, 500.0], 499.5, "P") == 499.0


def test_last_exit_minute_full_and_half_day():
    assert last_exit_minute(390) == 375  # 15:45
    assert last_exit_minute(210) == 195  # 12:45 on a 13:00 close


def test_single_call_buys_ask_sells_bid_and_caps_premium():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (120, "C", 500.0): (2.50, 2.55)})
    t, why = price_trade(book, stock_trade(), 500.2, 501.0, 100_000.0, OptionParams())
    # 2% of 100k = 2,000 -> floor(2000 / 200) = 10 contracts
    assert why == "ok" and t.shares == 10 and t.entry_price == 2.00 and t.exit_price == 2.50
    assert abs(t.gross - 10 * 100 * 0.50) < 1e-9
    assert abs(t.cost - 2 * 10 * 0.65) < 1e-9
    assert t.exit_reason == "stop:C500"


def test_short_signal_uses_put_and_close_exit_uses_1545_quote():
    book = Book({(30, "P", 500.0): (1.00, 1.10), (375, "P", 500.0): (0.0, 0.05), (389, "P", 500.0): (0.9, 0.95)})
    t, _ = price_trade(book, stock_trade(side=-1, exit_=390, reason="close"), 499.8, 499.0, 100_000.0, OptionParams())
    assert t.exit_minute == 375 and t.exit_price == 0.0 and t.gross < 0


def test_half_day_close_exit_uses_1245_quote():
    book = Book({(30, "C", 500.0): (1.00, 1.10), (195, "C", 500.0): (1.40, 1.45), (210, "C", 500.0): (9.0, 9.5)})
    t, _ = price_trade(book, stock_trade(exit_=210, reason="close"), 500.0, 500.5, 100_000.0, OptionParams(), close_minute=210)
    assert t.exit_minute == 195 and t.exit_price == 1.40


def test_skip_reasons_before_entry():
    assert price_trade(Book({}), stock_trade(), 500.0, 500.0, 1e5, OptionParams())[1] == "no_entry_quote"
    book = Book({(30, "C", 500.0): (30.0, 30.5), (120, "C", 500.0): (31.0, 31.5)})
    assert price_trade(book, stock_trade(), 500.0, 500.0, 100_000.0, OptionParams())[1] == "too_expensive_for_cap"


def test_single_missing_exit_quote_counts_as_zero():
    book = Book({(30, "C", 500.0): (1.95, 2.00)})
    t, why = price_trade(book, stock_trade(), 500.0, 498.0, 100_000.0, OptionParams())
    assert why == "ok" and t.exit_price == 0.0 and t.exit_reason.endswith(":exit_quote_missing")


def test_vertical_debit_and_credit():
    book = Book({
        (30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25),
        (120, "C", 500.0): (3.00, 3.05), (120, "C", 505.0): (0.40, 0.45),
    })
    t, _ = price_trade(book, stock_trade(), 500.0, 502.0, 100_000.0, OptionParams(instrument="vertical"))
    assert abs(t.entry_price - 1.80) < 1e-9 and abs(t.exit_price - 2.55) < 1e-9
    assert t.shares == 11  # floor(2000 / 180)
    assert abs(t.cost - 4 * 11 * 0.65) < 1e-9


def test_vertical_missing_short_exit_quote_is_not_skipped():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25), (120, "C", 500.0): (6.0, 6.1)})
    t, why = price_trade(book, stock_trade(), 500.0, 506.0, 100_000.0, OptionParams(instrument="vertical"))
    # short 505C ask missing -> intrinsic 1.00 + 0.05
    assert why == "ok" and abs(t.exit_price - (6.0 - 1.05)) < 1e-9


def test_run_options_equity_and_counts():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (120, "C", 500.0): (2.95, 3.00)})
    other_day = Trade(date(2024, 2, 29), 1, 100, 30, 500.0, 120, 501.0, "stop", 0.0, 0.0)
    stock = BacktestResult(Params(), [], [stock_trade(), stock_trade(side=-1), other_day])
    prices = {(D, 30): 500.0, (D, 120): 501.0}
    res, counts = run_options(stock, prices, {D: 390, date(2024, 3, 4): 390}, book, [D, date(2024, 3, 4)])
    assert len(res.days) == 2 and len(res.trades) == 1
    assert counts["no_entry_quote"] == 1  # the put has no quote
    assert counts["outside_option_days"] == 1
    assert res.days[0].aum_end > res.days[0].aum_start
    assert res.days[1].ret == 0.0


def _write_day(root, day, state, quotes, low=499.0, high=None):
    """quotes: {(right, strike): [(minute, bid_open, ask_open[, bid_close, ask_close]), ...]} in collector format."""
    import csv
    import gzip
    from datetime import datetime
    from zoneinfo import ZoneInfo

    folder = root / day.isoformat()
    folder.mkdir()
    status_lines = [f"state={state}", f"low={'' if low == '' else f'{low:g}'}"]
    if high is not None:
        status_lines.append(f"high={'' if high == '' else f'{high:g}'}")
    (folder / "status.txt").write_text("\n".join(status_lines) + "\n", encoding="utf-8")
    open_ts = int(datetime(day.year, day.month, day.day, 9, 30, tzinfo=ZoneInfo("America/New_York")).timestamp())
    with (folder / "manifest.csv").open("w", newline="", encoding="utf-8") as m:
        mw = csv.writer(m)
        mw.writerow(["file", "right", "strike", "con_id", "bid_bars", "ask_bars", "first_epoch", "last_epoch"])
        for (right, strike), rows in quotes.items():
            name = f"SPY-{day:%Y%m%d}-{right}-{strike:g}.csv.gz"
            mw.writerow([name, right, f"{strike:g}", 1, len(rows), len(rows), "", ""])
            with gzip.open(folder / name, "wt", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(["epoch", "bid_open", "bid_high", "bid_low", "bid_close",
                            "ask_open", "ask_high", "ask_low", "ask_close"])
                for row in rows:
                    minute, bid, ask = row[0], row[1], row[2]
                    bc = row[3] if len(row) > 3 else ""
                    ac = row[4] if len(row) > 4 else ""
                    w.writerow([open_ts + 60 * minute, bid, "", "", bc, ask, "", "", ac])
    return folder


def test_file_quote_book_reads_collector_files(tmp_path):
    from strategies.noise_band_0dte import FileQuoteBook

    _write_day(tmp_path, D, "complete", {
        ("C", 500.0): [(-120, 9.0, 9.5), (30, 1.95, 2.00), (120, 2.50, 2.55), (375, 0.1, "")],
        ("C", 501.0): [(30, 1.40, 1.45)],
        ("P", 499.0): [(30, 1.0, 1.1)],
    })
    _write_day(tmp_path, date(2024, 3, 4), "partial", {("C", 500.0): [(30, 1.0, 1.1)]})
    book = FileQuoteBook(tmp_path)
    assert book.days() == [D]
    assert book.excluded_days() == {}
    assert list(book.strikes(D)) == [499.0, 500.0, 501.0]
    assert book.quote(D, 30, "C", 500.0) == (1.95, 2.00)
    assert book.quote(D, 375, "C", 500.0) is None  # blank ask side
    assert book.quote(D, -120, "C", 500.0) is None  # pre-market bars are not session minutes
    assert book.quote(D, 30, "P", 501.0) is None  # contract not stored
    assert list(book.strikes(date(2024, 3, 4))) == [] and book.quote(date(2024, 3, 4), 30, "C", 500.0) is None
    t, why = price_trade(book, stock_trade(), 500.2, 501.0, 100_000.0, OptionParams())
    assert why == "ok" and t.entry_price == 2.00 and t.exit_price == 2.50


def test_crossed_quotes_skip_as_stale_quote_not_zero_credit():
    # Single entry crossed
    t, why = price_trade(
        Book({(30, "C", 500.0): (2.10, 2.00), (120, "C", 500.0): (2.50, 2.55)}),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(),
    )
    assert t is None and why == "stale_quote"

    # Single exit crossed: must skip as stale_quote rather than pricing exit at 0 credit
    t, why = price_trade(
        Book({(30, "C", 500.0): (1.95, 2.00), (120, "C", 500.0): (2.66, 2.45)}),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(),
    )
    assert t is None and why == "stale_quote"

    # Vertical short entry crossed
    t, why = price_trade(
        Book({
            (30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.40, 0.30),
            (120, "C", 500.0): (3.00, 3.05), (120, "C", 505.0): (0.50, 0.55),
        }),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(instrument="vertical"),
    )
    assert t is None and why == "stale_quote"

    # Vertical short exit crossed
    t, why = price_trade(
        Book({
            (30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25),
            (120, "C", 500.0): (3.00, 3.05), (120, "C", 505.0): (0.60, 0.50),
        }),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(instrument="vertical"),
    )
    assert t is None and why == "stale_quote"

    # Vertical long exit crossed
    t, why = price_trade(
        Book({
            (30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25),
            (120, "C", 500.0): (3.10, 3.00), (120, "C", 505.0): (0.50, 0.55),
        }),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(instrument="vertical"),
    )
    assert t is None and why == "stale_quote"

    # Unaffordable entry is classified as too_expensive_for_cap even if exit is crossed
    t, why = price_trade(
        Book({(30, "C", 500.0): (30.0, 30.5), (120, "C", 500.0): (31.5, 31.0)}),
        stock_trade(), 500.0, 501.0, 100_000.0, OptionParams(),
    )
    assert t is None and why == "too_expensive_for_cap"


def test_file_quote_book_marks_isolated_stale_and_ignores_penny_flat(tmp_path):
    from strategies.noise_band_0dte import FileQuoteBook

    # 6 in-range contracts; only 1 has a 30-min flat run above $0.10 (16.7% < 20% threshold)
    # Another has a 60-min flat run at $0.05/$0.06 (penny floor <= $0.10 -> not stale)
    frozen_bars = [(30, 1.95, 2.00)] + [(m, 2.50, 2.55) for m in range(100, 135)]
    penny_bars = [(m, 0.05, 0.06) for m in range(60, 130)]
    ok_bars = [(30, 1.40, 1.45), (120, 1.80, 1.85)]
    _write_day(tmp_path, D, "complete", {
        ("C", 500.0): frozen_bars,
        ("P", 500.0): ok_bars,
        ("C", 501.0): ok_bars,
        ("P", 501.0): ok_bars,
        ("C", 502.0): penny_bars,
        ("P", 502.0): ok_bars,
    }, low=500.0, high=502.0)

    book = FileQuoteBook(tmp_path)
    assert book.days() == [D]
    assert book.excluded_days() == {}
    assert book.is_stale(D, 120, "C", 500.0) is True
    assert book.is_stale(D, 30, "C", 500.0) is False
    assert book.is_stale(D, 100, "C", 502.0) is False  # penny option <= $0.10 not flagged

    # Trade exiting on frozen minute skips as stale_quote
    t, why = price_trade(book, stock_trade(entry=30, exit_=120), 500.0, 501.0, 100_000.0, OptionParams())
    assert t is None and why == "stale_quote"

    # Healthy strike on the same day still prices normally
    t, why = price_trade(book, stock_trade(entry=30, exit_=120), 501.0, 501.5, 100_000.0, OptionParams())
    assert why == "ok" and t.entry_price == 1.45 and t.exit_price == 1.80


def test_file_quote_book_excludes_widespread_stale_session(tmp_path):
    from strategies.noise_band_0dte import FileQuoteBook

    bad_day = date(2024, 3, 5)
    frozen_bars = [(m, 2.66, 2.45) for m in range(280, 320)]
    ok_bars = [(30, 1.95, 2.00), (120, 2.50, 2.55)]
    # 2 of 4 in-range contracts frozen/crossed (50% >= 20% threshold)
    _write_day(tmp_path, bad_day, "complete", {
        ("C", 500.0): frozen_bars,
        ("P", 500.0): frozen_bars,
        ("C", 501.0): ok_bars,
        ("P", 501.0): ok_bars,
    }, low=500.0, high=501.0)
    _write_day(tmp_path, D, "complete", {
        ("C", 500.0): ok_bars,
        ("P", 500.0): ok_bars,
    }, low=500.0, high=500.0)

    book = FileQuoteBook(tmp_path)
    assert book.days() == [D]
    assert bad_day in book.excluded_days()
    assert "stale_session" in book.excluded_days()[bad_day]
    assert list(book.strikes(bad_day)) == []
    assert book.quote(bad_day, 30, "C", 501.0) is None


def test_file_quote_book_edge_cases_crossed_only_close_diff_unsorted_and_empty_range(tmp_path):
    from strategies.noise_band_0dte import FileQuoteBook

    # 1. Crossed-only exclusion (>=10 varying crossed bars, no flat run)
    crossed_only_day = date(2024, 3, 6)
    varying_crossed = [(m, round(2.00 + 0.05 * m, 2), round(1.90 + 0.05 * m, 2)) for m in range(10, 22)]
    _write_day(tmp_path, crossed_only_day, "complete", {
        ("C", 500.0): varying_crossed,
        ("P", 500.0): [(30, 1.95, 2.00)],
    }, low=500.0, high=500.0)

    # 2. Close differing from open breaks flat run; unsorted + duplicate rows resolve by last write in minute order
    edge_day = date(2024, 3, 7)
    # Active intrabar moves (bid_close != bid_open) at same open -> NOT flat
    active_close_bars = [(m, 2.00, 2.05, 2.10, 2.15) for m in range(100, 135)]
    # Unsorted 30-min flat run plus a duplicate epoch where later uncrossed row overwrites earlier crossed row
    unsorted_flat = list(reversed([(m, 2.50, 2.55, 2.50, 2.55) for m in range(200, 232)]))
    unsorted_flat.extend([(30, 2.10, 2.00, 2.10, 2.00), (30, 1.95, 2.00, 1.95, 2.00)])
    ok_bars = [(30, 1.40, 1.45)]
    _write_day(tmp_path, edge_day, "complete", {
        ("C", 500.0): active_close_bars,
        ("P", 500.0): unsorted_flat,
        ("C", 501.0): ok_bars,
        ("P", 501.0): ok_bars,
        ("C", 502.0): ok_bars,
        ("P", 502.0): ok_bars,
    }, low="", high="")  # empty low=/high= falls back safely without ValueError

    book = FileQuoteBook(tmp_path)
    assert crossed_only_day in book.excluded_days()
    assert edge_day in book.days()
    assert book.is_stale(edge_day, 120, "C", 500.0) is False  # intrabar move breaks flat run
    assert book.is_stale(edge_day, 215, "P", 500.0) is True   # unsorted 32-min flat run still caught
    assert book.is_stale(edge_day, 30, "P", 500.0) is False   # duplicate epoch overwritten by uncrossed row
    assert book.quote(edge_day, 30, "P", 500.0) == (1.95, 2.00)


def _collector():
    """The QuantVPS collector (infra/quant-vps/odte-quotes/odte_quotes.py, standard library only), loaded by path."""
    import importlib.util
    import sys
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "infra" / "quant-vps" / "odte-quotes" / "odte_quotes.py"
    spec = importlib.util.spec_from_file_location("odte_quotes_parity", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_collector_stale_rule_matches_file_quote_book(tmp_path):
    """The collector keeps a stale session partial with its own copy of the Amendment 2026-11-28 (f)-(g) rule
    (card vertex-odte-quotes-stale-crossed-guard); both copies must give the same crossed opens and flat verdict."""
    import csv
    import gzip

    from strategies import noise_band_0dte as nb

    oq = _collector()
    assert (oq.STALE_FLAT_MINUTES, oq.STALE_ASK_FLOOR, oq.STALE_CROSSED_OPENS, oq.STALE_DAY_FRACTION) == (
        nb.STALE_FLAT_MINUTES, nb.STALE_ASK_FLOOR, nb.STALE_CROSSED_CONTRACT_MINUTES, nb.STALE_DAY_FRACTION)
    cases = {
        ("C", 500.0): [(m, 2.66, 2.45) for m in range(280, 320)],  # frozen and crossed
        ("P", 500.0): [(m, 1.0, 1.1, 1.0, 1.1) for m in range(29)],  # 29 flat minutes: not frozen
        ("C", 501.0): [(m, 0.05, 0.10) for m in range(40)],  # flat at a $0.10 ask: not frozen
        ("P", 501.0): [(m, 2.00, 2.05, 2.10, 2.15) for m in range(100, 135)],  # closes move: not flat
        ("C", 502.0): list(reversed([(m, 2.50, 2.55) for m in range(200, 232)])) + [(30, 2.10, 2.00), (30, 1.95, 2.00)],
        ("P", 502.0): [(m, round(2.0 + 0.05 * m, 2), round(1.9 + 0.05 * m, 2)) for m in range(-5, 12)],  # 12 crossed
    }
    folder = _write_day(tmp_path, D, "complete", cases, low=500.0, high=502.0)
    verdicts = []
    for right, strike in cases:
        path = folder / f"SPY-{D:%Y%m%d}-{right}-{strike:g}.csv.gz"
        _, crossed, flat = nb._load_contract(path, D)
        with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
            got_crossed, got_longest = oq.quote_health(list(csv.reader(f))[1:], D)
        assert (got_crossed, got_longest >= oq.STALE_FLAT_MINUTES) == (len(crossed), bool(flat)), (right, strike)
        verdicts.append((len(crossed), bool(flat)))
    assert verdicts == [(40, True), (0, False), (0, False), (0, False), (0, True), (12, False)]
