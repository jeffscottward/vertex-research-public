#!/usr/bin/env bash
# Retention rule for the web build backups of the QuantVPS web app (`vertex-web.service`).
# Run it on the rig. It reaches QuantVPS through the `quantvps` SSH alias, as
# infra/quantvps/restart-when-idle.sh does. It restarts nothing and changes no unit.
#
# Three build pair families live in apps/web on QuantVPS:
#  - `bak`: `dist.bak-<TS>` with `.wrangler.bak-<TS>` (build swap on deploy; keep newest KEEP=10).
#  - `failed`: `dist.failed-<TS>` with `.wrangler.failed-<TS>` (rollback on failed health check;
#    keep newest KEEP_FAILED=2).
#  - `undeployed`: `dist.undeployed-<TS>` with `.wrangler.undeployed-<TS>` (manually parked build;
#    keep newest KEEP_UNDEPLOYED=2 unpinned pairs plus every pair with `dist.undeployed-<TS>/PINNED`).
#
# Rule:
#  - A complete pair is both names with the strict timestamp form (<TS> = 20261101T125501Z), each a
#    non-symlink directory.
#  - Pairs are ordered by the timestamp in the name (not by file time).
#  - A pinned `undeployed` pair (`dist.undeployed-<TS>/PINNED` exists) is never deleted and is
#    reported with its size; unreadable `dist.undeployed-*` dirs fail closed (`skip`).
#  - Without --apply the script only prints the plan (a preview). Nothing changes, no lock is taken.
#  - `--apply` deletes at most LIMIT=3 pairs per run across all families (priority: bak, failed,
#    undeployed; oldest first within each family). When more pairs are over the keep count, the next
#    run continues. No run deletes more.
#  - Other names are never touched: live `dist` and `.wrangler`, half-pairs, names with another form,
#    symlinks, and names with characters outside A-Z a-z 0-9 . _ -.
#
# How a pair is deleted:
#  1. Rename both folders into their family-specific staging names under the restart lock on the rig:
#     `bak` -> `dist.prune-<TS>` / `.wrangler.prune-<TS>`,
#     `failed` -> `dist.prune-failed-<TS>` / `.wrangler.prune-failed-<TS>`,
#     `undeployed` -> `dist.prune-undeployed-<TS>` / `.wrangler.prune-undeployed-<TS>`.
#     The restart script selects its rollback source with `dist.bak-<TS>`, so a renamed folder is
#     never a rollback candidate. Non-`bak` source trees must be writable before renaming.
#  2. Release the lock. Delete the renamed folders in priority order (bak, failed, undeployed),
#     oldest pair first, at most LIMIT=3 per run. Each family guards only its own `.wrangler.<fam>-<TS>`.
#  3. List again and report what is left.
#  A run that stops at any point is finished by a later `--apply` run: renamed folders count toward
#  LIMIT and are deleted first.
#
# Lock: the restart lock, ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock on the rig
# (the same path as restart-when-idle.sh, stage-build.sh and stage-runtime.sh). Only step 1 holds it,
# without waiting. While it is held the Nautilus backtest worker claims nothing, and a restart or a
# stage that starts exits 8.
# Record: step 1 appends to ${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-prune.log on QuantVPS
# (best effort: a failed append does not stop the run). Historical 4-field lines are implicitly `bak`.
# Lines:
#   <UTC time> delete <TS> <sha|none> <bak|failed|undeployed>
#   <UTC time> finish <TS> none <bak|failed|undeployed>
#   <UTC time> run renamed=<n> keep=<KEEP> keep_failed=<KEEP_FAILED> keep_undeployed=<KEEP_UNDEPLOYED> rc=<0|1>
#
# Usage: infra/quantvps/prune-web-backups.sh [--dry-run | --apply]
#   (no flag)  preview: print the plan; change nothing. `--dry-run` means the same.
#   --apply    rename and delete up to LIMIT pairs of the plan.
# Exit codes: 0 preview printed, or the run did its work (the last line says when more pairs
#   remain); 2 usage; 3 precondition failed (no answer over ssh, folder not found, no live build,
#   incomplete listing, plan check failed, a kept or pinned pair is not on disk), nothing changed;
#   8 the restart lock is held, nothing changed; 11 the lock file could not be opened or flock
#   failed, nothing changed; 13 partial or unknown: the rename, the delete or the check after it did
#   not complete (run --apply again). After a failed rename step the delete step still runs for the
#   pairs that were renamed, so exit 13 can follow a run that deleted pairs. Codes 2, 3, 8 and 11
#   match restart-when-idle.sh; 13 is not used by it.
# Test hooks: VERTEX_WEB_SSH (remote command runner, gets one shell command string), VERTEX_WEB_DIR,
#   VERTEX_RESTART_LOCK. `--plan <file>` is the pure rule used by the tests: it reads a listing
#   and prints the plan lines; with `--apply` it prints the plan of an apply run.
# Text formats:
#   Listing (from QuantVPS): `@@DIR <folder>` (a user name in /home/<user>/ is printed as *),
#   `@@LIVE <sha>`, `@@DF <used kB>`; `N <type> <name>` for each dist.* and .wrangler.* backup,
#   failed, undeployed or renamed name made only of the characters A-Z a-z 0-9 . _ - (type
#   d = directory, p = pinned undeployed directory, u = unreadable undeployed directory,
#   l = symlink, f = other); `B` for each such name with any other character (never touched);
#   `S <fam> <TS> <kB> <sha|none>` for each complete pair; `U <kB> <name>` for each staged folder;
#   `@@END` as the last line.
#   Plan (from the rule): `keep <TS>` (`bak`) or `keep <TS> <fam>` (`failed`/`undeployed`),
#   `pinned <TS> undeployed`, `delete <TS>[ <fam>]`, `blocked <TS>[ <fam>]`, `finish <TS>[ <fam>]`,
#   `leftover <name>`, `skip <name> <reason>`, `strange <n>`, `waiting <n>`, `over <n>`,
#   `over_bak <n>`, `over_failed <n>`, `over_undeployed <n>`, `error <text>`, and `plan-ok`.
set -uo pipefail

UNIT="vertex-web"
KEEP=10
KEEP_FAILED=2
KEEP_UNDEPLOYED=2
LIMIT=3
FAMILIES="bak:$KEEP:prune failed:$KEEP_FAILED:prune-failed undeployed:$KEEP_UNDEPLOYED:prune-undeployed"
TS_GLOB='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'

# The rule (see "Text formats" above). Variables: keep, keep_failed, keep_undeployed, limit,
# mode (preview|apply). A preview marks every unpinned pair over the keep count; an apply plan
# allocates global budget = max(0, limit - waiting) in order bak -> failed -> undeployed.
# The program contains no single quote: it travels inside a single-quoted remote command.
PLAN_AWK='
BEGIN {
  fams[1] = "bak";        keep_of["bak"] = keep + 0
  fams[2] = "failed";     keep_of["failed"] = keep_failed + 0
  fams[3] = "undeployed"; keep_of["undeployed"] = keep_undeployed + 0
  np = 0
  pf[++np] = "dist.prune-failed-";          pf_fam[np] = "failed";     pf_half[np] = "d"; pf_st[np] = "p"
  pf[++np] = ".wrangler.prune-failed-";     pf_fam[np] = "failed";     pf_half[np] = "w"; pf_st[np] = "p"
  pf[++np] = "dist.prune-undeployed-";      pf_fam[np] = "undeployed"; pf_half[np] = "d"; pf_st[np] = "p"
  pf[++np] = ".wrangler.prune-undeployed-"; pf_fam[np] = "undeployed"; pf_half[np] = "w"; pf_st[np] = "p"
  pf[++np] = "dist.prune-";                 pf_fam[np] = "bak";        pf_half[np] = "d"; pf_st[np] = "p"
  pf[++np] = ".wrangler.prune-";            pf_fam[np] = "bak";        pf_half[np] = "w"; pf_st[np] = "p"
  pf[++np] = "dist.bak-";                   pf_fam[np] = "bak";        pf_half[np] = "d"; pf_st[np] = "s"
  pf[++np] = ".wrangler.bak-";              pf_fam[np] = "bak";        pf_half[np] = "w"; pf_st[np] = "s"
  pf[++np] = "dist.failed-";                pf_fam[np] = "failed";     pf_half[np] = "d"; pf_st[np] = "s"
  pf[++np] = ".wrangler.failed-";           pf_fam[np] = "failed";     pf_half[np] = "w"; pf_st[np] = "s"
  pf[++np] = "dist.undeployed-";            pf_fam[np] = "undeployed"; pf_half[np] = "d"; pf_st[np] = "s"
  pf[++np] = ".wrangler.undeployed-";       pf_fam[np] = "undeployed"; pf_half[np] = "w"; pf_st[np] = "s"
}
function strict(t) { return t ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z$/ }
function sort_arr(a, n,    i, j, v) {
  for (i = 2; i <= n; i++) {
    v = a[i]
    for (j = i - 1; j >= 1 && (a[j] "") > (v ""); j--) a[j + 1] = a[j]
    a[j + 1] = v
  }
}
$0 == "B" { strange++; next }
$1 != "N" { next }
NF != 3 || $0 != "N " $2 " " $3 || $3 !~ /^[A-Za-z0-9._-]+$/ { strange++; next }
{
  type = $2; name = $3; idx = 0
  for (i = 1; i <= np; i++) {
    if (index(name, pf[i]) == 1) { idx = i; break }
  }
  if (idx == 0) next
  fam = pf_fam[idx]; half = pf_half[idx]; st = pf_st[idx]
  t = substr(name, length(pf[idx]) + 1)
  k = fam ":" t
  if (st == "s" && half == "d") { if (strict(t)) dany[k] = 1 }
  else if (st == "s" && half == "w") { if (strict(t)) wany[k] = 1 }
  else if (st == "p" && half == "d") { if (strict(t)) taken[k] = 1 }
  else if (st == "p" && half == "w") { if (strict(t)) { taken[k] = 1; takenw[k] = 1 } }
  if (fam == "undeployed" && half == "d" && st == "s" && type == "u") {
    odd[name] = "not readable; cannot check PINNED"
    next
  }
  is_dir = (type == "d" || (fam == "undeployed" && half == "d" && st == "s" && type == "p"))
  if (!is_dir) { odd[name] = "not a directory"; next }
  if (!strict(t)) { odd[name] = "name form"; next }
  if (st == "s" && half == "d") {
    dist[k] = 1
    if (type == "p") pin[k] = 1
  } else if (st == "s" && half == "w") {
    wr[k] = 1
  } else if (st == "p" && half == "d") {
    pd[k] = 1; left[name] = 1; gone[k] = 1
  } else if (st == "p" && half == "w") {
    left[name] = 1; gone[k] = 1
  }
}
END {
  waiting = 0
  for (k in dist) {
    split(k, p, ":"); fam = p[1]; t = p[2]
    if (!(k in wr)) odd["dist." fam "-" t] = "no .wrangler." fam " pair"
  }
  for (k in wr) {
    if (k in dist) continue
    split(k, p, ":"); fam = p[1]; t = p[2]
    if ((k in pd) && !(k in takenw) && !(k in dany)) { fin[k] = 1; waiting++ }
    else if (k in taken) odd[".wrangler." fam "-" t] = "a renamed name with this timestamp exists; remove one by hand"
    else odd[".wrangler." fam "-" t] = "no dist." fam " pair"
  }
  for (k in gone) if (!(k in wany)) waiting++
  rem_budget = limit - waiting
  if (rem_budget < 0) rem_budget = 0
  over_total = 0; nout = 0
  for (fi = 1; fi <= 3; fi++) {
    fam = fams[fi]
    sfx = (fam == "bak" ? "" : " " fam)
    nunp = 0; npin = 0; nall = 0
    delete unp; delete pinned_arr; delete all_ts; delete st_of
    for (k in dist) {
      if (!(k in wr)) continue
      split(k, p, ":")
      if (p[1] != fam) continue
      t = p[2]
      all_ts[++nall] = t
      if (k in pin) pinned_arr[++npin] = t
      else unp[++nunp] = t
    }
    sort_arr(unp, nunp)
    sort_arr(all_ts, nall)
    fk = nunp - keep_of[fam] + 1
    if (fk < 1) fk = 1
    over_f = fk - 1
    over_of[fam] = over_f
    over_total += over_f
    budget = (mode == "apply" ? rem_budget : over_f)
    dels = 0; maxdel = ""; minkeep = ""
    for (i = 1; i <= nunp; i++) {
      t = unp[i]; k = fam ":" t
      if (i < fk && (k in taken)) { st_of[t] = "blocked"; continue }
      if (i < fk && dels < budget) { st_of[t] = "delete"; dels++; maxdel = t }
      else { st_of[t] = "keep"; if (minkeep == "") minkeep = t }
    }
    if (mode == "apply") rem_budget -= dels
    want = (nunp < keep_of[fam] ? nunp : keep_of[fam])
    newest = 0
    for (i = fk; i <= nunp; i++) if (st_of[unp[i]] == "keep") newest++
    pin_ok = 1
    for (i = 1; i <= npin; i++) if (pinned_arr[i] in st_of) pin_ok = 0
    if (!pin_ok || newest != want || (dels > 0 && !((maxdel "") < (minkeep "")))) {
      print "error plan check failed"; exit
    }
    for (i = 1; i <= nall; i++) {
      t = all_ts[i]; k = fam ":" t
      if (k in pin) out_lines[++nout] = "pinned " t sfx
      else out_lines[++nout] = st_of[t] " " t sfx
    }
  }
  for (i = 1; i <= nout; i++) print out_lines[i]
  for (fi = 1; fi <= 3; fi++) {
    fam = fams[fi]
    sfx = (fam == "bak" ? "" : " " fam)
    nfin = 0; delete fin_ts
    for (k in fin) {
      split(k, p, ":")
      if (p[1] == fam) fin_ts[++nfin] = p[2]
    }
    sort_arr(fin_ts, nfin)
    for (i = 1; i <= nfin; i++) print "finish " fin_ts[i] sfx
  }
  nleft = 0; for (name in left) left_arr[++nleft] = name
  sort_arr(left_arr, nleft)
  for (i = 1; i <= nleft; i++) print "leftover " left_arr[i]
  nodd = 0; for (name in odd) odd_arr[++nodd] = name
  sort_arr(odd_arr, nodd)
  for (i = 1; i <= nodd; i++) print "skip " odd_arr[i] " " odd[odd_arr[i]]
  if (strange > 0) print "strange " strange
  print "waiting " waiting
  print "over " over_total
  print "over_bak " over_of["bak"]
  print "over_failed " over_of["failed"]
  print "over_undeployed " over_of["undeployed"]
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

plan() { awk -v keep="$KEEP" -v keep_failed="$KEEP_FAILED" -v keep_undeployed="$KEEP_UNDEPLOYED" -v limit="$LIMIT" -v mode="$MODE" "$PLAN_AWK"; }

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
# One line per name of a managed or staged family. The shell pattern gives each name as one word,
# so a blank or a newline in a name cannot forge a line: such a name becomes a "B" line.
NAMES="for d in dist.bak-* .wrangler.bak-* dist.failed-* .wrangler.failed-* dist.undeployed-* .wrangler.undeployed-* dist.prune-* .wrangler.prune-*; do
  [ -e \"\$d\" ] || [ -L \"\$d\" ] || continue;
  case \"\$d\" in *[!A-Za-z0-9._-]*) echo B; continue ;; esac;
  if [ -L \"\$d\" ]; then y=l;
  elif [ -d \"\$d\" ]; then
    case \"\$d\" in
      dist.undeployed-*)
        if [ ! -r \"\$d\" ] || [ ! -x \"\$d\" ]; then y=u;
        elif [ -e \"\$d/PINNED\" ] || [ -L \"\$d/PINNED\" ]; then y=p;
        else y=d; fi ;;
      *) y=d ;;
    esac;
  else y=f; fi;
  echo \"N \$y \$d\"; done"
SHA_OF="head -c 64 \"\$d/DEPLOYED_SHA\" 2>/dev/null | tr -cd 0-9a-f | cut -c1-12"

# Each remote command starts with a ": <name>;" marker (a no-op) so logs and tests can name it.
LIST=": prune-list; $GUARD; echo \"@@DIR \$(pwd -P | sed \"s|^/home/[^/]*/|/home/*/|\")\";
echo \"@@LIVE \$(head -c 64 DEPLOYED_SHA 2>/dev/null | tr -cd 0-9a-f | cut -c1-12)\";
echo \"@@DF \$(df -Pk . | tail -n 1 | awk '{print \$3}')\"; $NAMES;
for fam in bak failed undeployed; do
  for d in dist.\"\$fam\"-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; t=\${d#dist.\"\$fam\"-};
    [ -d \".wrangler.\$fam-\$t\" ] && [ ! -L \".wrangler.\$fam-\$t\" ] || continue; sha=\$($SHA_OF);
    a=\$(du -sk \"\$d\" 2>/dev/null | cut -f1); b=\$(du -sk \".wrangler.\$fam-\$t\" 2>/dev/null | cut -f1);
    echo \"S \$fam \$t \$(( \${a:-0} + \${b:-0} )) \${sha:-none}\"; done;
done;
for d in dist.prune-* .wrangler.prune-*; do
  [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; case \"\$d\" in *[!A-Za-z0-9._-]*) continue ;; esac;
  a=\$(du -sk \"\$d\" 2>/dev/null | cut -f1); echo \"U \${a:-0} \$d\"; done; echo @@END"

# Runs while the rig holds the restart lock. It lists and plans again on the host, so the renames
# never come from an earlier listing. Before the first rename it checks that every kept and pinned
# pair is on disk. Families execute in priority order (bak, failed, undeployed), running finish
# repairs before new deletes within each family. Per-pair errors set rc=1 and continue; only the
# 15 s loop budget breaks early. A concurrent PINNED marker on undeployed skips cleanly (rc=0).
RENAME=": prune-rename; $GUARD; start=\$(date +%s);
plan=\$($NAMES | awk -v keep=$KEEP -v keep_failed=$KEEP_FAILED -v keep_undeployed=$KEEP_UNDEPLOYED -v limit=$LIMIT -v mode=apply '$PLAN_AWK') || exit 3;
case \"\$plan\" in *plan-ok) ;; *) echo \"\$plan\"; exit 3 ;; esac;
bad=;
while read -r kind t pfam rest; do
  case \"\$kind\" in keep|pinned) ;; *) continue ;; esac;
  [ -n \"\$pfam\" ] || pfam=bak;
  [ -d \"dist.\$pfam-\$t\" ] && [ ! -L \"dist.\$pfam-\$t\" ] && [ -d \".wrangler.\$pfam-\$t\" ] && [ ! -L \".wrangler.\$pfam-\$t\" ] || bad=\"\$pfam \$t\";
done <<EOF
\$plan
EOF
[ -z \"\$bad\" ] || { echo \"error a kept pair is not on disk: \$bad\"; exit 3; };
log=\"\${XDG_STATE_HOME:-\$HOME/.local/state}/vertex-web-prune.log\"; mkdir -p \"\$(dirname \"\$log\")\" 2>/dev/null; rc=0; n=0; timed_out=0;
for spec in $FAMILIES; do
  [ \"\$timed_out\" = 1 ] && break;
  fam=\${spec%%:*}; pfx=\${spec##*:};
  for want_kind in finish delete; do
    [ \"\$timed_out\" = 1 ] && break;
    while read -r kind t pfam rest; do
      [ \"\$kind\" = \"\$want_kind\" ] || continue;
      [ -n \"\$pfam\" ] || pfam=bak;
      [ \"\$pfam\" = \"\$fam\" ] || continue;
      case \"\$t\" in $TS_GLOB) ;; *) rc=1; continue ;; esac;
      [ \$(( \$(date +%s) - start )) -le 15 ] || { rc=1; timed_out=1; break; };
      sha=;
      if [ \"\$kind\" = delete ]; then
        d=\"dist.\$fam-\$t\"; w=\".wrangler.\$fam-\$t\";
        [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && [ -d \"\$w\" ] && [ ! -L \"\$w\" ] || { rc=1; continue; };
        [ ! -e \"dist.\$pfx-\$t\" ] && [ ! -L \"dist.\$pfx-\$t\" ] && [ ! -e \".wrangler.\$pfx-\$t\" ] && [ ! -L \".wrangler.\$pfx-\$t\" ] || { rc=1; continue; };
        if [ \"\$fam\" = undeployed ]; then
          [ -r \"\$d\" ] && [ -x \"\$d\" ] || { rc=1; continue; };
          if [ -e \"\$d/PINNED\" ] || [ -L \"\$d/PINNED\" ]; then continue; fi;
        fi;
        if [ \"\$fam\" != bak ]; then
          if [ ! -r \"\$d\" ] || [ ! -w \"\$d\" ] || [ ! -x \"\$d\" ] || [ ! -r \"\$w\" ] || [ ! -w \"\$w\" ] || [ ! -x \"\$w\" ] || [ -n \"\$(find \"\$d\" \"\$w\" -type d \\( ! -readable -o ! -writable -o ! -executable \\) 2>&1 | head -n 1)\" ]; then
            rc=1; continue;
          fi;
        fi;
        sha=\$($SHA_OF);
        mv -T -- \"\$d\" \"dist.\$pfx-\$t\" || { rc=1; continue; };
        mv -T -- \"\$w\" \".wrangler.\$pfx-\$t\" || { rc=1; continue; };
        n=\$((n + 1));
        if [ \"\$fam\" = bak ]; then echo \"renamed \$t \${sha:-none}\"; else echo \"renamed \$t \${sha:-none} \$fam\"; fi;
      else
        [ ! -e \"dist.\$fam-\$t\" ] && [ ! -L \"dist.\$fam-\$t\" ] || { rc=1; continue; };
        [ -d \"dist.\$pfx-\$t\" ] && [ ! -L \"dist.\$pfx-\$t\" ] && [ -d \".wrangler.\$fam-\$t\" ] && [ ! -L \".wrangler.\$fam-\$t\" ] || { rc=1; continue; };
        [ ! -e \".wrangler.\$pfx-\$t\" ] && [ ! -L \".wrangler.\$pfx-\$t\" ] || { rc=1; continue; };
        mv -T -- \".wrangler.\$fam-\$t\" \".wrangler.\$pfx-\$t\" || { rc=1; continue; };
        if [ \"\$fam\" = bak ]; then echo \"finished \$t\"; else echo \"finished \$t \$fam\"; fi;
      fi;
      echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) \$kind \$t \${sha:-none} \$fam\" >>\"\$log\" 2>/dev/null;
    done <<EOF
\$plan
EOF
  done;
done;
echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) run renamed=\$n keep=$KEEP keep_failed=$KEEP_FAILED keep_undeployed=$KEEP_UNDEPLOYED rc=\$rc\" >>\"\$log\" 2>/dev/null;
echo \"@@END \$rc\""

# Runs after the lock is released. Deletes renamed folders in priority order (bak, failed,
# undeployed), oldest pair first, at most LIMIT pairs total. Only literal names of the strict form
# reach rm. Each family skips any timestamp whose own `.wrangler.<fam>-<TS>` still exists.
DELETE=": prune-delete; $GUARD; rc=0; n=0;
for spec in $FAMILIES; do
  [ \$n -ge $LIMIT ] && break;
  fam=\${spec%%:*}; pfx=\${spec##*:};
  for t in \$({ for d in dist.\"\$pfx\"-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && echo \"\${d#dist.\"\$pfx\"-}\"; done; for d in .wrangler.\"\$pfx\"-$TS_GLOB; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] && echo \"\${d#.wrangler.\"\$pfx\"-}\"; done; } | sort -u); do
    [ -e \".wrangler.\$fam-\$t\" ] || [ -L \".wrangler.\$fam-\$t\" ] && continue;
    [ \$n -ge $LIMIT ] && break; n=\$((n + 1));
    for d in \"dist.\$pfx-\$t\" \".wrangler.\$pfx-\$t\"; do [ -d \"\$d\" ] && [ ! -L \"\$d\" ] || continue; rm -rf -- \"./\$d\" || rc=1; done;
    if [ ! -e \"dist.\$pfx-\$t\" ] && [ ! -L \"dist.\$pfx-\$t\" ] && [ ! -e \".wrangler.\$pfx-\$t\" ] && [ ! -L \".wrangler.\$pfx-\$t\" ]; then
      if [ \"\$fam\" = bak ]; then echo \"deleted \$t\"; else echo \"deleted \$t \$fam\"; fi;
    fi;
  done;
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
  local tag a b c d
  while read -r tag a b c d; do
    case "$tag" in
      S) [[ "$c" =~ ^[0-9]+$ ]] || c=0; SIZE["$a:$b"]="$c"; SHA["$a:$b"]="$d" ;;
      U) [[ "$a" =~ ^[0-9]+$ ]] || a=0; OTHER["$b"]="$a" ;;
    esac
  done <<<"$LISTING"
  PLAN="$(grep '^N \|^B$' <<<"$LISTING" | plan)"
  [ "$(tail -n 1 <<<"$PLAN")" = "plan-ok" ]
}

count() { grep -c "^$1 " <<<"$PLAN" || true; }
plan_val() { sed -n "s/^$1 //p" <<<"$PLAN" | head -n 1; }

pinned_mib() {
  local kb=0 kind t fam rest
  while read -r kind t fam rest; do
    [ "$kind" = pinned ] || continue
    [ -n "$fam" ] || fam=bak
    kb=$((kb + ${SIZE["$fam:$t"]:-0}))
  done <<<"$PLAN"
  echo "$(( (kb + 512) / 1024 ))"
}

print_plan() {
  local kind name rest fam label live
  while read -r kind name rest; do
    case "$kind" in
      blocked)
        fam="${rest%% *}"
        [ -n "$fam" ] || fam=bak
        label="$name"
        [ "$fam" != bak ] && label="dist.$fam-$name"
        echo "blocked $label (a renamed name with this timestamp exists; remove one of them by hand)" ;;
      strange) echo "skip: $name name(s) with a blank or another unusual character (never touched)" ;;
      keep | delete | pinned)
        fam="${rest%% *}"
        [ -n "$fam" ] || fam=bak
        label="$name"
        [ "$fam" != bak ] && label="dist.$fam-$name"
        live=""
        [ -n "$LIVE" ] && [ "${SHA["$fam:$name"]:-}" = "$LIVE" ] && live=" = live"
        echo "$kind $label ${SHA["$fam:$name"]:-none} $(mib "${SIZE["$fam:$name"]:-0}")$live" ;;
      finish)
        fam="${rest%% *}"
        [ -n "$fam" ] || fam=bak
        echo "leftover .wrangler.$fam-$name (second half of an interrupted rename)" ;;
      leftover) echo "leftover $name $(mib "${OTHER[$name]:-0}")" ;;
      skip) echo "skip $name ($rest)" ;;
    esac
  done <<<"$PLAN"
  return 0
}

print_summary() {
  local mode="$1"
  if [ "$mode" = preview ]; then
    echo "summary mode=preview pairs_before=$PAIRS_BEFORE pinned=$PINNED_BEFORE pinned_mib=$PINNED_MIB_BEFORE delete=$N_DELETE over=$OVER bak_over=$OVER_BAK failed_over=$OVER_FAILED undeployed_over=$OVER_UNDEPLOYED leftover_folders=$N_LEFT used_before_mib=$(( (USED_BEFORE + 512) / 1024 ))"
  else
    echo "summary mode=apply pairs_before=$PAIRS_BEFORE renamed=$2 deleted=$3 pairs_after=$4 pinned=$5 pinned_mib=$6 over_after=$7 bak_over_after=$8 failed_over_after=$9 undeployed_over_after=${10} leftover_folders=${11} used_before_mib=$(( (USED_BEFORE + 512) / 1024 )) used_after_mib=$(( (${12} + 512) / 1024 ))"
  fi
}

if ! read_listing; then
  reason="no complete listing of apps/web on QuantVPS"
  grep -q '^error ' <<<"$PLAN" && reason="$(sed -n 's/^error //p' <<<"$PLAN" | head -n 1)"
  echo "NOT PRUNED: $reason; nothing changed"
  exit 3
fi
PINNED_BEFORE=$(count pinned)
PINNED_MIB_BEFORE=$(pinned_mib)
PAIRS_BEFORE=$(( $(count keep) + PINNED_BEFORE + $(count delete) + $(count blocked) ))
N_DELETE=$(count delete)
N_FINISH=$(count finish)
N_LEFT=$(( $(count leftover) + N_FINISH ))
OVER="$(plan_val over)"
OVER_BAK="$(plan_val over_bak)"
OVER_FAILED="$(plan_val over_failed)"
OVER_UNDEPLOYED="$(plan_val over_undeployed)"
USED_BEFORE="$DF_USED"

echo "prune-web-backups: mode=$MODE folder=$DIR keep=$KEEP keep_failed=$KEEP_FAILED keep_undeployed=$KEEP_UNDEPLOYED limit=$LIMIT"
print_plan

if [ "$APPLY" = 0 ]; then
  if [ "$OVER" -gt "$LIMIT" ]; then
    echo "note: $OVER complete pairs are over the keep count; one --apply run deletes up to $LIMIT (bak first, then failed, then undeployed)"
  fi
  print_summary preview
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
  print_summary apply 0 0 "$PAIRS_BEFORE" "$PINNED_BEFORE" "$PINNED_MIB_BEFORE" "$OVER" "$OVER_BAK" "$OVER_FAILED" "$OVER_UNDEPLOYED" 0 "$USED_BEFORE"
  finish_line 0 "$OVER" "$(count blocked)" 0
  exit 0
fi

RENAMED=0
rename_ok=1
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
    if [ "$(tail -n 1 <<<"$RENAME_OUT")" != "@@END 1" ]; then
      # No answer or a cut answer: the state on the host is unknown. Stop here.
      echo "PARTIAL: the rename step did not complete (exit $rename_rc, $RENAMED pair(s) renamed); run --apply again"
      exit 13
    fi
    # The rename command ended and reported a failed step. Renamed pairs that wait are still
    # deleted below, so a rename that fails in every run does not stop the deletes.
    rename_ok=0
  fi
fi

DELETED=0
delete_ok=1
if [ "$RENAMED" -gt 0 ] || [ "$N_LEFT" -gt 0 ] || [ "$rename_ok" = 0 ]; then
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
PINNED_AFTER=$(count pinned)
PINNED_MIB_AFTER=$(pinned_mib)
PAIRS_AFTER=$(( $(count keep) + PINNED_AFTER + $(count delete) + $(count blocked) ))
OVER_AFTER="$(plan_val over)"
OVER_BAK_AFTER="$(plan_val over_bak)"
OVER_FAILED_AFTER="$(plan_val over_failed)"
OVER_UNDEPLOYED_AFTER="$(plan_val over_undeployed)"
LEFT_AFTER=$(( $(count leftover) + $(count finish) ))
print_summary apply "$RENAMED" "$DELETED" "$PAIRS_AFTER" "$PINNED_AFTER" "$PINNED_MIB_AFTER" "$OVER_AFTER" "$OVER_BAK_AFTER" "$OVER_FAILED_AFTER" "$OVER_UNDEPLOYED_AFTER" "$LEFT_AFTER" "$DF_USED"
if [ "$delete_ok" = 0 ] || [ "$rename_ok" = 0 ]; then
  what="the delete step"
  if [ "$rename_ok" = 0 ] && [ "$delete_ok" = 0 ]; then
    what="both rename and delete steps"
  elif [ "$rename_ok" = 0 ]; then
    what="a rename step"
  fi
  echo "PARTIAL: $what failed; $RENAMED pair(s) renamed, $DELETED pair(s) deleted, $LEFT_AFTER renamed folder(s) left; run --apply again"
  exit 13
fi
finish_line "$DELETED" "$OVER_AFTER" "$(count blocked)" "$(plan_val waiting)"
