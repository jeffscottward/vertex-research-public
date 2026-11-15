"""Errors of the market notes tool: a failure (exit 1) or a usage error (exit 2)."""
from __future__ import annotations


class NoteError(RuntimeError):
    """The command could not finish. The message is safe to print (it never holds a key)."""


class UsageError(Exception):
    """The command line is wrong. Nothing was downloaded, sent or stored."""
