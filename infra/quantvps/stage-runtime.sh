#!/usr/bin/env bash
# Stage the runtime tree of a build commit on QuantVPS, next to the live one (infra/quantvps/).
# Run it on the rig, in the build worktree, after `pnpm install --frozen-lockfile` and the build
# output copy. It changes no live file and restarts nothing: `restart-when-idle.sh` moves the
# staged tree into place at the restart (see its "Runtime tree" header section).
#
# Runtime tree: every tracked file of HEAD, and `node_modules` of the root and of each workspace
# package named under `importers:` in pnpm-lock.yaml. The checkout on QuantVPS has no .git and no
# package store, so the packages come from this worktree.
#
# Steps:
#  1. Take the vertex-web restart lock (the same file as restart-when-idle.sh), so a stage and a
#     restart never overlap. Held: exit 8.
#  2. Refuse (exit 3) when a tracked file differs from HEAD, when the root node_modules is a link or
#     has no .modules.yaml, or when `pnpm install --frozen-lockfile --offline` fails. pnpm has no
#     read-only check: that command completes node_modules from the local store or fails.
#  3. Refuse (exit 3) when QuantVPS has an unfinished runtime swap or less free space than
#     VERTEX_RUNTIME_MIN_FREE_KB (default 5 GiB). Backups of earlier swaps are never deleted here.
#     Up to this point nothing on QuantVPS changed: an earlier stage is still usable.
#  4. Remove an old .runtime-next/ in the checkout and copy the runtime tree into a new one with
#     rsync. Files with the same content, owner and mode as the live ones become hard links
#     (--link-dest with --checksum; file times are not copied and do not count). Failure: exit 5.
#  5. Program check in the staged tree, with the Node.js of the unit: `vite --version` and
#     `workerd --version`. It shows that these two programs execute on QuantVPS. Failure: exit 4.
#  6. Write .runtime-next/PATHS (the swap units, one per line) and .runtime-next/RUNTIME_SHA (HEAD).
#     RUNTIME_SHA is written last: a stage without it is incomplete and is never swapped in.
#
# Swap units (PATHS): each tracked top-level entry except `apps`, the root node_modules, each entry
# of apps/ except apps/web, each tracked entry directly in apps/web/, apps/web/node_modules, and
# RUNTIME_SHA. Server-side state (private/, and in apps/web: dist, .wrangler, their backups,
# DEPLOYED_SHA, .next, .vinext) is in no unit and stays in place.
#
# Usage: infra/quantvps/stage-runtime.sh   (no arguments; the current directory selects the worktree)
# Exit codes: 0 staged; 2 usage; 3 refused, nothing on QuantVPS changed; 4 program check failed;
#   5 the earlier stage was removed and the new copy failed;
#   8 the restart lock is held; 11 the lock file could not be opened or flock failed.
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR
#   (apps/web on the target; the checkout is two levels above), VERTEX_RUNTIME_RSYNC_TARGET (rsync
#   destination of the checkout, default quantvps:<checkout>), VERTEX_RUNTIME_PNPM,
#   VERTEX_RUNTIME_NODE, VERTEX_RUNTIME_MIN_FREE_KB, VERTEX_RESTART_LOCK.
set -uo pipefail

UNIT="vertex-web"
[ $# -eq 0 ] || { echo "usage: $0   (run it in the build worktree; no arguments)" >&2; exit 2; }

read -r -a SSH_CMD <<<"${VERTEX_WEB_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 quantvps}"
read -r -a PNPM_CMD <<<"${VERTEX_RUNTIME_PNPM:-pnpm}"
MIN_FREE_KB="${VERTEX_RUNTIME_MIN_FREE_KB:-5242880}"
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
[ -d node_modules ] && [ ! -L node_modules ] && [ -f node_modules/.modules.yaml ] ||
  refuse "node_modules in $ROOT is missing, is a link, or has no .modules.yaml; run pnpm install --frozen-lockfile here"
"${PNPM_CMD[@]}" install --frozen-lockfile --offline >/dev/null 2>&1 ||
  refuse "pnpm install --frozen-lockfile --offline failed: node_modules does not match pnpm-lock.yaml; run pnpm install --frozen-lockfile"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Copy list (NUL separated): tracked files, then node_modules of every lockfile importer.
git ls-files -z >"$WORK/list" || refuse "git ls-files failed"
awk '/^importers:/ { on = 1; next } on && /^[^ ]/ { exit }
  on && /^  [^ ].*:$/ { key = $0; sub(/^  /, "", key); sub(/:$/, "", key); gsub(/^['\''"]|['\''"]$/, "", key); print key }' \
  pnpm-lock.yaml >"$WORK/importers"
[ -s "$WORK/importers" ] || refuse "pnpm-lock.yaml names no importer"
while IFS= read -r key; do
  if [ "$key" = . ]; then modules=node_modules; else modules="$key/node_modules"; fi
  if [ -d "$modules" ] && [ ! -L "$modules" ]; then printf '%s\0' "$modules" >>"$WORK/list"; fi
done <"$WORK/importers"

# Swap units, one per line. -z: git prints every name as it is (no quoting of spaces or non-ASCII
# bytes). A name with a newline cannot be a PATHS line.
units_of() { # [<directory>/]: the tracked entries directly in it
  # stdout of this function is the unit file: the refusal text goes to stderr.
  git ls-tree -z --name-only HEAD "$@" >"$WORK/names" || refuse "git ls-tree failed for ${*:-the root}" >&2
  [ "$(tr -cd '\n' <"$WORK/names" | wc -c)" = 0 ] || refuse "a tracked name in ${*:-the root} holds a newline" >&2
  tr '\0' '\n' <"$WORK/names"
}
units_of >"$WORK/root"
units_of apps/ >"$WORK/apps"
units_of apps/web/ >"$WORK/web"
[ -s "$WORK/web" ] || refuse "HEAD has no tracked file in apps/web"
{
  grep -vx apps "$WORK/root"
  echo node_modules
  grep -vx apps/web "$WORK/apps"
  cat "$WORK/web"
  echo apps/web/node_modules
  echo RUNTIME_SHA
} >"$WORK/PATHS"
printf '%s\n' "$SHA" >"$WORK/RUNTIME_SHA"

if [ -n "${VERTEX_WEB_DIR:-}" ]; then
  CHECKOUT_CMD=": checkout; cd '$VERTEX_WEB_DIR/../..' && pwd -P"
else
  CHECKOUT_CMD=": checkout; cd \"\$(systemctl show $UNIT -p WorkingDirectory --value)/../..\" && pwd -P"
fi
CHECKOUT="$(remote "$CHECKOUT_CMD" 2>/dev/null | head -n 1)"
[[ "$CHECKOUT" = /?* ]] || refuse "no checkout path from QuantVPS (answer: ${CHECKOUT:-none})"

# Checks that change nothing: the checkout, an unfinished swap, the free space (`free <KB>`).
SPACE=": space; cd '$CHECKOUT' && test -f apps/web/package.json || { echo 'no apps/web/package.json'; exit 1; }
for d in .runtime-bak-* .runtime-failed-*; do
  if [ -d \"\$d\" ] && [ ! -f \"\$d/COMPLETE\" ] && [ ! -f \"\$d/UNDONE\" ]; then echo \"incomplete \$d\"; exit 1; fi; done
echo \"free \$(df -Pk . | awk 'NR == 2 { print \$4 }')\""
space="$(remote "$SPACE" 2>&1)" || {
  case "$space" in
    incomplete\ *) refuse "an earlier runtime swap did not finish (${space#incomplete } has no COMPLETE file). Repair it first: infra/quantvps/README.md, \"Repair an unfinished runtime swap\"." ;;
    *) refuse "cannot check $CHECKOUT on QuantVPS: ${space:-no answer}" ;;
  esac
}
free_kb="$(sed -n 's/^free //p' <<<"$space" | head -n 1)"
[[ "$free_kb" =~ ^[0-9]+$ ]] || refuse "no free-space answer from QuantVPS: ${space:-none}"
[ "$free_kb" -ge "$MIN_FREE_KB" ] ||
  refuse "only $((free_kb / 1024)) MiB free on QuantVPS (minimum $((MIN_FREE_KB / 1024)) MiB). Old dist.bak-*, .runtime-bak-* and .runtime-failed-* directories need an owner decision before removal."

# From here the earlier stage is gone. It loses its completeness marker first, then it is removed.
PREPARE=": prepare; cd '$CHECKOUT' && rm -f .runtime-next/RUNTIME_SHA && rm -rf .runtime-next && mkdir .runtime-next"
prepared="$(remote "$PREPARE" 300 2>&1)" ||
  refuse "cannot prepare $CHECKOUT/.runtime-next on QuantVPS: ${prepared:-no answer}" 5

TARGET="${VERTEX_RUNTIME_RSYNC_TARGET:-quantvps:$CHECKOUT}"
echo "copying the runtime tree of $SHA to $TARGET/.runtime-next ($(tr -cd '\0' <"$WORK/list" | wc -c) list entries)"
# -rlpgoD is -a without -t: file times are not copied, so they do not count for --link-dest, and a
# file becomes a hard link to the live file whenever content (--checksum), owner and mode are equal.
# With -t, package files from another package store (other file times) would never link, and every
# stage and every backup would cost the full tree (measured 2026-11-15: 1.8 GB, 0 links).
timeout 3600 rsync -rlpgoD --checksum --from0 --files-from="$WORK/list" --link-dest="$CHECKOUT" ./ "$TARGET/.runtime-next/" ||
  refuse "rsync of the runtime tree failed (exit $?); .runtime-next is incomplete and will not be used" 5

if [ -n "${VERTEX_RUNTIME_NODE:-}" ]; then
  NODE_FIND="node='$VERTEX_RUNTIME_NODE'"
else
  NODE_FIND="node=\$(systemctl show $UNIT -p ExecStart --value | sed -n 's/.*[{ ]path=\\([^ ;]*\\).*/\\1/p' | head -n 1)"
fi
SMOKE=": smoke; cd '$CHECKOUT/.runtime-next/apps/web' && $NODE_FIND && test -n \"\$node\" &&
\"\$node\" node_modules/vite/bin/vite.js --version &&
for w in ../../node_modules/.pnpm/@cloudflare+workerd-linux-64@*/node_modules/@cloudflare/workerd-linux-64/bin/workerd; do
  test -x \"\$w\" && \"\$w\" --version || exit 1; done"
smoke="$(remote "$SMOKE" 120 2>&1)" ||
  refuse "the staged programs do not start on QuantVPS: ${smoke:-no answer}. .runtime-next has no RUNTIME_SHA and will not be used." 4

timeout 300 rsync -rlpgoD "$WORK/PATHS" "$TARGET/.runtime-next/PATHS" &&
  timeout 300 rsync -rlpgoD "$WORK/RUNTIME_SHA" "$TARGET/.runtime-next/RUNTIME_SHA" ||
  refuse "could not write PATHS and RUNTIME_SHA; .runtime-next is incomplete and will not be used" 5

echo "program check: $(paste -sd ',' <<<"$smoke" | sed 's/,/, /g')"
echo "staged runtime $SHA in $CHECKOUT/.runtime-next ($(wc -l <"$WORK/PATHS" | tr -d ' ') swap units); next: infra/quantvps/restart-when-idle.sh"
