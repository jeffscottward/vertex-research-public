"""Job context: arguments, defaults, output tables, warnings and per-source outcomes."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from .upstream import Upstream, UpstreamError

CORE7 = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
STOCKS = ("AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "COST", "NFLX")
UNIVERSE_ENV = "OPENBB_STOCK_UNIVERSE"
MAX_WARNINGS = 500
MAX_WARNING_CHARS = 2000


class ArgumentError(ValueError):
    """Bad arguments or configuration: exit 2."""


@dataclass
class Context:
    job: str
    today: date
    up: Upstream
    since: date | None = None
    symbols: tuple[str, ...] | None = None
    filers: tuple[str, ...] | None = None
    env: Mapping[str, str] = field(default_factory=dict)
    stocks: tuple[str, ...] = STOCKS
    warnings: list[str] = field(default_factory=list)
    sources_ok: int = 0
    sources_failed: int = 0
    # Rows collected so far per table; the document is built from these, so a job that hits the
    # deadline still prints what it already fetched.
    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def start(self, default_days: int) -> date:
        """`--since` or today minus the job's default window."""
        return self.since or (self.today - timedelta(days=default_days))

    def table(self, name: str) -> list[dict[str, Any]]:
        return self.tables.setdefault(name, [])

    def warn(self, message: str) -> None:
        text = " ".join(str(message).split())
        if len(text) > MAX_WARNING_CHARS:
            text = text[: MAX_WARNING_CHARS - 1] + "…"
        if text not in self.warnings:
            self.warnings.append(text)

    def ok(self) -> None:
        self.sources_ok += 1

    def failed(self, source: str, error: UpstreamError | Exception) -> None:
        self.sources_failed += 1
        message = error.message if isinstance(error, UpstreamError) else f"{type(error).__name__}: {error}"
        self.warn(f"{source}: {message}")

    def take(
        self,
        source: str,
        data: Any,
        build: Callable[[], Iterable[dict[str, Any]]],
        sink: list[dict[str, Any]],
        *,
        expect_rows: bool = True,
    ) -> list[dict[str, Any]]:
        """Turn one source's upstream payload into rows and add them to `sink`.

        The source counts as fetched (`ok`) only when this succeeds: an exception in `build` marks
        the source failed and adds nothing, so one bad record never drops the other sources. When
        non-empty upstream input gives no row at all (an upstream column or header change), it
        warns.
        """
        try:
            out = list(build())
        except Exception as exc:  # noqa: BLE001 - one source's bad payload must not stop the job
            self.failed(source, UpstreamError("error", f"could not read the upstream payload ({type(exc).__name__}: {exc})"))
            return []
        self.ok()
        sink.extend(out)
        size = len(data) if hasattr(data, "__len__") else 0
        if expect_rows and size and not out:
            self.warn(f"{source}: upstream returned {size} records but none gave a row (format change?)")
        return out

    def symbol_list(self, default: tuple[str, ...]) -> tuple[str, ...]:
        return self.symbols if self.symbols is not None else default

    @property
    def core_and_stocks(self) -> tuple[str, ...]:
        return CORE7 + tuple(s for s in self.stocks if s not in CORE7)

    def capped_warnings(self) -> list[str]:
        if len(self.warnings) <= MAX_WARNINGS:
            return list(self.warnings)
        kept = self.warnings[: MAX_WARNINGS - 1]
        return kept + [f"{len(self.warnings) - len(kept)} more warnings not shown"]


def all_failed(ctx: Context) -> bool:
    return ctx.sources_failed > 0 and ctx.sources_ok == 0


def parse_list(text: str | None) -> list[str]:
    if text is None:
        return []
    return [part.strip() for part in text.replace(" ", ",").split(",") if part.strip()]
