#!/usr/bin/env bash
# Give one CI job a private TMPDIR on tmpfs (/dev/shm) when it has room.
# Test files that fsync (FileHandle.sync) wait for other jobs' writeback on the
# shared btrfs disk; on tmpfs fsync returns at once. Tmpfs pages count against
# the runner MemoryMax; `up` checks only tmpfs free space (SHM_MIN_KIB) and else keeps TMPDIR.
#   up    create the dir, export TMPDIR through GITHUB_ENV, print the choice
#   down  remove this job's dir (run it in an `if: always()` step)
# Env: JOB_TMPDIR_SHM (tmpfs root, default /dev/shm; tests override it).
set -euo pipefail

SHM="${JOB_TMPDIR_SHM:-/dev/shm}"
# 4 GiB free: an estimate; tests remove their temp dirs (PR #140), and `down`
# logs the size left at job end. The margin also leaves room for the
# PostgreSQL tmpfs data dir (2 GiB) of the same job.
SHM_MIN_KIB="${JOB_TMPDIR_MIN_KIB:-$((4 * 1024 * 1024))}"
RUNNER="${RUNNER_NAME:-local}"
# Keep the path short: tests create AF_UNIX sockets under TMPDIR (108-byte
# limit, with nested acceptance clones). /dev/shm/vct-rig-vertex-4 (25 chars)
# is shorter than the runner default /var/lib/gh-runner/<runner>/_tmp. A runner
# runs one job at a time, so one dir per runner is private to the current job.
DIR="${SHM}/vct-${RUNNER//[^A-Za-z0-9_-]/_}"

up() {
  # Anything at DIR is a leftover of a killed or cancelled job of this runner.
  rm -rf "${DIR}" 2>/dev/null || true
  local free_kib
  free_kib="$(df --output=avail -k "${SHM}" 2>/dev/null | tail -n 1 | tr -d ' ' || true)"
  if [[ -w "${SHM}" && "${free_kib}" =~ ^[0-9]+$ ]] && (( free_kib >= SHM_MIN_KIB )) &&
    mkdir -m 700 "${DIR}" 2>/dev/null; then
    [[ -n "${GITHUB_ENV:-}" ]] && echo "TMPDIR=${DIR}" >>"${GITHUB_ENV}"
    echo "TMPDIR: ${DIR} (tmpfs, ${free_kib} KiB free; job ${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1} ${GITHUB_JOB:-}${JOB_INDEX:+ #${JOB_INDEX}})"
  else
    echo "TMPDIR: ${TMPDIR:-/tmp} (unchanged; ${SHM} not writable or < ${SHM_MIN_KIB} KiB free)"
  fi
}

down() {
  if [[ -d "${DIR}" ]]; then echo "Size at job end: $(du -sk "${DIR}" | cut -f1) KiB"; fi
  rm -rf "${DIR}"
  echo "Removed ${DIR}"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
