"""Vertex OpenBB fetcher: public market, macro and filing data for the openbb.* ingest.

`python -I -m vertex_openbb <job>` prints one `openbb-batch.v1` JSON document on stdout
(docs/vertex-rebuild/openbb.md). Research only: nothing here places, changes or cancels orders,
opens a database or writes a data file.
"""

__version__ = "0.1.0"
