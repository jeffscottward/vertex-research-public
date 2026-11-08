#!/usr/bin/env bash
# Start or stop a throwaway PostgreSQL 17.6 for CI on the rig runner.
# The rig runner user has no Docker access, so this runs the same server version
# as infra/docker/postgres.compose.yml from user-space binaries in the runner temp dir.
# psql comes from the host (postgresql-libs). It applies the same roles and databases and listens only on 127.0.0.1.
set -euo pipefail

PG_VERSION=17.6.0-beta.15
PG_SHA256=8d14394e1092b8bc659943966a5d1cd19b1bcc34ab02e135ed7c51fe60ba9d12
PG_URL="https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-${PG_VERSION}.tgz"
PORT="${VERTEX_POSTGRES_PORT:-55582}"
# How often `up` moves to another port when the bind fails with "Address already in use".
BIND_ATTEMPTS=5
BASE="${RUNNER_TEMP:-/tmp}/vertex-ci-postgres"
CACHE="${RUNNER_TOOL_CACHE:-${BASE}}/embedded-postgres-${PG_VERSION}"
# Keep data and logs outside RUNNER_TEMP so a cancelled job leaves a pidfile the next job can stop.
BIN="${CACHE}/package/native/bin"
# Test data only: when /dev/shm has room the data directory lives there (DATA
# then is a symlink to it), so DROP DATABASE cleanup is not slowed by btrfs
# fsyncs while parallel runners share the disk.
use_port() {
  PORT="$1"
  BASE="${CACHE}/run-${PORT}"
  DATA="${BASE}/data"
  SHM_DATA="/dev/shm/vertex-ci-postgres-$(id -u)-${PORT}"
}
use_port "${PORT}"
SHM_MIN_KIB=$((2 * 1024 * 1024))

install_binaries() {
  # The marker is written last: a job cancelled during the install never leaves
  # a half-extracted cache that later jobs would reuse.
  if [[ -f "${CACHE}/.installed" ]]; then return; fi
  rm -rf "${CACHE}/package"
  mkdir -p "${CACHE}"
  local archive="${CACHE}/pg.tgz"
  curl --fail --silent --show-error --location --output "${archive}" "${PG_URL}"
  echo "${PG_SHA256}  ${archive}" | sha256sum --check --quiet
  tar -xzf "${archive}" -C "${CACHE}"
  (cd "${CACHE}/package" && node scripts/hydrate-symlinks.js)
  rm -f "${archive}"
  touch "${CACHE}/.installed"
}

# Stop the server of one data directory, then remove the directory. pg_ctl signals
# the PID in postmaster.pid without checking it, and a stale file can name a
# reused PID, so signal only a live postgres process.
stop_server() {
  local data="$1" pid=""
  if [[ -f "${data}/postmaster.pid" ]]; then pid="$(head -n 1 "${data}/postmaster.pid")"; fi
  if [[ -n "${pid}" && "$(cat "/proc/${pid}/comm" 2>/dev/null || true)" == postgres ]]; then
    "${BIN}/pg_ctl" --pgdata="${data}" --mode=immediate --wait stop || true
  fi
  if [[ -L "${data}" ]]; then rm -rf "$(readlink -f "${data}")"; fi
  rm -rf "${data}"
}

# Put the data directory in /dev/shm when it is writable and has room; else on disk.
make_data_directory() {
  local free_kib
  free_kib="$(df --output=avail -k /dev/shm 2>/dev/null | tail -n 1 | tr -d ' ' || true)"
  if [[ "${free_kib}" =~ ^[0-9]+$ ]] && (( free_kib >= SHM_MIN_KIB )) &&
    rm -rf "${SHM_DATA}" && mkdir -m 700 "${SHM_DATA}" 2>/dev/null; then
    ln -s "${SHM_DATA}" "${DATA}"
    echo "PostgreSQL data directory: ${SHM_DATA} (tmpfs)"
  else
    mkdir -p "${DATA}"
    echo "PostgreSQL data directory: ${DATA} (disk)"
  fi
}

# CI only: a runner runs one job at a time and CACHE is in its own tool cache, so
# every server under CACHE belongs to an earlier, cancelled job of this runner.
# The workflow may move to another port when one is busy, so stop them all here.
stop_leftovers() {
  if [[ -z "${RUNNER_TOOL_CACHE:-}" || ! -x "${BIN}/pg_ctl" ]]; then return; fi
  local pidfile
  for pidfile in "${CACHE}"/run-*/data/postmaster.pid; do
    [[ -f "${pidfile}" ]] || continue
    stop_server "${pidfile%/postmaster.pid}"
  done
}

# CI-only and test data only: no crash safety is needed for a throwaway server.
# Never use these settings for a database that holds real data.
CI_DURABILITY_OFF="-c fsync=off -c synchronous_commit=off -c full_page_writes=off"

# Publish a moved port to the later workflow steps (tests and `down`). Later
# GITHUB_ENV lines override earlier ones.
publish_port() {
  local old="$1"
  if [[ -z "${GITHUB_ENV:-}" ]]; then return; fi
  {
    echo "VERTEX_POSTGRES_PORT=${PORT}"
    if [[ -n "${DATABASE_URL:-}" ]]; then echo "DATABASE_URL=${DATABASE_URL/:${old}\//:${PORT}/}"; fi
    if [[ -n "${TEST_DATABASE_URL:-}" ]]; then echo "TEST_DATABASE_URL=${TEST_DATABASE_URL/:${old}\//:${PORT}/}"; fi
  } >>"${GITHUB_ENV}"
}

# Initialise and start a server on PORT. Return 3 when the port is taken: a
# listener, or a non-listening socket (for example an outgoing connection that
# got this port as its local port) that only the bind itself detects.
start_on_port() {
  if [[ -n "$(ss -Hltn "sport = :${PORT}")" ]]; then return 3; fi
  # `set -e` does not apply inside a function called from `||`; fail explicitly.
  mkdir -p "${BASE}" || return 1
  make_data_directory || return 1
  local pwfile="${BASE}/pw" log="${BASE}/postgres.log" offset=0
  printf '%s\n' postgres-bootstrap-local-only >"${pwfile}"
  "${BIN}/initdb" --pgdata="${DATA}" --username=postgres --pwfile="${pwfile}" \
    --auth=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null || return 1
  rm -f "${pwfile}"
  if [[ -f "${log}" ]]; then offset="$(stat -c %s "${log}")"; fi
  if "${BIN}/pg_ctl" --pgdata="${DATA}" --log="${log}" --wait start \
    -o "-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=${BASE} -c max_prepared_transactions=10 ${CI_DURABILITY_OFF}"; then
    return 0
  fi
  if tail -c "+$((offset + 1))" "${log}" | grep -q "Address already in use"; then
    stop_server "${DATA}"
    return 3
  fi
  return 1
}

up() {
  stop_leftovers
  install_binaries
  down
  local first="${PORT}" attempt status
  for ((attempt = 1; ; attempt++)); do
    status=0
    start_on_port || status=$?
    if ((status == 0)); then break; fi
    if ((status != 3)); then exit "${status}"; fi
    if ((attempt >= BIND_ATTEMPTS)); then
      echo "Port ${PORT} is already in use on this host, after ${attempt} ports from ${first}. Stop the other server and rerun." >&2
      exit 1
    fi
    echo "Port ${PORT} is in use; trying $((PORT + 100))."
    use_port "$((PORT + 100))"
  done
  if [[ "${PORT}" != "${first}" ]]; then publish_port "${first}"; fi
  PGPASSWORD=postgres-bootstrap-local-only psql --host=127.0.0.1 --port="${PORT}" \
    --username=postgres --dbname=postgres --set=ON_ERROR_STOP=1 --quiet <<'SQL'
CREATE DATABASE darkfactory_test_maintenance;
\connect darkfactory_test_maintenance
CREATE ROLE darkfactory_test_runner LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD 'darkfactory-test-only';
CREATE ROLE darkfactory_app LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD 'darkfactory-app-local-only';
-- Read-only login for certified semantic-layer SQL (migration 0056_semantic_layer grants it CONNECT and
-- SELECT). No membership in any other role.
CREATE ROLE vertex_semantic_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD 'semantic-reader-test-only';
CREATE DATABASE darkfactory_dev OWNER darkfactory_app;
REVOKE CONNECT ON DATABASE darkfactory_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE darkfactory_dev TO darkfactory_app;
REVOKE CONNECT ON DATABASE darkfactory_test_maintenance FROM PUBLIC;
GRANT CONNECT ON DATABASE darkfactory_test_maintenance TO darkfactory_test_runner;
ALTER ROLE postgres NOLOGIN;
SQL
  PGPASSWORD=darkfactory-test-only psql --host=127.0.0.1 --port="${PORT}" \
    --username=darkfactory_test_runner --dbname=darkfactory_test_maintenance --command='SELECT 1' >/dev/null
  echo "PostgreSQL ${PG_VERSION} ready on 127.0.0.1:${PORT}"
}

down() {
  stop_server "${DATA}"
}

case "${1:-}" in
  install) install_binaries ;;
  up) up ;;
  down) down ;;
  *) echo "usage: $0 install|up|down" >&2; exit 2 ;;
esac
