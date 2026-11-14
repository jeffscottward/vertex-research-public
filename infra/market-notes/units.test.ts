import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The wrapper is the copy of the installed ~/.local/bin/vertex-market-note. It runs here against a
// fake interpreter in a temp home, so no test reaches the API, yt-dlp, the GPU or a model.
const script = fileURLToPath(new URL("./vertex-market-note", import.meta.url));
const DEFAULT_RUNNER = "Github/trading/vertex-research-public-ticks-runner";
const KEY = "secret-write-key";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

interface Rig {
  env: Record<string, string>;
  keyFile: string;
  root: string;
}

const fakePython = (path: string, label: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "${label} args:$* key:\${VERTEX_AGENT_API_KEY:-none} origin:\${VERTEX_ORIGIN:-none} cwd:\${PWD#"$HOME"/}"\n`
  );
  chmodSync(path, 0o755);
};

const makeRig = (runner = "runner", python = true): Rig => {
  const root = mkdtempSync(join(tmpdir(), "market-note-units-"));
  roots.push(root);
  mkdirSync(join(root, runner, "services/research"), { recursive: true });
  if (python) {
    fakePython(
      join(root, runner, "services/research/.venv/bin/python"),
      "venv"
    );
  }
  const keyFile = join(root, "key");
  writeFileSync(keyFile, `${KEY}\n`);
  chmodSync(keyFile, 0o600);
  return {
    env: {
      HOME: root,
      MARKET_NOTES_KEY_FILE: keyFile,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      ...(runner === DEFAULT_RUNNER
        ? {}
        : { MARKET_NOTES_RUNNER_DIR: join(root, runner) }),
    },
    keyFile,
    root,
  };
};

const run = (rig: Rig, args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...rig.env, ...env },
  });

describe("vertex-market-note wrapper", () => {
  it("runs the market notes CLI in services/research with the key from its file", () => {
    const rig = makeRig();
    const result = run(rig, [
      "add",
      "https://youtu.be/abc",
      "--as-of",
      "2026-11-11",
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      `venv args:-m market_notes.cli add https://youtu.be/abc --as-of 2026-11-11 key:${KEY} origin:none cwd:runner/services/research`
    );
  });

  it("keeps an argument with spaces as one argument", () => {
    const rig = makeRig();
    writeFileSync(
      join(rig.root, "runner/services/research/.venv/bin/python"),
      '#!/usr/bin/env bash\nprintf "%s|" "$@"\n'
    );
    const result = run(rig, ["add", "owner text with  spaces; $(id) `id`"]);
    expect(result.stdout).toBe(
      "-m|market_notes.cli|add|owner text with  spaces; $(id) `id`|"
    );
  });

  it("defaults to the ticks runner checkout and the default key file", () => {
    const rig = makeRig(DEFAULT_RUNNER);
    mkdirSync(join(rig.root, ".config/vertex"), { recursive: true });
    writeFileSync(
      join(rig.root, ".config/vertex/agent-write-key"),
      "other-key\r\n"
    );
    chmodSync(join(rig.root, ".config/vertex/agent-write-key"), 0o400);
    const result = run(rig, ["list"], { MARKET_NOTES_KEY_FILE: "" });
    expect(result.stdout.trim()).toBe(
      `venv args:-m market_notes.cli list key:other-key origin:none cwd:${DEFAULT_RUNNER}/services/research`
    );
  });

  it("sources the nonsecret settings file when it exists", () => {
    const rig = makeRig();
    const other = join(rig.root, "opt/python");
    fakePython(other, "other");
    mkdirSync(join(rig.root, ".config/vertex"), { recursive: true });
    writeFileSync(
      join(rig.root, ".config/vertex/market-notes.env"),
      `VERTEX_ORIGIN=https://vertex.example.com\nMARKET_NOTES_PYTHON=${other}\n`
    );
    const result = run(rig, ["list"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `other args:-m market_notes.cli list key:${KEY} origin:https://vertex.example.com cwd:runner/services/research`
    );
  });

  it("refuses a settings file that group or others can write", () => {
    for (const mode of [0o660, 0o606, 0o666, 0o622]) {
      const rig = makeRig();
      const file = join(rig.root, "settings.env");
      writeFileSync(file, "VERTEX_ORIGIN=https://evil.example.com\n");
      chmodSync(file, mode);
      const result = run(rig, ["list"], { MARKET_NOTES_ENV_FILE: file });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("group and others cannot write");
    }
    const rig = makeRig();
    const file = join(rig.root, "settings.env");
    writeFileSync(file, "VERTEX_ORIGIN=https://vertex.example.com\n");
    chmodSync(file, 0o644);
    expect(
      run(rig, ["list"], { MARKET_NOTES_ENV_FILE: file }).stdout
    ).toContain("origin:https://vertex.example.com");
  });

  // A fake `stat` first on PATH stands in for a file of another owner or a `stat` that prints nothing.
  const withFakeStat = (rig: Rig, output: string): Record<string, string> => {
    const bin = join(rig.root, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "stat"),
      `#!/usr/bin/env bash\nprintf '%s' '${output}'\n`
    );
    chmodSync(join(bin, "stat"), 0o755);
    return { PATH: `${bin}:${rig.env["PATH"] ?? ""}` };
  };

  it("refuses a settings file of another owner, and fails closed when stat prints nothing", () => {
    const otherOwner = `${(process.getuid?.() ?? 0) + 1} 600`;
    for (const output of [otherOwner, "", "600", "x 600", "1000 rw-", "\n"]) {
      const rig = makeRig();
      const file = join(rig.root, "settings.env");
      writeFileSync(file, "VERTEX_ORIGIN=https://evil.example.com\n");
      chmodSync(file, 0o600);
      const result = run(rig, ["list"], {
        MARKET_NOTES_ENV_FILE: file,
        ...withFakeStat(rig, output),
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `${file} must be a readable file of the current user that group and others cannot write`
      );
    }
    // The same fake with this user's id and a safe mode passes the settings check.
    const rig = makeRig();
    const file = join(rig.root, "settings.env");
    writeFileSync(file, "VERTEX_ORIGIN=https://vertex.example.com\n");
    const result = run(rig, ["list"], {
      MARKET_NOTES_ENV_FILE: file,
      ...withFakeStat(rig, `${process.getuid?.() ?? 0} 600`),
    });
    // The fake prints the same text for the key file, which is not a plain owner-only mode.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be readable by its owner only");
  });

  it("fails closed on the key file when stat prints nothing", () => {
    const rig = makeRig();
    const result = run(rig, ["list"], withFakeStat(rig, ""));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `vertex-market-note: ${rig.keyFile} must be readable by its owner only (chmod 600)\n`
    );
  });

  it("refuses two different origins, so the key cannot go to one that the calling shell adds", () => {
    const refusal = "VERTEX_API_URL and VERTEX_ORIGIN are both set and differ";
    // The settings file names the origin; the calling shell adds the variable that the client reads first.
    const rig = makeRig();
    const file = join(rig.root, "settings.env");
    writeFileSync(file, "VERTEX_ORIGIN=https://vertex.example.com\n");
    chmodSync(file, 0o600);
    const hijack = run(rig, ["list"], {
      MARKET_NOTES_ENV_FILE: file,
      VERTEX_API_URL: "https://evil.example.com",
    });
    expect(hijack.status).toBe(2);
    expect(hijack.stdout).toBe("");
    expect(hijack.stderr).toContain(refusal);
    expect(hijack.stderr).not.toContain(KEY);
    // Without a settings file the same rule holds for the two shell variables.
    const both = run(makeRig(), ["list"], {
      VERTEX_API_URL: "https://a.example.com",
      VERTEX_ORIGIN: "https://b.example.com",
    });
    expect(both.status).toBe(2);
    expect(both.stderr).toContain(refusal);
    // Equal values (a final slash does not count) and one value alone are fine.
    const same = run(rig, ["list"], {
      MARKET_NOTES_ENV_FILE: file,
      VERTEX_API_URL: "https://vertex.example.com/",
    });
    expect(same.status).toBe(0);
    expect(same.stdout).toContain("origin:https://vertex.example.com");
    const one = run(makeRig(), ["list"], {
      VERTEX_API_URL: "https://vertex.example.com",
    });
    expect(one.status).toBe(0);
  });

  it("refuses a key file with group or other permission bits and never prints the key", () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o601, 0o610]) {
      const rig = makeRig();
      chmodSync(rig.keyFile, mode);
      const result = run(rig, ["list"]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `vertex-market-note: ${rig.keyFile} must be readable by its owner only (chmod 600)\n`
      );
      expect(result.stderr).not.toContain(KEY);
    }
  });

  it("exits 2 when the key file is missing or empty", () => {
    const missing = makeRig();
    rmSync(missing.keyFile);
    const first = run(missing, ["list"]);
    expect(first.status).toBe(2);
    expect(first.stdout).toBe("");
    expect(first.stderr).toContain(
      "the write key file is missing or not readable"
    );
    const empty = makeRig();
    writeFileSync(empty.keyFile, "\n");
    const second = run(empty, ["list"]);
    expect(second.status).toBe(2);
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain("is empty");
  });

  it("exits 127 with the install hint when the research interpreter is missing", () => {
    const rig = makeRig("runner", false);
    const result = run(rig, ["list"]);
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `the research interpreter is not installed (${rig.root}/runner/services/research/.venv/bin/python)`
    );
    expect(result.stderr).toContain("requirements-linux-py312.lock");
    expect(result.stderr).not.toContain(KEY);
  });

  it("passes the exit code of the CLI through", () => {
    const rig = makeRig();
    writeFileSync(
      join(rig.root, "runner/services/research/.venv/bin/python"),
      "#!/usr/bin/env bash\nexit 1\n"
    );
    expect(run(rig, ["add", "x"]).status).toBe(1);
  });

  it("holds no key, no cookie option and no CPU fallback", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain('exec "$PY" -m market_notes.cli "$@"');
    expect(text).not.toMatch(/--cookies|browser|device|MIN_FREE_MIB|set -x/u);
    expect(text).not.toMatch(/echo[^\n]*VERTEX_AGENT_API_KEY/u);
  });
});
