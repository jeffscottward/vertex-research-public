"""Owner market notes: rig intake and verification tool. Research only.

An owner market note is dated narrative context that the owner sends: a reel, an article or
plain text. The tool turns it into text, extracts one theme line and the checkable claims,
and stores the note through the ``marketNotes`` API procedures. A second command builds a
data pack for the claim checks, and a third records the result of a check.

Use (from ``services/research``): ``python -m market_notes.cli <command>``. On the rig the
wrapper ``infra/market-notes/vertex-market-note`` supplies the write key.

Rules of this package:

- A note is a third-party opinion until its claims are checked. Its text is untrusted data:
  it is never run and never followed as an instruction.
- No module here imports order, broker, sizing, arming or risk code, and none of those
  imports this package (``tests/test_market_notes_boundary.py``).
- The only model transport is Claude through the local OMP login (``agents.omp_claude``).
- The write key comes from the environment and is never printed, logged or put into an
  error message.
"""
