"""Run only via an explicit reviewed configuration: python -m vertex_host --config PATH."""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
import signal
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vertex-host")
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_run(args.config))
    except KeyboardInterrupt:
        return 130
    except Exception:
        # Library/source paths, credentials, artifact bodies and HTTP errors do
        # not leak to unattended service logs. Private readiness has safe codes.
        print("vertex-host unavailable; explicit configuration, authority or capability failed", file=sys.stderr)
        return 78


async def _run(path: Path) -> int:
    from vertex_contracts import ContractAuthority
    from vertex_control import ClientConfig, ControlClient
    from .cache import HostUnavailable
    from .config import FileCredentialResolver, load_config, read_pinned
    from .lifecycle import HostRuntime

    if sys.platform != "linux" or sys.version_info[:3] != (3, 12, 11):
        raise HostUnavailable("reviewed-linux-python-3-12-11-required")
    config = load_config(path)
    bundle = read_pinned(config["contractBundle"], 16_777_216)
    authority = ContractAuthority(bundle, config["contractBundle"]["sha256"])
    credentials = FileCredentialResolver(config["credentials"])
    control = config["control"]
    if type(control) is not dict or set(control) != {"origin", "credentialRef", "timeoutSeconds", "maximumRequestBytes", "maximumResponseBytes"}:
        raise HostUnavailable("explicit-control-transport-policy-required")
    client = ControlClient(ClientConfig(origin=control["origin"], credential_ref=control["credentialRef"],
        timeout_seconds=control["timeoutSeconds"], max_request_bytes=control["maximumRequestBytes"],
        max_response_bytes=control["maximumResponseBytes"]), credentials, authority)
    kernel = None
    if config["kernel"] is not None:
        from vertex_kernel_bridge import KernelBridge, ReviewedKernelConfig
        selected = config["kernel"]
        if type(selected) is not dict or set(selected) != {"libraryPath", "librarySha256", "buildId", "kernelSourceSha256", "contractSourceSha256", "bundleSha256"}:
            raise HostUnavailable("explicit-reviewed-kernel-identity-required")
        if selected["bundleSha256"] != config["contractBundle"]["sha256"]:
            raise HostUnavailable("kernel-contract-authority-mismatch")
        kernel = KernelBridge.load(config=ReviewedKernelConfig(library_path=Path(selected["libraryPath"]),
            library_sha256=selected["librarySha256"], build_id=selected["buildId"],
            kernel_source_sha256=selected["kernelSourceSha256"], contract_source_sha256=selected["contractSourceSha256"],
            bundle_sha256=selected["bundleSha256"]), contract_bundle=bundle)
    host = HostRuntime(config=config, contracts=authority, control=client, secret_resolver=credentials, kernel=kernel)
    loop = asyncio.get_running_loop()
    for event in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(event, host.request_shutdown)
    try:
        async with client:
            await host.run()
    finally:
        for event in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(event)
        # Host drain normally closes this. Loading/startup failure must not keep
        # an authority usable; close is idempotent and never dlcloses live frames.
        if kernel is not None:
            kernel.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
