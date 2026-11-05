#!/usr/bin/env python3
"""Disabled: this script used to call IBKR placeOrder directly.

The frozen version (sha256 a12a52dae6828e8c770f085289119c65fbadbba701b75e1e0f3466502d53bead)
connected its own TWS API client and called ``client.placeOrder`` for each
approved draft. That bypassed the owner arm gate and the options-only,
defined-risk order policy in ``nautilus/arm_gate.py`` (options only, risk always
defined, max loss per order <= 2% of NetLiquidation). It cannot be routed
through ``arm_gate.place_order`` from the host: the arm record is bound to the
Nautilus image version, which a host Python process never matches, so it would
be refused anyway.

It now refuses to run and never connects to IBKR. portfolio-ui's close button
runs this script, so that button reports this message. Close a position in TWS
or IBKR Mobile, or through the armed Nautilus node, whose ``place_order`` call
site enforces the gate and the order policy.
"""

from __future__ import annotations

import sys

REFUSAL = (
    "This position-close transmit script is disabled: it placed IBKR orders directly, "
    "bypassing the owner arm gate and the options-only order policy (nautilus/arm_gate.py). "
    "No order was sent. Close positions in TWS or IBKR Mobile, or through the armed Nautilus node."
)
EXIT_DISABLED = 2


def main(argv: list[str] | None = None) -> int:
    del argv  # every invocation is refused, whatever its flags
    print(REFUSAL, file=sys.stderr)
    return EXIT_DISABLED


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
