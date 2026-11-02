"""Offline tests: ephemeral synthetic files, Python children and local keygen only."""
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import infrastructure_probe as probe


class InfrastructureProbeTests(unittest.TestCase):
    def setUp(self):
        # /tmp is deliberately supported when root-owned and sticky; the private
        # directory beneath it and every file belong to the calling user.
        self.temp = tempfile.TemporaryDirectory(dir="/tmp")
        self.root = Path(self.temp.name)
        self.trust = self.root / "known_hosts"
        self.key = self.root / "identity"
        self.trust_bytes = b"synthetic trust fixture\n"
        self.key_bytes = b"synthetic identity fixture\n"
        self.trust.write_bytes(self.trust_bytes)
        self.key.write_bytes(self.key_bytes)
        self.trust.chmod(0o600)
        self.key.chmod(0o600)
        self.config = dict(host="probe.example.invalid", user="observer", port=22,
                           known_hosts=str(self.trust), identity=str(self.key))

    def tearDown(self):
        self.temp.cleanup()

    def assert_blocked_without_process(self, config):
        with patch.object(probe.subprocess, "Popen") as launch:
            result = probe.probe_infrastructure(config, execute=True)
        self.assertEqual(result["reason"], "invalid_configuration")
        launch.assert_not_called()

    def test_disabled_default_never_launches_process(self):
        with patch.object(probe.subprocess, "Popen") as launch:
            result = probe.probe_infrastructure(self.config)
        self.assertEqual(result["reason"], "probe_disabled")
        launch.assert_not_called()

    def test_unsafe_configuration_fails_before_any_process(self):
        cases = [("host", "-oProxyCommand=whoami"), ("host", "a.invalid;id"),
                 ("host", "unknown-alias"), ("host", "$(id).invalid"),
                 ("user", "root;id"), ("user", "-root"), ("port", True),
                 ("port", 0), ("port", 65536), ("port", "22"),
                 ("known_hosts", "/tmp/trust %h"), ("identity", "relative-key"),
                 ("identity", "/" + str(self.key)),
                 ("identity", str(self.root / ".." / self.root.name / "identity"))]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.assert_blocked_without_process({**self.config, field: value})

    def test_extra_config_command_and_password_rejected(self):
        for field in ["command", "password", "ssh_options", "timeout"]:
            with self.subTest(field=field):
                self.assert_blocked_without_process({**self.config, field: "unsafe"})

    def test_command_injection_unknown_and_empty_checks_fail_closed(self):
        for checks in [("restart",), ("hostname; id",), (), "hostname", ("os", "os")]:
            with self.subTest(checks=checks), patch.object(probe.subprocess, "Popen") as launch:
                result = probe.probe_infrastructure(self.config, checks, execute=True)
                self.assertEqual(result["reason"], "invalid_checks")
                launch.assert_not_called()

    def test_missing_symlink_and_writable_files_blocked(self):
        self.key.unlink()
        self.assert_blocked_without_process(self.config)
        self.key.symlink_to(self.trust)
        self.assert_blocked_without_process(self.config)
        self.key.unlink()
        self.key.write_text("synthetic")
        self.key.chmod(0o644)
        self.assert_blocked_without_process(self.config)
        self.key.chmod(0o600)
        self.trust.chmod(0o622)
        self.assert_blocked_without_process(self.config)

    def test_nonregular_and_empty_files_block_without_hanging(self):
        self.key.unlink()
        os.mkfifo(self.key, 0o600)
        self.assert_blocked_without_process(self.config)
        self.key.unlink()
        self.key.touch(mode=0o600)
        self.assert_blocked_without_process(self.config)

    def test_group_world_writable_and_nonsticky_parents_blocked(self):
        for mode in [0o770, 0o707, 0o777]:
            with self.subTest(mode=mode):
                self.root.chmod(mode)
                try:
                    self.assert_blocked_without_process(self.config)
                finally:
                    self.root.chmod(0o700)

    def test_wrong_owner_parent_and_leaf_blocked(self):
        real_fstat = os.fstat
        for target in [self.root, self.trust, self.key]:
            target_inode = target.stat().st_ino

            def wrong_owner(fd):
                info = real_fstat(fd)
                if info.st_ino == target_inode:
                    values = list(info)
                    values[4] = os.getuid() + 1
                    return os.stat_result(values)
                return info

            with self.subTest(target=target.name), patch.object(probe.os, "fstat", side_effect=wrong_owner):
                self.assert_blocked_without_process(self.config)

    def test_sticky_writable_parent_must_be_root_owned(self):
        real_fstat = os.fstat
        inode = self.root.stat().st_ino

        def user_owned_sticky(fd):
            info = real_fstat(fd)
            if info.st_ino == inode:
                values = list(info)
                values[0] = stat.S_IFDIR | 0o1777
                values[4] = 12345
                return os.stat_result(values)
            return info

        with patch.object(probe.os, "getuid", return_value=12345), patch.object(probe.os, "fstat", side_effect=user_owned_sticky):
            self.assert_blocked_without_process(self.config)

    def test_symlink_ancestor_blocked(self):
        nested = self.root / "private"
        nested.mkdir(mode=0o700)
        alias = self.root / "alias"
        alias.symlink_to(nested, target_is_directory=True)
        moved = nested / "identity"
        self.key.rename(moved)
        self.assert_blocked_without_process({**self.config, "identity": str(alias / "identity")})

    def test_unknown_host_stops_before_ssh(self):
        with patch.object(probe, "_run", return_value=subprocess.CompletedProcess([], 1, "", "secret")) as run:
            result = probe.probe_infrastructure(self.config, execute=True)
        self.assertEqual(result["reason"], "host_trust_unverified")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][0], "/usr/bin/ssh-keygen")
        self.assertNotIn("secret", json.dumps(result))

    def test_pinned_ssh_policy_and_sanitized_metadata(self):
        outputs = iter(["synthetic matching entry", "private-host\n", "Linux\n", "private-user\n", "running\nexited\n"])
        pinned = set()

        def run(argv, timeout):
            self.assertLessEqual(timeout, 12)
            if argv[0] == "/usr/bin/ssh-keygen":
                path = argv[argv.index("-f") + 1]
                self.assertEqual(Path(path).read_bytes(), self.trust_bytes)
                pinned.add(path)
            else:
                for option in ["StrictHostKeyChecking=yes", "BatchMode=yes", "PasswordAuthentication=no",
                               "KbdInteractiveAuthentication=no", "IdentityAgent=none", "IdentitiesOnly=yes",
                               "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "ProxyCommand=none",
                               "PermitLocalCommand=no", "ControlPath=none"]:
                    self.assertIn(option, argv)
                self.assertEqual(argv[1:3], ["-F", "/dev/null"])
                self.assertIn(argv[-1], probe.COMMANDS.values())
                path = argv[argv.index("-i") + 1]
                self.assertEqual(Path(path).read_bytes(), self.key_bytes)
                pinned.add(path)
                trust = next(arg.split("=", 1)[1] for arg in argv if arg.startswith("UserKnownHostsFile="))
                self.assertIn(trust, pinned)
                self.assertEqual(Path(trust).read_bytes(), self.trust_bytes)
            self.assertNotIn(str(self.key), argv)
            self.assertNotIn(str(self.trust), argv)
            return subprocess.CompletedProcess([], 0, next(outputs), "")

        with patch.object(probe, "_run", side_effect=run):
            result = probe.probe_infrastructure(self.config, execute=True)
        self.assertEqual(result["state"], "observed")
        self.assertEqual(result["brokerHandshake"], "not_attempted")
        self.assertEqual(result["recovery"], "disabled")
        self.assertEqual(result["trading"], "disabled")
        self.assertEqual(result["observations"]["containers"]["states"], {"exited": 1, "running": 1})
        self.assertNotIn("private-", json.dumps(result))
        for path in pinned:
            self.assertFalse(Path(path).exists(), "pinned descriptors must close after the probe")

    def test_leaf_substitution_after_preflight_cannot_change_consumed_files(self):
        pinned = []

        def run(argv, timeout):
            if argv[0] == "/usr/bin/ssh-keygen":
                # Substitute both names before even the trust lookup consumes its
                # path. The subsequent SSH must see these same original inodes.
                for file in [self.trust, self.key]:
                    file.unlink()
                    file.write_text("substituted bytes")
                    file.chmod(0o600)
                trust = argv[argv.index("-f") + 1]
                pinned.append(trust)
                self.assertEqual(Path(trust).read_bytes(), self.trust_bytes)
                return subprocess.CompletedProcess([], 0, "synthetic match", "")
            trust = next(arg.split("=", 1)[1] for arg in argv if arg.startswith("UserKnownHostsFile="))
            key = argv[argv.index("-i") + 1]
            pinned.append(key)
            self.assertEqual(trust, pinned[0])
            self.assertEqual(Path(trust).read_bytes(), self.trust_bytes)
            self.assertEqual(Path(key).read_bytes(), self.key_bytes)
            return subprocess.CompletedProcess([], 0, "Linux\n", "")

        with patch.object(probe, "_run", side_effect=run):
            result = probe.probe_infrastructure(self.config, ("os",), execute=True)
        self.assertEqual(result["state"], "observed")
        for path in pinned:
            self.assertFalse(Path(path).exists())

    def test_parent_substitution_during_walk_cannot_redirect_file_open(self):
        nested = self.root / "private"
        nested.mkdir(mode=0o700)
        self.key.rename(nested / "identity")
        real_open = os.open
        switched = False

        def replace_parent(path, flags, *args, **kwargs):
            nonlocal switched
            fd = real_open(path, flags, *args, **kwargs)
            if path == "private" and not switched:
                switched = True
                nested.rename(self.root / "original")
                nested.mkdir(mode=0o700)
                (nested / "identity").write_text("substituted bytes")
                (nested / "identity").chmod(0o600)
            return fd

        with patch.object(probe.os, "open", side_effect=replace_parent):
            with probe._safe_file(str(nested / "identity"), identity=True) as pinned:
                self.assertEqual(Path(pinned).read_bytes(), self.key_bytes)
        self.assertTrue(switched)
        self.assertFalse(Path(pinned).exists())

    def test_pins_close_on_failure_and_missing_procfs_fails_closed(self):
        real_stat = os.stat

        def missing_procfs(path, *args, **kwargs):
            if str(path).startswith("/proc/"):
                raise FileNotFoundError("synthetic detail")
            return real_stat(path, *args, **kwargs)

        with patch.object(probe.os, "stat", side_effect=missing_procfs):
            self.assert_blocked_without_process(self.config)
        pinned = []

        def fail(argv, timeout):
            pinned.append(argv[argv.index("-f") + 1])
            raise OSError("sensitive detail")

        with patch.object(probe, "_run", side_effect=fail):
            result = probe.probe_infrastructure(self.config, execute=True)
        self.assertEqual(result["reason"], "local_tool_unavailable")
        self.assertNotIn("sensitive", json.dumps(result))
        self.assertFalse(Path(pinned[0]).exists())

    def test_partial_pin_failure_closes_every_opened_descriptor(self):
        real_open = os.open
        opened = []

        def track_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            opened.append(fd)
            return fd

        self.key.chmod(0o644)
        with patch.object(probe.os, "open", side_effect=track_open):
            self.assert_blocked_without_process(self.config)
        self.assertTrue(opened)
        for fd in set(opened):
            with self.assertRaises(OSError) as error:
                os.fstat(fd)
            self.assertEqual(error.exception.errno, errno.EBADF)

    def test_timeout_auth_and_overflow_failure_are_not_readiness(self):
        for failure, reason in [(subprocess.TimeoutExpired("ssh", 12), "command_timeout"),
                                (probe._OutputLimitExceeded(), "unexpected_metadata"),
                                (subprocess.CompletedProcess([], 255, "", "Permission denied secret"), "ssh_or_command_failed")]:
            with self.subTest(reason=reason), patch.object(probe, "_run", side_effect=[
                subprocess.CompletedProcess([], 0, "synthetic matching entry", ""), failure]):
                result = probe.probe_infrastructure(self.config, ("hostname",), execute=True)
            self.assertEqual(result["reason"], reason)
            self.assertEqual(result["brokerHandshake"], "not_attempted")
            self.assertNotIn("secret", json.dumps(result))

    def test_trust_lookup_overflow_stops_before_ssh(self):
        with patch.object(probe, "_run", side_effect=probe._OutputLimitExceeded()) as run:
            result = probe.probe_infrastructure(self.config, execute=True)
        self.assertEqual(result["reason"], "unexpected_metadata")
        self.assertEqual(run.call_count, 1)

    def test_malformed_output_not_forwarded(self):
        with patch.object(probe, "_run", side_effect=[
            subprocess.CompletedProcess([], 0, "synthetic matching entry", ""),
            subprocess.CompletedProcess([], 0, "running\nSECRET=value\n", "")]):
            result = probe.probe_infrastructure(self.config, ("containers",), execute=True)
        self.assertEqual(result["reason"], "unexpected_metadata")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_cli_rejects_arbitrary_commands_without_echo(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), patch.object(probe.subprocess, "Popen") as launch:
            code = probe.main(["--command", "sensitive-untrusted-text"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stdout.getvalue())["reason"], "invalid_arguments")
        self.assertNotIn("sensitive", stdout.getvalue())
        launch.assert_not_called()


class BoundedProcessTests(unittest.TestCase):
    def setUp(self):
        self.children = []
        self.real_popen = subprocess.Popen

    def launch(self, *args, **kwargs):
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["env"], probe.PROCESS_ENV)
        self.assertNotIn("SSH_AUTH_SOCK", kwargs["env"])
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(kwargs["bufsize"], 0)
        child = self.real_popen(*args, **kwargs)
        self.children.append(child)
        return child

    def tearDown(self):
        # Test failure must not leak even a synthetic helper process.
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait()
            for stream in [child.stdout, child.stderr]:
                if stream is not None:
                    stream.close()

    def assert_reaped(self):
        self.assertTrue(self.children)
        child = self.children[-1]
        self.assertIsNotNone(child.returncode)
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)
        with self.assertRaises(ChildProcessError):
            os.waitpid(child.pid, os.WNOHANG)

    def run_child(self, code, timeout=5):
        with patch.object(probe.subprocess, "Popen", side_effect=self.launch):
            return probe._run([sys.executable, "-I", "-c", code], timeout)

    def test_child_reads_original_pins_after_path_replacement_with_fds_closed(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            trust = Path(directory) / "known_hosts"
            key = Path(directory) / "identity"
            trust.write_text("synthetic trust\n")
            key.write_text("synthetic identity\n")
            trust.chmod(0o600)
            key.chmod(0o600)
            with probe._safe_file(str(trust)) as pinned_trust, probe._safe_file(str(key), identity=True) as pinned_key:
                for path in [trust, key]:
                    path.unlink()
                    path.write_text("replacement")
                    path.chmod(0o600)
                # launch() requires close_fds=True: the child must resolve the
                # parent's verified descriptors, not inherit a usable copy.
                result = self.run_child(
                    f"from pathlib import Path; import sys; "
                    f"sys.stdout.write(Path({pinned_trust!r}).read_text()); "
                    f"sys.stdout.write(Path({pinned_key!r}).read_text())")
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "synthetic trust\nsynthetic identity\n")
                self.assert_reaped()
            self.assertFalse(Path(pinned_trust).exists())
            self.assertFalse(Path(pinned_key).exists())

    def test_openssh_key_and_trust_readers_consume_pinned_synthetic_files(self):
        # ssh-keygen is already required by the probe. Generate only an ephemeral
        # test key; do not inspect existing credentials or print fixture bytes.
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            key = root / "identity"
            trust = root / "known_hosts"
            with patch.object(probe.subprocess, "Popen", side_effect=self.launch):
                generated = probe._run(
                    ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "",
                     "-C", "synthetic-probe-test", "-f", str(key)], 5)
                self.assertEqual(generated.returncode, 0)
                self.assert_reaped()
                expected_public = " ".join(key.with_suffix(".pub").read_text().split()[:2])
                trust_line = "probe.example.invalid " + expected_public
                trust.write_text(trust_line + "\n")
                trust.chmod(0o600)
                with probe._safe_file(str(trust)) as pinned_trust, probe._safe_file(str(key), identity=True) as pinned_key:
                    for path in [trust, key]:
                        path.rename(root / ("original-" + path.name))
                        path.write_text("invalid substituted fixture\n")
                        path.chmod(0o600)
                    public = probe._run(["/usr/bin/ssh-keygen", "-y", "-f", pinned_key], 5)
                    self.assertEqual(public.returncode, 0)
                    self.assertTrue(" ".join(public.stdout.split()[:2]) == expected_public,
                                    "Pinned key reader must consume the generated original")
                    self.assert_reaped()
                    lookup = probe._run(
                        ["/usr/bin/ssh-keygen", "-F", "probe.example.invalid", "-f", pinned_trust], 5)
                    self.assertEqual(lookup.returncode, 0)
                    self.assertTrue(trust_line in lookup.stdout,
                                    "Pinned trust reader must consume the generated original")
                    self.assert_reaped()
                self.assertFalse(Path(pinned_trust).exists())
                self.assertFalse(Path(pinned_key).exists())

    def test_each_stream_and_combined_exact_boundary_succeed(self):
        for stdout_size, stderr_size in [(probe.MAX_OUTPUT, 0), (0, probe.MAX_OUTPUT),
                                         (probe.MAX_OUTPUT // 2, probe.MAX_OUTPUT // 2)]:
            with self.subTest(stdout=stdout_size, stderr=stderr_size):
                result = self.run_child(f"import os; os.write(1, b'x'*{stdout_size}); os.write(2, b'y'*{stderr_size})")
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "x" * stdout_size)
                self.assertEqual(result.stderr, "")
                self.assert_reaped()

    def test_stdout_stderr_and_combined_overflow_kill_and_reap(self):
        for stdout_size, stderr_size in [(probe.MAX_OUTPUT + 1, 0), (0, probe.MAX_OUTPUT + 1),
                                         (probe.MAX_OUTPUT // 2, probe.MAX_OUTPUT // 2 + 1)]:
            with self.subTest(stdout=stdout_size, stderr=stderr_size):
                code = (f"import os, time; os.write(1, b'x'*{stdout_size}); "
                        f"os.write(2, b'y'*{stderr_size}); time.sleep(60)")
                with self.assertRaises(probe._OutputLimitExceeded) as error:
                    self.run_child(code)
                self.assertEqual(str(error.exception), "")
                self.assert_reaped()

    def test_unbounded_writer_is_stopped_without_unbounded_reads(self):
        real_read = os.read
        read_sizes = []

        def bounded_read(fd, size):
            if self.children and fd in [self.children[0].stdout.fileno(), self.children[0].stderr.fileno()]:
                read_sizes.append(size)
            return real_read(fd, size)

        with patch.object(probe.os, "read", side_effect=bounded_read):
            with self.assertRaises(probe._OutputLimitExceeded):
                self.run_child("import os\nwhile True: os.write(1, b'x'*4096)")
        self.assertTrue(read_sizes)
        self.assertLessEqual(max(read_sizes), 4096)
        self.assertLessEqual(sum(read_sizes), probe.MAX_OUTPUT + 1)
        self.assert_reaped()

    def test_limits_count_bytes_not_decoded_characters(self):
        with self.assertRaises(probe._OutputLimitExceeded):
            self.run_child(f"import os; os.write(1, b'\\xc3\\xa9'*{probe.MAX_OUTPUT // 2 + 1})")
        self.assert_reaped()

    def test_timeout_kills_reaps_and_does_not_expose_output(self):
        with self.assertRaises(subprocess.TimeoutExpired) as error:
            self.run_child("import os, time; os.write(1, b'sensitive'); time.sleep(60)", timeout=0.1)
        self.assertIsNone(error.exception.output)
        self.assertIsNone(error.exception.stderr)
        self.assertNotIn("sensitive", str(error.exception))
        self.assert_reaped()

    def test_deadline_also_covers_child_with_closed_output_pipes(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_child("import os, time; os.close(1); os.close(2); time.sleep(60)", timeout=0.1)
        self.assert_reaped()

    def test_io_failure_still_kills_and_reaps(self):
        real_read = os.read

        def failed_read(fd, size):
            if self.children and fd in [self.children[0].stdout.fileno(), self.children[0].stderr.fileno()]:
                raise OSError("synthetic read failure")
            return real_read(fd, size)

        with patch.object(probe.os, "read", side_effect=failed_read):
            with self.assertRaises(OSError):
                self.run_child("import os, time; os.write(1, b'x'); time.sleep(60)")
        self.assert_reaped()


if __name__ == "__main__":
    unittest.main()
