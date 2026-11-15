#!/usr/bin/env bash
# Retention rule for the web build backups of the QuantVPS web app (`vertex-web.service`).
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias, as
# infra/quantvps/restart-when-idle.sh does. It restarts nothing and changes no unit.
#
# Each web deploy copies the live build into a backup pair in apps/web on QuantVPS:
# `dist.bak-<TS>` with `.wrangler.bak-<TS>` (<TS> = 20261101T125501Z). This script keeps the newest
# KEEP complete pairs and deletes older ones.
#
# Rule:
#  - A complete pair is both names with the strict timestamp form, each a directory and not a symlink.
#  - Pairs are ordered by the timestamp in the name (not by file time). The newest KEEP stay.
#  - Without --apply the script only prints the plan (a preview). Nothing changes, no lock is taken.
#  - `--apply` deletes at most LIMIT pairs per run, oldest first. When more pairs are over the keep
#    count, the next run continues. No run deletes more.
#  - Other names are never touched: the live `dist` and `.wrangler`, half pairs, names with another
#    form, symlinks, and the `*.failed-*` and `*.undeployed-*` folders (reported as "not managed").
#
# How a pair is deleted:
#  1. Rename both folders to `dist.prune-<TS>` and `.wrangler.prune-<TS>` (one remote call, while
#     this script holds the restart lock on the rig). The restart script selects its rollback source
#     with the glob `dist.bak-<TS>`, so a renamed folder is never a rollback candidate.
#  2. Release the lock. Delete the renamed folders, oldest pair first.
#  3. List again and report what is left.
#  A run that stops at any point is finished by a later `--apply` run: renamed folders count toward
#  LIMIT and are deleted first.
#
# Lock: the restart lock, ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock on the rig
# (the same path as restart-when-idle.sh and stage-runtime.sh). Only step 1 holds it, without
# waiting. While it is held the Nautilus backtest worker claims nothing, and a restart or a stage
# that starts exits 8.
# Record: step 1 appends to ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-prune.log on QuantVPS
# (best effort: a failed append does not stop the run). The log records renames; a renamed pair is
# deleted by the same run or by a later one. Lines:
#   <UTC time> delete <TS> <sha|none>          a pair that this run renamed
#   <UTC time> finish <TS> none                the second half of an interrupted rename
#   <UTC time> run renamed=<n> keep=<KEEP> rc=<0|1>   once per run that reached the rename step
#
# Usage: infra/quantvps/prune-web-backups.sh [--dry-run | --apply]
#   (no flag)  preview: print the plan; change nothing. `--dry-run` means the same.
#   --apply    rename and delete up to LIMIT pairs of the plan.
# Exit codes: 0 preview printed, or the run did its work (the last line says when more pairs
#   remain); 2 usage; 3 precondition failed (no answer over ssh, folder not found, no live build,
#   incomplete listing, plan check failed, a kept pair is not on disk), nothing changed; 8 the
#   restart lock is held, nothing changed; 11 the lock file could not be opened or flock failed,
#   nothing changed; 13 partial or unknown: the rename, the delete or the check after it did not
#   complete (run --apply again). Codes 2, 3, 8 and 11 match restart-when-idle.sh; 13 is not used
#   by it.
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR,
#   VERTEX_RESTART_LOCK. `--plan <file>` is the pure rule used by the tests: it reads a listing
#   and prints the plan lines; with `--apply` it prints the plan of an apply run.
# Text formats:
#   Listing (from QuantVPS): `@@DIR <folder>` (a user name in /home/<user>/ is printed as *),
#   `@@LIVE <sha>`, `@@DF <used kB>`; `N <type> <name>` for each dist.* and .wrangler.* backup,
#   renamed, failed or undeployed name made only of the characters A-Z a-z 0-9 . _ - (type
#   d = directory, l = symlink, f = other); `B` for each such name with any other character
#   (never touched); `S <TS> <kB> <sha|none>` for each complete pair; `U <kB> <name>` for each
#   unmanaged or renamed folder; `@@END` as the last line.
#   Plan (from the rule): `keep <TS>`, `delete <TS>`, `blocked <TS>` (a complete pair that cannot
#   be renamed because a `*.prune-<TS>` name with its timestamp exists), `finish <TS>`,
#   `leftover <name>`, `skip <name> <reason>`, `unmanaged <name>`, `strange <n>` (the number of B
#   lines and of N lines with a wrong form), `waiting <n>` (renamed pairs that a run can delete),
#   `over <n>` (complete pairs over the keep count), `error <text>`, and `plan-ok` as the last
#   line of a valid plan.
set -uo pipefail

UNIT="vertex-web"
KEEP=10
LIMIT=3
TS_GLOB='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'

# The rule (see "Text formats" above). Variables: keep, limit, mode (preview|apply). A preview
# marks every pair over the keep count; an apply plan marks only what one run renames (limit minus
# the renamed pairs that wait for their delete).
# The program contains no single quote: it travels inside a single-quoted remote command.
PLAN_AWK='
function strict(t) { return t ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z$/ }
function note(name, type, t) {
  if (type != "d") { odd[name] = "not a directory"; return 0 }
  if (!strict(t)) { odd[name] = "name form"; return 0 }
  return 1
}
$0 == "B" { strange++; next }
$1 != "N" { next }
NF != 3 || $0 != "N " $2 " " $3 || $3 !~ /^[A-Za-z0-9._-]+$/ { strange++; next }
{
  type = $2; name = $3
  # taken, takenw and wany hold a timestamp for a name of any type; dist, wr, pd and gone only
  # for a directory.
  if (name ~ /^dist\.bak-/) { t = substr(name, 10); if (note(name, type, t)) dist[t] = 1 }
  else if (name ~ /^\.wrangler\.bak-/) { t = substr(name, 15); if (strict(t)) wany[t] = 1; if (note(name, type, t)) wr[t] = 1 }
  else if (name ~ /^dist\.prune-/) { t = substr(name, 12); if (strict(t)) taken[t] = 1; if (note(name, type, t)) { pd[t] = 1; left[name] = 1; gone[t] = 1 } }
  else if (name ~ /^\.wrangler\.prune-/) { t = substr(name, 17); if (strict(t)) { taken[t] = 1; takenw[t] = 1 }; if (note(name, type, t)) { left[name] = 1; gone[t] = 1 } }
  else if (name ~ /^(dist|\.wrangler)\.(failed|undeployed)-/) unmanaged[name] = 1
}
END {
  n = 0
  for (t in dist) {
    if (t in wr) pairs[++n] = t
    else odd["dist.bak-" t] = "no .wrangler.bak pair"
  }
  waiting = 0
  for (t in wr) {
    if (t in dist) continue
    if ((t in pd) && !(t in takenw)) { fin[t] = 1; waiting++ }
    else if (t in taken) odd[".wrangler.bak-" t] = "a renamed name with this timestamp exists; remove one by hand"
    else odd[".wrangler.bak-" t] = "no dist.bak pair"
  }
  for (t in gone) if (!(t in wany)) waiting++
  for (i = 2; i <= n; i++) {
    v = pairs[i]
    for (j = i - 1; j >= 1 && (pairs[j] "") > (v ""); j--) pairs[j + 1] = pairs[j]
    pairs[j + 1] = v
  }
  first_keep = n - keep + 1
  if (first_keep < 1) first_keep = 1
  over = first_keep - 1
  budget = over
  if (mode == "apply") {
    budget = limit - waiting
    if (budget < 0) budget = 0
  }
  dels = 0; keeps = 0; maxdel = ""; minkeep = ""
  for (i = 1; i <= n; i++) {
    t = pairs[i]
    if (i < first_keep && (t in taken)) { out[i] = "blocked " t; continue }
    if (i < first_keep && dels < budget) { out[i] = "delete " t; dels++; maxdel = t }
    else { out[i] = "keep " t; keeps++; if (minkeep == "") minkeep = t }
  }
  want = (n < keep ? n : keep)
  newest = 0
  for (i = first_keep; i <= n; i++) if (out[i] == "keep " pairs[i]) newest++
  if (newest != want || (dels > 0 && !((maxdel "") < (minkeep "")))) { print "error plan check failed"; exit }
  for (i = 1; i <= n; i++) print out[i]
  for (t in fin) print "finish " t
  for (name in left) print "leftover " name
  for (name in odd) print "skip " name " " odd[name]
  for (name in unmanaged) print "unmanaged " name
  if (strange > 0) print "strange " strange
  print "waiting " waiting
  print "over " over
  print "plan-ok"
}'

usage() { echo "usage: $0 [--dry-run | --apply]" >&2; exit 2; }

APPLY=0
DRY=0
PLAN_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) DRY=1 ;;
    --plan) [ $# -ge 2 ] || usage; PLAN_FILE="$2"; shift ;;
    *) usage ;;
  esac
  shift
done
if [ "$APPLY" = 1 ] && [ "$DRY" = 1 ]; then echo "--dry-run cannot be combined with --apply" >&2; exit 2; fi
MODE=preview
[ "$APPLY" = 1 ] && MODE=apply

plan() { awk -v keep="$KEEP" -v limit="$LIMIT" -v mode="$MODE" "$PLAN_AWK"; }

if [ -n "$PLAN_FILE" ]; then
  [ -r "$PLAN_FILE" ] || { echo "cannot read $PLAN_FILE" >&2; exit 2; }
  plan <"$PLAN_FILE"
  exit 0
fi

read -r -a SSH_CMD <<<"${VERTEX_WEB_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 quantvps}"
# remote <command> [timeout-seconds, default 60]
remote() { timeout "${2:-60}" "${SSH_CMD[@]}" "$1"; }

# apps/web on QuantVPS, found from the unit (WorkingDirectory is <checkout>/private/basic-app-named).
# Every remote command stops (exit 3) when the folder is not found or holds no live build.
if [ -n "${VERTEX_WEB_DIR:-}" ]; then
  GUARD="cd '$VERTEX_WEB_DIR' || exit 3"
else
  GUARD="w=\$(systemctl show $UNIT -p WorkingDirectory --value); [ -n \"\$w\" ] || exit 3; cd \"\$w/../../apps/web\" || exit 3"
fi
GUARD="LC_ALL=C; export LC_ALL; $GUARD; [ -d dist ] && [ -d .wrangler ] || exit 3"
# One line per name of a managed or reported family. The shell pattern gives each name as one
# word, so a blank or a newline in a name cannot forge a line: such a name becomes a "B" line.
NAMES="for d in dist.bak-* .wrangler.bak-* dist.prune-* .wrangler.prune-* dist.failed-* .wrangler.failed-* dist.undeployed-* .wrangler.undeployed-*; do
  [ -e \"\$d\" ] || [ -L \"\$d\" ] || continue;
  case \"\$d\" in *[!A-Za-z0-9._-]*) echo B; continue ;; esac;
  if [ -L \"\$d\" ]; then y=l; elif [ -d \"\$d\" ]; then y=d; else y=f; fi; echo \"N \$y \$d\"; done"
SHA_OF="head -c 64 \"\$d/DEPLOYED_SHA\" 2>/dev/null | tr -cd 0-9a-f | cut -c1-12"

# Each remote command starts with a ": <name>;" marker (a no-op) so logs and tests can name it.
LIST=": prune-list; $GUARD; echo \"@@DIR \$(pwd -P | sed \"s|^/home/[^/]*/|/home/*/|\")\";
echo \"@@LIVE \$(head -c 64 DEPLOYED_SHA 2>/dev/null | tr -cd 0-9a-f | cut -c1-12)\";
echo \"@@DF \$(df -Pk . | tail -n 1 | awk '{print \$3}')\"; $NAMES;
for d in dist.bak-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; t=\${d#dist.bak-};
  [ -d \".wrangler.bak-\$t\" ] && [ ! -L \".wrangler.bak-\$t\" ] || continue; sha=\$($SHA_OF);
  a=\$(du -sk \"\$d\" 2>/dev/null | cut -f1); b=\$(du -sk \".wrangler.bak-\$t\" 2>/dev/null | cut -f1);
  echo \"S \$t \$(( \${a:-0} + \${b:-0} )) \${sha:-none}\"; done;
for d in dist.failed-* .wrangler.failed-* dist.undeployed-* .wrangler.undeployed-* dist.prune-* .wrangler.prune-*; do
  [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; case \"\$d\" in *[!A-Za-z0-9._-]*) continue ;; esac;
  a=\$(du -sk \"\$d\" 2>/dev/null | cut -f1); echo \"U \${a:-0} \$d\"; done; echo @@END"

# Runs while the rig holds the restart lock. It lists and plans again on the host, so the renames
# never come from an earlier listing. Before the first rename it checks that every kept pair is on
# disk. A rename stops when a target name exists, and the loop stops after 30 s, before the
# local 60 s timeout releases the lock.
RENAME=": prune-rename; $GUARD; start=\$(date +%s);
plan=\$($NAMES | awk -v keep=$KEEP -v limit=$LIMIT -v mode=apply '$PLAN_AWK') || exit 3;
case \"\$plan\" in *plan-ok) ;; *) echo \"\$plan\"; exit 3 ;; esac;
bad=;
while read -r kind t rest; do
  [ \"\$kind\" = keep ] || continue;
  [ -d \"dist.bak-\$t\" ] && [ ! -L \"dist.bak-\$t\" ] && [ -d \".wrangler.bak-\$t\" ] && [ ! -L \".wrangler.bak-\$t\" ] || bad=\$t;
done <<EOF
\$plan
EOF
[ -z \"\$bad\" ] || { echo \"error a kept pair is not on disk: \$bad\"; exit 3; };
log=\"\${XDG_STATE_HOME:-\$HOME/.local/state}/vertex-web-prune.log\"; mkdir -p \"\$(dirname \"\$log\")\" 2>/dev/null; rc=0; n=0;
while read -r kind t rest; do
  case \"\$kind\" in delete|finish) ;; *) continue ;; esac;
  case \"\$t\" in $TS_GLOB) ;; *) rc=1; break ;; esac;
  [ \$(( \$(date +%s) - start )) -le 30 ] || { rc=1; break; };
  sha=;
  if [ \"\$kind\" = delete ]; then d=\"dist.bak-\$t\";
    [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && [ -d \".wrangler.bak-\$t\" ] && [ ! -L \".wrangler.bak-\$t\" ] || { rc=1; break; };
    [ ! -e \"dist.prune-\$t\" ] && [ ! -L \"dist.prune-\$t\" ] && [ ! -e \".wrangler.prune-\$t\" ] && [ ! -L \".wrangler.prune-\$t\" ] || { rc=1; break; };
    sha=\$($SHA_OF); mv -T -- \"\$d\" \"dist.prune-\$t\" || { rc=1; break; }; fi;
  [ ! -e \".wrangler.prune-\$t\" ] && [ ! -L \".wrangler.prune-\$t\" ] && mv -T -- \".wrangler.bak-\$t\" \".wrangler.prune-\$t\" || { rc=1; break; };
  if [ \"\$kind\" = delete ]; then n=\$((n + 1)); echo \"renamed \$t \${sha:-none}\"; else echo \"finished \$t\"; fi;
  echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) \$kind \$t \${sha:-none}\" >>\"\$log\" 2>/dev/null;
done <<EOF
\$plan
EOF
echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) run renamed=\$n keep=$KEEP rc=\$rc\" >>\"\$log\" 2>/dev/null;
echo \"@@END \$rc\""

# Runs after the lock is released. Deletes renamed folders, oldest pair first. It starts the
# delete of at most LIMIT pairs. Only literal names of the strict form reach rm. A renamed folder
# whose `.wrangler.bak-<TS>` still exists belongs to a rename in progress and is left alone.
DELETE=": prune-delete; $GUARD; rc=0; n=0;
for t in \$(for d in dist.prune-$TS_GLOB .wrangler.prune-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && echo \"\${d##*.prune-}\"; done | sort -u); do
  [ -e \".wrangler.bak-\$t\" ] || [ -L \".wrangler.bak-\$t\" ] && continue;
  [ \$n -ge $LIMIT ] && break; n=\$((n + 1));
  for d in \"dist.prune-\$t\" \".wrangler.prune-\$t\"; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; rm -rf -- \"./\$d\" || rc=1; done;
  [ ! -e \"dist.prune-\$t\" ] && [ ! -e \".wrangler.prune-\$t\" ] && echo \"deleted \$t\";
done; echo \"@@END \$rc\""

mib() { echo "$(( ($1 + 512) / 1024 )) MiB"; }

# Read one listing into the globals DIR, LIVE, DF_USED, SIZE[], SHA[], OTHER[] and PLAN.
declare -A SIZE SHA OTHER
read_listing() {
  LISTING="$(remote "$LIST" 180 2>&1)"
  local rc=$?
  PLAN=""
  if [ $rc -ne 0 ] || [ "$(tail -n 1 <<<"$LISTING")" != "@@END" ]; then
    grep -v '^[NSU@]' <<<"$LISTING" >&2
    return 1
  fi
  DIR="$(sed -n 's/^@@DIR //p' <<<"$LISTING" | head -n 1)"
  LIVE="$(sed -n 's/^@@LIVE //p' <<<"$LISTING" | head -n 1)"
  DF_USED="$(sed -n 's/^@@DF //p' <<<"$LISTING" | head -n 1)"
  [[ "$DF_USED" =~ ^[0-9]+$ ]] || DF_USED=0
  SIZE=(); SHA=(); OTHER=()
  local tag a b c
  while read -r tag a b c; do
    case "$tag" in
      S) [[ "$b" =~ ^[0-9]+$ ]] || b=0; SIZE[$a]="$b"; SHA[$a]="$c" ;;
      U) [[ "$a" =~ ^[0-9]+$ ]] || a=0; OTHER[$b]="$a" ;;
    esac
  done <<<"$LISTING"
  PLAN="$(grep '^N \|^B$' <<<"$LISTING" | plan)"
  [ "$(tail -n 1 <<<"$PLAN")" = "plan-ok" ]
}

count() { grep -c "^$1 " <<<"$PLAN" || true; }

print_plan() {
  local kind name rest live
  while read -r kind name rest; do
    case "$kind" in
      blocked) echo "blocked $name (a renamed name with this timestamp exists; remove one of them by hand)" ;;
      strange) echo "skip: $name name(s) with a blank or another unusual character (never touched)" ;;
      keep | delete)
        live=""
        [ -n "$LIVE" ] && [ "${SHA[$name]:-}" = "$LIVE" ] && live=" = live"
        echo "$kind $name ${SHA[$name]:-none} $(mib "${SIZE[$name]:-0}")$live" ;;
      finish) echo "leftover .wrangler.bak-$name (second half of an interrupted rename)" ;;
      leftover) echo "leftover $name $(mib "${OTHER[$name]:-0}")" ;;
      skip) echo "skip $name ($rest)" ;;
    esac
  done <<<"$PLAN"
  local family n kb d
  for family in failed undeployed; do
    n=0; kb=0
    for d in "${!OTHER[@]}"; do
      case "$d" in dist."$family"-* | .wrangler."$family"-*) n=$((n + 1)); kb=$((kb + ${OTHER[$d]})) ;; esac
    done
    [ "$n" -gt 0 ] && echo "not managed: $n *.$family-* folder(s), $(mib "$kb")"
  done
  return 0
}

if ! read_listing; then
  reason="no complete listing of apps/web on QuantVPS"
  grep -q '^error ' <<<"$PLAN" && reason="$(sed -n 's/^error //p' <<<"$PLAN" | head -n 1)"
  echo "NOT PRUNED: $reason; nothing changed"
  exit 3
fi
PAIRS_BEFORE=$(( $(count keep) + $(count delete) + $(count blocked) ))
N_DELETE=$(count delete)
N_FINISH=$(count finish)
N_LEFT=$(( $(count leftover) + N_FINISH ))
OVER="$(sed -n 's/^over //p' <<<"$PLAN")"
USED_BEFORE="$DF_USED"

echo "prune-web-backups: mode=$MODE folder=$DIR keep=$KEEP limit=$LIMIT"
print_plan

if [ "$APPLY" = 0 ]; then
  if [ "$OVER" -gt "$LIMIT" ]; then
    echo "note: $OVER complete pairs are over the keep count; one --apply run deletes the oldest $LIMIT"
  fi
  echo "summary mode=preview pairs_before=$PAIRS_BEFORE delete=$N_DELETE over=$OVER leftover_folders=$N_LEFT used_before_mib=$(( (USED_BEFORE + 512) / 1024 ))"
  echo "PREVIEW: nothing deleted"
  exit 0
fi

# The last line of a run that completed: what was deleted and what still waits.
finish_line() { # <deleted> <over> <blocked> <waiting>
  local line="PRUNED: $1 pairs"
  if [ $(( $2 - $3 )) -gt 0 ] || [ "$4" -gt 0 ]; then
    line="$line; more remain ($(( $2 - $3 )) over the keep count, $4 renamed pair(s) wait); the next run continues"
  fi
  [ "$3" -gt 0 ] && line="$line; $3 blocked pair(s) need a person (see the blocked lines)"
  echo "$line"
}

if [ "$N_DELETE" -eq 0 ] && [ "$N_LEFT" -eq 0 ]; then
  # Nothing to rename and nothing to delete: no lock, no second listing.
  echo "summary mode=apply pairs_before=$PAIRS_BEFORE renamed=0 deleted=0 pairs_after=$PAIRS_BEFORE over_after=$OVER leftover_folders=0 used_before_mib=$(( (USED_BEFORE + 512) / 1024 )) used_after_mib=$(( (USED_BEFORE + 512) / 1024 ))"
  finish_line 0 "$OVER" "$(count blocked)" 0
  exit 0
fi

RENAMED=0
if [ "$N_DELETE" -gt 0 ] || [ "$N_FINISH" -gt 0 ]; then
  # Only flock's "lock held" answer (exit 1) is exit 8. A lock file that cannot be opened or any
  # other flock failure is exit 11. Same lock path as restart-when-idle.sh.
  LOCK="${VERTEX_RESTART_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock}"
  mkdir -p "$(dirname "$LOCK")" 2>/dev/null
  if ! { exec 9>"$LOCK"; } 2>/dev/null; then
    echo "NOT PRUNED: cannot open lock file ${LOCK/#$HOME/\~}; nothing changed"
    exit 11
  fi
  flock -n 9
  lock_rc=$?
  if [ $lock_rc -eq 1 ]; then
    echo "NOT PRUNED: the restart lock is held (a restart, a stage or another prune runs); nothing deleted; run again later"
    exit 8
  elif [ $lock_rc -ne 0 ]; then
    echo "NOT PRUNED: cannot lock ${LOCK/#$HOME/\~} (flock exit $lock_rc); nothing changed"
    exit 11
  fi
  RENAME_OUT="$(remote "$RENAME" 60 2>&1)"
  rename_rc=$?
  flock -u 9
  exec 9>&-
  grep '^renamed \|^finished ' <<<"$RENAME_OUT" | sed 's/^/  /'
  RENAMED=$(grep -c '^renamed ' <<<"$RENAME_OUT" || true)
  if [ $rename_rc -eq 3 ]; then
    reason="the rename step failed its precondition on QuantVPS"
    grep -q '^error ' <<<"$RENAME_OUT" && reason="$(sed -n 's/^error //p' <<<"$RENAME_OUT" | head -n 1)"
    echo "NOT PRUNED: $reason; nothing changed"
    exit 3
  fi
  if [ $rename_rc -ne 0 ] || [ "$(tail -n 1 <<<"$RENAME_OUT")" != "@@END 0" ]; then
    grep -v '^renamed \|^finished \|^@@' <<<"$RENAME_OUT" >&2
    echo "PARTIAL: the rename step did not complete (exit $rename_rc, $RENAMED pair(s) renamed); run --apply again"
    exit 13
  fi
fi

DELETED=0
delete_ok=1
if [ "$RENAMED" -gt 0 ] || [ "$N_LEFT" -gt 0 ]; then
  DELETE_OUT="$(remote "$DELETE" 600 2>&1)"
  delete_rc=$?
  DELETED=$(grep -c '^deleted ' <<<"$DELETE_OUT" || true)
  if [ $delete_rc -ne 0 ] || [ "$(tail -n 1 <<<"$DELETE_OUT")" != "@@END 0" ]; then
    grep -v '^deleted \|^@@' <<<"$DELETE_OUT" >&2
    delete_ok=0
  fi
fi

if ! read_listing; then
  echo "PARTIAL: $RENAMED pair(s) renamed, $DELETED pair(s) deleted, but the check after the delete got no complete listing; run --apply again"
  exit 13
fi
PAIRS_AFTER=$(( $(count keep) + $(count delete) + $(count blocked) ))
OVER_AFTER="$(sed -n 's/^over //p' <<<"$PLAN")"
LEFT_AFTER=$(( $(count leftover) + $(count finish) ))
echo "summary mode=apply pairs_before=$PAIRS_BEFORE renamed=$RENAMED deleted=$DELETED pairs_after=$PAIRS_AFTER over_after=$OVER_AFTER leftover_folders=$LEFT_AFTER used_before_mib=$(( (USED_BEFORE + 512) / 1024 )) used_after_mib=$(( (DF_USED + 512) / 1024 ))"
if [ "$delete_ok" = 0 ]; then
  echo "PARTIAL: $RENAMED pair(s) renamed, $DELETED pair(s) deleted, $LEFT_AFTER renamed folder(s) left; run --apply again"
  exit 13
fi
finish_line "$DELETED" "$OVER_AFTER" "$(count blocked)" "$(sed -n 's/^waiting //p' <<<"$PLAN")"
