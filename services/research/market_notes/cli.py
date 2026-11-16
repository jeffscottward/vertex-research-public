"""Rig intake and verification of owner market notes. Research only: no order, size or risk path.

Use (from services/research; on the rig through infra/market-notes/vertex-market-note):

    python -m market_notes.cli add <url-or-text> [--owner-message URL]
    python -m market_notes.cli list [--scope active|all] [--format text|json]
    python -m market_notes.cli evidence <id> [--ticker T ...] [--quarters 8]
    python -m market_notes.cli check <id> --claim c1 --status supported --evidence "..."
    python -m market_notes.cli renew <id> --review-by 2026-12-31
    python -m market_notes.cli retire <id>

Exit codes: 0 done, 1 failure (nothing half-stored), 2 wrong command line.

Environment (names only; no value is ever printed):
- VERTEX_API_URL (or VERTEX_ORIGIN) and VERTEX_AGENT_API_KEY: the Vertex API and an operator
  write key. https, or http on this machine only; redirects are refused.
- VERTEX_MARKET_NOTE_YTDLP: the yt-dlp binary (default: yt-dlp on PATH). It always runs with
  --ignore-config --no-cookies --no-cookies-from-browser --no-playlist: public media only.
- VERTEX_MARKET_NOTE_TRANSCRIBE and VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON: the GPU transcribe
  script and its interpreter (default: ~/Github/tools/ig-kb-systemcracker/transcribe.py and the
  .venv next to it). The script must keep its GPU gate of at least 4,096 MiB free; there is no
  CPU path.
- VERTEX_OMP_BIN: the omp binary for the claim extraction (Claude through the local OMP login).
- FINANCIAL_DATASETS_API_KEY (or FINANCIALDATASETS_API_KEY): for `evidence` only.

The text of a note is third-party data. It is stored and shown, never run and never followed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TextIO

from providers import financialdatasets_cli as fd

from . import contract, evidence, process, render, sources
from . import transcribe as asr
from .client import API_KEY_ENV, MarketNotesClient, MarketNotesError
from .errors import NoteError, UsageError
from .extract import Generator, default_generator, extract

PROG = "python -m market_notes.cli"
REVIEW_DAYS = 30
TRANSCRIPT_FILE_MAX_BYTES = 2_000_000


def _today() -> date:
    return datetime.now(timezone.utc).date()


@dataclass
class Deps:
    """Everything the commands reach outside this process. Tests replace each one with a fake."""

    client_factory: Callable[[Mapping[str, str]], Any] = MarketNotesClient.from_env
    download_run: Callable[..., Any] = process.run_group
    transcribe_run: Callable[..., Any] = process.run_group
    article_opener: Callable[..., Any] | None = None
    resolve: Callable[..., Any] | None = None  # None: socket.getaddrinfo
    install_signal: Callable[[int, Any], Any] = signal.signal
    generator_factory: Callable[[], Generator] = default_generator
    fd_transport_factory: Callable[[str, Any], Any] | None = None
    fd_clock: Any = None
    today: Callable[[], date] = _today
    sleep: Callable[[float], None] = time.sleep


class _Out:
    """Result lines go to stdout and progress or errors to stderr. A key value is never written."""

    def __init__(self, stdout: TextIO, stderr: TextIO, environ: Mapping[str, str]) -> None:
        self._stdout, self._stderr = stdout, stderr
        names = (API_KEY_ENV, *fd.KEY_ENV_NAMES)
        self._secrets = [value for value in (environ.get(name, "").strip() for name in names) if value]

    def _safe(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "<hidden>")
        return text

    def say(self, text: str) -> None:
        self._stdout.write(self._safe(text) + "\n")

    def note(self, text: str) -> None:
        self._stderr.write(self._safe(f"market-notes: {text}") + "\n")
        self._stderr.flush()


def _checked(check: Callable[..., Any], *args: Any) -> Any:
    """Run one value check of the command line; a wrong value is a usage error."""
    try:
        return check(*args)
    except ValueError as error:
        raise UsageError(str(error)) from None


def _client(environ: Mapping[str, str], deps: Deps) -> Any:
    try:
        return deps.client_factory(environ)
    except ValueError as error:  # names the variables only, never a value
        raise NoteError(str(error)) from None


def _cut(text: str, maximum: int) -> str:
    """``text`` cut to ``maximum`` UTF-16 code units."""
    if contract.units(text) <= maximum:
        return text
    return text.encode("utf-16-le")[:maximum * 2].decode("utf-16-le", errors="ignore").rstrip()


# ---- add ------------------------------------------------------------------------------------

def _flag_extraction(args: argparse.Namespace, theme: str, claims: list[str], direction: str,
                     confidence: str, found: contract.Extraction | None = None) -> contract.Extraction:
    """The extraction with the command-line values; flag values come before the model's."""
    base = found or contract.Extraction(theme, tuple(claims), (), (), (), direction, confidence)
    return contract.extraction({
        "theme": theme, "claims": claims,
        "affected": {"sectors": [*args.sector, *base.sectors],
                     "strategies": [*args.strategy, *base.strategies],
                     "tickers": [*(symbol.upper() for symbol in args.ticker), *base.tickers]},
        "stance": {"confidence": confidence, "direction": direction},
    })


def _check_flag_texts(args: argparse.Namespace) -> None:
    """Check each text typed on the command line. A wrong value names its flag; nothing is changed silently."""
    typed = (("--theme", [] if args.theme is None else [args.theme], contract.THEME_MAX),
             ("--claim", args.claim, contract.CLAIM_MAX), ("--sector", args.sector, contract.SECTOR_MAX),
             ("--strategy", args.strategy, contract.STRATEGY_MAX))
    for flag, values, maximum in typed:
        for value in values:
            _checked(contract.one_line, value, maximum, flag)
    for symbol in args.ticker:
        try:
            contract.ticker(symbol.upper())
        except ValueError as error:
            raise UsageError(f"--ticker: {error}") from None


def _manual_extraction(args: argparse.Namespace) -> contract.Extraction | None:
    """The extraction given on the command line, or None when Claude must read the text."""
    if (args.theme is not None) != bool(args.claim):
        raise UsageError("pass --theme together with at least one --claim, or neither (then Claude reads the text)")
    _check_flag_texts(args)
    if args.theme is None:
        # The flags that add to the model's answer are checked now, before any download.
        _checked(_flag_extraction, args, "theme", ["claim"], args.stance or "neutral", args.confidence or "low")
        return None
    if args.stance is None or args.confidence is None:
        raise UsageError("with --theme and --claim also pass --stance and --confidence")
    return _checked(_flag_extraction, args, args.theme, args.claim, args.stance, args.confidence)


def _transcript_file(path: str) -> str:
    """The text of the file. At most the limit plus one byte is read: a pipe or a device reports no size."""
    try:
        with open(Path(path).expanduser(), "rb") as handle:
            data = handle.read(TRANSCRIPT_FILE_MAX_BYTES + 1)
    except OSError as error:
        raise UsageError(f"--transcript-file cannot be read ({error.strerror or type(error).__name__})") from None
    if len(data) > TRANSCRIPT_FILE_MAX_BYTES:
        raise UsageError(f"--transcript-file is larger than {TRANSCRIPT_FILE_MAX_BYTES // 1_000_000} MB")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise UsageError("--transcript-file is not UTF-8 text") from None


def _reel_text(url: str, args: argparse.Namespace, environ: Mapping[str, str], deps: Deps,
               out: _Out) -> tuple[str, str | None, str | None]:
    """Transcript, author and upload date of one public reel."""
    gate = asr.preflight(environ)  # fail before the download when the GPU tool is missing or its gate is too low
    folder = Path(tempfile.mkdtemp(prefix="vertex-market-note-dl-"))
    try:
        out.note("downloading the audio with yt-dlp (public media only: no cookies, no browser)")
        reel = sources.download_reel(url, folder, environ=environ, run=deps.download_run, resolve=deps.resolve)
        out.note(f"transcribing on the GPU (waits for {gate} MiB free; "
                 f"limit {args.transcribe_timeout:g} s; no CPU path)")
        transcript = asr.transcribe(reel.audio, reel.media_id, environ=environ, run=deps.transcribe_run,
                                    timeout_s=args.transcribe_timeout)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return transcript.text, reel.author, reel.upload_date


def _add(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    value = args.source
    if not value.strip():
        raise UsageError("the note source is empty")
    detected = sources.detect_kind(value)
    kind = args.kind or detected
    if kind == "owner-text" and detected != "owner-text":
        raise UsageError("--kind owner-text takes the note text, not a link")
    if kind != "owner-text" and detected == "owner-text":
        raise UsageError(f"--kind {kind} needs one http(s) link")
    source_url = _checked(contract.url, value, "the source link") if kind != "owner-text" else None
    if source_url is None and args.transcript_file:
        raise UsageError("--transcript-file goes with a link; for plain text pass the text itself")
    if source_url is None and contract.broken_text(value):
        raise UsageError("the note text holds a NUL character or bytes that are not valid text")
    if kind == "reel" and not args.transcript_file and not source_url.lower().startswith("https://"):
        raise UsageError("a reel link must use https (or pass its text with --transcript-file)")
    today = deps.today()
    owner_message = _checked(contract.url, args.owner_message, "--owner-message") if args.owner_message else None
    author = _checked(contract.one_line, args.author, contract.AUTHOR_MAX, "--author") if args.author else None
    as_of = _checked(contract.as_of_date, args.as_of, "--as-of", today) if args.as_of else None
    review_by = _checked(contract.review_date, args.review_by, "--review-by", today) if args.review_by else None
    if as_of is not None and review_by is not None and review_by < as_of:
        raise UsageError(f"--review-by {review_by} is before the as-of date {as_of}")
    if not 0 < args.transcribe_timeout <= asr.MAX_TIMEOUT_S:
        raise UsageError(f"--transcribe-timeout must be in (0, {asr.MAX_TIMEOUT_S:g}] seconds")
    manual = _manual_extraction(args)
    file_text = _transcript_file(args.transcript_file) if args.transcript_file else None

    client = _client(environ, deps)
    if source_url is not None:
        known = client.list_notes(scope="all", source_url=source_url)["notes"]
        if known:
            out.say(render.stored_text(f"already stored: {known[0].get('id')}", known[0]))
            return 0

    # Text from outside (a file, a transcript, a page) loses what the server refuses in raw text.
    upload_date: str | None = None
    if file_text is not None:
        raw = contract.tidy_text(file_text)
    elif kind == "reel":
        reel_text, reel_author, upload_date = _reel_text(source_url, args, environ, deps, out)
        raw, author = contract.tidy_text(reel_text), author or reel_author
    elif kind == "article":
        raw = contract.tidy_text(sources.fetch_article(source_url, opener=deps.article_opener, resolve=deps.resolve,
                                                       notify=out.note))
    else:
        raw = value
    raw = raw.strip()
    if not raw:
        raise NoteError("the note text is empty; nothing was stored")
    if contract.units(raw) > contract.RAW_TEXT_MAX:
        out.note(f"the text has {contract.units(raw):,} characters; the first {contract.RAW_TEXT_MAX:,} are stored")
        raw = _cut(raw, contract.RAW_TEXT_MAX)

    if as_of is None and upload_date is not None:
        try:
            as_of = contract.as_of_date(upload_date, "the reel upload date", today)
            out.note(f"as-of date {as_of} is the reel upload date (set another with --as-of)")
        except ValueError:
            out.note("the reel upload date cannot be a note date; the as-of date is today (set another with --as-of)")
    as_of = as_of or today
    # The review clock starts when the owner sends the note, so a reel that is already old still
    # gets its review period.
    review_by = review_by or max(as_of, today) + timedelta(days=REVIEW_DAYS)
    if review_by < as_of:
        raise UsageError(f"--review-by {review_by} is before the as-of date {as_of}")
    if review_by < today:
        out.note(f"review date {review_by} is before today: the note will read as expired and stay out of "
                 "agent context until you renew it with the renew command")

    if manual is not None:
        found = manual
    else:
        out.note("reading the theme and the claims with Claude through the OMP login")
        model = extract(raw, kind=kind, as_of=as_of.isoformat(), generator_factory=deps.generator_factory)
        try:
            found = _flag_extraction(args, model.theme, list(model.claims), args.stance or model.direction,
                                     args.confidence or model.confidence, model)
        except ValueError as error:
            raise NoteError(f"the model answer with the command-line values is outside the contract: {error}") from None

    created, note = client.add({
        "affected": found.affected(), "asOf": as_of.isoformat(), "claims": list(found.claims),
        "ownerMessageUrl": owner_message, "rawText": raw, "reviewBy": review_by.isoformat(),
        "source": {"author": author, "kind": kind, "url": source_url},
        "stance": found.stance(), "theme": found.theme,
    })
    out.say(render.stored_text(f"{'stored' if created else 'already stored'}: {note['id']}", note))
    return 0


# ---- list, evidence, check, renew, retire ----------------------------------------------------

def _list(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    listing = _client(environ, deps).list_notes(scope=args.scope)
    if args.scope == "active":  # the server leaves the others out; this keeps the promise if it does not
        listing = render.active_only(listing)
    out.say(json.dumps(listing, ensure_ascii=False, indent=2) if args.format == "json"
            else render.notes_text(listing, args.scope))
    return 0


def _evidence(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    note_id = _checked(contract.note_id, args.id)
    if not 1 <= args.quarters <= evidence.MAX_QUARTERS:
        raise UsageError(f"--quarters must be 1 to {evidence.MAX_QUARTERS} (one page; pages are not followed)")
    asked = [_checked(contract.ticker, symbol.upper()) for symbol in args.ticker]
    note = _client(environ, deps).get(note_id)
    affected = note.get("affected") if isinstance(note.get("affected"), dict) else {}
    named = [symbol for symbol in affected.get("tickers") or []
             if contract.is_ticker(symbol)]
    tickers = list(dict.fromkeys([*asked, *named]))
    if not tickers:
        raise UsageError("the note names no ticker; pass --ticker")
    chosen, left_out = tickers[:evidence.MAX_TICKERS], tickers[evidence.MAX_TICKERS:]
    pack = evidence.build_pack(note, chosen, left_out, args.quarters, environ=environ,
                               transport_factory=deps.fd_transport_factory, clock=deps.fd_clock, sleep=deps.sleep)
    out.say(evidence.pack_json(pack) if args.format == "json" else evidence.pack_text(pack))
    if not evidence.complete(pack):
        failed = next(entry for entry in pack["tickers"] if entry["status"] != "ok")
        out.note(f"the pack is not complete: {failed['ticker']}: {failed['reason']}. "
                 "A ticker without numbers has no numbers; nothing was made up")
        return 1
    return 0


def _check(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    note_id = _checked(contract.note_id, args.id)
    claim = _checked(contract.claim_id, args.claim)
    proof = _checked(contract.evidence, args.evidence)
    note = _client(environ, deps).record_checks(note_id, [{"claimId": claim, "evidence": proof,
                                                           "status": args.status}])
    out.say("\n".join([f"recorded: {note['id']} {claim} [{args.status}]",
                       f"verification: {render.verification_line(note.get('verification'))}",
                       "claims:", *render.claim_lines(note)]))
    return 0


def _renew(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    note_id = _checked(contract.note_id, args.id)
    review_by = _checked(contract.review_date, args.review_by, "--review-by", deps.today())
    note = _client(environ, deps).review(note_id, {"kind": "renew", "reviewBy": review_by.isoformat()})
    out.say(f"renewed: {note['id']} review by {note.get('reviewBy')} status {note.get('status')}")
    return 0


def _retire(args: argparse.Namespace, environ: Mapping[str, str], deps: Deps, out: _Out) -> int:
    note = _client(environ, deps).review(_checked(contract.note_id, args.id), {"kind": "retire"})
    out.say(f"retired: {note['id']} status {note.get('status')}")
    return 0


COMMANDS = {"add": _add, "list": _list, "evidence": _evidence, "check": _check, "renew": _renew, "retire": _retire}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=PROG, description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True, metavar="command")

    add = commands.add_parser("add", help="store one note from a reel link, an article link or plain text")
    add.add_argument("source", metavar="url-or-text", help="a reel link, an article link, or the note text")
    add.add_argument("--owner-message", metavar="URL", help="link to the owner's message that supplied the note")
    add.add_argument("--as-of", metavar="DATE", help="market date of the note, YYYY-MM-DD "
                                                   "(default: the reel upload date, else today UTC)")
    add.add_argument("--review-by", metavar="DATE", help=f"review date (default: {REVIEW_DAYS} days after today, or after a later as-of date)")
    add.add_argument("--author", help="author of the source (default for a reel: its uploader)")
    add.add_argument("--kind", choices=contract.SOURCE_KINDS,
                     help="default: instagram, tiktok, youtube and x/twitter post links are reels, "
                          "another http(s) link is an article, anything else is owner text")
    add.add_argument("--transcript-file", metavar="PATH",
                     help="text of the link, already transcribed: no download and no transcription")
    add.add_argument("--theme", help="theme line; with --claim the model is not called")
    add.add_argument("--claim", action="append", default=[], help="one checkable claim; repeat for more")
    add.add_argument("--stance", choices=contract.STANCES)
    add.add_argument("--confidence", choices=contract.CONFIDENCES)
    add.add_argument("--ticker", action="append", default=[], help="affected ticker; repeat for more")
    add.add_argument("--sector", action="append", default=[], help="affected sector; repeat for more")
    add.add_argument("--strategy", action="append", default=[], help="affected strategy or sleeve; repeat for more")
    add.add_argument("--transcribe-timeout", type=float, default=asr.DEFAULT_TIMEOUT_S, metavar="SECONDS",
                     help=f"limit of the GPU transcription, with the wait for free GPU memory "
                          f"(default {asr.DEFAULT_TIMEOUT_S:g})")

    listing = commands.add_parser("list", help="notes with the status of every claim")
    listing.add_argument("--scope", choices=contract.LIST_SCOPES, default="active",
                         help="active leaves out expired and retired notes (default)")
    listing.add_argument("--format", choices=("text", "json"), default="text")

    pack = commands.add_parser("evidence", help="quarterly cash-flow data pack for the claim checks (no model call)")
    pack.add_argument("id")
    pack.add_argument("--ticker", action="append", default=[],
                      help=f"ticker to add to those of the note; at most {evidence.MAX_TICKERS} in one pack")
    pack.add_argument("--quarters", type=int, default=evidence.DEFAULT_QUARTERS,
                      help=f"quarters per ticker, 1-{evidence.MAX_QUARTERS} (default {evidence.DEFAULT_QUARTERS})")
    pack.add_argument("--format", choices=("text", "json"), default="text")

    check = commands.add_parser("check", help="record the status and the evidence of one claim")
    check.add_argument("id")
    check.add_argument("--claim", required=True, metavar="cN", help="claim id, c1 to c12")
    check.add_argument("--status", required=True, choices=contract.CHECK_STATUSES)
    check.add_argument("--evidence", required=True, metavar="TEXT",
                       help=f"what the check found, with its source and date (at most {contract.EVIDENCE_MAX} characters)")

    renew = commands.add_parser("renew", help="set a new review date (an expired note becomes active again)")
    renew.add_argument("id")
    renew.add_argument("--review-by", required=True, metavar="DATE")

    retire = commands.add_parser("retire", help="retire a note for good")
    retire.add_argument("id")
    return parser


def main(argv: list[str] | None = None, *, environ: Mapping[str, str] | None = None,
         stdout: TextIO | None = None, stderr: TextIO | None = None, deps: Deps | None = None) -> int:
    environ = os.environ if environ is None else environ
    out = _Out(sys.stdout if stdout is None else stdout, sys.stderr if stderr is None else stderr, environ)
    try:
        args = _parser().parse_args(argv)
    except SystemExit as stop:  # argparse has printed the help (0) or the usage message (2)
        return stop.code if isinstance(stop.code, int) else 2
    deps = deps or Deps()
    try:
        # SIGTERM and SIGHUP end the child process group and remove the temporary directories.
        with process.exit_on_signals(deps.install_signal):
            return COMMANDS[args.command](args, environ, deps, out)
    except process.Terminated as stop:
        out.note(f"stopped by {signal.Signals(stop.signum).name}: the command did not finish; "
                 "its child processes were ended and its temporary files removed")
        return 128 + stop.signum
    except UsageError as error:
        out.note(f"usage: {error}")
        return 2
    except (NoteError, MarketNotesError) as error:
        out.note(str(error))
        return 1
    except Exception as error:  # never show a traceback that could carry request details
        out.note(f"internal error ({type(error).__name__})")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
