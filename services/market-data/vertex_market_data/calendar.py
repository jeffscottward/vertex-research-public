"""Calendar implementation over explicitly supplied versioned sessions, never guessed holidays."""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from typing import Any

from providers.boundary import BoundaryError, epoch_ns, identifier
from .normalization import BarWindow


@dataclass(frozen=True)
class Session:
    session_id: str
    open_at: str
    close_at: str


@dataclass(frozen=True)
class BarBinding:
    provider: str
    timestamp_field: str
    timestamp_semantics: str
    interval: str
    source_reference: str
    # Precomputed interval endpoints preserve provider nanoseconds and exchange DST.
    windows: tuple[BarWindow, ...]


class ExplicitSessionCalendar:
    def __init__(self, *, calendar_id: str, version: str, sessions: tuple[Session, ...], bindings: tuple[BarBinding, ...]):
        self.calendar_id, self.version = identifier(calendar_id), identifier(version)
        if not calendar_id.endswith(":" + version):
            raise BoundaryError("calendar-version-must-be-bound-to-identity")
        if not sessions or len(sessions) > 10_000 or len(bindings) > 32:
            raise BoundaryError("calendar-budget")
        ordered = sorted(sessions, key=lambda session: epoch_ns(session.open_at))
        if len({session.session_id for session in sessions}) != len(sessions):
            raise BoundaryError("duplicate-calendar-session")
        for index, session in enumerate(ordered):
            identifier(session.session_id)
            if epoch_ns(session.open_at) >= epoch_ns(session.close_at) or (index and epoch_ns(ordered[index - 1].close_at) > epoch_ns(session.open_at)):
                raise BoundaryError("calendar-session-overlap")
        starts = [epoch_ns(session.open_at) for session in ordered]
        ends = [epoch_ns(session.close_at) for session in ordered]
        self._bindings: dict[tuple[str, str], tuple[str, dict[int, BarWindow]]] = {}
        for binding in bindings:
            key = (binding.provider, binding.interval)
            if key in self._bindings or not binding.source_reference or binding.timestamp_semantics not in ("start", "end") or not binding.timestamp_field:
                raise BoundaryError("calendar-binding-ambiguous")
            if not 1 <= len(binding.windows) <= 100_000:
                raise BoundaryError("calendar-window-budget")
            windows = {}
            for window in binding.windows:
                if window.interval != binding.interval or epoch_ns(window.start_at) >= epoch_ns(window.end_at) or epoch_ns(window.observed_at) < epoch_ns(window.end_at):
                    raise BoundaryError("invalid-provider-window")
                session_index = bisect_right(starts, epoch_ns(window.start_at)) - 1
                if session_index < 0 or epoch_ns(window.end_at) > ends[session_index]:
                    raise BoundaryError("window-outside-calendar-session")
                source_time = epoch_ns(window.start_at if binding.timestamp_semantics == "start" else window.end_at)
                if source_time in windows:
                    raise BoundaryError("duplicate-calendar-window")
                windows[source_time] = window
            self._bindings[key] = (binding.timestamp_field, windows)

    def bar_window(self, *, provider: str, row: dict[str, Any], calendar: str, interval: str, as_of_at: str) -> BarWindow:
        if calendar != self.calendar_id:
            raise BoundaryError("calendar-identity-mismatch")
        binding = self._bindings.get((provider, interval))
        if binding is None:
            raise BoundaryError("provider-calendar-binding-unavailable")
        timestamp_field, windows = binding
        timestamp = row.get(timestamp_field)
        if not isinstance(timestamp, str):
            raise BoundaryError("explicit-source-timestamp-required")
        window = windows.get(epoch_ns(timestamp))
        if window is None or epoch_ns(window.observed_at) > epoch_ns(as_of_at):
            raise BoundaryError("bar-window-unavailable-at-cutoff")
        return window
