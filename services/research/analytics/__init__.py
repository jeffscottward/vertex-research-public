"""Cross-asset research analytics (research only).

``ports.SeriesAnalytics`` is the port. ``gs_quant_backend.GsQuantAnalytics`` is
the adapter over the offline part of Goldman Sachs gs-quant 2.2.4 (optional,
lazy import). ``report`` builds the Core 7 risk table through the port. No
module here calls Marquee, a broker, a model or the network, and no result
grants trading authority. See docs/vertex-rebuild/gs-quant.md.
"""
