import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The rig units for the breadth-90 tick are copies of the installed files in ~/.config/systemd/user
// and ~/.local/bin. The wrapper runs against a fake bun in a temp home, so no test runs a tick.
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const values = (text: string, key: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("vertex-breadth-90 units", () => {
  it("the timer runs the spec schedule on weekdays in New York time", () => {
    expect(values(read("vertex-breadth-90.timer"), "OnCalendar")).toEqual(
      [
        "10:30",
        "12:00",
        "13:30",
        "14:30",
        "15:00",
        "15:30",
        "15:45",
        "16:20",
        "17:00",
      ].map((time) => `Mon..Fri *-*-* ${time}:00 America/New_York`)
    );
    expect(values(read("vertex-breadth-90.timer"), "Persistent")).toEqual([
      "true",
    ]);
  });

  it("the service runs the wrapper from the runner checkout", () => {
    const service = read("vertex-breadth-90.service");
    expect(values(service, "ExecStart")).toEqual([
      "%h/.local/bin/vertex-breadth-90-run",
    ]);
    expect(values(service, "WorkingDirectory")).toEqual([
      "%h/Github/trading/vertex-research-public-ticks-runner",
    ]);
    expect(values(service, "Type")).toEqual(["oneshot"]);
  });

  const runWrapper = (env: Record<string, string>): string => {
    const root = mkdtempSync(join(homedir(), ".cache", "b90-units-"));
    roots.push(root);
    const bin = join(root, ".local/share/mise/installs/bun/1.4.2/bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "runner"));
    writeFileSync(
      join(bin, "bun"),
      '#!/usr/bin/env bash\necho "args:$* key:${VERTEX_AGENT_API_KEY:-none}"\n'
    );
    chmodSync(join(bin, "bun"), 0o755);
    writeFileSync(join(root, "key"), "secret-key\n");
    const script = fileURLToPath(
      new URL("./vertex-breadth-90-run", import.meta.url)
    );
    const result = spawnSync("bash", [script, "--mode", "final"], {
      encoding: "utf8",
      env: {
        BREADTH90_KEY_FILE: join(root, "key"),
        BREADTH90_RUNNER_DIR: join(root, "runner"),
        HOME: root,
        ...env,
      },
    });
    return result.stdout.trim();
  };

  it("the wrapper runs without push by default", () => {
    expect(runWrapper({})).toBe(
      "args:run vertex:breadth-90:tick --no-push --mode final key:none"
    );
  });

  it("the wrapper reads the write key only when push is enabled", () => {
    expect(
      runWrapper({ BREADTH90_PUSH: "1", VERTEX_ORIGIN: "https://v" })
    ).toBe("args:run vertex:breadth-90:tick --mode final key:secret-key");
  });
});
