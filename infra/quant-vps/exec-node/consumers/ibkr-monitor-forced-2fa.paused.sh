#!/bin/sh
# Forced command for the ibkr-monitor 2FA key while exec_node.py switches or rolls back the exec node root.
# No 2FA run may start in that window. exec_node.py replaces this file with the real command afterwards.
echo "ibkr-monitor 2fa key: paused for exec node maintenance" >&2
exit 1
