#!/usr/bin/env bash
# Retention rule for the runtime tree backups of the QuantVPS web app (`vertex-web.service`).
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias, as
# infra/quantvps/restart-when-idle.sh does. It restarts nothing and changes no unit.
# Design: docs/vertex-rebuild/designs/quantvps-runtime-backup-retention/design.md.
#
# Each restart that swaps a staged runtime tree in moves the old tree into a backup folder in the
# checkout root on QuantVPS: `.runtime-bak-<TS>` (<TS> = 20261116T114258Z), which gets the file
# COMPLETE when the swap finished. This script keeps the newest KEEP complete backups and deletes
# older ones (owner decision 2026-11-15, rule A: keep 2).
#
# Rule:
#  - A complete backup is a directory (not a symlink) `.runtime-bak-<TS>` with the strict timestamp
#    form, with COMPLETE and without UNDONE. Backups are ordered by the timestamp in the name.
#  - Without --apply the script only prints the plan (a preview). Nothing changes, no lock is taken.
#  - `--apply` deletes at most LIMIT backups per run, oldest first. The next run continues.
#  - An unfinished swap (a `.runtime-bak-*` or `.runtime-failed-*` directory with neither COMPLETE
#    nor UNDONE) stops the run (exit 3), as it stops restart-when-idle.sh and stage-runtime.sh.
#  - Other names are never touched: `.runtime-next`, `.runtime-failed-*` folders and
#    `.runtime-bak-*` folders with UNDONE (reported as "not managed"), other name forms, symlinks.
#
# How a backup is deleted:
#  1. Rename it to `.runtime-prune-<TS>` (one remote call, while this script holds the restart lock
#     on the rig). The restart and stage scripts look only at `.runtime-bak-*` and
#     `.runtime-failed-*`, so a renamed folder is invisible to them.
#  2. Release the lock. Delete the renamed folders, oldest first. Unchanged files of a backup are
#     hard links to the live tree; removing a link does not change the live file.
#  3. List again and report what is left.
#  A run that stops at any point is finished by a later `--apply` run: renamed folders count toward
#  LIMIT and are deleted first.
#
# Lock: the restart lock, ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock on the rig
# (the same path as restart-when-idle.sh, stage-runtime.sh and prune-web-backups.sh). Only step 1
# holds it, without waiting. A restart holds it from before its swap until after its rollback, so
# no rename runs between the two.
# Record: step 1 appends to ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-runtime-prune.log on
# QuantVPS (best effort). Lines:
#   <UTC time> delete <TS> <sha|none>                  a backup that this run renamed
#   <UTC time> run renamed=<n> keep=<KEEP> rc=<0|1>    once per run that reached the rename step
#
# Usage: infra/quantvps/prune-runtime-backups.sh [--dry-run | --apply]
#   (no flag)  preview: print the plan; change nothing. `--dry-run` means the same.
#   --apply    rename and delete up to LIMIT backups of the plan.
# Exit codes (the same as prune-web-backups.sh): 0 preview printed, or the run did its work (the
#   last line says when more backups remain), or --apply skipped during US trading hours (weekdays
#   09:15-16:05 New York time; nothing changed); 2 usage; 3 precondition failed (no answer over ssh,
#   checkout or RUNTIME_SHA not found, incomplete listing, unfinished swap, plan check failed, a
#   kept backup is not on disk), nothing changed; 8 the restart lock is held, nothing changed;
#   11 the lock file could not be opened or flock failed, nothing changed; 13 partial or unknown:
#   the rename, the delete or the check after it did not complete (run --apply again).
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR
#   (apps/web of the checkout; the checkout root is two folders up), VERTEX_RESTART_LOCK,
#   VERTEX_PRUNE_NY_TIME ("<weekday 1-7> <HHMM>" in New York, replaces the clock).
#   `--plan <file>` is the pure rule used by the tests: it reads a listing and prints the plan.
# Text formats:
#   Listing (from QuantVPS): `@@DIR <folder>` (a user name in /home/<user>/ is printed as *),
#   `@@LIVE <sha>`, `@@DF <used kB>`; `N <type> <state> <name>` for each .runtime-bak-*,
#   .runtime-failed-* and .runtime-prune-* name made only of the characters A-Z a-z 0-9 . _ -
#   (type d = directory, l = symlink, f = other; state for a name that is a directory or a symlink
#   to one: C = COMPLETE only, U = UNDONE only, X = both, I = neither, E = a .runtime-bak-* with
#   COMPLETE whose PATHS units are all gone (a rollback moved its tree back live); else -); `B <state>` for each
#   such name with any other character (never touched); `S <TS> <sha|none>` for each complete
#   backup; `U <kB> <name>` for each .runtime-failed-* directory (du size, hard-linked files
#   included); `@@END` as the last line.
#   Plan (from the rule): `keep <TS>`, `delete <TS>`, `blocked <TS>` (a backup that cannot be
#   renamed because a `.runtime-prune-<TS>` name exists), `leftover <name>` (a renamed folder that
#   waits for its delete), `skip <name> <reason>`, `unmanaged <name> <reason>`, `strange <n>`,
#   `waiting <n>`, `over <n>`, `error <text>`, and `plan-ok` as the last line of a valid plan.
set -uo pipefail

UNIT="vertex-web"
KEEP=2
# One backup per run: a runtime tree holds about 88,600 entries (2026-11-15), mostly hard links, and
# each removal is a metadata write on the trading host's disk. One tree is about 10 times the
# 8,700 entries of the 3 build-backup pairs that one prune-web-backups.sh run deletes.
LIMIT=1
TS_GLOB='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'

# The rule (see "Text formats" above). Variables: keep, limit, mode (preview|apply). A preview
# marks every backup over the keep count; an apply plan marks only what one run renames (limit
# minus the renamed folders that wait for their delete).
# The program contains no single quote: it travels inside a single-quoted remote command.
PLAN_AWK='
function strict(t) { return t ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z$/ }
function swapdir(name) { return name ~ /^\.runtime-(bak|failed)-/ }
$1 == "B" { strange++; if ($2 == "I") unfinished = "a name with an unusual character"; next }
$1 != "N" { next }
NF != 4 || $0 != "N " $2 " " $3 " " $4 || $4 !~ /^[A-Za-z0-9._-]+$/ { strange++; next }
{
  type = $2; state = $3; name = $4
  if (swapdir(name) && state == "I") { if (unfinished == "") unfinished = name; next }
  if (name ~ /^\.runtime-bak-/) {
    t = substr(name, 14)
    if (type != "d") odd[name] = "not a directory"
    else if (!strict(t)) odd[name] = "name form"
    else if (state == "C") bak[t] = 1
    else if (state == "U") unmanaged[name] = "UNDONE: a refused swap, put back"
    else if (state == "E") unmanaged[name] = "empty: its tree went back live in a rollback"
    else if (state == "X") odd[name] = "both COMPLETE and UNDONE"
    else odd[name] = "unknown state"
  } else if (name ~ /^\.runtime-failed-/) {
    unmanaged[name] = "failed tree of a rollback"
  } else if (name ~ /^\.runtime-prune-/) {
    t = substr(name, 16)
    if (strict(t)) taken[t] = 1
    if (type != "d") odd[name] = "not a directory"
    else if (!strict(t)) odd[name] = "name form"
    else { left[name] = 1; waiting++ }
  }
}
END {
  if (unfinished != "") {
    print "error an unfinished runtime swap: " unfinished " has neither COMPLETE nor UNDONE; repair it first (infra/quantvps/README.md, \"Repair an unfinished runtime swap\")"
    exit
  }
  n = 0
  for (t in bak) list[++n] = t
  for (i = 2; i <= n; i++) {
    v = list[i]
    for (j = i - 1; j >= 1 && (list[j] "") > (v ""); j--) list[j + 1] = list[j]
    list[j + 1] = v
  }
  first_keep = n - keep + 1
  if (first_keep < 1) first_keep = 1
  over = first_keep - 1
  budget = over
  if (mode == "apply") {
    budget = limit - waiting
    if (budget < 0) budget = 0
  }
  dels = 0; maxdel = ""; minkeep = ""
  for (i = 1; i <= n; i++) {
    t = list[i]
    if (i < first_keep && (t in taken)) { out[i] = "blocked " t; continue }
    if (i < first_keep && dels < budget) { out[i] = "delete " t; dels++; maxdel = t }
    else { out[i] = "keep " t; if (minkeep == "") minkeep = t }
  }
  want = (n < keep ? n : keep)
  newest = 0
  for (i = first_keep; i <= n; i++) if (out[i] == "keep " list[i]) newest++
  if (newest != want || (dels > 0 && !((maxdel "") < (minkeep "")))) { print "error plan check failed"; exit }
  for (i = 1; i <= n; i++) print out[i]
  for (name in left) print "leftover " name
  for (name in odd) print "skip " name " " odd[name]
  for (name in unmanaged) print "unmanaged " name " " unmanaged[name]
  if (strange > 0) print "strange " strange
  print "waiting " (waiting + 0)
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

# The checkout root on QuantVPS, found from the unit (WorkingDirectory is
# <checkout>/private/basic-app-named). Every remote command stops (exit 3) when the folder is not
# found or holds no live runtime tree (RUNTIME_SHA).
if [ -n "${VERTEX_WEB_DIR:-}" ]; then
  GUARD="cd '$VERTEX_WEB_DIR' && cd ../.. || exit 3"
else
  GUARD="w=\$(systemctl show $UNIT -p WorkingDirectory --value); [ -n \"\$w\" ] || exit 3; cd \"\$w/../..\" || exit 3"
fi
GUARD="LC_ALL=C; export LC_ALL; $GUARD; [ -d apps/web ] && [ -f RUNTIME_SHA ] || exit 3"
# One line per name of a managed or reported family. The shell pattern gives each name as one
# word, so a blank or a newline in a name cannot forge a line: such a name becomes a "B" line.
# The state test follows a symlink, as the unfinished-swap checks of the restart and stage
# scripts do (`[ -d ]`).
NAMES="for d in .runtime-bak-* .runtime-failed-* .runtime-prune-*; do
  [ -e \"\$d\" ] || [ -L \"\$d\" ] || continue;
  s=-; if [ -d \"\$d\" ]; then
    if [ -f \"\$d/COMPLETE\" ]; then if [ -f \"\$d/UNDONE\" ]; then s=X; else s=C; fi;
    elif [ -f \"\$d/UNDONE\" ]; then s=U; else s=I; fi; fi;
  case \"\$d\" in .runtime-bak-*) if [ \"\$s\" = C ]; then s=E; [ -s \"\$d/PATHS\" ] &&
    while IFS= read -r p; do if [ -e \"\$d/\$p\" ] || [ -L \"\$d/\$p\" ]; then s=C; break; fi; done <\"\$d/PATHS\"; fi ;; esac;
  case \"\$d\" in *[!A-Za-z0-9._-]*) echo \"B \$s\"; continue ;; esac;
  if [ -L \"\$d\" ]; then y=l; elif [ -d \"\$d\" ]; then y=d; else y=f; fi; echo \"N \$y \$s \$d\"; done"
SHA_OF="head -c 64 \"\$d/RUNTIME_SHA\" 2>/dev/null | tr -cd 0-9a-f | cut -c1-12"

# Each remote command starts with a ": <name>;" marker (a no-op) so logs and tests can name it.
LIST=": runtime-prune-list; $GUARD; echo \"@@DIR \$(pwd -P | sed \"s|^/home/[^/]*/|/home/*/|\")\";
echo \"@@LIVE \$(head -c 64 RUNTIME_SHA 2>/dev/null | tr -cd 0-9a-f | cut -c1-12)\";
echo \"@@DF \$(df -Pk . | tail -n 1 | awk '{print \$3}')\"; $NAMES;
for d in .runtime-bak-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && [ -f \"\$d/COMPLETE\" ] || continue;
  sha=\$($SHA_OF); echo \"S \${d#.runtime-bak-} \${sha:-none}\"; done;
for d in .runtime-failed-*; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; case \"\$d\" in *[!A-Za-z0-9._-]*) continue ;; esac;
  a=\$(du -sk \"\$d\" 2>/dev/null | cut -f1); echo \"U \${a:-0} \$d\"; done; echo @@END"

# Runs while the rig holds the restart lock. It lists and plans again on the host, so the renames
# never come from an earlier listing. Before the first rename it checks that every kept backup is
# on disk with COMPLETE. A rename stops when the target name exists. The loop starts no rename
# later than 15 s after the command started on the host; the rig releases the lock 60 s after it
# started ssh.
RENAME=": runtime-prune-rename; $GUARD; start=\$(date +%s);
plan=\$($NAMES | awk -v keep=$KEEP -v limit=$LIMIT -v mode=apply '$PLAN_AWK') || exit 3;
case \"\$plan\" in *plan-ok) ;; *) echo \"\$plan\"; exit 3 ;; esac;
bad=;
while read -r kind t rest; do
  [ \"\$kind\" = keep ] || continue;
  [ -d \".runtime-bak-\$t\" ] && [ ! -L \".runtime-bak-\$t\" ] && [ -f \".runtime-bak-\$t/COMPLETE\" ] || bad=\$t;
done <<EOF
\$plan
EOF
[ -z \"\$bad\" ] || { echo \"error a kept backup is not on disk: \$bad\"; exit 3; };
log=\"\${XDG_STATE_HOME:-\$HOME/.local/state}/vertex-runtime-prune.log\"; mkdir -p \"\$(dirname \"\$log\")\" 2>/dev/null; rc=0; n=0;
while read -r kind t rest; do
  [ \"\$kind\" = delete ] || continue;
  case \"\$t\" in $TS_GLOB) ;; *) rc=1; break ;; esac;
  [ \$(( \$(date +%s) - start )) -le 15 ] || { rc=1; break; };
  d=\".runtime-bak-\$t\";
  [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && [ -f \"\$d/COMPLETE\" ] && [ ! -e \"\$d/UNDONE\" ] || { rc=1; break; };
  [ ! -e \".runtime-prune-\$t\" ] && [ ! -L \".runtime-prune-\$t\" ] || { rc=1; break; };
  sha=\$($SHA_OF); mv -T -- \"\$d\" \".runtime-prune-\$t\" || { rc=1; break; };
  n=\$((n + 1)); echo \"renamed \$t \${sha:-none}\";
  { echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) delete \$t \${sha:-none}\" >>\"\$log\"; } 2>/dev/null;
done <<EOF
\$plan
EOF
{ echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) run renamed=\$n keep=$KEEP rc=\$rc\" >>\"\$log\"; } 2>/dev/null;
echo \"@@END \$rc\""

# Runs after the lock is released. Deletes renamed folders, oldest first (the glob sorts by name).
# It starts the delete of at most LIMIT folders. Only literal names of the strict form reach rm.
# The delete runs at the lowest CPU and I/O priority (ionice where it exists), so the services on
# the host keep their share of the disk; the seconds that each delete took are printed.
DELETE=": runtime-prune-delete; $GUARD; rc=0; n=0; low=; command -v ionice >/dev/null 2>&1 && low='ionice -c3';
for d in .runtime-prune-$TS_GLOB; do
  [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue;
  [ \$n -ge $LIMIT ] && break; n=\$((n + 1)); t0=\$(date +%s);
  \$low nice -n 19 rm -rf -- \"./\$d\" || rc=1;
  if [ -e \"\$d\" ] || [ -L \"\$d\" ]; then rc=1; else echo \"deleted \${d#.runtime-prune-} \$(( \$(date +%s) - t0 ))\"; fi;
done; echo \"@@END \$rc\""

# Read one listing into the globals DIR, LIVE, DF_USED, SHA[], OTHER[] and PLAN.
declare -A SHA OTHER
read_listing() {
  LISTING="$(remote "$LIST" 180 2>&1)"
  local rc=$?
  PLAN=""
  if [ $rc -ne 0 ] || [ "$(tail -n 1 <<<"$LISTING")" != "@@END" ]; then
    grep -v '^[NSUB@]' <<<"$LISTING" >&2
    return 1
  fi
  DIR="$(sed -n 's/^@@DIR //p' <<<"$LISTING" | head -n 1)"
  LIVE="$(sed -n 's/^@@LIVE //p' <<<"$LISTING" | head -n 1)"
  DF_USED="$(sed -n 's/^@@DF //p' <<<"$LISTING" | head -n 1)"
  [[ "$DF_USED" =~ ^[0-9]+$ ]] || DF_USED=0
  SHA=(); OTHER=()
  local tag a b
  while read -r tag a b; do
    case "$tag" in
      S) SHA[$a]="$b" ;;
      U) [[ "$a" =~ ^[0-9]+$ ]] || a=0; OTHER[$b]="$a" ;;
    esac
  done <<<"$LISTING"
  PLAN="$(grep '^N \|^B ' <<<"$LISTING" | plan)"
  [ "$(tail -n 1 <<<"$PLAN")" = "plan-ok" ]
}

count() { grep -c "^$1 " <<<"$PLAN" || true; }
mib() { echo "$(( ($1 + 512) / 1024 ))"; }

print_plan() {
  local kind name rest live
  while read -r kind name rest; do
    case "$kind" in
      blocked) echo "blocked $name (a .runtime-prune-$name name exists; a renamed folder is deleted by the next run, any other kind of name needs a person)" ;;
      strange) echo "skip: $name name(s) with a blank or another unusual character (never touched)" ;;
      keep | delete)
        live=""
        [ -n "$LIVE" ] && [ "${SHA[$name]:-}" = "$LIVE" ] && live=" = live"
        echo "$kind $name ${SHA[$name]:-none}$live" ;;
      leftover) echo "leftover $name (renamed by an earlier run; deleted first)" ;;
      skip) echo "skip $name ($rest)" ;;
      unmanaged)
        if [ -n "${OTHER[$name]:-}" ]; then
          echo "not managed: $name ($rest; $(mib "${OTHER[$name]}") MiB with the files it shares by hard link)"
        else
          echo "not managed: $name ($rest)"
        fi ;;
    esac
  done <<<"$PLAN"
  return 0
}

if ! read_listing; then
  reason="no complete listing of the checkout on QuantVPS"
  grep -q '^error ' <<<"$PLAN" && reason="$(sed -n 's/^error //p' <<<"$PLAN" | head -n 1)"
  echo "NOT PRUNED: $reason; nothing changed"
  exit 3
fi
BEFORE=$(( $(count keep) + $(count delete) + $(count blocked) ))
N_DELETE=$(count delete)
N_LEFT=$(count leftover)
OVER="$(sed -n 's/^over //p' <<<"$PLAN")"
USED_BEFORE="$DF_USED"

echo "prune-runtime-backups: mode=$MODE folder=$DIR live=${LIVE:-none} keep=$KEEP limit=$LIMIT"
print_plan

if [ "$APPLY" = 0 ]; then
  if [ "$OVER" -gt "$LIMIT" ]; then
    echo "note: $OVER complete backups are over the keep count; one --apply run deletes at most $LIMIT (the oldest first)"
  fi
  echo "summary mode=preview backups_before=$BEFORE delete=$N_DELETE over=$OVER leftover_folders=$N_LEFT used_before_mib=$(mib "$USED_BEFORE")"
  echo "PREVIEW: nothing deleted"
  exit 0
fi

# US trading hours: no rename and no delete on the trading host during the regular session,
# Monday to Friday 09:15 to 16:05 New York time (15 minutes before the open, as one delete call may
# run up to 15 minutes, and 5 after the close; market holidays count as trading days). A time that cannot be read counts as trading hours. The next deploy prunes.
read -r NY_DOW NY_HM _ <<<"${VERTEX_PRUNE_NY_TIME:-$(TZ=America/New_York date +'%u %H%M' 2>/dev/null)}"
in_hours=1
if [[ "${NY_DOW:-}" =~ ^[1-7]$ ]] && [[ "${NY_HM:-}" =~ ^[0-2][0-9][0-5][0-9]$ ]]; then
  if [ "$NY_DOW" -gt 5 ] || [ $((10#$NY_HM)) -lt 915 ] || [ $((10#$NY_HM)) -ge 1605 ]; then in_hours=0; fi
fi
if [ "$in_hours" = 1 ]; then
  echo "NOT PRUNED: US trading hours or unknown time (New York day ${NY_DOW:-?} time ${NY_HM:-?}); nothing deleted; a run outside 09:15-16:05 New York time on weekdays prunes"
  exit 0
fi

# The last line of a run that completed: what was deleted and what still waits.
finish_line() { # <deleted> <over> <blocked> <waiting>
  local line="PRUNED: $1 backup(s)"
  if [ $(( $2 - $3 )) -gt 0 ] || [ "$4" -gt 0 ]; then
    line="$line; more remain ($(( $2 - $3 )) over the keep count, $4 renamed folder(s) wait); the next run continues"
  fi
  [ "$3" -gt 0 ] && line="$line; $3 blocked backup(s) (see the blocked lines)"
  echo "$line"
}

if [ "$N_DELETE" -eq 0 ] && [ "$N_LEFT" -eq 0 ]; then
  # Nothing to rename and nothing to delete: no lock, no second listing.
  echo "summary mode=apply backups_before=$BEFORE renamed=0 deleted=0 backups_after=$BEFORE over_after=$OVER leftover_folders=0 used_before_mib=$(mib "$USED_BEFORE") used_after_mib=$(mib "$USED_BEFORE")"
  finish_line 0 "$OVER" "$(count blocked)" 0
  exit 0
fi

RENAMED=0
rename_ok=1
if [ "$N_DELETE" -gt 0 ]; then
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
  grep '^renamed ' <<<"$RENAME_OUT" | sed 's/^/  /'
  RENAMED=$(grep -c '^renamed ' <<<"$RENAME_OUT" || true)
  if [ $rename_rc -eq 3 ]; then
    reason="the rename step failed its precondition on QuantVPS"
    grep -q '^error ' <<<"$RENAME_OUT" && reason="$(sed -n 's/^error //p' <<<"$RENAME_OUT" | head -n 1)"
    echo "NOT PRUNED: $reason; nothing changed"
    exit 3
  fi
  if [ $rename_rc -ne 0 ] || [ "$(tail -n 1 <<<"$RENAME_OUT")" != "@@END 0" ]; then
    grep -v '^renamed \|^@@' <<<"$RENAME_OUT" >&2
    if [ "$(tail -n 1 <<<"$RENAME_OUT")" != "@@END 1" ]; then
      # No answer or a cut answer: the state on the host is unknown. Stop here.
      echo "PARTIAL: the rename step did not complete (exit $rename_rc, $RENAMED backup(s) renamed); run --apply again"
      exit 13
    fi
    # The rename command ended and reported a failed step. Renamed folders that wait are still
    # deleted below, so a rename that fails in every run does not stop the deletes.
    rename_ok=0
  fi
fi

DELETED=0
delete_ok=1
if [ "$RENAMED" -gt 0 ] || [ "$N_LEFT" -gt 0 ] || [ "$rename_ok" = 0 ]; then
  DELETE_OUT="$(remote "$DELETE" 900 2>&1)"
  delete_rc=$?
  DELETED=$(grep -c '^deleted ' <<<"$DELETE_OUT" || true)
  awk '$1 == "deleted" { print "  deleted " $2 " (" $3 " s)" }' <<<"$DELETE_OUT"
  if [ $delete_rc -ne 0 ] || [ "$(tail -n 1 <<<"$DELETE_OUT")" != "@@END 0" ]; then
    grep -v '^deleted \|^@@' <<<"$DELETE_OUT" >&2
    delete_ok=0
  fi
fi

if ! read_listing; then
  echo "PARTIAL: $RENAMED backup(s) renamed, $DELETED backup(s) deleted, but the check after the delete got no complete listing; run --apply again"
  exit 13
fi
AFTER=$(( $(count keep) + $(count delete) + $(count blocked) ))
OVER_AFTER="$(sed -n 's/^over //p' <<<"$PLAN")"
LEFT_AFTER=$(count leftover)
echo "summary mode=apply backups_before=$BEFORE renamed=$RENAMED deleted=$DELETED backups_after=$AFTER over_after=$OVER_AFTER leftover_folders=$LEFT_AFTER used_before_mib=$(mib "$USED_BEFORE") used_after_mib=$(mib "$DF_USED")"
if [ "$delete_ok" = 0 ] || [ "$rename_ok" = 0 ]; then
  what="the delete step"
  [ "$rename_ok" = 0 ] && what="a rename step"
  echo "PARTIAL: $what failed; $RENAMED backup(s) renamed, $DELETED backup(s) deleted, $LEFT_AFTER renamed folder(s) left; run --apply again"
  exit 13
fi
finish_line "$DELETED" "$OVER_AFTER" "$(count blocked)" "$(sed -n 's/^waiting //p' <<<"$PLAN")"
