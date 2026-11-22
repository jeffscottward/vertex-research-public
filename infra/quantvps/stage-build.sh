#!/usr/bin/env bash
# Stage the build output of a build commit on QuantVPS, next to the live one (infra/quantvps/).
# Run it on the rig, in the build worktree, after the build (`bun run build`) and after
# `git rev-parse HEAD > apps/web/dist/DEPLOYED_SHA` (README deploy step 1). It changes no file that
# the running web app reads and restarts nothing: `restart-when-idle.sh --deploy <sha>` moves the
# staged build into place in the same remote command that restarts the unit, so the running
# process never serves from a dist that it was not started from.
#
# Stage: apps/web/.build-next/ on QuantVPS (the same file system as apps/web/dist):
#   dist/                          the build output; it holds DEPLOYED_SHA (the build commit)
#   .wrangler/deploy/config.json   the deploy config of the same build
#   STAGED_SHA                     the build commit; written last, so a cut copy is never used
#
# Steps:
#  1. Take the vertex-web restart lock (the same file as restart-when-idle.sh), so a stage and a
#     restart never overlap. Held: exit 8.
#  2. Refuse (exit 3) when a tracked file differs from HEAD, when the build output is missing, or
#     when apps/web/dist/DEPLOYED_SHA is not HEAD.
#  3. Ask QuantVPS for the path of apps/web. Refuse (exit 3) without an answer, or when .build-next
#     or one of its folders is a symlink or a file. Up to this point nothing on QuantVPS changed.
#  4. Remove the marker of an earlier stage, then copy the build output with rsync (--delete
#     removes files of an earlier stage; --checksum, because a file of equal size and time can
#     differ; server/.dev.vars, the bindings file that only the host has, is never copied) and the
#     deploy config. Failure: exit 5; the stage has no marker and is never used.
#  5. Check the copy on QuantVPS and write STAGED_SHA. Failure: exit 5.
#
# A stage is used only by `restart-when-idle.sh --deploy <sha>` for the same commit. A restart
# without --deploy ignores it, and the next stage replaces it.
#
# Usage: infra/quantvps/stage-build.sh   (no arguments; the current directory selects the worktree)
# Exit codes: 0 staged; 2 usage; 3 refused, nothing on QuantVPS changed; 5 the copy or the check
#   failed and the stage is incomplete; 8 the restart lock is held; 11 the lock file could not be
#   opened or flock failed.
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR
#   (apps/web on the target), VERTEX_BUILD_RSYNC_TARGET (rsync destination of apps/web, default
#   quantvps:<path>), VERTEX_RESTART_LOCK.
set -uo pipefail

UNIT="vertex-web"
[ $# -eq 0 ] || { echo "usage: $0   (run it in the build worktree; no arguments)" >&2; exit 2; }

read -r -a SSH_CMD <<<"${VERTEX_WEB_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 quantvps}"
# remote <command> [timeout-seconds, default 60]
remote() { timeout "${2:-60}" "${SSH_CMD[@]}" "$1"; }
refuse() { echo "NOT STAGED: $1"; exit "${2:-3}"; }

LOCK="${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}"
mkdir -p "$(dirname "$LOCK")"
{ exec 9>"$LOCK"; } 2>/dev/null || refuse "cannot open lock file $LOCK" 11
flock -n 9
lock_rc=$?
[ "$lock_rc" != 1 ] || refuse "a vertex-web restart waiter or another stage is active" 8
[ "$lock_rc" = 0 ] || refuse "cannot lock $LOCK (flock exit $lock_rc)" 11

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || refuse "the current directory is not in a git worktree"
cd "$ROOT" || refuse "cannot enter $ROOT"
SHA="$(git rev-parse HEAD)" || refuse "cannot read HEAD"
git diff --quiet HEAD -- || refuse "a tracked file differs from HEAD ($SHA); stage only a clean build worktree"
# The one spelling of the deploy config path; the stage keeps the same relative path.
CONF=.wrangler/deploy/config.json # json-data-ignore: wrangler deploy config (build tool config), not app data
[ -f apps/web/dist/server/wrangler.json ] && [ -f "apps/web/$CONF" ] ||
  refuse "the build output is missing in $ROOT/apps/web (dist/server/wrangler.json, $CONF); run bun run build"
built="$(cat apps/web/dist/DEPLOYED_SHA 2>/dev/null)"
[ "$built" = "$SHA" ] ||
  refuse "apps/web/dist/DEPLOYED_SHA holds ${built:-nothing}, but HEAD is $SHA; build this commit and record it (README deploy step 1)"

if [ -n "${VERTEX_WEB_DIR:-}" ]; then
  WEBDIR_CMD=": webdir; cd '$VERTEX_WEB_DIR' && pwd -P"
else
  WEBDIR_CMD=": webdir; cd \"\$(systemctl show $UNIT -p WorkingDirectory --value)/../../apps/web\" && pwd -P"
fi
WEB="$(remote "$WEBDIR_CMD" 2>/dev/null | head -n 1)"
[[ "$WEB" = /?* ]] || refuse "no apps/web path from QuantVPS (answer: ${WEB:-none})"

# Exit 3 of this command: refused before any change. From the `rm` on, the earlier stage is no
# longer complete.
PREPARE=": prepare; cd '$WEB' || exit 3
for n in .build-next .build-next/dist .build-next/.wrangler '.build-next/${CONF%/*}'; do
  if [ -L \"\$n\" ] || { [ -e \"\$n\" ] && [ ! -d \"\$n\" ]; }; then echo \"\$n is a symlink or a file\"; exit 3; fi; done
rm -f .build-next/STAGED_SHA && mkdir -p .build-next/dist '.build-next/${CONF%/*}'"
prepared="$(remote "$PREPARE" 120 2>&1)"
prepare_rc=$?
[ "$prepare_rc" != 3 ] || refuse "cannot use $WEB/.build-next on QuantVPS: ${prepared:-no answer}"
[ "$prepare_rc" = 0 ] || refuse "cannot prepare $WEB/.build-next on QuantVPS: ${prepared:-no answer}" 5

TARGET="${VERTEX_BUILD_RSYNC_TARGET:-quantvps:$WEB}"
echo "copying the build output of $SHA to $TARGET/.build-next"
timeout 1800 rsync -a --checksum --delete --exclude server/.dev.vars apps/web/dist/ "$TARGET/.build-next/dist/" ||
  refuse "rsync of the build output failed (exit $?); .build-next has no marker and will not be used" 5
timeout 300 rsync -a --checksum "apps/web/$CONF" "$TARGET/.build-next/$CONF" ||
  refuse "rsync of the deploy config failed (exit $?); .build-next has no marker and will not be used" 5

MARK=": mark; cd '$WEB/.build-next' || exit 1
[ -d dist ] && [ ! -L dist ] && [ -f dist/server/wrangler.json ] && [ -f '$CONF' ] &&
  [ \"\$(cat dist/DEPLOYED_SHA 2>/dev/null)\" = '$SHA' ] || { echo 'the copied stage does not hold build $SHA'; exit 1; }
echo '$SHA' >STAGED_SHA.tmp && mv -f STAGED_SHA.tmp STAGED_SHA"
marked="$(remote "$MARK" 2>&1)" ||
  refuse "the check of the copied stage failed: ${marked:-no answer}. .build-next has no marker and will not be used." 5

echo "staged build $SHA in $WEB/.build-next; next: infra/quantvps/stage-runtime.sh, then infra/quantvps/restart-when-idle.sh --deploy $SHA"
