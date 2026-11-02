#!/usr/bin/env bash
# The only restart route for the QuantVPS web app (`vertex-web.service`, infra/quantvps/).
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias and restarts ONLY
# `vertex-web`. It never starts, stops or restarts Nautilus, the IB gateway, the exec node, the
# recovery bridge, Docker or any container.
#
# Steps:
#  1. Gate: the build output that run-preview.mjs needs (apps/web/dist/server/wrangler.json and
#     apps/web/.wrangler/deploy/config.json) must exist on QuantVPS. Else no restart (exit 3).
#  2. Wait until vertex-web is idle (signal below) on two polls in a row.
#  3. `systemctl restart vertex-web`, then a health check: `/` returns 200 and `/dashboard` returns
#     307 to the sign-in page on 127.0.0.1:3450.
#  4. Health check failed: roll back to the newest dist.bak-<TS> with its .wrangler.bak-<TS> (or
#     --backup <TS>). The failed build is kept as dist.failed-<now>/.wrangler.failed-<now>; the backup
#     is copied, so it stays available. Restart and check health again.
#  5. Check that every container from the baseline keeps its start time (one-off `*-run-<hex>`
#     compose containers may vanish; new containers are ignored) and that vertex-web restarted.
#
# Idle signal (all must hold; the quiet window is VERTEX_RESTART_QUIET seconds, default 30):
#  - The last vertex-web journal line is older than the quiet window. `vite preview` logs every
#    completed request ("GET /path 200 OK (12ms)"), so this means no request finished recently.
#  - On every established TCP connection to 127.0.0.1:3450 (from `ss -tni`): no bytes queued, and
#    no data sent or received inside the quiet window (`lastsnd`, `lastrcv`; a missing field means
#    0 ms ago). Caddy keeps idle keep-alive connections open; they count as idle.
#  - No connection has an open request: data received after the last data sent (`lastrcv` smaller
#    than `lastsnd`), or bytes received with no byte sent yet (a new connection), means a
#    request still waits for its response (for example a slow query).
#  - The probe is complete (`@@END` after the `ss` output). A failed or cut probe counts as busy.
#  - A unit that is not active has nothing to protect and counts as idle.
# Limit: a streamed response that already sent bytes and then stalls longer than the quiet window,
# with no other traffic, reads as idle.
#
# Give-up: when the waiter has not seen two idle polls in a row VERTEX_RESTART_GIVE_UP_AFTER
# wall-clock seconds after the first busy poll (default 3600), the restart is abandoned with ONE
# #omp-alerts notice (exit 4). There is no forced restart.
# Lock: one fixed path for every caller, ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock.
#
# Usage: infra/quantvps/restart-when-idle.sh [--dry-run] [--backup <TS>]
#   --dry-run  print the idle decision, current health, rollback candidate and start times; no
#              restart, no lock, no alert. Exit 0 = idle, 10 = busy.
#   --backup   rollback source timestamp (dist.bak-<TS> and .wrangler.bak-<TS>), default newest pair.
# Exit codes: 0 restarted and healthy; 2 usage; 3 gate or probe failed, or the vertex-web start time
#   did not change (no restart happened); 4 gave up (busy); 5 health failed, rolled back and healthy;
#   6 health failed and rollback failed (web down), or no health answer over ssh (state unknown);
#   7 restarted and healthy, but a container start time changed or could not be checked;
#   8 another restart waiter holds the lock (this run did nothing).
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR,
#   VERTEX_RESTART_SLEEP, VERTEX_RESTART_ALERT (alert command, gets the text), VERTEX_RESTART_LOCK,
#   VERTEX_RESTART_POLL, VERTEX_RESTART_QUIET, VERTEX_RESTART_GIVE_UP_AFTER,
#   VERTEX_RESTART_HEALTH_TIMEOUT (wall-clock seconds). `--decide` is the pure idle decision used
#   by the tests: `restart-when-idle.sh --decide <probe-file> <quiet-seconds>`.
set -uo pipefail

UNIT="vertex-web"
PORT=3450
# apps/web on QuantVPS, found from the unit: WorkingDirectory is <checkout>/private/basic-app-named.
if [ -n "${VERTEX_WEB_DIR:-}" ]; then
  WEB_CD="cd '$VERTEX_WEB_DIR'"
else
  WEB_CD="cd \"\$(systemctl show $UNIT -p WorkingDirectory --value)/../../apps/web\""
fi

# Pure idle decision. Input: probe text (see PROBE). Prints "idle" or "busy", then reason lines.
decide() {
  awk -v quiet="$2" '
    function flush() {
      if (peer == "") return
      conns++
      if (recvq + 0 > 0 || sendq + 0 > 0) { busy = 1; reasons = reasons "\nconnection " peer ": " recvq + sendq " bytes queued" }
      snd = (lastsnd == "" ? 0 : lastsnd + 0); rcv = (lastrcv == "" ? 0 : lastrcv + 0)
      # Open request: data received after the last data sent. The kernel stamps both times when a
      # connection opens, so a request on a new loopback connection can share the open tick; bytes
      # received with no byte sent yet catch that case. Equal times after a response (same 4 ms
      # jiffy) read as answered.
      if (rcv < snd || (brecv + 0 > 0 && bsent + 0 == 0)) { busy = 1; reasons = reasons "\nconnection " peer ": request received " int(rcv / 1000) " s ago, no response yet" }
      else if (snd < quiet * 1000 || rcv < quiet * 1000) { busy = 1; reasons = reasons "\nconnection " peer ": data " (snd < rcv ? snd : rcv) " ms ago" }
      peer = ""
    }
    /^@@NOW / { now = $2 + 0; next }
    /^@@LAST / { last = $2; next }
    /^@@ACTIVE / { active = $2; next }
    /^@@END/ { ended = 1; next }
    /^@@/ { next }
    /^[ \t]/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^lastsnd:/) { lastsnd = substr($i, 9) }
        if ($i ~ /^lastrcv:/) { lastrcv = substr($i, 9) }
        if ($i ~ /^bytes_sent:/) { bsent = substr($i, 12) }
        if ($i ~ /^bytes_received:/) { brecv = substr($i, 16) }
      }
      next
    }
    NF >= 4 { flush(); recvq = $1; sendq = $2; peer = $4; lastsnd = ""; lastrcv = ""; bsent = ""; brecv = ""; next }
    END {
      flush()
      if (active == "") { print "busy"; print "probe incomplete (no unit state)"; exit }
      if (active != "active") { print "idle"; print "unit " "vertex-web" " is " active "; nothing to protect"; exit }
      if (now == 0) { print "busy"; print "probe incomplete (no clock)"; exit }
      if (!ended) { print "busy"; print "probe incomplete (no complete ss output)"; exit }
      if (last != "" && last != "none") {
        age = now - int(last)
        if (age < quiet) { busy = 1; reasons = reasons "\nlast log line " age " s ago (quiet window " quiet " s)" }
        logtext = "last log line " age " s ago"
      } else { logtext = "no log line" }
      if (busy) { print "busy"; print substr(reasons, 2); exit }
      print "idle"
      print "no open request on :" 3450 " (" conns + 0 " keep-alive connection(s), quiet >= " quiet " s); " logtext
    }
  ' "$1"
}

if [ "${1:-}" = "--decide" ]; then
  [ $# -eq 3 ] || { echo "usage: $0 --decide <probe-file> <quiet-seconds>" >&2; exit 2; }
  decide "$2" "$3"
  exit 0
fi

DRY=0
BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --backup)
      shift
      [[ "${1:-}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "--backup needs a timestamp like 20261101T125501Z" >&2; exit 2; }
      BACKUP="$1" ;;
    *) echo "usage: $0 [--dry-run] [--backup <TS>]" >&2; exit 2 ;;
  esac
  shift
done

# ServerAlive and `timeout` keep a dropped network from hanging a call past the wall-clock limits.
read -r -a SSH_CMD <<<"${VERTEX_WEB_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 quantvps}"
SLEEP="${VERTEX_RESTART_SLEEP:-sleep}"
POLL="${VERTEX_RESTART_POLL:-5}"
QUIET="${VERTEX_RESTART_QUIET:-30}"
GIVE_UP_AFTER="${VERTEX_RESTART_GIVE_UP_AFTER:-3600}"
HEALTH_TIMEOUT="${VERTEX_RESTART_HEALTH_TIMEOUT:-120}"
BOT_PORT="${OMP_BOT_HTTP_PORT:-47821}"

# remote <command> [timeout-seconds, default 60]
remote() { timeout "${2:-60}" "${SSH_CMD[@]}" "$1"; }

# One #omp-alerts notice through the rig bot loopback /post.
alert() {
  if [ -n "${VERTEX_RESTART_ALERT:-}" ]; then $VERTEX_RESTART_ALERT "$1" || true; return; fi
  local body
  body="$(jq -nc --arg t "$1" '{channel:"omp-alerts",text:$t}')" &&
    curl -fsS --max-time 5 -H 'content-type: application/json' -d "$body" \
      "http://127.0.0.1:$BOT_PORT/post" >/dev/null 2>&1 ||
    echo "warning: #omp-alerts notice not delivered: $1" >&2
}

# Each remote command starts with a ": <name>;" marker (a no-op) so logs and test fakes can name it.
PROBE=": probe; echo \"@@NOW \$(date +%s)\"; echo \"@@ACTIVE \$(systemctl is-active $UNIT)\";
last=\$(journalctl -u $UNIT -n 1 -q -o short-unix --no-pager 2>/dev/null | awk '{print int(\$1)}');
echo \"@@LAST \${last:-none}\"; ss -Htni state established '( sport = :$PORT )' && echo @@END"
HEALTH=": health; r=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$PORT/);
d=\$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 http://127.0.0.1:$PORT/dashboard);
echo \"root=\$r dashboard=\$d active=\$(systemctl is-active $UNIT)\""
GATE=": gate; $WEB_CD && test -f dist/server/wrangler.json && test -f .wrangler/deploy/config.json && echo build-output-ok"
STARTS=": starts; set -o pipefail; echo \"$UNIT \$(systemctl show $UNIT -p ActiveEnterTimestamp --value)\" &&
docker ps -aq | xargs -r docker inspect -f '{{.Name}} {{.State.StartedAt}}' | sort"
# Only timestamped backup pairs count; a stray name such as dist.bak-old never becomes the source.
CANDIDATE=": candidate; $WEB_CD && want='$BACKUP' &&
for d in \$(ls -1d dist.bak-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z 2>/dev/null | sort -r); do
  ts=\${d#dist.bak-}; if [ -n \"\$want\" ] && [ \"\$ts\" != \"\$want\" ]; then continue; fi;
  if [ -d \".wrangler.bak-\$ts\" ]; then echo \"\$ts\"; exit 0; fi; done; exit 1"
RESTART=": restart; systemctl restart $UNIT"

healthy() { [[ "$1" =~ ^root=200\ dashboard=307\ [^\ ]*/sign-in[^\ ]*\ active=active$ ]]; }
# The health line only: ssh warnings on stderr must not fail a healthy build.
health_line() { remote "$HEALTH" 2>/dev/null | grep -m1 '^root=' || echo "no health answer"; }

# Poll health until it passes or HEALTH_TIMEOUT (wall-clock seconds) runs out. Prints the last line.
wait_healthy() {
  local start h=""
  start="$(date +%s)"
  while :; do
    h="$(health_line)"
    if healthy "$h"; then echo "$h"; return 0; fi
    if [ $(($(date +%s) - start)) -ge "$HEALTH_TIMEOUT" ]; then echo "$h"; return 1; fi
    $SLEEP 3
  done
}

probe_decision() {
  local file out rc
  file="$(mktemp)"
  out="$(remote "$PROBE" 2>/dev/null)"; rc=$?
  if [ $rc -ne 0 ] && [ -z "$out" ]; then rm -f "$file"; printf 'busy\nprobe failed (ssh exit %s)\n' "$rc"; return; fi
  printf '%s\n' "$out" >"$file"
  decide "$file" "$QUIET"
  rm -f "$file"
}

if [ "$DRY" = 1 ]; then
  d="$(probe_decision)"
  echo "decision: $(head -n 1 <<<"$d")"
  tail -n +2 <<<"$d" | sed 's/^/  /'
  echo "health now: $(health_line)"
  echo "build output: $(remote "$GATE" 2>/dev/null || echo missing)"
  echo "rollback source: $(remote "$CANDIDATE" 2>/dev/null || echo none) (dist.bak-<TS> + .wrangler.bak-<TS>)"
  echo "start times:"; remote "$STARTS" 2>&1 | sed 's/^/  /'
  echo "dry run: no restart"
  [ "$(head -n 1 <<<"$d")" = idle ] && exit 0
  exit 10
fi

# One fixed lock path for every caller (login shell, cron, systemd-run, ssh), so two waiters never run.
LOCK="${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}"
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -n 9 || { echo "NOT RESTARTED: another vertex-web restart waiter is active; exiting"; exit 8; }

gate="$(remote "$GATE" 2>/dev/null)"
if [ "$gate" != build-output-ok ]; then
  echo "NOT RESTARTED: build output missing in apps/web on QuantVPS: $gate"
  exit 3
fi
if ! source_ts="$(remote "$CANDIDATE" 2>/dev/null)" || ! [[ "$source_ts" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "NOT RESTARTED: no rollback source (dist.bak-${BACKUP:-<TS>} with .wrangler.bak-${BACKUP:-<TS>}) in apps/web on QuantVPS"
  exit 3
fi
echo "gate: build output ok; rollback source $source_ts"

# The give-up limit is wall-clock time: ssh and probe time count too.
busy_since=""; streak=0; d=""
while :; do
  d="$(probe_decision)"
  if [ "$(head -n 1 <<<"$d")" = idle ]; then
    streak=$((streak + 1))
    [ "$streak" -ge 2 ] && break
  else
    streak=0
    [ -n "$busy_since" ] || busy_since="$(date +%s)"
    if [ $(($(date +%s) - busy_since)) -ge "$GIVE_UP_AFTER" ]; then
      reasons="$(tail -n +2 <<<"$d" | head -n 3 | paste -sd ';' -)"
      alert "⚠️ **vertex-web restart abandoned** (QuantVPS): the web app stayed busy for $((GIVE_UP_AFTER / 60)) min, so it was not restarted. Still busy: ${reasons:-unknown}. Run infra/quantvps/restart-when-idle.sh again when it is quiet."
      echo "gave up after ${GIVE_UP_AFTER}s busy: ${reasons:-unknown}"
      exit 4
    fi
  fi
  $SLEEP "$POLL"
done
echo "idle: $(tail -n +2 <<<"$d" | paste -sd ';' -)"

# 0 = vertex-web restarted and every container start time is unchanged; 1 = a container start time
# changed or could not be read; 2 = the vertex-web start time did not change (no restart happened).
check_starts() {
  local after changed web_before web_after
  if ! after="$(remote "$STARTS" 2>/dev/null)"; then
    echo "protected containers: start-time check FAILED (probe error); check \`docker ps\` on QuantVPS"
    return 1
  fi
  # Compare only containers in the baseline: a changed StartedAt is flagged, and so is a missing one,
  # except one-off `compose run` containers (`*-run-<hex>`), which start and vanish on their own.
  # Containers that appear after the baseline are ignored.
  changed="$(awk -v unit="$UNIT" '
    NF < 2 { next }
    NR == FNR { if ($1 != unit) base[$1] = $2; next }
    $1 != unit { now[$1] = $2 }
    END {
      for (n in base) {
        if (n in now) { if (now[n] != base[n]) print n " started " base[n] " -> " now[n] }
        else if (n !~ /-run-[0-9a-f]+$/) print n " missing (was started " base[n] ")"
      }
    }' <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sort)"
  web_before="$(grep "^$UNIT " <<<"$before" | cut -d' ' -f2-)"
  web_after="$(grep "^$UNIT " <<<"$after" | cut -d' ' -f2-)"
  echo "$UNIT ActiveEnterTimestamp: $web_before -> $web_after"
  if [ -n "$changed" ]; then
    echo "protected containers: START TIME CHANGED"; echo "$changed"
    alert "⚠️ **vertex-web restart** (QuantVPS): a container start time changed during the restart window. Check \`docker ps\` on QuantVPS."
    return 1
  fi
  echo "protected containers: start times unchanged"
  [ "$web_before" != "$web_after" ] || return 2
}

# Start-time baseline right before the restart: the idle wait can last an hour and cross the
# scheduled 03:00 UTC exec-node container restarts, which must not count as a change made here.
if ! before="$(remote "$STARTS" 2>/dev/null)"; then
  echo "NOT RESTARTED: start-time probe failed (systemctl or docker on QuantVPS, or ssh)"
  exit 3
fi
echo "restarting $UNIT"
# ExecStartPre waits up to 120 s for Postgres, so the restart call gets 300 s.
remote "$RESTART" 300 2>&1 || echo "warning: restart command failed (exit $?); checking health"
if h="$(wait_healthy)"; then
  echo "healthy: $h"
  check_starts; rc=$?
  if [ "$rc" = 2 ]; then
    echo "NOT RESTARTED: $UNIT ActiveEnterTimestamp did not change; the old process still serves"
    exit 3
  fi
  [ "$rc" = 0 ] || exit 7
  exit 0
fi
if [ "$h" = "no health answer" ]; then
  echo "HEALTH UNKNOWN: no health answer over ssh; no rollback"
  alert "⚠️ **vertex-web restart: state unknown** (QuantVPS): the health check got no answer over ssh, so no rollback was done. Check vertex-web on QuantVPS by hand."
  exit 6
fi
echo "UNHEALTHY after restart: $h"
NOW="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK=": rollback; $WEB_CD && test -d dist.bak-$source_ts && test -d .wrangler.bak-$source_ts &&
mv dist dist.failed-$NOW && mv .wrangler .wrangler.failed-$NOW &&
cp -a dist.bak-$source_ts dist && cp -a .wrangler.bak-$source_ts .wrangler && systemctl restart $UNIT"
if remote "$ROLLBACK" 300 2>&1 && h2="$(wait_healthy)"; then
  echo "rolled back to $source_ts: $h2 (failed build kept as dist.failed-$NOW)"
  alert "⚠️ **vertex-web restart failed its health check** (QuantVPS: $h). Rolled back to build $source_ts; the web app is healthy again ($h2). The failed build is kept as dist.failed-$NOW."
  check_starts
  exit 5
fi
echo "ROLLBACK FAILED: ${h2:-rollback command failed}"
alert "❌ **vertex-web is down** (QuantVPS): the restart failed its health check ($h) and the rollback to $source_ts did not recover it (${h2:-rollback command failed}). It needs a manual fix."
check_starts
exit 6
