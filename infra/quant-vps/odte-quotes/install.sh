#!/usr/bin/env bash
# Installs the SPY 0DTE option quote collector (research only, card vertex-noise-band-0dte-collect).
# Run on the rig from a checkout: infra/quant-vps/odte-quotes/install.sh [quantvps-ssh-host]
#
# QuantVPS (as root over ssh): /opt/vertex-odte-quotes/{odte_quotes.py,test_odte_quotes.py,resolve-gateway.sh}
# and the units vertex-odte-quotes{,-check}.{service,timer} in /etc/systemd/system. It runs the unit tests
# there first, keeps the old files in /opt/vertex-odte-quotes/rollback-<UTC time>/, then enables both
# timers. It never starts the collector, and it touches no other unit, container or the IB gateway.
# Owner rule 2026-11-16: no QuantVPS deploy during market hours (only after 16:00 ET or before 08:30 ET);
# the script refuses to run from 08:30 to 16:00 ET on a weekday.
# Rig (this user): the user units vertex-odte-quotes-pull.{service,timer} (rsync copy to
# ~/.local/share/vertex/odte-quotes).
set -euo pipefail
HOST="${1:-quantvps}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
NY_DOW="$(TZ=America/New_York date +%u)"
NY_HM="$(TZ=America/New_York date +%H%M)"
if [[ "${NY_DOW}" -le 5 && "10#${NY_HM}" -ge 830 && "10#${NY_HM}" -lt 1600 ]]; then
  echo "market hours (08:30-16:00 ET on a weekday): no QuantVPS deploy now; nothing changed" >&2
  exit 3
fi
FILES=(odte_quotes.py test_odte_quotes.py resolve-gateway.sh vertex-odte-quotes.service vertex-odte-quotes.timer
  vertex-odte-quotes-check.service vertex-odte-quotes-check.timer)

STAGE="$(ssh -o BatchMode=yes "${HOST}" 'mktemp -d /tmp/odte-quotes-stage-XXXXXX')"
trap 'ssh -o BatchMode=yes "${HOST}" "rm -rf ${STAGE}" || true' EXIT
for f in "${FILES[@]}"; do scp -q "${HERE}/${f}" "${HOST}:${STAGE}/${f}"; done

# shellcheck disable=SC2087 # expand STAGE and TS here, on purpose
ssh -o BatchMode=yes "${HOST}" bash -s <<EOF
set -euo pipefail
cd "${STAGE}"
[ -x /opt/vertex-history/venv/bin/python ] || { echo "no /opt/vertex-history venv; nothing changed"; exit 3; }
/opt/vertex-history/venv/bin/python -c 'import ibapi' || { echo "ibapi missing in the venv; nothing changed"; exit 3; }
docker inspect ibkr-nautilus-exec-node-ib-gateway-1 >/dev/null || { echo "ib-gateway container missing; nothing changed"; exit 3; }
/opt/vertex-history/venv/bin/python -B -I -W ignore test_odte_quotes.py || { echo "unit tests failed; nothing changed"; exit 3; }
D=/opt/vertex-odte-quotes
R=\$D/rollback-${TS}
mkdir -p "\$D" "\$R"; chmod 755 "\$D"; chmod 700 "\$R"
for f in odte_quotes.py test_odte_quotes.py resolve-gateway.sh; do [ -f "\$D/\$f" ] && cp -p "\$D/\$f" "\$R/" || true; done
for u in vertex-odte-quotes.service vertex-odte-quotes.timer vertex-odte-quotes-check.service vertex-odte-quotes-check.timer; do
  [ -f "/etc/systemd/system/\$u" ] && cp -p "/etc/systemd/system/\$u" "\$R/" || true
done
install -m 0644 odte_quotes.py test_odte_quotes.py "\$D/"
install -m 0755 resolve-gateway.sh "\$D/"
install -m 0644 vertex-odte-quotes.service vertex-odte-quotes.timer vertex-odte-quotes-check.service \
  vertex-odte-quotes-check.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vertex-odte-quotes.timer vertex-odte-quotes-check.timer
echo "backup=\$R"
systemctl list-timers --no-pager vertex-odte-quotes.timer vertex-odte-quotes-check.timer
EOF

mkdir -p "${HOME}/.config/systemd/user" "${HOME}/.local/share/vertex/odte-quotes"
# The rig copy pulls from the same host this script installed to.
sed "s#^\(ExecStart=.*\) quantvps:#\1 ${HOST}:#" "${HERE}/vertex-odte-quotes-pull.service" \
  > "${HOME}/.config/systemd/user/vertex-odte-quotes-pull.service"
install -m 0644 "${HERE}/vertex-odte-quotes-pull.timer" "${HOME}/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now vertex-odte-quotes-pull.timer
systemctl --user list-timers --no-pager vertex-odte-quotes-pull.timer
