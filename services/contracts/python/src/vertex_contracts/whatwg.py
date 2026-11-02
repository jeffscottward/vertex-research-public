"""Source-compatible URL predicates backed by Ada's WHATWG implementation.

API source: https://ada-url.readthedocs.io/en/latest/_modules/ada_url/ada_adapter.html
Version source: https://pypi.org/pypi/ada-url/4.0.0/json
No URL parsing, distribution discovery or backend import happens on module import.
The backend is required when constructing an authority, not silently substituted.
"""

from functools import lru_cache
from importlib import import_module, metadata

from .codec import ContractUnavailable

WHATWG_DISTRIBUTION = "ada-url"
WHATWG_VERSION = "4.0.0"


@lru_cache(maxsize=1)
def require_whatwg_backend():
    try:
        if metadata.version(WHATWG_DISTRIBUTION) != WHATWG_VERSION:
            raise ContractUnavailable("Unsupported WHATWG backend version")
        backend = import_module("ada_url")
        parser = getattr(backend, "URL", None)
        if not callable(parser):
            raise ContractUnavailable("WHATWG URL backend missing required API")
        return parser
    except ContractUnavailable:
        raise
    except (ImportError, OSError, RuntimeError, AttributeError, metadata.PackageNotFoundError) as exc:
        raise ContractUnavailable("Pinned WHATWG URL backend is unavailable") from exc


def public_https(value) -> bool:
    if type(value) is not str or len(value) > 2048:
        return False
    try:
        if len(value.encode("utf-16-le", "strict")) // 2 > 2048:
            return False
    except UnicodeError:
        return False
    parser = require_whatwg_backend()
    try:
        parsed = parser(value)
    except ValueError:
        return False
    except (OSError, RuntimeError) as exc:
        raise ContractUnavailable("WHATWG URL backend failed") from exc
    try:
        fields = tuple(getattr(parsed, name) for name in ("protocol", "username", "password", "search", "hash"))
    except (AttributeError, OSError, RuntimeError) as exc:
        raise ContractUnavailable("WHATWG URL backend component support unavailable") from exc
    if any(type(field) is not str for field in fields):
        raise ContractUnavailable("Unsupported WHATWG URL component representation")
    # Match source `new URL(value)`: the parser handles IDNA, percent hosts,
    # special-scheme recovery, tabs/newlines and IPv4/IPv6. Empty '?' and '#'
    # serialize to empty search/hash getters and are accepted by the source.
    # Never replace the artifact string with normalized href: hashes bind input.
    return fields[0] == "https:" and all(field == "" for field in fields[1:])
