import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

const directives = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeExecutable = (path: string, content: string): void => {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { force: true, recursive: true });
  }
});

describe("vertex-nautilus-worker systemd unit", () => {
  const service = readFileSync(
    here("./vertex-nautilus-worker.service"),
    "utf8"
  );

  it("stays research-only with the 65 s start wait and safe hardening", () => {
    expect(service).toContain("research only");
    expect(directives(service, "Type")).toEqual(["simple"]);
    expect(directives(service, "ExecStartPre")).toEqual(["/usr/bin/sleep 65"]);
    expect(directives(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-nautilus-worker-run",
    ]);
    expect(directives(service, "KillMode")).toEqual(["mixed"]);
    expect(directives(service, "NoNewPrivileges")).toEqual(["yes"]);
  });
});

describe("vertex-nautilus-worker-run.sh", () => {
  const template = readFileSync(
    here("./vertex-nautilus-worker-run.sh"),
    "utf8"
  );

  const renderLauncher = (
    root: string,
    overrides: Partial<{
      bun: string;
      checkout: string;
      keyFile: string;
      python: string;
    }> = {}
  ): { bunLog: string; launcher: string } => {
    const checkout = overrides.checkout ?? join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    const keyFile = overrides.keyFile ?? join(root, "agent-write-key");
    writeFileSync(keyFile, "test-write-key", "utf8");
    chmodSync(keyFile, 0o600);
    const bunLog = join(root, "bun.log");
    const bun = overrides.bun ?? join(root, "fake-bun");
    writeExecutable(
      bun,
      `#!/usr/bin/env bash
printf '%s|%s|%s\n' "$VERTEX_NAUTILUS_PYTHON" "$VERTEX_AGENT_API_KEY" "$*" > "${bunLog}"
`
    );
    const venvDir = join(root, "nautilus-venv");
    let rendered = template
      .replace("__RUNNER_CHECKOUT__", checkout)
      .replace("__AGENT_WRITE_KEY_FILE__", keyFile)
      .replace("__BUN__", bun)
      .replace("__VERTEX_ORIGIN__", "https://vertex.example.test")
      .replace("__NAUTILUS_VENV__", venvDir)
      .replace("__ALERT_POST_URL__", "")
      .replace("__ALERT_CHANNEL__", "");
    if (overrides.python !== undefined) {
      rendered = rendered.replace(`${venvDir}/bin/python`, overrides.python);
    }
    const launcher = join(root, "vertex-nautilus-worker-run");
    writeExecutable(launcher, rendered);
    return { bunLog, launcher };
  };

  it("refuses unreplaced placeholders and insecure key file permissions", () => {
    const root = makeTempDir("vertex-worker-run-");
    const raw = join(root, "raw.sh");
    writeExecutable(raw, template);
    const unreplaced = spawnSync("bash", [raw], { encoding: "utf8" });
    expect(unreplaced.status).toBe(64);
    expect(unreplaced.stderr).toContain("__PLACEHOLDER__");

    const keyFile = join(root, "loose-key");
    const { launcher } = renderLauncher(root, { keyFile });
    chmodSync(keyFile, 0o644);
    const loose = spawnSync("bash", [launcher], { encoding: "utf8" });
    expect(loose.status).toBe(64);
    expect(loose.stderr).toContain("mode 0600");
  });

  it("refuses missing, broken-symlink, directory and non-executable VERTEX_NAUTILUS_PYTHON before invoking bun", () => {
    const root = makeTempDir("vertex-worker-py-");

    // Missing binary
    const missing = renderLauncher(root);
    const missingRun = spawnSync("bash", [missing.launcher], {
      encoding: "utf8",
    });
    expect(missingRun.status).toBe(64);
    expect(missingRun.stderr).toContain("VERTEX_NAUTILUS_PYTHON");
    expect(missingRun.stderr).toContain("setup-nautilus-venv.sh");
    expect(() => readFileSync(missing.bunLog, "utf8")).toThrow();

    // Broken symlink
    const brokenLink = join(root, "broken-python");
    symlinkSync(join(root, "does-not-exist"), brokenLink);
    const broken = renderLauncher(root, { python: brokenLink });
    const brokenRun = spawnSync("bash", [broken.launcher], {
      encoding: "utf8",
    });
    expect(brokenRun.status).toBe(64);
    expect(brokenRun.stderr).toContain("setup-nautilus-venv.sh");

    // Directory instead of file
    const dirTarget = join(root, "dir-python");
    mkdirSync(dirTarget);
    const dirCase = renderLauncher(root, { python: dirTarget });
    const dirRun = spawnSync("bash", [dirCase.launcher], { encoding: "utf8" });
    expect(dirRun.status).toBe(64);

    // Non-executable file
    const nonExec = join(root, "non-exec-python");
    writeFileSync(nonExec, "#!/bin/sh\n", "utf8");
    chmodSync(nonExec, 0o644);
    const nonExecCase = renderLauncher(root, { python: nonExec });
    const nonExecRun = spawnSync("bash", [nonExecCase.launcher], {
      encoding: "utf8",
    });
    expect(nonExecRun.status).toBe(64);
  });

  it("execs bun when VERTEX_NAUTILUS_PYTHON is a valid symlink to an executable file", () => {
    const root = makeTempDir("vertex-worker-ok-");
    const realPy = join(root, "real-python");
    writeExecutable(realPy, "#!/usr/bin/env bash\nexit 0\n");
    const venvBin = join(root, "nautilus-venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const pyLink = join(venvBin, "python");
    symlinkSync(realPy, pyLink);

    const { bunLog, launcher } = renderLauncher(root);
    const run = spawnSync("bash", [launcher, "--once"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(bunLog, "utf8").trim()).toBe(
      `${pyLink}|test-write-key|--no-env-file scripts/vertex-backtest-worker-nautilus.ts --once`
    );
  });
});

describe("setup-nautilus-venv.sh", () => {
  const scriptPath = here("./setup-nautilus-venv.sh");

  const makeFakeCheckout = (
    root: string,
    options: Partial<{ lockContent: string; includePackage: boolean }> = {}
  ): { checkout: string; lock: string } => {
    const checkout = join(root, "checkout");
    const research = join(checkout, "services", "research");
    mkdirSync(research, { recursive: true });
    if (options.includePackage !== false) {
      const pkg = join(research, "nautilus_backtest");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "__init__.py"), '"""fake package"""\n', "utf8");
    }
    const lock = join(research, "requirements-nautilus-linux-py312.lock");
    writeFileSync(
      lock,
      options.lockContent ??
        "# lock\nnautilus-trader==1.227.0 --hash=sha256:0000\n",
      "utf8"
    );
    return { checkout, lock };
  };

  /** Writes a fake python script that behaves like CPython 3.12 with configurable version/package state. */
  const writeFakePython = (
    path: string,
    options: Partial<{
      pyVersion: string;
      nautilusVersion: string;
      logFile: string;
    }> = {}
  ): void => {
    const pyVersion = options.pyVersion ?? "3.12";
    const nautilusVersion = options.nautilusVersion ?? "1.227.0";
    const logLine =
      options.logFile === undefined
        ? ""
        : `printf 'python:%s\\n' "$*" >> "${options.logFile}"`;
    writeExecutable(
      path,
      `#!/usr/bin/env bash
set -euo pipefail
${logLine}
if [[ "$*" == *"sys.version_info"* && "$*" != *"nautilus_trader"* ]]; then
  printf '%s\\n' "${pyVersion}"
  exit 0
fi
if [[ "$*" == *"-m venv"* ]]; then
  target="\${@: -1}"
  mkdir -p "$target/bin"
  cp "$0" "$target/bin/python"
  chmod 0755 "$target/bin/python"
  exit 0
fi
if [[ "$*" == *"-m pip install"* ]]; then
  exit 0
fi
if [[ "$*" == *"nautilus_trader"* ]]; then
  expected="\${VERTEX_EXPECTED_NAUTILUS_VERSION:-}"
  if [[ "${pyVersion}" != "3.12" ]]; then
    echo "wrong python ${pyVersion}" >&2
    exit 1
  fi
  if [[ ! -f "$PYTHONPATH/nautilus_backtest/__init__.py" ]]; then
    echo "missing nautilus_backtest" >&2
    exit 1
  fi
  if [[ -n "$expected" && "${nautilusVersion}" != "$expected" ]]; then
    echo "version mismatch: ${nautilusVersion} != $expected" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`
    );
  };

  const writeFakeUv = (
    binDir: string,
    fakePy: string,
    logFile: string
  ): void => {
    writeExecutable(
      join(binDir, "uv"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'uv:%s\\n' "$*" >> "${logFile}"
if [[ "$1" == "venv" ]]; then
  target="\${@: -1}"
  rm -rf "$target"
  mkdir -p "$target/bin"
  cp "${fakePy}" "$target/bin/python"
  chmod 0755 "$target/bin/python"
  exit 0
fi
if [[ "$1" == "pip" && "$2" == "sync" ]]; then
  if [[ -z "\${VIRTUAL_ENV:-}" ]]; then
    echo "VIRTUAL_ENV missing" >&2
    exit 2
  fi
  exit 0
fi
echo "unexpected uv call: $*" >&2
exit 2
`
    );
  };

  it("prints help and rejects unknown flags, missing lock, unpinned lock and missing package", () => {
    const help = spawnSync("bash", [scriptPath, "--help"], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("setup-nautilus-venv.sh");

    const bad = spawnSync("bash", [scriptPath, "--bogus"], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(64);
    expect(bad.stderr).toContain("--bogus");

    const root = makeTempDir("vertex-setup-err-");
    const { checkout } = makeFakeCheckout(root, {
      lockContent: "pytest==9.0.3 --hash=sha256:0000\n",
    });
    const unpinned = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", join(root, "v")],
      { encoding: "utf8" }
    );
    expect(unpinned.status).toBe(64);
    expect(unpinned.stderr).toContain("nautilus-trader");

    const missingLock = spawnSync(
      "bash",
      [
        scriptPath,
        "--checkout",
        checkout,
        "--lock",
        join(root, "nope.lock"),
        "--venv",
        join(root, "v"),
      ],
      { encoding: "utf8" }
    );
    expect(missingLock.status).toBe(64);

    const noPkgRoot = makeTempDir("vertex-setup-nopkg-");
    const noPkg = makeFakeCheckout(noPkgRoot, { includePackage: false });
    const missingPkg = spawnSync(
      "bash",
      [
        scriptPath,
        "--checkout",
        noPkg.checkout,
        "--venv",
        join(noPkgRoot, "v"),
      ],
      { encoding: "utf8" }
    );
    expect(missingPkg.status).toBe(64);
    expect(missingPkg.stderr).toContain("nautilus_backtest");
  });

  it("creates, idempotently syncs, and repairs a broken venv via uv with hash verification", () => {
    const root = makeTempDir("vertex-setup-uv-");
    const { checkout, lock } = makeFakeCheckout(root);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const logFile = join(root, "ops.log");
    const fakePy = join(root, "fake-py312");
    writeFakePython(fakePy, { logFile });
    writeFakeUv(binDir, fakePy, logFile);
    const venv = join(root, "nautilus-venv");

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
    };

    // 1. Create from scratch
    const first = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", venv],
      { encoding: "utf8", env }
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`nautilus-venv ready: ${venv}/bin/python`);
    expect(first.stdout).toContain("nautilus-trader 1.227.0");
    const log1 = readFileSync(logFile, "utf8");
    expect(log1).toContain(
      `uv:venv --clear --quiet --no-config --python 3.12 ${venv}`
    );
    expect(log1).toContain(
      `uv:pip sync --quiet --require-hashes --only-binary :all: --no-config ${lock}`
    );

    // 2. Idempotent re-run skips uv venv when venv Python is already healthy 3.12
    writeFileSync(logFile, "", "utf8");
    const second = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", venv],
      { encoding: "utf8", env }
    );
    expect(second.status, second.stderr).toBe(0);
    const log2 = readFileSync(logFile, "utf8");
    expect(log2).not.toContain("uv:venv");
    expect(log2).toContain(
      "uv:pip sync --quiet --require-hashes --only-binary :all: --no-config"
    );

    // 3. Broken symlink triggers uv venv --clear repair
    rmSync(join(venv, "bin", "python"));
    symlinkSync(join(root, "vanished-python"), join(venv, "bin", "python"));
    writeFileSync(logFile, "", "utf8");
    const repaired = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", venv],
      { encoding: "utf8", env }
    );
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(readFileSync(logFile, "utf8")).toContain("uv:venv --clear");
  });

  it("falls back to python3.12 -m venv and hash-checked pip install when uv is unavailable", () => {
    const root = makeTempDir("vertex-setup-pip-");
    const { checkout, lock } = makeFakeCheckout(root);
    const logFile = join(root, "pip.log");
    const fakePy = join(root, "python3.12");
    writeFakePython(fakePy, { logFile });
    const venv = join(root, "nautilus-venv");

    const run = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", venv, "--python", fakePy],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERTEX_NAUTILUS_SETUP_NO_UV: "1",
        },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain(`-m venv --clear ${venv}`);
    expect(log).toContain(
      `-m pip install --quiet --disable-pip-version-check --no-deps --require-hashes --only-binary=:all: -r ${lock}`
    );
  });

  it("fails verification when the installed nautilus-trader version does not match the lock", () => {
    const root = makeTempDir("vertex-setup-mismatch-");
    const { checkout } = makeFakeCheckout(root);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const logFile = join(root, "mismatch.log");
    const badPy = join(root, "fake-py-bad");
    writeFakePython(badPy, { nautilusVersion: "1.999.0" });
    writeFakeUv(binDir, badPy, logFile);
    const venv = join(root, "nautilus-venv");

    const run = spawnSync(
      "bash",
      [scriptPath, "--checkout", checkout, "--venv", venv],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        },
      }
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("version mismatch");
  });
});
