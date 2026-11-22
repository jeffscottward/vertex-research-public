#!/usr/bin/env bash
# The only restart route for the QuantVPS web app (`vertex-web.service`, infra/quantvps/).
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias and restarts ONLY
# `vertex-web`. It never starts, stops or restarts Nautilus, the IB gateway, the exec node, the
# recovery bridge, Docker or any container.
#
# Steps:
#  1. Build guard (--deploy <sha>): a complete stage of that commit must exist in
#     apps/web/.build-next (written by stage-build.sh). Else no restart (exit 3). The restart command
#     then moves the staged build into place directly before `systemctl restart` (see "Build stage").
#     Without --deploy the script restarts the build that is live in dist and ignores any stage.
#  1a. Gate: the build output that run-preview.mjs needs (apps/web/dist/server/wrangler.json and
#     apps/web/.wrangler/deploy/config.json) must exist on QuantVPS. Else no restart (exit 3).
#  1b. Version guard: the new build SHA (DEPLOYED_SHA in the staged build with --deploy, else in dist;
#     written on the rig at build time) must not
#     be a strict ancestor of the deployed SHA (apps/web/DEPLOYED_SHA, written by this script after
#     each healthy restart). An older build, an unknown SHA or a SHA missing from the rig checkout
#     stops the run with no restart (exit 9), unless --allow-older <reason> is given.
#  2. Wait until vertex-web is idle (signal below) on two polls in a row.
#  3. `systemctl restart vertex-web`, then a health check: `/` returns 200 and `/dashboard` returns
#     307 to the sign-in page on 127.0.0.1:3450.
#  4. Health check failed: roll back to the backup pair that the swap of this run made (--deploy),
#     else to the newest dist.bak-<TS> with its .wrangler.bak-<TS> (or --backup <TS>). Both halves of
#     a pair must be directories and no symlinks. The failed build is kept as
#     dist.failed-<now>/.wrangler.failed-<now>; the backup is copied, so it stays available. Restart
#     and check health again.
#  5. Check that every container from the baseline keeps its start time (one-off `*-run-<hex>`
#     compose containers may vanish; new containers are ignored) and that vertex-web restarted.
#
# Build stage: a deploy never copies a build over the live dist, because the running process would
# then serve from a folder that it was not started from (2026-11-19: HTTP 500 for the asset files of
# the old build for 30 minutes). stage-build.sh (rig) copies the build to apps/web/.build-next/ and
# writes STAGED_SHA last. With --deploy <sha> the restart command (one remote command, after the
# idle decision) checks the stage again, copies .wrangler to .wrangler.bak-<TS>, renames dist to
# dist.bak-<TS> and .build-next/dist to dist, replaces the deploy config, runs the runtime swap
# (when one is staged) and then restarts the unit. It prints the time from the first rename to the
# restart call. That pair is the rollback source of the run. A failure after the first rename puts
# the build back (the stage is then complete again) and the restart is not sent (exit 3). When the
# restart was sent but the unit start time did not change, one more remote call puts the build
# back. A deploy is confirmed only when the swap and the restart are both confirmed. With no closing
# line from the restart command (a lost connection) and a changed unit start time, one more remote
# call must prove the swap of this run. With an unchanged start time the build is put back. A run
# that ends without a confirmed deploy exits 3 and, for an unknown or contradictory state, sends one
# #omp-alerts notice. The steps of the restart command write to .build-next/restart.log on the
# host, which is printed afterwards: a closed connection cannot stop the command between the swap
# and the restart. A reboot or a kill on the host can (README, "Repair a cut build swap"). No file
# or directory is deleted.
#
# Runtime tree: the tracked files and node_modules of the checkout on QuantVPS. RUNTIME_SHA in the
# checkout root names their commit. stage-runtime.sh (rig) copies the tree of a build commit to
# .runtime-next/ in the checkout. Runtime guard (step 1c, after the version guard):
#  - RUNTIME_SHA equals the new build SHA: plain restart.
#  - Else a complete stage for the new build SHA exists: the restart command first moves every path
#    in .runtime-next/PATHS from the checkout to .runtime-bak-<TS>/ and the staged path into its place
#    (renames, one remote command with the restart). A failed move puts the finished paths back and
#    the restart command is not sent; the old process keeps serving (exit 3).
#  - Else, or with no answer, an unknown build SHA or an unfinished earlier swap (a .runtime-bak-* or
#    .runtime-failed-* directory with neither COMPLETE nor UNDONE): no restart (exit 12).
#    --allow-stale-runtime <reason> restarts on a tree at another commit, with one #omp-alerts
#    notice. It never skips the "no answer" and "unfinished swap" refusals.
# After a swap, a failed health check also moves the new runtime tree to .runtime-failed-<now>/ and
# the saved one back, in the rollback command. No health answer over ssh: no rollback, the swapped
# tree stays (exit 6). No directory is ever deleted here.
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
# Worker pause: the Nautilus backtest worker (infra/research-worker, same user on this host) polls
# the API every few seconds, so vertex-web would never be quiet for the window. Right before the
# idle wait this script writes its PID and the time to the worker pause file
# (VERTEX_WORKER_PAUSE_FILE, default ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-nautilus-worker.pause).
# While it exists the worker claims nothing (a run in progress finishes and delivers first; that
# traffic only delays the idle decision). The file is removed on every exit (trap EXIT; INT, TERM
# and HUP exit through it). The worker ignores a file older than 90 min, so a killed script
# (SIGKILL) cannot stop it for good. --dry-run never touches the file.
#
# Market hours guard (owner rule 2026-11-16): a real run refuses (exit 14) on Monday to Friday from
# 08:30 to 16:00 New York time, before the lock, before each idle poll and after the idle wait.
# Market holidays count as trading days; a time that cannot be read counts as market hours.
# --allow-market-hours <reason> skips the guard with one #omp-alerts notice. --dry-run prints the
# decision and never refuses.
#
# Give-up: when the waiter has not seen two idle polls in a row VERTEX_RESTART_GIVE_UP_AFTER
# wall-clock seconds after the first busy poll (default 3600), the restart is abandoned with ONE
# #omp-alerts notice (exit 4). There is no forced restart.
# Lock: one fixed path for every caller, ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock.
# Bash version (bash version guard): a real run (no --dry-run, no --decide) needs bash 5.3 or newer.
# On an older bash it prints "NOT RESTARTED: bash <version> is older than 5.3. ..." and exits 2
# before the lock. --dry-run and --decide set no traps and run on any bash. Bash 5.2 (tested:
# 5.2.21; older versions are refused untested) runs a pending trap while it parses the text of a
# $(...) during an expansion (eval.c parse_command;
# https://lists.gnu.org/archive/html/bug-bash/2023-09/msg00058.html, fixed in 5.3). The INT, TERM
# or HUP trap then fails with a false "unexpected EOF" syntax error, so the signal has no effect,
# and the broken parse can discard the whole idle-wait loop: the script then goes on to the restart,
# or ends with exit 0 without a restart.
#
# Usage: infra/quantvps/restart-when-idle.sh [--dry-run] [--deploy <sha>] [--backup <TS>]
#          [--allow-older <reason>] [--allow-stale-runtime <reason>] [--allow-market-hours <reason>]
#   --deploy   swap the staged build of this commit (7 to 40 hex digits) in with the restart. An old
#              copy of this script rejects the argument (exit 2) and so cannot report a deploy that
#              did nothing.
#   --dry-run  print the idle decision, the market hours and build stage decisions, current health,
#              rollback candidate, start times and the version and runtime guard decisions; no
#              restart, no lock, no alert. Exit 0 = idle, 10 = busy.
#   --allow-older  deploy a build that is older than (or not provably newer than) the deployed SHA,
#              for a deliberate rollback or the first recorded deploy. The reason is printed.
#   --allow-stale-runtime  restart although the runtime tree is not at the new build SHA (emergency
#              only). The reason is printed and sent to #omp-alerts.
#   --allow-market-hours  restart on Monday to Friday from 08:30 to 16:00 New York time (see "Market
#              hours guard" below; only with an owner decision). The reason is printed and sent to
#              #omp-alerts.
#   --backup   rollback source timestamp (dist.bak-<TS> and .wrangler.bak-<TS>), default newest pair.
# Exit codes: 0 restarted and healthy; 2 usage, or bash older than 5.3 (this run did nothing);
#   3 gate, build guard or probe failed, or the vertex-web start time did not change (no restart
#   happened), or the deploy is not confirmed (--deploy: the swap or the restart);
#   4 gave up (busy); 5 health failed, rolled back and healthy;
#   6 health failed and rollback failed (web down), or no health answer over ssh (state unknown);
#   7 restarted and healthy, but a container start time changed or could not be checked;
#   8 another restart waiter holds the lock (this run did nothing);
#   9 version guard refused: the new build is older than the deployed one, or a SHA is unknown;
#   11 the lock file could not be opened or flock failed (this run did nothing);
#   12 runtime guard refused: the runtime tree is not at the new build SHA and no stage for it
#   exists, or QuantVPS gave no answer about it, or an earlier swap is unfinished;
#   14 market hours guard refused: Monday to Friday 08:30-16:00 New York time, or the time could not
#   be read (no call to QuantVPS was made, or the idle wait reached 08:30; no restart happened).
#   13 is not used: it means "partial or unknown" in the prune scripts.
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR,
#   VERTEX_RESTART_SLEEP, VERTEX_RESTART_ALERT (alert command, gets the text), VERTEX_RESTART_LOCK,
#   VERTEX_RESTART_POLL, VERTEX_RESTART_QUIET, VERTEX_RESTART_GIVE_UP_AFTER,
#   VERTEX_RESTART_HEALTH_TIMEOUT (wall-clock seconds), VERTEX_WORKER_PAUSE_FILE (worker pause
#   file), VERTEX_DEPLOY_NY_TIME (the New York time for the market hours guard; a set hook is
#   printed), VERTEX_RESTART_BASH_VERSION (the bash version the guard checks, <major>.<minor>, default
#   from BASH_VERSINFO; the tests set it, CI has bash 5.2), VERTEX_DEPLOY_GIT_DIR (checkout for the
#   ancestry check, default this repository). `--decide` is the pure idle decision used
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
# The checkout root on QuantVPS: apps/web is two levels below it.
ROOT_CD="$WEB_CD && cd ../.."

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
ALLOW_OLDER=""
ALLOW_STALE=""
DEPLOY=""
ALLOW_MARKET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --backup)
      shift
      [[ "${1:-}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "--backup needs a timestamp like 20261101T125501Z" >&2; exit 2; }
      BACKUP="$1" ;;
    --allow-older)
      shift
      [ -n "${1:-}" ] && [[ "$1" != --* ]] || { echo "--allow-older needs a reason" >&2; exit 2; }
      ALLOW_OLDER="$1" ;;
    --allow-stale-runtime)
      shift
      [ -n "${1:-}" ] && [[ "$1" != --* ]] || { echo "--allow-stale-runtime needs a reason" >&2; exit 2; }
      ALLOW_STALE="$1" ;;
    --deploy)
      shift
      [[ "${1:-}" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--deploy needs the build commit (7 to 40 hex digits)" >&2; exit 2; }
      DEPLOY="$1" ;;
    --allow-market-hours)
      shift
      [ -n "${1:-}" ] && [[ "$1" != --* ]] || { echo "--allow-market-hours needs a reason" >&2; exit 2; }
      ALLOW_MARKET="$1" ;;
    *) echo "usage: $0 [--dry-run] [--deploy <sha>] [--backup <TS>] [--allow-older <reason>] [--allow-stale-runtime <reason>] [--allow-market-hours <reason>]" >&2; exit 2 ;;
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
# Both halves must be real directories: a symlink or a file named dist.bak-<TS> is skipped.
CANDIDATE=": candidate; $WEB_CD && want='$BACKUP' &&
for d in \$(ls -1d dist.bak-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z 2>/dev/null | sort -r); do
  ts=\${d#dist.bak-}; if [ -n \"\$want\" ] && [ \"\$ts\" != \"\$want\" ]; then continue; fi;
  if [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && [ -d \".wrangler.bak-\$ts\" ] && [ ! -L \".wrangler.bak-\$ts\" ]; then echo \"\$ts\"; exit 0; fi; done; exit 1"
RESTART=": restart; systemctl restart $UNIT"
# Build stage (written by stage-build.sh): apps/web/.build-next/ holds dist/, the deploy config and,
# written last, STAGED_SHA. Answers "staged none" (no .build-next/dist), "staged <sha>" (complete:
# STAGED_SHA is a commit name and equals .build-next/dist/DEPLOYED_SHA) or "staged incomplete".
STAGE=": stage; $WEB_CD || exit 1
CONF=.wrangler/deploy/config.json
if [ ! -e .build-next/dist ] && [ ! -L .build-next/dist ]; then echo 'staged none'; exit 0; fi
sha=\$(cat .build-next/STAGED_SHA 2>/dev/null)
case \"\$sha\" in '' | *[!0-9a-f]*) sha='' ;; esac
if [ -d .build-next ] && [ ! -L .build-next ] && [ -d .build-next/dist ] && [ ! -L .build-next/dist ] &&
  [ -f .build-next/dist/server/wrangler.json ] && [ -f \".build-next/\$CONF\" ] &&
  [ -n \"\$sha\" ] && [ \"\$(cat .build-next/dist/DEPLOYED_SHA 2>/dev/null)\" = \"\$sha\" ]; then echo \"staged \$sha\"; else echo 'staged incomplete'; fi"
# New build SHA (written on the rig at build time) and the SHA that last passed a restart. The new
# SHA is read from the staged build with --deploy (SHA_SRC, set by build_guard), else from dist.
SHA_SRC=dist
set_shas() {
  SHAS=": shas; $WEB_CD && echo \"new \$(cat $SHA_SRC/DEPLOYED_SHA 2>/dev/null || echo none)\" &&
echo \"deployed \$(cat DEPLOYED_SHA 2>/dev/null || echo none)\""
}
set_shas
# After a healthy restart, the SHA the guard checked becomes the deployed SHA, but only while dist
# still holds it (a dist copied again during the idle wait is not recorded). After a rollback, the
# restored dist's SHA is recorded (no SHA file: the record is removed).
record_new() { remote ": record; $WEB_CD && if [ \"\$(cat dist/DEPLOYED_SHA 2>/dev/null)\" = '$CHECKED_SHA' ]; then echo '$CHECKED_SHA' >DEPLOYED_SHA.tmp && mv DEPLOYED_SHA.tmp DEPLOYED_SHA; else echo dist-changed; exit 1; fi"; }
CHECKED_SHA=""
RECORD=": record; $WEB_CD && if [ -f dist/DEPLOYED_SHA ]; then cp dist/DEPLOYED_SHA DEPLOYED_SHA.tmp && mv DEPLOYED_SHA.tmp DEPLOYED_SHA; else rm -f DEPLOYED_SHA; fi"
GIT_DIR_CHECK="${VERTEX_DEPLOY_GIT_DIR:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel 2>/dev/null || echo .)}"

# Runtime swap. Shell text that runs on QuantVPS in the checkout root (sh with GNU mv: `mv -T`
# never moves a path into an existing directory of the same name).
# swap_paths <from> <to> [strict]: for each path in <from>/PATHS, the live path moves to <to>/ and the
# path in <from>/ moves into its place. strict: every listed path must exist in <from>. <to> gets a
# PATHS copy (it drives a later swap back), DONE (the moved paths) and COMPLETE. A failed move puts
# the finished paths back and returns 1; <to> gets UNDONE only when every path is back in place.
read -r -d '' SWAP_LIB <<'EOS' || true
has() { [ -e "$1" ] || [ -L "$1" ]; }
# Every refusal before the first move ends with the line "swap: nothing moved", and a finished undo
# with "swap: undone": the caller treats any other ending as an unknown state.
nomove() { echo "swap: $1"; echo "swap: nothing moved"; return 1; }
swap_paths() {
  from="$1"; to="$2"; strict="${3:-}"
  [ -f "$from/PATHS" ] || { nomove "$from/PATHS is missing"; return 1; }
  if has "$to"; then nomove "$to exists"; return 1; fi
  while IFS= read -r p; do
    case "$p" in '' | /* | .. | ../* | */.. | */../*) nomove "bad path '$p' in $from/PATHS"; return 1 ;; esac
    if [ -n "$strict" ] && ! has "$from/$p"; then nomove "$from/$p is missing"; return 1; fi
  done <"$from/PATHS"
  mkdir "$to" && cp "$from/PATHS" "$to/PATHS" && : >"$to/DONE" || { : 2>/dev/null >"$to/UNDONE"; nomove "cannot prepare $to"; return 1; }
  while IFS= read -r p; do
    if { ! has "$p" || { mkdir -p "$to/$(dirname "$p")" && mv -T "$p" "$to/$p"; }; } &&
      { ! has "$from/$p" || { mkdir -p "$(dirname "$p")" && mv -T "$from/$p" "$p"; }; }; then
      printf '%s\n' "$p" >>"$to/DONE"
      continue
    fi
    echo "swap: move failed at $p; putting the finished paths back"
    undo=ok
    if has "$to/$p" && ! has "$p"; then mv -T "$to/$p" "$p" || { undo=failed; echo "swap: could not restore $p"; }; fi
    while IFS= read -r q; do
      if has "$q"; then mv -T "$q" "$from/$q" || { undo=failed; echo "swap: could not put back $from/$q"; continue; }; fi
      if has "$to/$q"; then mv -T "$to/$q" "$q" || { undo=failed; echo "swap: could not restore $q"; }; fi
    done <"$to/DONE"
    if [ "$undo" = ok ] && : >"$to/UNDONE"; then echo "swap: undone"; else echo "swap: the undo did not finish; $to stays unfinished"; fi
    return 1
  done <"$from/PATHS"
  : >"$to/COMPLETE"
  echo "swapped $(wc -l <"$to/DONE" | tr -d ' ') paths: $from -> live, live -> $to"
}
EOS
# Build swap. Shell text that runs on QuantVPS with the restart; <web> is apps/web.
# build_in <web> <ts> <sha>: the live build becomes the backup pair <ts> (dist is renamed; .wrangler
# is copied, because it also holds local state of the app), the staged build becomes dist, and its
# deploy config replaces the live one. A refusal before the first rename ends with the line
# "build: nothing moved"; a later failure runs build_back.
# build_back <web> <ts>: the reverse. The new build goes back to .build-next/dist (the stage is then
# complete again), the old build back to dist, and the old deploy config back in place. It ends with
# "build: undone" or "build: the undo did not finish". The copy .wrangler.bak-<ts> stays.
# Nothing is deleted. No COMPLETE or UNDONE files: a cut swap shows in the names (dist missing).
read -r -d '' BUILD_LIB <<'EOS' || true
CONF=.wrangler/deploy/config.json
bhas() { [ -e "$1" ] || [ -L "$1" ]; }
bdir() { [ -d "$1" ] && [ ! -L "$1" ]; }
bnomove() { echo "build: $1"; echo "build: nothing moved"; return 1; }
build_back() {
  w="$1"; ts="$2"; ok=1
  [ -n "$ts" ] || { echo "build: no timestamp"; return 1; }
  if bdir "$w/dist.bak-$ts"; then
    if bhas "$w/dist"; then
      if bhas "$w/.build-next/dist"; then ok=0; echo "build: dist and .build-next/dist both exist"
      else mv -T "$w/dist" "$w/.build-next/dist" || ok=0; fi
    fi
    if [ "$ok" = 1 ]; then mv -T "$w/dist.bak-$ts" "$w/dist" || ok=0; fi
  fi
  if [ "$ok" = 1 ] && [ -f "$w/.wrangler.bak-$ts/${CONF#.wrangler/}" ]; then
    cp "$w/.wrangler.bak-$ts/${CONF#.wrangler/}" "$w/$CONF.tmp" && mv -f "$w/$CONF.tmp" "$w/$CONF" || ok=0
  fi
  if [ "$ok" = 1 ]; then echo "build: undone"; return 0; fi
  echo "build: the undo did not finish; check dist, .build-next/dist and dist.bak-$ts in apps/web"
  return 1
}
build_in() {
  w="$1"; ts="$2"; sha="$3"
  [ -n "$ts" ] && [ -n "$sha" ] || { bnomove "no timestamp or no build SHA"; return 1; }
  [ "$(cat "$w/.build-next/STAGED_SHA" 2>/dev/null)" = "$sha" ] &&
    [ "$(cat "$w/.build-next/dist/DEPLOYED_SHA" 2>/dev/null)" = "$sha" ] &&
    bdir "$w/.build-next/dist" && [ -f "$w/.build-next/$CONF" ] ||
    { bnomove "the staged build changed after the guard"; return 1; }
  bdir "$w/dist" && bdir "$w/.wrangler" || { bnomove "dist or .wrangler in apps/web is not a directory"; return 1; }
  for n in "dist.bak-$ts" ".wrangler.bak-$ts"; do
    if bhas "$w/$n"; then bnomove "$n exists"; return 1; fi
  done
  cp -a "$w/.wrangler" "$w/.wrangler.bak-$ts" ||
    { bnomove "cannot copy .wrangler (a partial .wrangler.bak-$ts can stay; no script uses it)"; return 1; }
  B0="$(date +%s%N)"
  if mv -T "$w/dist" "$w/dist.bak-$ts" && mv -T "$w/.build-next/dist" "$w/dist" &&
    mkdir -p "$w/${CONF%/*}" && cp "$w/.build-next/$CONF" "$w/$CONF.tmp" && mv -f "$w/$CONF.tmp" "$w/$CONF"; then
    echo "build: swapped in $sha (previous build: dist.bak-$ts with .wrangler.bak-$ts)"
    return 0
  fi
  echo "build: the swap failed; putting the live build back"
  build_back "$w" "$ts"
  return 1
}
EOS
# Build guard. Prints one decision line and sets BUILD_ACTION to none or swap (with --deploy:
# BUILD_STAGED is the staged commit, and the new SHA is then read from the stage); returns
# 0 = allowed, 1 = refused. Without --deploy a stage is never used: the line names what is ignored.
BUILD_ACTION=none
BUILD_STAGED=""
build_guard() {
  local out state cause
  out="$(remote "$STAGE" 2>/dev/null)"
  state="$(sed -n 's/^staged //p' <<<"$out" | head -n 1)"
  BUILD_ACTION=none
  if [ -z "$DEPLOY" ]; then
    case "$state" in
      none) echo "build: no staged build; the restart keeps the build that is live in dist" ;;
      '') echo "build: no answer about .build-next; the restart keeps the build that is live in dist" ;;
      *) echo "build: the staged build $state in .build-next is ignored (no --deploy)" ;;
    esac
    return 0
  fi
  if [ -z "$state" ]; then
    cause="no answer from QuantVPS about .build-next. Check ssh, then run this script again."
  elif [ "$state" = none ]; then
    cause="--deploy $DEPLOY was given, but no build is staged in apps/web/.build-next. Run infra/quantvps/stage-build.sh in the build worktree first."
  elif [ "$state" = incomplete ]; then
    cause="the stage in apps/web/.build-next is not complete. Run infra/quantvps/stage-build.sh in the build worktree again."
  elif same_sha "$state" "$DEPLOY"; then
    BUILD_ACTION=swap
    BUILD_STAGED="$state"
    SHA_SRC=.build-next/dist
    set_shas
    echo "build: the staged build $state will be swapped in at the restart"; return 0
  else
    cause="the staged build is $state, not $DEPLOY. Stage the build of $DEPLOY with infra/quantvps/stage-build.sh, or pass the staged commit."
  fi
  echo "NOT RESTARTED: build stage: $cause"
  return 1
}

# Market hours guard (owner rule 2026-11-16): no restart of the web app on Monday to Friday from
# 08:30 to 16:00 New York time; market holidays count as trading days. The time is read as in
# prune-runtime-backups.sh: GNU date falls back to UTC without an error when the zone data is
# missing, so the zone name must be EST or EDT, and a time that cannot be read counts as market
# hours. Test hook VERTEX_DEPLOY_NY_TIME: "<day 1-7> <HHMM> <zone>", or the path of an executable
# file that prints such a line (a test moves the clock with it during the idle wait).
ny_now() {
  if [ -z "${VERTEX_DEPLOY_NY_TIME:-}" ]; then TZ=America/New_York date +'%u %H%M %Z' 2>/dev/null
  elif [ -f "$VERTEX_DEPLOY_NY_TIME" ] && [ -x "$VERTEX_DEPLOY_NY_TIME" ]; then "$VERTEX_DEPLOY_NY_TIME"
  else printf '%s\n' "$VERTEX_DEPLOY_NY_TIME"; fi
}
# Prints the New York time that it read; returns 0 outside market hours, 1 inside or unknown.
market_window() {
  local dow hm z _
  read -r dow hm z _ <<<"$(ny_now)"
  if [[ "${dow:-}" =~ ^[1-7]$ ]] && [[ "${hm:-}" =~ ^([01][0-9]|2[0-3])[0-5][0-9]$ ]] && [[ "${z:-}" =~ ^E[SD]T$ ]]; then
    echo "New York day $dow time $hm"
    [ "$dow" -gt 5 ] || [ $((10#$hm)) -lt 830 ] || [ $((10#$hm)) -ge 1600 ]
    return
  fi
  echo "New York time unknown (day ${dow:-?} time ${hm:-?} zone ${z:-?})"
  return 1
}
# market_guard [quiet]: returns 0 = allowed, 1 = refused (with one NOT RESTARTED line). quiet:
# print nothing when allowed. --allow-market-hours skips the guard with one #omp-alerts notice per
# run (none in a dry run).
MARKET_ALERTED=0
market_guard() {
  local when
  if when="$(market_window)"; then
    [ -n "${1:-}" ] || echo "market hours: outside Monday to Friday 08:30-16:00 New York time ($when)"
    return 0
  fi
  if [ -n "$ALLOW_MARKET" ]; then
    # The line is printed at the first call and whenever the notice goes out (the window can open
    # during the idle wait). The notice says "run": the run can still end without a restart.
    if [ "$DRY" != 1 ] && [ "$MARKET_ALERTED" = 0 ]; then
      MARKET_ALERTED=1
      echo "market hours: WARNING guard skipped ($when): $ALLOW_MARKET"
      alert "⚠️ **vertex-web restart run in US market hours** (QuantVPS): the market hours guard was skipped ($when). Reason: $ALLOW_MARKET"
    elif [ -z "${1:-}" ]; then echo "market hours: WARNING guard skipped ($when): $ALLOW_MARKET"
    fi
    return 0
  fi
  echo "NOT RESTARTED: market hours guard: $when. No restart of the web app on Monday to Friday from 08:30 to 16:00 New York time (an unknown time counts as market hours). Run this script after 16:00 or before 08:30 New York time. --allow-market-hours <reason> skips this guard; use it only with an owner decision."
  return 1
}

# Runtime tree state: the live commit, the staged commit, and the first swap directory that an
# interrupted swap left without COMPLETE or UNDONE.
RUNTIME=": runtime; $ROOT_CD || exit 1
echo \"live \$(cat RUNTIME_SHA 2>/dev/null || echo none)\"
echo \"staged \$(cat .runtime-next/RUNTIME_SHA 2>/dev/null || echo none)\"
inc=none; for d in .runtime-bak-* .runtime-failed-*; do
  if [ -d \"\$d\" ] && [ ! -f \"\$d/COMPLETE\" ] && [ ! -f \"\$d/UNDONE\" ]; then inc=\"\$d\"; break; fi; done
echo \"incomplete \$inc\""

# Two commit names are the same commit when one is a prefix of the other (7 to 40 hex digits):
# RUNTIME_SHA always holds a full name, dist/DEPLOYED_SHA may hold a short one.
same_sha() {
  [[ "$1" =~ ^[0-9a-f]{7,40}$ ]] && [[ "$2" =~ ^[0-9a-f]{7,40}$ ]] && { [[ "$1" == "$2"* ]] || [[ "$2" == "$1"* ]]; }
}
# Runtime guard (call it after version_guard: it uses CHECKED_SHA). Prints one decision line and sets
# RUNTIME_ACTION to none or swap (and RT_STAGED to the staged commit); returns 0 = allowed, 1 = refused.
RUNTIME_ACTION=none
RT_STAGED=""
runtime_guard() {
  local out live staged inc cause
  out="$(remote "$RUNTIME" 2>/dev/null)"
  live="$(sed -n 's/^live //p' <<<"$out" | head -n 1)"
  staged="$(sed -n 's/^staged //p' <<<"$out" | head -n 1)"
  inc="$(sed -n 's/^incomplete //p' <<<"$out" | head -n 1)"
  RUNTIME_ACTION=none
  if [ -z "$live" ] || [ -z "$inc" ]; then
    cause="no answer from QuantVPS about the runtime tree. Check ssh, then run this script again."
  elif [ "$inc" != none ]; then
    cause="an earlier runtime swap did not finish ($inc has no COMPLETE file). Repair it first: infra/quantvps/README.md, \"Repair an unfinished runtime swap\"."
  elif same_sha "$live" "$CHECKED_SHA"; then
    echo "runtime: live runtime tree is at build $CHECKED_SHA"; return 0
  elif same_sha "$staged" "$CHECKED_SHA"; then
    RUNTIME_ACTION=swap
    RT_STAGED="$staged"
    echo "runtime: the staged tree of build $CHECKED_SHA will be swapped in at the restart (live: $live)"; return 0
  elif [ -n "$ALLOW_STALE" ]; then
    # The override covers only a tree at another commit, never a failed read or an unfinished swap.
    echo "runtime: WARNING guard skipped (runtime tree at $live, build ${CHECKED_SHA:-unknown}): $ALLOW_STALE"
    [ "$DRY" = 1 ] || alert "⚠️ **vertex-web restart with the runtime guard skipped** (QuantVPS): runtime tree at $live, build ${CHECKED_SHA:-unknown}. Reason: $ALLOW_STALE"
    return 0
  elif [ -z "$CHECKED_SHA" ]; then
    cause="the new build SHA is unknown, so the runtime tree cannot be compared with it."
  else
    cause="the runtime tree is at $live, the build is $CHECKED_SHA, and no complete stage for this build exists (staged: $staged). Run infra/quantvps/stage-runtime.sh in the build worktree, then run this script again."
  fi
  echo "NOT RESTARTED: runtime guard: $cause"
  return 1
}

# Version guard. Prints one decision line; returns 0 = allowed, 1 = refused.
version_guard() {
  local out new deployed problem=""
  out="$(remote "$SHAS" 2>/dev/null)"
  new="$(sed -n 's/^new //p' <<<"$out" | head -n 1)"
  deployed="$(sed -n 's/^deployed //p' <<<"$out" | head -n 1)"
  sha_ok() { [[ "$1" =~ ^[0-9a-f]{7,40}$ ]]; }
  if ! sha_ok "$new"; then problem="new build SHA unknown ($SHA_SRC/DEPLOYED_SHA: ${new:-no answer})"
  elif ! sha_ok "$deployed"; then problem="deployed SHA unknown (DEPLOYED_SHA: ${deployed:-no answer})"
  fi
  sha_ok "$new" && CHECKED_SHA="$new"
  if [ -n "$problem" ]; then :
  elif [ "$new" = "$deployed" ]; then echo "version: new $new equals deployed"; return 0
  elif ! git -C "$GIT_DIR_CHECK" cat-file -e "$new^{commit}" 2>/dev/null ||
       ! git -C "$GIT_DIR_CHECK" cat-file -e "$deployed^{commit}" 2>/dev/null; then
    problem="cannot compare $new with deployed $deployed: a commit is missing in $GIT_DIR_CHECK (git fetch)"
  elif [ "$(git -C "$GIT_DIR_CHECK" rev-parse "$new^{commit}")" = "$(git -C "$GIT_DIR_CHECK" rev-parse "$deployed^{commit}")" ]; then
    echo "version: new $new equals deployed"; return 0
  elif git -C "$GIT_DIR_CHECK" merge-base --is-ancestor "$new" "$deployed"; then
    problem="new build $new is OLDER than deployed $deployed (strict ancestor)"
  else echo "version: new $new is not an ancestor of deployed $deployed"; return 0
  fi
  if [ -n "$ALLOW_OLDER" ]; then echo "version: WARNING $problem; allowed by --allow-older: $ALLOW_OLDER"; return 0; fi
  echo "NOT RESTARTED: $problem; use --allow-older <reason> for a deliberate rollback."
  if [ "$BUILD_ACTION" = swap ]; then
    echo "  The refused build stays in apps/web/.build-next on QuantVPS; it is never used without --deploy."
  else
    echo "  The refused build is still in apps/web/dist on QuantVPS: restore dist.bak-<TS> and .wrangler.bak-<TS>, so a later restart cannot serve it."
  fi
  return 1
}

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
  [ -z "${VERTEX_DEPLOY_NY_TIME:-}" ] || echo "market hours guard: test hook VERTEX_DEPLOY_NY_TIME replaces the clock"
  market_guard | sed -e 's/^NOT RESTARTED: market hours guard: /market hours guard would refuse: /' -e 's/\. No restart of the web app on .*$//'
  build_guard | sed 's/^NOT RESTARTED: build stage: /build stage would refuse: /'
  # A pipe runs its left side in a subshell: call build_guard again here so SHA_SRC is set.
  build_guard >/dev/null
  echo "build output: $(remote "$GATE" 2>/dev/null || echo missing)"
  echo "rollback source: $(remote "$CANDIDATE" 2>/dev/null || echo none) (dist.bak-<TS> + .wrangler.bak-<TS>)"
  echo "start times:"; remote "$STARTS" 2>&1 | sed 's/^/  /'
  version_guard | sed 's/^NOT RESTARTED: /version guard would refuse: /'
  # A pipe runs its left side in a subshell: call version_guard again here so CHECKED_SHA is set.
  version_guard >/dev/null
  runtime_guard | sed 's/^NOT RESTARTED: runtime guard: /runtime guard would refuse: /'
  echo "dry run: no restart"
  [ "$(head -n 1 <<<"$d")" = idle ] && exit 0
  exit 10
fi

# Bash version guard (see "Bash version" above). Only a real run sets the INT, TERM and HUP traps, so
# --dry-run and --decide (both handled above) run on any bash.
checked_bash="${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"
shown_bash="$BASH_VERSION"
if [ -n "${VERTEX_RESTART_BASH_VERSION:-}" ]; then
  echo "bash version guard: test hook VERTEX_RESTART_BASH_VERSION=$VERTEX_RESTART_BASH_VERSION replaces bash $BASH_VERSION"
  checked_bash="$VERTEX_RESTART_BASH_VERSION"
  shown_bash="$VERTEX_RESTART_BASH_VERSION"
fi
# A malformed value counts as too old. The test builtin reads 08 as eight; bash arithmetic would
# stop at it as a bad octal number.
if ! [[ "$checked_bash" =~ ^([0-9]{1,3})\.([0-9]{1,3})$ ]] || [ "${BASH_REMATCH[1]}" -lt 5 ] ||
  { [ "${BASH_REMATCH[1]}" -eq 5 ] && [ "${BASH_REMATCH[2]}" -lt 3 ]; }; then
  echo "NOT RESTARTED: bash $shown_bash is older than 5.3. Bash before 5.3 can lose a stop signal (INT, TERM, HUP) in the idle wait and then restart $UNIT anyway (bash bug, fixed in 5.3); run this script with bash 5.3 or newer"
  exit 2
fi

# Market hours guard, before the lock and before any call to QuantVPS. A set test hook is named.
[ -z "${VERTEX_DEPLOY_NY_TIME:-}" ] || echo "market hours guard: test hook VERTEX_DEPLOY_NY_TIME replaces the clock"
market_guard || exit 14

# One fixed lock path for every caller (login shell, cron, systemd-run, ssh), so two waiters never run.
# Only flock's "lock held" answer (exit 1) means another waiter (exit 8). A lock file that cannot be
# opened (full disk, no permission, a directory) or any other flock failure is a failed run (exit 11).
LOCK="${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}"
mkdir -p "$(dirname "$LOCK")"
if ! { exec 9>"$LOCK"; } 2>/dev/null; then
  # Open it again in a subshell only to read the reason: bash reports "<path>: <reason>".
  reason="$({ : >"$LOCK"; } 2>&1)"
  reason="${reason##*: }"
  echo "NOT RESTARTED: cannot open lock file $LOCK: ${reason:-open failed}"
  exit 11
fi
flock -n 9
lock_rc=$?
if [ "$lock_rc" = 1 ]; then
  echo "NOT RESTARTED: another vertex-web restart waiter is active; exiting"
  exit 8
fi
if [ "$lock_rc" != 0 ]; then
  echo "NOT RESTARTED: cannot lock $LOCK (flock exit $lock_rc)"
  exit 11
fi

build_guard || exit 3
gate="$(remote "$GATE" 2>/dev/null)"
if [ "$gate" != build-output-ok ]; then
  echo "NOT RESTARTED: build output missing in apps/web on QuantVPS: $gate"
  echo "  When dist is missing after a cut swap: infra/quantvps/README.md, \"Repair a cut build swap\"."
  exit 3
fi
# With --deploy the swap itself makes the rollback source (the live build becomes the backup pair
# of this run), so an older pair is needed only for a plain restart or with --backup.
if ! source_ts="$(remote "$CANDIDATE" 2>/dev/null)" || ! [[ "$source_ts" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  source_ts=""
  if [ "$BUILD_ACTION" != swap ] || [ -n "$BACKUP" ]; then
    echo "NOT RESTARTED: no rollback source (dist.bak-${BACKUP:-<TS>} with .wrangler.bak-${BACKUP:-<TS>}) in apps/web on QuantVPS"
    exit 3
  fi
fi
if [ "$BUILD_ACTION" = swap ] && [ -z "$BACKUP" ]; then echo "gate: build output ok; rollback source: the live build (the swap makes the backup pair)"
else echo "gate: build output ok; rollback source $source_ts"; fi
version_guard || exit 9
runtime_guard || exit 12

# Worker pause for the idle wait and the restart (see "Worker pause" above). A pause file that
# cannot be written is only a warning: the wait may then give up while the worker polls.
PAUSE_FILE="${VERTEX_WORKER_PAUSE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-nautilus-worker.pause}"
trap 'rm -f "$PAUSE_FILE"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
if mkdir -p "$(dirname "$PAUSE_FILE")" 2>/dev/null &&
  printf 'pid %s\nsince %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PAUSE_FILE" 2>/dev/null; then
  echo "worker paused: $PAUSE_FILE"
else
  echo "warning: cannot write the worker pause file $PAUSE_FILE; a polling worker can keep vertex-web busy"
fi

# The give-up limit is wall-clock time: ssh and probe time count too.
# The wait can last an hour and reach 08:30 New York time: the market hours guard runs again before
# each poll and after the wait (exit 14, no restart).
busy_since=""; streak=0; d=""
while :; do
  market_guard quiet || exit 14
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
market_guard quiet || exit 14
# The idle wait can be long: a build copied into dist meanwhile was never checked.
if [ -n "$CHECKED_SHA" ]; then
  now_sha="$(sed -n 's/^new //p' <<<"$(remote "$SHAS" 2>/dev/null)" | head -n 1)"
  if [ "$now_sha" != "$CHECKED_SHA" ]; then
    echo "NOT RESTARTED: $SHA_SRC/DEPLOYED_SHA changed during the idle wait ($CHECKED_SHA -> ${now_sha:-no answer}); run the script again"
    exit 9
  fi
fi

# 0 = vertex-web restarted and every container start time is unchanged; 1 = a container start time
# changed or could not be read; 2 = the vertex-web start time did not change (no restart happened).
# WEB_RESTARTED: yes, no, or unknown (the probe failed). It does not depend on the container result.
WEB_RESTARTED=unknown
check_starts() {
  local after changed web_before web_after
  WEB_RESTARTED=unknown
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
  if [ "$web_before" != "$web_after" ]; then WEB_RESTARTED=yes; else WEB_RESTARTED=no; fi
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
RT_TS="$(date -u +%Y%m%dT%H%M%SZ)"
RT_NOTE=""
BUILD_NOTE=""
if [ "$BUILD_ACTION" = swap ] || [ "$RUNTIME_ACTION" = swap ]; then
  # One remote command: no client-side step sits between the swaps and the restart. The stages are
  # checked again, because the idle wait can be long. The build goes first, because its undo is two
  # renames; a failed runtime swap (which undoes itself) puts the build back, and the restart is
  # then not sent. W is apps/web; the working directory is the checkout root.
  build_in=":"; build_back=":"; build_time=":"; runtime_in=":"; libs=""
  if [ "$BUILD_ACTION" = swap ]; then
    libs="$BUILD_LIB"
    build_in="build_in \"\$W\" $RT_TS '$BUILD_STAGED' || exit 1"
    build_back="build_back \"\$W\" $RT_TS"
    build_time="echo \"build: \$(( (\$(date +%s%N) - B0) / 1000000 )) ms from the first rename to the restart call\""
  fi
  if [ "$RUNTIME_ACTION" = swap ]; then
    libs="$SWAP_LIB
$libs"
    # The caller reads "swap: nothing moved" as "the runtime tree was not touched".
    [ "$BUILD_ACTION" != swap ] || build_in="build_in \"\$W\" $RT_TS '$BUILD_STAGED' || { echo 'swap: nothing moved'; exit 1; }"
    runtime_in="rt_ok=1
[ \"\$(cat .runtime-next/RUNTIME_SHA 2>/dev/null)\" = '$RT_STAGED' ] || { echo 'swap: the staged runtime tree changed after the guard'; echo 'swap: nothing moved'; rt_ok=0; }
if [ \$rt_ok = 1 ]; then swap_paths .runtime-next .runtime-bak-$RT_TS strict || rt_ok=0; fi
if [ \$rt_ok != 1 ]; then $build_back; exit 1; fi"
  fi
  if [ "$BUILD_ACTION" = swap ]; then
    # The steps write to a file on the host, which is printed afterwards. A step never writes to the
    # ssh connection, so a closed connection (network loss, or a signal to this script) cannot stop
    # the command between the swap and the restart: it runs to its end on the host.
    RESTART=": restart; $WEB_CD || exit 1
W=\"\$(pwd -P)\"; cd ../.. || exit 1
(
$libs
$build_in
$runtime_in
$build_time
systemctl restart $UNIT
) >\"\$W/.build-next/restart.log\" 2>&1
rc=\$?
cat \"\$W/.build-next/restart.log\"
exit \$rc"
  else
    # Runtime swap only: the text of the baseline.
    RESTART=": restart; $ROOT_CD || exit 1
$SWAP_LIB
[ \"\$(cat .runtime-next/RUNTIME_SHA 2>/dev/null)\" = '$RT_STAGED' ] || { echo 'swap: the staged runtime tree changed after the guard'; echo 'swap: nothing moved'; exit 1; }
swap_paths .runtime-next .runtime-bak-$RT_TS strict && systemctl restart $UNIT"
  fi
  UNSWAP=": unswap; $ROOT_CD || exit 1
$SWAP_LIB
if [ -f .runtime-bak-$RT_TS/COMPLETE ]; then swap_paths .runtime-bak-$RT_TS .runtime-failed-$RT_TS
elif [ -d .runtime-bak-$RT_TS ] && [ ! -f .runtime-bak-$RT_TS/UNDONE ]; then echo 'the swap into .runtime-bak-$RT_TS is unfinished; repair it (infra/quantvps/README.md)'; exit 1
else echo 'the runtime tree was not swapped'; fi"
  # Proof that the swap of this run happened, for a run whose restart command sent no closing line:
  # the backup pair of this run exists, the staged build is gone from the stage, dist holds the new
  # commit, and the live deploy config is the staged one.
  BUILD_CONFIRM=": confirm; $WEB_CD || exit 1
CONF=.wrangler/deploy/config.json
[ -d dist.bak-$RT_TS ] && [ ! -L dist.bak-$RT_TS ] && [ ! -e .build-next/dist ] && [ ! -L .build-next/dist ] &&
  [ \"\$(cat dist/DEPLOYED_SHA 2>/dev/null)\" = '$BUILD_STAGED' ] && cmp -s \"\$CONF\" \".build-next/\$CONF\" &&
  echo build-swap-confirmed"
  BUILD_UNSWAP=": unswap; $WEB_CD || exit 1
$BUILD_LIB
build_back . $RT_TS"
fi
echo "restarting $UNIT"
# ExecStartPre waits up to 120 s for Postgres, so the restart call gets 300 s.
restart_out="$(remote "$RESTART" 300 2>&1)"; restart_rc=$?
[ -z "$restart_out" ] || printf '%s\n' "$restart_out"
[ "$restart_rc" = 0 ] || echo "warning: restart command failed (exit $restart_rc); checking health"
# SWAPPED: yes = the swap reported its last move; no = the swap refused or put its moves back;
# unknown = neither line arrived (for example a lost connection), so the tree can be in any state.
SWAPPED=no
if [ "$RUNTIME_ACTION" = swap ]; then
  if grep -q '^swapped .* live -> \.runtime-bak-' <<<"$restart_out"; then
    SWAPPED=yes
    RT_NOTE=" Runtime files of $CHECKED_SHA stay swapped in (previous: .runtime-bak-$RT_TS)."
  elif grep -qx 'swap: nothing moved' <<<"$restart_out" || grep -qx 'swap: undone' <<<"$restart_out"; then
    RT_NOTE=" The runtime tree was not swapped."
  else
    SWAPPED=unknown
    RT_NOTE=" Runtime tree state unknown: check .runtime-next and .runtime-bak-$RT_TS in the checkout on QuantVPS."
  fi
fi
# BUILD_SWAPPED: yes = the staged build is in dist; no = nothing moved, or the moves were put back;
# unknown = no closing line arrived (for example a lost connection); failed = an undo did not
# finish. Only "yes" and a proved "unknown" can become a confirmed deploy.
BUILD_SWAPPED=no
if [ "$BUILD_ACTION" = swap ]; then
  BUILD_NOTE=" Build state unknown: check dist, .build-next/dist and dist.bak-$RT_TS in apps/web on QuantVPS."
  if grep -q '^build: the undo did not finish' <<<"$restart_out"; then BUILD_SWAPPED=failed
  elif grep -qx 'build: nothing moved' <<<"$restart_out" || grep -qx 'build: undone' <<<"$restart_out"; then
    BUILD_NOTE=" The staged build was not swapped in; the previous build is still in dist."
  elif grep -q '^build: swapped in ' <<<"$restart_out"; then
    BUILD_SWAPPED=yes
    BUILD_NOTE=" Build $BUILD_STAGED is in dist (previous: dist.bak-$RT_TS)."
  else BUILD_SWAPPED=unknown
  fi
  # The backup pair that the swap made is the rollback source of this run.
  if [ "$BUILD_SWAPPED" != no ] && [ -z "$BACKUP" ]; then source_ts="$RT_TS"; fi
fi
if h="$(wait_healthy)"; then
  echo "healthy: $h"
  check_starts; rc=$?
  if [ "$rc" = 2 ] || [ "$WEB_RESTARTED" = no ]; then
    # The old process must not keep serving from a swapped tree: move the saved tree back.
    if [ "$RUNTIME_ACTION" = swap ] && [ "$SWAPPED" = no ]; then echo "runtime:$RT_NOTE"
    elif [ "$SWAPPED" != no ]; then
      if unswap_out="$(remote "$UNSWAP" 120 2>&1)"; then echo "runtime: $(tail -n 1 <<<"$unswap_out")"
      else
        [ -z "$unswap_out" ] || printf '%s\n' "$unswap_out"
        echo "runtime: WARNING the swap back failed.$RT_NOTE"
        alert "⚠️ **vertex-web restart did not happen and the runtime swap back failed** (QuantVPS).$RT_NOTE The old process still serves. Check the checkout by hand."
      fi
    fi
    # The same for the build: the old process must not keep serving from the new dist.
    if [ "$BUILD_ACTION" = swap ] && [ "$BUILD_SWAPPED" = no ]; then echo "build:$BUILD_NOTE"
    elif [ "$BUILD_ACTION" = swap ]; then
      if unswap_out="$(remote "$BUILD_UNSWAP" 120 2>&1)"; then
        echo "$(tail -n 1 <<<"$unswap_out"): the previous build is back in dist; the new build is back in .build-next"
        # An unknown swap state on the production host reaches a person, also when the undo passed.
        [ "$BUILD_SWAPPED" = yes ] ||
          alert "⚠️ **vertex-web deploy not confirmed** (QuantVPS): the restart command sent no closing line and the web app did not restart. The build was put back ($(tail -n 1 <<<"$unswap_out")). Check dist, .build-next/dist and dist.bak-$RT_TS in apps/web, then run the deploy again."
      else
        [ -z "$unswap_out" ] || printf '%s\n' "$unswap_out"
        echo "build: WARNING the swap back failed.$BUILD_NOTE"
        alert "⚠️ **vertex-web restart did not happen and the build swap back failed** (QuantVPS).$BUILD_NOTE The old process still serves and can answer 500 for its asset files. Check apps/web by hand."
      fi
    fi
    echo "NOT RESTARTED: $UNIT ActiveEnterTimestamp did not change; the old process still serves"
    exit 3
  fi
  # A deploy counts only when the swap and the restart are both confirmed. Swap reported: the
  # restart must be seen (start time changed) or, when the start times could not be read, the
  # restart command must have ended with exit 0. Swap unknown (no closing line): the restart must
  # be seen and one more remote call must prove the swap of this run (BUILD_CONFIRM). The new commit
  # in dist alone proves nothing: a redeploy of the deployed commit has it before any swap.
  if [ "$BUILD_ACTION" = swap ]; then
    confirmed=no
    if [ "$BUILD_SWAPPED" = yes ] && { [ "$WEB_RESTARTED" = yes ] || [ "$restart_rc" = 0 ]; }; then confirmed=yes
    elif [ "$BUILD_SWAPPED" = unknown ] && [ "$WEB_RESTARTED" = yes ] &&
      [ "$(remote "$BUILD_CONFIRM" 2>/dev/null | tail -n 1)" = build-swap-confirmed ]; then
      confirmed=yes
      BUILD_SWAPPED=yes
      echo "build: confirmed on QuantVPS: dist holds $BUILD_STAGED and dist.bak-$RT_TS exists (the restart command sent no closing line)"
    fi
    if [ "$confirmed" != yes ]; then
      echo "NOT DEPLOYED: $UNIT is healthy, but the deploy of $BUILD_STAGED is not confirmed (swap: $BUILD_SWAPPED, restart seen: $WEB_RESTARTED, restart command exit $restart_rc).$BUILD_NOTE"
      alert "⚠️ **vertex-web deploy not confirmed** (QuantVPS): the web app is healthy, but the deploy of $BUILD_STAGED is not confirmed (swap: $BUILD_SWAPPED, restart seen: $WEB_RESTARTED). The old process may serve from the new dist. Check the ActiveEnterTimestamp of vertex-web and dist, .build-next/dist and dist.bak-$RT_TS in apps/web.$RT_NOTE"
      exit 3
    fi
  fi
  if [ -z "$CHECKED_SHA" ]; then echo "warning: new build SHA unknown; DEPLOYED_SHA not recorded"
  elif ! record_new >/dev/null 2>&1; then echo "warning: DEPLOYED_SHA not recorded (dist/DEPLOYED_SHA no longer $CHECKED_SHA, or ssh failed)"
  else echo "recorded DEPLOYED_SHA $CHECKED_SHA"; fi
  if [ "$BUILD_ACTION" = swap ]; then
    echo "build: $BUILD_STAGED is live; the previous build is kept as dist.bak-$RT_TS with .wrangler.bak-$RT_TS"
  fi
  case "$RUNTIME_ACTION:$SWAPPED" in
    swap:yes) echo "runtime: files of $CHECKED_SHA are live; previous files kept in .runtime-bak-$RT_TS" ;;
    swap:*) echo "runtime: WARNING$RT_NOTE" ;;
  esac
  if [ "$RUNTIME_ACTION" = swap ] && { [ "$SWAPPED" != yes ] || [ "$WEB_RESTARTED" != yes ]; }; then
    alert "⚠️ **vertex-web restart with a runtime swap needs a check** (QuantVPS): the web app is healthy, but the swap or the restart is not confirmed (swap: $SWAPPED, restart seen: $WEB_RESTARTED).$RT_NOTE"
  fi
  [ "$rc" = 0 ] || exit 7
  exit 0
fi
if [ "$h" = "no health answer" ]; then
  echo "HEALTH UNKNOWN: no health answer over ssh; no rollback.$BUILD_NOTE$RT_NOTE"
  alert "⚠️ **vertex-web restart: state unknown** (QuantVPS): the health check got no answer over ssh, so no rollback was done. Check vertex-web on QuantVPS by hand.$BUILD_NOTE$RT_NOTE"
  exit 6
fi
echo "UNHEALTHY after restart: $h"
NOW="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -z "$source_ts" ]; then
  # --deploy without an older pair, and the swap did not happen: nothing to roll back to.
  echo "ROLLBACK FAILED: no rollback source.$BUILD_NOTE"
  alert "❌ **vertex-web is down** (QuantVPS): the health check failed ($h) and there is no rollback source: the staged build was not swapped in, and apps/web holds no older backup pair. It needs a manual fix.$BUILD_NOTE$RT_NOTE"
  check_starts
  exit 6
fi
ROLLBACK=": rollback; $WEB_CD && test -d dist.bak-$source_ts && test ! -L dist.bak-$source_ts &&
test -d .wrangler.bak-$source_ts && test ! -L .wrangler.bak-$source_ts &&
mv dist dist.failed-$NOW && mv .wrangler .wrangler.failed-$NOW &&
cp -a dist.bak-$source_ts dist && cp -a .wrangler.bak-$source_ts .wrangler && systemctl restart $UNIT"
if [ "$RUNTIME_ACTION" = swap ]; then
  # The saved runtime tree goes back first (when the swap finished), in the same remote command as
  # the build rollback and the restart. A failed swap back is reported; the build rollback still runs.
  ROLLBACK=": rollback; $ROOT_CD || exit 1
$SWAP_LIB
if [ -f .runtime-bak-$RT_TS/COMPLETE ]; then swap_paths .runtime-bak-$RT_TS .runtime-failed-$NOW || echo 'warning: runtime files were not restored'; fi
${ROLLBACK#: rollback; }"
fi
rb_out="$(remote "$ROLLBACK" 300 2>&1)"; rb_rc=$?
[ -z "$rb_out" ] || printf '%s\n' "$rb_out"
if [ "$RUNTIME_ACTION" = swap ]; then
  if grep -q "^swapped .* paths: .runtime-bak-$RT_TS -> live" <<<"$rb_out"; then
    RT_NOTE=" Runtime files of the previous deploy were restored (failed ones: .runtime-failed-$NOW)."
  elif grep -q '^swap: the undo did not finish' <<<"$rb_out"; then
    RT_NOTE=" Runtime tree state unknown: the swap back did not finish and its undo did not finish either (.runtime-failed-$NOW is unfinished; previous: .runtime-bak-$RT_TS)."
  elif grep -q "^warning: runtime files were not restored" <<<"$rb_out"; then
    RT_NOTE=" Runtime files were NOT restored: the runtime tree of $CHECKED_SHA is still live (previous: .runtime-bak-$RT_TS)."
  elif [ "$SWAPPED" != no ]; then
    RT_NOTE=" Runtime tree state unknown: check .runtime-bak-$RT_TS and .runtime-failed-$NOW in the checkout on QuantVPS."
  fi
fi
if [ "$rb_rc" = 0 ] && h2="$(wait_healthy)"; then
  echo "rolled back to $source_ts: $h2 (failed build kept as dist.failed-$NOW).$RT_NOTE"
  alert "⚠️ **vertex-web restart failed its health check** (QuantVPS: $h). Rolled back to build $source_ts; the web app is healthy again ($h2). The failed build is kept as dist.failed-$NOW.$RT_NOTE"
  remote "$RECORD" 2>/dev/null || echo "warning: could not record DEPLOYED_SHA on QuantVPS"
  check_starts
  exit 5
fi
echo "ROLLBACK FAILED: ${h2:-rollback command failed}"
alert "❌ **vertex-web is down** (QuantVPS): the restart failed its health check ($h) and the rollback to $source_ts did not recover it (${h2:-rollback command failed}). It needs a manual fix.$RT_NOTE"
check_starts
exit 6
