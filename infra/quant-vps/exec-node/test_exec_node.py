"""Tests for exec_node.py and the Vertex-owned exec node runtime files.

Run: python3 -W ignore infra/quant-vps/exec-node/test_exec_node.py
The compose test runs real `docker compose config` when Docker Compose is installed (QuantVPS, rig).
"""

import copy
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exec_node as en  # noqa: E402

RUNTIME = HERE / "runtime"
OLD = "/opt/vertex-quant"
NEW = "/opt/vertex-exec-node"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compose_config(root: str) -> dict:
    """Shape of `docker compose config --format json` for the exec node (values are fakes)."""
    services = {}
    for svc in en.SERVICES:
        services[svc] = {
            "image": f"img/{svc}",
            "networks": {"prototype": None},
            "environment": {"SECRET_LIKE": "s3cr3t-value"},
        }
    services["postgres"]["volumes"] = [{"type": "bind", "source": f"{root}/data/postgres", "target": "/var/lib/x"}]
    services["portfolio-ui"]["environment"]["VERTEX_QUANT_HOST_ROOT"] = root
    services["caddy"]["env_file"] = [{"path": f"{root}/.env", "required": True}]
    services["nautilus-trader"]["build"] = {"context": root, "dockerfile": "nautilus/Dockerfile"}
    return {
        "name": en.PROJECT,
        "services": services,
        "networks": {"prototype": {"name": en.PROJECT + "_prototype", "driver": "bridge"}},
        "volumes": {"caddy_data": {"name": en.PROJECT + "_caddy_data"}, "caddy_config": {"name": en.PROJECT + "_caddy_config"}},
    }


HASHES = {svc: f"h-{svc}" for svc in en.SERVICES}


def new_hashes() -> dict:
    changed = dict(HASHES)
    for svc in ("postgres", "portfolio-ui", "caddy", "nautilus-trader"):
        changed[svc] = "x-" + svc
    return changed


class GateTests(unittest.TestCase):
    def test_only_path_changes_pass_and_names_are_identical(self):
        result = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW)
        self.assertTrue(result["ok"], result["problems"])
        self.assertEqual(result["project"], "ibkr-nautilus-exec-node")
        self.assertEqual(result["networks"], {"prototype": "ibkr-nautilus-exec-node_prototype"})
        self.assertEqual(result["containers"]["ib-gateway"], "ibkr-nautilus-exec-node-ib-gateway-1")
        self.assertIn("ib-gateway", result["kept"])
        self.assertIn("services.postgres.volumes[0].source", result["pathChanges"])

    def test_project_name_change_blocks(self):
        new = compose_config(NEW)
        new["name"] = "vertex-exec-node"
        new["networks"]["prototype"]["name"] = "vertex-exec-node_prototype"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertFalse(result["ok"])
        self.assertTrue(any("project name" in p for p in result["problems"]))
        self.assertIn("container names differ", result["problems"])
        self.assertIn("network names differ", result["problems"])

    def test_volume_rename_blocks(self):
        new = compose_config(NEW)
        new["volumes"]["caddy_data"]["name"] = "other_caddy_data"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertIn("volume names differ", result["problems"])

    def test_container_name_override_blocks(self):
        new = compose_config(NEW)
        new["services"]["ib-gateway"]["container_name"] = "ib-gateway"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertIn("container names differ", result["problems"])

    def test_non_path_value_change_blocks_without_printing_the_value(self):
        new = compose_config(NEW)
        new["services"]["watchdog"]["environment"]["SECRET_LIKE"] = "other-secret-value"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertFalse(result["ok"])
        text = json.dumps(result)
        self.assertIn("services.watchdog.environment.SECRET_LIKE", text)
        self.assertNotIn("other-secret-value", text)
        self.assertNotIn("s3cr3t-value", text)

    def test_image_change_blocks(self):
        new = compose_config(NEW)
        new["services"]["ib-gateway"]["image"] = "gnzsnz/ib-gateway:latest"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertIn("images differ", result["problems"])

    def test_gateway_recreate_blocks(self):
        hashes = new_hashes()
        hashes["ib-gateway"] = "changed"
        result = en.gate(compose_config(OLD), compose_config(NEW), HASHES, hashes, OLD, NEW)
        self.assertFalse(result["ok"])
        self.assertTrue(any("ib-gateway config hash" in p for p in result["problems"]))

    def test_missing_service_blocks(self):
        new = compose_config(NEW)
        del new["services"]["netdata"]
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertFalse(result["ok"])

    def test_unpinned_project_name_must_match(self):
        result = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW,
                         {"old": en.PROJECT, "new": "vertex-exec-node"})
        self.assertFalse(result["ok"])
        self.assertTrue(any("without -p" in p for p in result["problems"]))

    def test_running_gateway_hash_must_match_the_new_root(self):
        ok = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW,
                     None, {"ib-gateway": HASHES["ib-gateway"]})
        self.assertTrue(ok["ok"], ok["problems"])
        bad = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW,
                      None, {"ib-gateway": "stale-label"})
        self.assertIn("running ib-gateway config hash differs from the new root", bad["problems"])
        missing = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW,
                          None, {"ib-gateway": None})
        self.assertFalse(missing["ok"])

    def test_retired_env_is_ignored_in_the_old_root_and_refused_in_the_new(self):
        old = compose_config(OLD)
        old["services"]["nautilus-trader"]["environment"]["CHARAN_TRADE_INTENTS_ENABLED"] = "false"
        old["services"]["nautilus-trader"]["environment"]["PORTFOLIO_AUTH_PASSWORD"] = "retired-pw-value"
        old["services"]["watchdog"]["environment"]["CHARAN_LIVE_TRANSMIT_ENABLED"] = "false"
        result = en.gate(old, compose_config(NEW), HASHES, new_hashes(), OLD, NEW)
        self.assertTrue(result["ok"], result["problems"])
        new = compose_config(NEW)
        new["services"]["watchdog"]["environment"]["CHARAN_LIVE_TRANSMIT_ENABLED"] = "retired-flag-value"
        result = en.gate(compose_config(OLD), new, HASHES, new_hashes(), OLD, NEW)
        self.assertFalse(result["ok"])
        self.assertIn("services.watchdog.environment.CHARAN_LIVE_TRANSMIT_ENABLED", " ".join(result["problems"]))
        self.assertNotIn("retired-flag-value", json.dumps(result))

    def test_portfolio_ui_keeps_its_login(self):
        old = compose_config(OLD)
        old["services"]["portfolio-ui"]["environment"]["PORTFOLIO_AUTH_PASSWORD"] = "pw-value"
        result = en.gate(old, compose_config(NEW), HASHES, new_hashes(), OLD, NEW)
        self.assertFalse(result["ok"])
        self.assertIn("services.portfolio-ui.environment.PORTFOLIO_AUTH_PASSWORD", " ".join(result["problems"]))

    def test_removed_files_in_the_new_root_block(self):
        result = en.gate(compose_config(OLD), compose_config(NEW), HASHES, new_hashes(), OLD, NEW,
                         None, None, ["src/signal-chart-view.ts: present (removed)"])
        self.assertFalse(result["ok"])
        self.assertIn("new root src/signal-chart-view.ts: present (removed)", result["problems"])

    def test_parse_hashes(self):
        self.assertEqual(en.parse_hashes("redis abc\npostgres def\n\n"), {"redis": "abc", "postgres": "def"})


@unittest.skipUnless(shutil.which("docker") and subprocess.run(
    ["docker", "compose", "version"], capture_output=True).returncode == 0, "docker compose not installed")
class RealComposeTests(unittest.TestCase):
    """Real `docker compose config` on the owned compose file in two roots: only paths may differ."""

    def make_root(self, base: Path, name: str) -> Path:
        root = base / name
        root.mkdir()
        shutil.copy(RUNTIME / "docker-compose.yml", root / "docker-compose.yml")
        (root / ".env").write_text(f"VERTEX_QUANT_HOST_ROOT={root}\nTWS_USERID=fake\nIBKR_TRADING_MODE=live\n")
        return root

    def test_gate_passes_for_the_owned_compose_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = self.make_root(Path(tmp), "old")
            new = self.make_root(Path(tmp), "new")
            result = en.run_gate(en.Runner(), str(old), str(new), check_running=False)
            self.assertTrue(result["ok"], result["problems"])
            self.assertEqual(result["volumes"], en.EXPECTED_VOLUMES)
            self.assertIn("ib-gateway", result["kept"])
            self.assertIn("postgres", result["recreate"])


class EnvTests(unittest.TestCase):
    def test_rewrite_replaces_the_one_host_root_line(self):
        text = "A=1\nVERTEX_QUANT_HOST_ROOT=/opt/vertex-quant\nB=two\n"
        self.assertEqual(en.rewrite_env(text, OLD, NEW), "A=1\nVERTEX_QUANT_HOST_ROOT=/opt/vertex-exec-node\nB=two\n")

    def test_rewrite_refuses_missing_or_duplicate_key(self):
        with self.assertRaises(en.ExecNodeError):
            en.rewrite_env("A=1\n", OLD, NEW)
        with self.assertRaises(en.ExecNodeError):
            en.rewrite_env("VERTEX_QUANT_HOST_ROOT=a\nVERTEX_QUANT_HOST_ROOT=b\n", OLD, NEW)

    def test_rewrite_refuses_other_old_root_lines_and_hides_values(self):
        with self.assertRaises(en.ExecNodeError) as ctx:
            en.rewrite_env("VERTEX_QUANT_HOST_ROOT=x\nTOKEN_PATH=/opt/vertex-quant/secret-value\n", OLD, NEW)
        self.assertIn("line(s) 2", str(ctx.exception))
        self.assertNotIn("secret-value", str(ctx.exception))


class ManifestTests(unittest.TestCase):
    def test_load_manifest(self):
        digest = "a" * 64
        self.assertEqual(en.load_manifest(f"{digest}  scripts/x.sh\n\n"), {"scripts/x.sh": digest})

    def test_load_manifest_rejects_unsafe_paths_and_bad_lines(self):
        for text in ("a" * 64 + "  ../x\n", "a" * 64 + "  /etc/x\n", "zz  x\n", "a" * 64 + " x\n",
                     "a" * 64 + "  x\n" + "b" * 64 + "  x\n"):
            with self.assertRaises(en.ExecNodeError):
                en.load_manifest(text)

    def test_committed_manifest_is_valid_and_covers_the_runtime(self):
        manifest = en.load_manifest((HERE / "frozen-manifest.sha256").read_text())
        self.assertGreater(len(manifest), 400)
        for rel in ("docker-compose.yml", "nautilus/Dockerfile", "portfolio-ui/server.mjs", "deploy/Caddyfile",
                    "scripts/request-ibkr-2fa-until-ready.sh", "watchdog/watchdog.py", ".env.example"):
            self.assertIn(rel, manifest)
        self.assertFalse(any(en.excluded(rel.split("/")[0]) for rel in manifest))


class OwnedRuntimeTests(unittest.TestCase):
    """The owned overlay is the frozen runtime except the documented path changes and one reader fix."""

    manifest = en.load_manifest((HERE / "frozen-manifest.sha256").read_text())
    unchanged = (
        "watchdog/Dockerfile",
        "watchdog/__init__.py",
        "watchdog/requirements.txt",
        "nautilus/arm_cli.py",
        "scripts/request-ibkr-2fa-until-ready.sh",
        "scripts/ibkr-account-heartbeat.sh",
        "scripts/ibkr-account-heartbeat-pm2.sh",
        "scripts/lib.sh",
        "scripts/load-env-defaults.sh",
        "scripts/healthcheck.sh",
    )
    path_changed = ("scripts/nautilus-arm.sh", "scripts/nautilus_health_alert.py")
    # The live tree paired the new snapshot script with an old reader (TypeError on
    # market_values_timeout_seconds), so the 2FA readiness check always failed. The owned reader is
    # vertex-quant commit ef1b38b (merged to its main), a superset of the frozen one. It also
    # records each position's tradingClass (not in the v1 JSON shape) for the class sidecar below.
    reader_fix = {"nautilus/ibkr_account.py": "d65e0d32247bee9e0734cf35eaadbfa66e30caa4ed6655d1d50f5d344794e9c3"}

    # State-machine audit 2026-11-03 (card sma-vertex-arm-killswitch): a kill switch deletes the
    # owner arm record (gate and watchdog), so removing the kill switch never re-arms the node.
    # Test: test_arm_killswitch.py. arm_gate.py also carries the options-only, defined-risk order
    # policy in place_order (owner rule 2026-11-04: options only, risk always defined, max loss per
    # order <= 2% NLV, one working close per contract). Test: test_order_policy.py.
    # Order policy v3 (owner decision 2026-11-11, card vertex-golive-spread-gate): defined-risk vertical
    # spreads as one BAG order, behind NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS (off by default;
    # off is the v2 behaviour), with per-name and total open-risk caps. Test: test_order_policy_v3.py.
    # The frozen close transmit script called client.placeOrder directly (gate bypass); the owned
    # refusal, now scripts/position_close.py (card move-close-off-charan-scripts), refuses every run.
    # Test: test_transmit_disabled.py.
    # scripts/ibkr_account_snapshot.py also writes ibkr-account-classes.json (conId/tradingClass per
    # position) beside each snapshot, which keeps the v1 shape that staged protection checks key by
    # key. arm_gate.py needs it to tell option classes apart. Test: test_order_policy.py.
    safety_fix = {
        "watchdog/watchdog.py": "215229586079adeb034d912f955d39770d6817dcff8acbb347b4fdb1fe96afe9",
        "nautilus/arm_gate.py": "18506c58530db4a79901087ffce38ccfacb7cd03e67d30c561833e2e119147f4",
        "scripts/ibkr_account_snapshot.py": "42265a912c610a676c604692437d68612642884f6d1e20f7de3d82a87d35d2f4",
        "scripts/position_close.py": "c4052f9678f89bf0304807897c4c656674a117fc2e86fbc768bd97af50ecad7c",
    }

    # Owner 2026-11-04 (card remove-charan-signals): the node has no trade-intent source. run_live.py
    # no longer imports nautilus/charan.py or polls the CHARAN Discord signal feed; the node only runs
    # health, IBKR connection state, the arm gate and protection. Test: test_no_signal_intake.py.
    # docker-compose.yml drops every CHARAN_* variable (nautilus-trader, watchdog, portfolio-ui) and the
    # portfolio-ui login that nautilus-trader received only for the retired intake's 2FA trigger. The gate
    # ignores those keys in the old root (en.retired_env). watchdog.py drops the CHARAN_* settings and the
    # CHARAN_LIVE_TRANSMIT_ENABLED term of live_broker_enabled (safety_fix digest above).
    # docker-compose.yml also passes the order policy v3 switch and the total open-risk cap (with its
    # source) to nautilus-trader; all three are empty by default (card vertex-golive-spread-gate).
    signal_removal = {
        "nautilus/run_live.py": "75fba631b5bc5e495fc3dba20911def6822551ece986a7f8d74117914b2a5bed",
        "docker-compose.yml": "16480d28b43aa65eb40d8e804c7479194f6df8f1eb305c341f6e54eadc8f2c37",
        # Card move-close-off-charan-scripts: /api/position-close runs scripts/position_close.py; the
        # rescan request write for the retired intake (nothing reads it) is gone.
        "portfolio-ui/server.mjs": "2639b8126c88c2fd5fe896a01968832ad51ed97e83e07484ebece20cb3f73110",
    }

    def test_compose_has_no_retired_environment(self):
        text = (RUNTIME / "docker-compose.yml").read_text()
        self.assertNotIn("charan", text.lower())
        self.assertNotIn("PORTFOLIO_AUTH", text.split("  nautilus-trader:")[1].split("  watchdog:")[0])

    def test_owned_runtime_names_no_signal_intake(self):
        # run_live.py keeps only the legacy config key name (test_no_signal_intake.py).
        for path in sorted(RUNTIME.rglob("*")):
            if path.is_file() and path != RUNTIME / "nautilus" / "run_live.py":
                self.assertNotIn("charan", path.read_text(errors="replace").lower(), str(path))

    def test_removed_files_are_frozen_files(self):
        self.assertEqual(len(set(en.REMOVED)), len(en.REMOVED))
        for rel in en.REMOVED:
            self.assertIn(rel, self.manifest, rel)
            self.assertNotIn(rel, en.owned_files(RUNTIME), rel)

    def test_live_dependencies_are_not_removed(self):
        # portfolio-ui's market refresh runs these (see en.REMOVED).
        for rel in ("src/signal-event-parser.ts", "src/update-market-data.ts", "portfolio-ui/server.mjs"):
            self.assertIn(rel, self.manifest, rel)
            self.assertNotIn(rel, en.REMOVED, rel)

    def test_signal_removal_files_are_pinned(self):
        for rel, digest in self.signal_removal.items():
            self.assertEqual(en.sha256_file(RUNTIME / rel), digest, rel)
            self.assertNotEqual(digest, self.manifest[rel], rel)

    def test_safety_fix_files_are_pinned(self):
        for rel, digest in self.safety_fix.items():
            self.assertEqual(en.sha256_file(RUNTIME / rel), digest, rel)
            # scripts/position_close.py is a new owned path, not a frozen file.
            self.assertNotEqual(digest, self.manifest.get(rel), rel)

    def test_reader_fix_matches_the_snapshot_script(self):
        for rel, digest in self.reader_fix.items():
            self.assertEqual(en.sha256_file(RUNTIME / rel), digest)
            self.assertNotEqual(digest, self.manifest[rel])
        reader = (RUNTIME / "nautilus" / "ibkr_account.py").read_text()
        script = (RUNTIME / "scripts" / "ibkr_account_snapshot.py").read_text()
        self.assertIn("client_options[\"market_values_timeout_seconds\"]", script)
        self.assertIn("market_values_timeout_seconds", reader)
        frozen_names = {"mask_account", "account_fingerprint", "IbkrOrderCancelClient", "sanitize_account_references",
                        "IbkrAccountSnapshotClient"}
        for name in frozen_names:
            self.assertRegex(reader, rf"\n(def|class) {name}\b", name)

    def test_unchanged_files_equal_the_frozen_bytes(self):
        for rel in self.unchanged:
            self.assertEqual(en.sha256_file(RUNTIME / rel), self.manifest[rel], rel)

    def test_path_changed_files_differ_only_by_the_root(self):
        for rel in self.path_changed:
            text = (RUNTIME / rel).read_text()
            self.assertNotEqual(en.sha256_file(RUNTIME / rel), self.manifest[rel])
            self.assertEqual(sha(text.replace(NEW, OLD).encode()), self.manifest[rel], rel)

    def test_overlay_is_exactly_the_listed_files(self):
        listed = set(self.unchanged) | set(self.path_changed) | set(self.reader_fix) | set(self.safety_fix) | set(self.signal_removal) | {"watchdog/.gitkeep"}
        self.assertEqual(set(en.owned_files(RUNTIME)), listed)

    def test_compose_keeps_the_project_name(self):
        first = (RUNTIME / "docker-compose.yml").read_text().splitlines()[0]
        self.assertEqual(first, "name: ibkr-nautilus-exec-node")

    def test_no_owned_file_names_the_old_root(self):
        for base in (RUNTIME, HERE / "systemd", HERE / "consumers"):
            for path in base.rglob("*"):
                if path.is_file():
                    self.assertNotIn(OLD, path.read_text(errors="replace"), str(path))

    def test_units_and_consumers_name_the_new_root(self):
        node = (HERE / "systemd" / "vertex-nautilus-node.service").read_text()
        self.assertIn(f"WorkingDirectory={NEW}\n", node)
        self.assertIn("docker compose -p ibkr-nautilus-exec-node up -d --no-build --no-recreate nautilus-trader", node)
        forced = (HERE / "consumers" / "ibkr-monitor-forced-2fa.sh").read_text()
        self.assertIn(f"cd {NEW} ||", forced)
        for unit in en.UNITS:
            self.assertTrue((HERE / "systemd" / unit).is_file(), unit)

    def test_repo_consumers_name_the_new_root(self):
        recovery = (HERE.parent / "recovery" / "vertex_ibkr_recovery.py").read_text()
        self.assertIn(f'SCRIPT = "{NEW}/scripts/request-ibkr-2fa-until-ready.sh"', recovery)
        self.assertIn(f'SCRIPT_CWD = "{NEW}"', recovery)
        self.assertNotIn(OLD, recovery)
        self.assertIn(f'ROOT = "{NEW}"', (HERE.parent / "status" / "collect.py").read_text())
        for rel in en.CONSUMERS:
            self.assertTrue((HERE.parent / rel).is_file(), rel)


class TwoFactorScriptTests(unittest.TestCase):
    """IBKR readiness is the account snapshot only; Nautilus health never decides it."""

    def run_check(self, snapshot_exit: int, health_exit: int) -> subprocess.CompletedProcess:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        shutil.copytree(RUNTIME / "scripts", Path(tmp) / "scripts")
        env = {
            "PATH": os.environ["PATH"],
            "HOME": tmp,
            "IBKR_2FA_TEST_MODE": "true",
            "IBKR_2FA_SKIP_LOAD_ENV": "true",
            "IBKR_2FA_NOTIFY_ENABLED": "0",
            "IBKR_2FA_ACCOUNT_SNAPSHOT_COMMAND": f"exit {snapshot_exit}",
            "IBKR_2FA_HEALTHCHECK_COMMAND": f"exit {health_exit}",
        }
        return subprocess.run(
            ["bash", str(Path(tmp) / "scripts" / "request-ibkr-2fa-until-ready.sh"), "--check-only"],
            env=env, capture_output=True, text=True, timeout=60,
        )

    def test_snapshot_ok_and_nautilus_down_is_ready(self):
        result = self.run_check(0, 1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("non-blocking", result.stdout + result.stderr)

    def test_snapshot_failure_is_not_ready_even_with_nautilus_ok(self):
        self.assertNotEqual(self.run_check(1, 0).returncode, 0)


class StageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.source = self.tmp / "opt" / "vertex-quant"
        self.target = self.tmp / "opt" / "vertex-exec-node"
        files = {
            "docker-compose.yml": "old compose\n",
            "scripts/run.sh": "#!/bin/sh\n",
            "scripts/owned.sh": "frozen owned\n",
            "portfolio-ui/server.mjs": "server\n",
        }
        for rel, text in files.items():
            (self.source / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.source / rel).write_text(text)
        (self.source / "portfolio-ui" / "node_modules").mkdir()
        (self.source / "portfolio-ui" / "node_modules" / "dep.js").write_text("dep\n")
        os.symlink("server.mjs", self.source / "portfolio-ui" / "link.mjs")
        (self.source / ".env").write_text(f"A=1\nVERTEX_QUANT_HOST_ROOT={self.source}\n")
        (self.source / ".env.bak-20261026").write_text("old secret\n")
        (self.source / "data" / "postgres").mkdir(parents=True)
        (self.source / "data" / "postgres" / "PG_VERSION").write_text("16\n")
        (self.source / ".git").mkdir()
        (self.source / "backups").mkdir()
        self.manifest = {rel: sha(text.encode()) for rel, text in files.items()}
        self.bundle = self.tmp / "bundle"
        (self.bundle / "exec-node" / "runtime" / "scripts").mkdir(parents=True)
        (self.bundle / "exec-node" / "runtime" / "scripts" / "owned.sh").write_text("vertex owned\n")

    def test_stage_builds_the_new_root_without_state_or_secret_backups(self):
        result = en.stage(self.source, self.target, self.bundle, self.manifest, "abc123")
        self.assertEqual(result["ownedFiles"], 1)
        self.assertEqual((self.target / "scripts" / "owned.sh").read_text(), "vertex owned\n")
        self.assertEqual((self.target / "scripts" / "run.sh").read_text(), "#!/bin/sh\n")
        self.assertEqual((self.target / "portfolio-ui" / "node_modules" / "dep.js").read_text(), "dep\n")
        self.assertTrue((self.target / "portfolio-ui" / "link.mjs").is_symlink())
        for absent in ("data", ".git", "backups", ".env.bak-20261026"):
            self.assertFalse((self.target / absent).exists(), absent)
        env = self.target / ".env"
        self.assertEqual(env.read_text(), f"A=1\nVERTEX_QUANT_HOST_ROOT={self.target}\n")
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        release = json.loads((self.target / en.RELEASE_FILE).read_text())
        self.assertEqual(release["vertexResearchCommit"], "abc123")
        self.assertEqual(list(release["ownedFiles"]), ["scripts/owned.sh"])
        self.assertTrue((self.source / "data" / "postgres" / "PG_VERSION").is_file(), "source state untouched")
        self.assertEqual(en.verify_staged(self.target, self.manifest, en.owned_files(self.bundle / "exec-node" / "runtime")), [])

    def test_stage_leaves_portfolio_ui_state_behind(self):
        (self.source / "portfolio-ui" / "data").mkdir()
        (self.source / "portfolio-ui" / "data" / "KILL_SWITCH").write_text("engaged\n")
        en.stage(self.source, self.target, self.bundle, self.manifest, "a")
        self.assertFalse((self.target / "portfolio-ui" / "data").exists())
        self.assertTrue((self.source / "portfolio-ui" / "data" / "KILL_SWITCH").is_file())

    def test_stage_is_idempotent(self):
        en.stage(self.source, self.target, self.bundle, self.manifest, "a")
        en.stage(self.source, self.target, self.bundle, self.manifest, "b")
        self.assertEqual(json.loads((self.target / en.RELEASE_FILE).read_text())["vertexResearchCommit"], "b")
        leftovers = [p.name for p in self.target.parent.iterdir() if ".stage-" in p.name or ".prev-" in p.name]
        self.assertEqual(leftovers, [])

    def test_stage_refuses_a_drifted_source(self):
        (self.source / "scripts" / "run.sh").write_text("edited\n")
        with self.assertRaises(en.ExecNodeError) as ctx:
            en.stage(self.source, self.target, self.bundle, self.manifest, "a")
        self.assertIn("scripts/run.sh: changed", str(ctx.exception))
        self.assertFalse(self.target.exists())

    def test_stage_leaves_removed_files_behind(self):
        removed = {"scripts/approve_charan_drafts.py": "retired\n", "src/signal-chart-view.ts": "retired\n"}
        for rel, text in removed.items():
            (self.source / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.source / rel).write_text(text)
            self.manifest[rel] = sha(text.encode())
        result = en.stage(self.source, self.target, self.bundle, self.manifest, "a")
        self.assertEqual(result["frozenFiles"], len(self.manifest))
        for rel in removed:
            self.assertFalse((self.target / rel).exists(), rel)
            self.assertTrue((self.source / rel).is_file(), "frozen source untouched")
        self.assertTrue((self.target / "scripts" / "run.sh").is_file())
        overlay = en.owned_files(self.bundle / "exec-node" / "runtime")
        self.assertEqual(en.verify_staged(self.target, self.manifest, overlay), [])
        (self.target / "src" / "signal-chart-view.ts").parent.mkdir(exist_ok=True)
        (self.target / "src" / "signal-chart-view.ts").write_text("retired\n")
        self.assertEqual(en.verify_staged(self.target, self.manifest, overlay),
                         ["src/signal-chart-view.ts: present (removed)"])

    def test_stage_refuses_after_the_switch(self):
        (self.target / "data").mkdir(parents=True)
        with self.assertRaises(en.ExecNodeError):
            en.stage(self.source, self.target, self.bundle, self.manifest, "a")


class PlanTests(unittest.TestCase):
    move_data = [en.MOVE, f"{OLD}/data", f"{NEW}/data", "required", "strict"]

    def test_switch_never_names_the_gateway_and_renames_state(self):
        plan = en.switch_plan(OLD, NEW, "/bundle", {})
        argvs = [argv for argv, _, _ in plan]
        for argv, cwd, check in plan:
            self.assertTrue(check, argv)
            if argv[:2] == ["docker", "compose"]:
                self.assertEqual(argv[2:4], ["-p", "ibkr-nautilus-exec-node"])
                self.assertNotIn("ib-gateway", argv)
                self.assertNotIn("down", argv)
                self.assertEqual(argv[-8:], list(en.STOP_ORDER))
        stops = [(argv, cwd) for argv, cwd, _ in plan if "stop" in argv and argv[0] == "docker"]
        self.assertEqual(stops[0][1], OLD)
        self.assertIn(self.move_data, argvs)
        self.assertIn([en.MOVE, f"{OLD}/portfolio-ui/data", f"{NEW}/portfolio-ui/data", "optional", "strict"], argvs)
        ups = [(argv, cwd) for argv, cwd, _ in plan if "up" in argv]
        self.assertEqual(ups, [(en.compose_argv("up", "-d", "--no-build", *en.STOP_ORDER), NEW)])
        self.assertLess(argvs.index(self.move_data), argvs.index(ups[0][0]))
        self.assertEqual(argvs[0], ["systemctl", "stop", en.RECOVERY_UNIT])
        self.assertEqual(argvs[1][-1], en.FORCED_2FA)
        self.assertIn("paused", argvs[1][-2])
        self.assertLess(argvs.index(argvs[1]), argvs.index(stops[0][0]))
        self.assertEqual(argvs[-1], ["systemctl", "start", en.HEALTH_ALERT_TIMER])

    def test_switch_keeps_the_installed_file_modes(self):
        dest = "/opt/vertex-status/collect.py"
        plan = en.switch_plan(OLD, NEW, "/bundle", {dest: 0o700})
        self.assertIn(["install", "-m", "700", "/bundle/status/collect.py", dest], [a for a, _, _ in plan])

    def test_rollback_mirrors_the_switch_and_tolerates_a_partial_switch(self):
        plan = en.rollback_plan(OLD, NEW, "/backup", "/bundle")
        argvs = [argv for argv, _, _ in plan]
        self.assertIn([en.MOVE, f"{NEW}/data", f"{OLD}/data", "required", "resume"], argvs)
        ups = [(argv, cwd) for argv, cwd, _ in plan if "up" in argv]
        self.assertEqual(ups, [(en.compose_argv("up", "-d", "--no-build", *en.STOP_ORDER), OLD)])
        for unit in en.UNITS:
            self.assertIn(["cp", "-p", f"/backup/units/{unit}", f"{en.SYSTEMD_DIR}/{unit}"], argvs)
        for dest in en.CONSUMERS.values():
            self.assertIn(["cp", "-p", f"/backup/consumers/{Path(dest).name}", dest], argvs)
        self.assertEqual(argvs[1][-2:], [f"/bundle/{en.FORCED_2FA_PAUSED}", en.FORCED_2FA])
        tolerant = [argv for argv, _, check in plan if not check]
        for argv in (["systemctl", "stop", en.RECOVERY_UNIT], ["pm2", "stop", en.PM2_NAME],
                     ["pm2", "delete", en.PM2_NAME]):
            self.assertIn(argv, tolerant)
        self.assertTrue(all(not c for a, _, c in plan if a[:2] == ["docker", "compose"] and "stop" in a))

    def test_dry_run_switch_prints_and_runs_nothing(self):
        lines = []
        runner = en.Runner(dry_run=True, log=lines.append)
        en.execute(runner, en.switch_plan(OLD, NEW, "/bundle", {}), [])
        self.assertTrue(all(line.startswith(("DRY-RUN ", "ok ")) for line in lines))

    def test_tool_never_arms_or_orders(self):
        source = (HERE / "exec_node.py").read_text()
        self.assertIn('"nautilus.arm_cli", "status", "--json"', source)
        for forbidden in ('"arm",', "arm_cli\", \"arm", "placeOrder", "place_order", "down\""):
            self.assertNotIn(forbidden, source)

    def test_paused_forced_command_denies(self):
        result = subprocess.run(["sh", str(HERE / "consumers" / "ibkr-monitor-forced-2fa.paused.sh")],
                                env={"SSH_ORIGINAL_COMMAND": "trigger", "PATH": os.environ["PATH"]},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)


class MoveStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.src, self.dst = str(self.tmp / "a"), str(self.tmp / "b")

    def test_rename_keeps_the_inode(self):
        os.mkdir(self.src)
        Path(self.src, "PG_VERSION").write_text("16\n")
        inode = os.stat(self.src).st_ino
        self.assertEqual(en.move_state(self.src, self.dst, True, False), "moved")
        self.assertEqual(os.stat(self.dst).st_ino, inode)
        self.assertFalse(os.path.exists(self.src))

    def test_both_present_refuses(self):
        os.mkdir(self.src)
        os.mkdir(self.dst)
        with self.assertRaises(en.ExecNodeError):
            en.move_state(self.src, self.dst, True, True)

    def test_resume_accepts_state_already_in_place(self):
        os.mkdir(self.dst)
        self.assertEqual(en.move_state(self.src, self.dst, True, True), "already in place")
        with self.assertRaises(en.ExecNodeError):
            en.move_state(self.src, self.dst, True, False)

    def test_optional_absent_is_skipped_and_required_absent_fails(self):
        self.assertEqual(en.move_state(self.src, self.dst, False, False), "absent")
        with self.assertRaises(en.ExecNodeError):
            en.move_state(self.src, self.dst, True, False)

    def test_execute_runs_the_move_step(self):
        os.mkdir(self.src)
        journal = []
        en.execute(en.Runner(log=lambda _line: None), [([en.MOVE, self.src, self.dst, "required", "strict"], None, True)],
                   journal)
        self.assertEqual(journal[0]["outcome"], "moved")


class HostCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_consumer_drift_accepts_only_the_root_swap(self):
        bundle = self.tmp / "bundle"
        (bundle / "status").mkdir(parents=True)
        (bundle / "status" / "collect.py").write_text(f'ROOT = "{NEW}"\n')
        installed = self.tmp / "collect.py"
        installed.write_text(f'ROOT = "{OLD}"\n')
        consumers = dict(en.CONSUMERS)
        try:
            en.CONSUMERS.clear()
            en.CONSUMERS["status/collect.py"] = str(installed)
            self.assertEqual(en.consumer_drift(bundle, OLD, NEW), [])
            installed.write_text(f'ROOT = "{OLD}"\nNEW_ROUTE = 1\n')
            self.assertEqual(len(en.consumer_drift(bundle, OLD, NEW)), 1)
        finally:
            en.CONSUMERS.clear()
            en.CONSUMERS.update(consumers)

    def test_references_skip_rollback_history_and_backups(self):
        (self.tmp / "rollback-1").mkdir()
        (self.tmp / "rollback-1" / "old.py").write_text(f'SCRIPT = "{OLD}/scripts/x"\n')
        (self.tmp / "unit.service.bak").write_text(f"WorkingDirectory={OLD}\n")
        (self.tmp / "live.service").write_text(f"WorkingDirectory={NEW}\n")
        self.assertEqual(en.references([str(self.tmp)], OLD), [])
        (self.tmp / "other.service").write_text(f"WorkingDirectory={OLD}\n")
        self.assertEqual(en.references([str(self.tmp)], OLD), [str(self.tmp / "other.service")])

    def test_two_fa_running_reads_proc_cmdlines(self):
        proc = self.tmp / "proc"
        (proc / "10").mkdir(parents=True)
        (proc / "10" / "cmdline").write_bytes(b"bash\0scripts/other.sh\0")
        self.assertFalse(en.two_fa_running(str(proc)))
        (proc / "11").mkdir()
        (proc / "11" / "cmdline").write_bytes(b"bash\0scripts/request-ibkr-2fa-until-ready.sh\0")
        self.assertTrue(en.two_fa_running(str(proc)))

    def test_build_manifest_pins_code_but_not_state_or_dependencies(self):
        root = self.tmp / "root"
        for rel in ("scripts/a.sh", "data/postgres/x", "portfolio-ui/data/KILL_SWITCH", "portfolio-ui/server.mjs",
                    "node_modules/dep/index.js", "nautilus/__pycache__/m.pyc", ".env", ".git/HEAD"):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text("x")
        rels = [line[66:] for line in en.build_manifest(root).splitlines()]
        self.assertEqual(rels, ["portfolio-ui/server.mjs", "scripts/a.sh"])

    def test_compose_env_drops_operator_variables(self):
        os.environ["VERTEX_QUANT_HOST_ROOT"] = "/elsewhere"
        os.environ["IBKR_TRADING_MODE"] = "paper"
        try:
            env = en.compose_env()
            self.assertNotIn("VERTEX_QUANT_HOST_ROOT", env)
            self.assertNotIn("IBKR_TRADING_MODE", env)
            self.assertIn("PATH", env)
        finally:
            del os.environ["VERTEX_QUANT_HOST_ROOT"], os.environ["IBKR_TRADING_MODE"]


class VerifyLogicTests(unittest.TestCase):
    def states(self, **override):
        base = {svc: {"status": "running", "health": "healthy", "configFiles": f"{NEW}/docker-compose.yml"}
                for svc in en.SERVICES}
        base["ib-gateway"]["configFiles"] = f"{OLD}/docker-compose.yml"
        base.update(override)
        return base

    def test_containers_ok_when_all_running_from_the_new_root(self):
        ok, _ = en.evaluate_containers(self.states(), NEW)
        self.assertTrue(ok)

    def test_containers_fail_when_one_is_unhealthy_or_from_the_old_root(self):
        ok, detail = en.evaluate_containers(self.states(watchdog={"status": "running", "health": "unhealthy"}), NEW)
        self.assertFalse(ok)
        self.assertIn("watchdog", detail)
        ok, detail = en.evaluate_containers(
            self.states(redis={"status": "running", "health": "healthy", "configFiles": f"{OLD}/docker-compose.yml"}),
            NEW)
        self.assertFalse(ok)
        self.assertIn("redis=wrong-root", detail)

    def test_pm2_heartbeat_must_be_online_in_the_root(self):
        procs = [{"name": en.PM2_NAME, "pm2_env": {"status": "online", "pm_cwd": NEW}}]
        self.assertTrue(en.evaluate_pm2(procs, NEW)[0])
        self.assertFalse(en.evaluate_pm2(procs, OLD)[0])
        self.assertFalse(en.evaluate_pm2([], NEW)[0])
        procs[0]["pm2_env"]["status"] = "stopped"
        self.assertFalse(en.evaluate_pm2(procs, NEW)[0])

    def test_parse_inspect_handles_containers_without_a_healthcheck(self):
        caddy = en.parse_inspect('{"state":{"Status":"running","StartedAt":"t1"},"id":"c1","configFiles":"/r/docker-compose.yml"}')
        self.assertEqual(caddy, {"status": "running", "health": "", "started": "t1", "id": "c1",
                                 "configFiles": "/r/docker-compose.yml"})
        redis = en.parse_inspect('{"state":{"Status":"running","Health":{"Status":"healthy"}},"id":"r1","configFiles":""}')
        self.assertEqual(redis["health"], "healthy")

    def test_inspect_template_renders_for_every_running_container(self):
        """Runs the real template on every running container (QuantVPS has caddy without a healthcheck)."""
        if not shutil.which("docker"):
            self.skipTest("docker not installed")
        listed = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True)
        if listed.returncode != 0 or not listed.stdout.split():
            self.skipTest("no readable running containers")
        for cid in listed.stdout.split():
            result = subprocess.run(["docker", "inspect", "-f", en.INSPECT_TEMPLATE, cid], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, "template failed")
            self.assertEqual(en.parse_inspect(result.stdout)["status"], "running")

    def test_arm_must_be_false(self):
        self.assertTrue(en.evaluate_arm({"armed": False, "detail": "no_arm_record"})[0])
        self.assertFalse(en.evaluate_arm({"armed": True, "detail": "armed"})[0])
        self.assertFalse(en.evaluate_arm({"armed": None, "detail": "arm_cli exit 1"})[0])

    def test_removed_files_must_be_absent_from_the_new_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(en.evaluate_removed(tmp), (True, "none present"))
            (Path(tmp) / "tests").mkdir()
            (Path(tmp) / "tests" / "test_charan_trade_intents.py").write_text("x\n")
            ok, detail = en.evaluate_removed(tmp)
            self.assertFalse(ok)
            self.assertEqual(detail, "tests/test_charan_trade_intents.py: present (removed)")
        self.assertTrue(en.evaluate_removed(OLD)[0], "the frozen old root keeps them")

    def test_diff_paths_handles_lists_and_missing_keys(self):
        self.assertEqual(en.diff_paths({"a": [1, 2]}, {"a": [1, 3], "b": 1}), ["a[1]", "b"])
        self.assertEqual(en.diff_paths([1], [1, 2]), ["$"])
        self.assertEqual(en.replace_strings(copy.deepcopy({"a": [OLD + "/x", 1]}), OLD, NEW), {"a": [NEW + "/x", 1]})



class HostConfigTests(unittest.TestCase):
    """Host values come from the host-local /etc/vertex/hosts.env, never from the committed tree."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.path = str(self.tmp / "hosts.env")

    def write(self, text):
        Path(self.path).write_text(text)

    def test_monitor_url_uses_the_configured_tailnet_ipv4(self):
        self.write("# host config\nVERTEX_TAILNET_HOST=quant-vps-host.example-tailnet.ts.net\n"
                   "VERTEX_TAILNET_IPV4=100.64.0.1\nVERTEX_TAILNET_IPV4=100.64.0.10\n")
        self.assertEqual(en.ibkr_monitor_health_url(self.path), "http://100.64.0.10:3461/api/health")

    def test_missing_or_malformed_config_refuses(self):
        for text in (None, "", "VERTEX_TAILNET_IPV4=\n", "VERTEX_TAILNET_IPV4=10.0.0.5\n",
                     "VERTEX_TAILNET_IPV4=100.64.0.10/evil\n", "VERTEX_TAILNET_IPV4=100.64.0.1000\n",
                     "VERTEX_TAILNET_IPV4=100.128.0.1\n", "VERTEX_TAILNET_IPV4=100.\u0664.0.1\n", "OTHER=100.64.0.10\n"):
            if text is not None:
                self.write(text)
            with self.assertRaises(en.ExecNodeError) as caught:
                en.ibkr_monitor_health_url(self.path)
            self.assertEqual(str(caught.exception), f"VERTEX_TAILNET_IPV4 missing or malformed in {self.path}")

    def test_committed_tool_names_no_tailnet_address(self):
        source = (HERE / "exec_node.py").read_text()
        self.assertNotRegex(source, r"\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b")


if __name__ == "__main__":
    unittest.main(verbosity=1)
