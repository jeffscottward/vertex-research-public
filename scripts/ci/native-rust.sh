#!/usr/bin/env bash
# Run the Rust test suites of the native services.
#
# services/kernel-bridge holds the only Cargo.lock. Its dependency graph contains
# the path crates services/contracts/rust (vertex-contracts) and
# services/execution-kernel (vertex-execution-kernel), so one locked run tests all
# three crates. The toolchain comes from services/kernel-bridge/rust-toolchain.toml.
#
# The kernel-bridge build script requires a reviewed build identity. This script
# computes the kernel source digest with the same algorithm as build.rs and uses
# a build ID that marks the build as an unreviewed CI test build. The result is a
# test binary only: it is never a release artifact.
#
# The kernel-bridge parity test needs a real contract bundle. This script
# generates it from the current sources (bun run vertex:contracts:generate) and
# pins it with an independent sha256sum. Requires installed node_modules.
#
# services/ibkr-history has no Cargo.lock and is not tested here.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
services="${root}/services"

# Same algorithm as services/kernel-bridge/build.rs:
# SHA256("vertex-kernel-source-v1\0" || sorted(path || NUL || sha256(file))).
source_sha256="$(
  cd "${services}" && {
    printf '%s\n' execution-kernel/Cargo.toml contracts/rust/Cargo.toml
    find execution-kernel/src contracts/rust/src -type f -name '*.rs'
  } | LC_ALL=C sort | python3 -c '
import hashlib, sys
digest = hashlib.sha256(b"vertex-kernel-source-v1\0")
for name in sys.stdin.read().split():
    digest.update(name.encode() + b"\0" + hashlib.sha256(open(name, "rb").read()).digest())
print(digest.hexdigest())
'
)"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bundle="${work}/bundle.json"
(cd "${root}" && bun --no-env-file scripts/vertex-contracts.ts generate --output "${bundle}" >/dev/null)

export VERTEX_KERNEL_BUILD_ID="ci-unreviewed-test"
export VERTEX_KERNEL_SOURCE_SHA256="${source_sha256}"
VERTEX_KERNEL_CONTRACT_SOURCE_SHA256="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["sourceDigest"])' "${bundle}")"
export VERTEX_KERNEL_CONTRACT_SOURCE_SHA256
export VERTEX_KERNEL_TEST_BUNDLE="${bundle}"
VERTEX_KERNEL_TEST_BUNDLE_SHA256="$(sha256sum "${bundle}" | cut -d' ' -f1)"
export VERTEX_KERNEL_TEST_BUNDLE_SHA256

# Build outside the checkout, so later lint and format steps never see build output.
export CARGO_TARGET_DIR="${work}/target"

cd "${services}/kernel-bridge"
cargo test --locked -p vertex-contracts -p vertex-execution-kernel -p vertex-kernel-bridge
