import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Public repository (2026-11-05): the install scripts name no real host. They read
// the rig's tailnet addresses from the host-local /etc/vertex/hosts.env on QuantVPS
// and stop before any change when the value is missing or malformed. The test runs
// only the host-config lines of each script, against a temporary file.
const HOSTS_ENV = "/etc/vertex/hosts.env";
const SCRIPTS = [
  "history/install-history.sh",
  "portfolio/install-portfolio.sh",
  "recovery/install-recovery.sh",
  "status/install-tailnet.sh",
] as const;
const rigLine = (value: string): string => `VERTEX_RIG_IPS=${value}\n`;
const TAILNET_LITERAL = /\b100\.\d+\.\d+\.\d+\b|fd7a:|\.ts\.net\b/u;

const source = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), "utf8");

const hostConfigLines = (text: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("RIG_IPS=$("));
  if (start < 0) throw new Error("RIG_IPS host-config line not found");
  return lines.slice(start, start + 2).join("\n");
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const runHostConfig = (rel: string, hosts: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "vtx-hosts-"));
  dirs.push(dir);
  const path = join(dir, "hosts.env");
  if (hosts !== undefined) writeFileSync(path, hosts);
  const program = `set -euo pipefail\n${hostConfigLines(source(rel)).replace(
    HOSTS_ENV,
    path
  )}\necho "rig=[$RIG_IPS]"\n`;
  return spawnSync("bash", ["-c", program], { encoding: "utf8" });
};

describe.each(SCRIPTS)("%s host config", (rel) => {
  it("names no tailnet address and reads VERTEX_RIG_IPS from the host file", () => {
    const text = source(rel);
    expect(text).not.toMatch(TAILNET_LITERAL);
    expect(hostConfigLines(text)).toContain(
      `sed -n 's/^VERTEX_RIG_IPS=//p' ${HOSTS_ENV}`
    );
  });

  it("uses the last VERTEX_RIG_IPS line", () => {
    const result = runHostConfig(
      rel,
      "# host config\nVERTEX_RIG_IPS=100.64.0.1\nVERTEX_RIG_IPS=100.64.0.20 fd7a:115c:a1e0::20\n"
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("rig=[100.64.0.20 fd7a:115c:a1e0::20]\n");
  });

  it.each([
    ["no host file", undefined],
    ["no key", "VERTEX_TAILNET_IPV4=100.64.0.10\n"],
    ["an empty value", "VERTEX_RIG_IPS=\n"],
    ["a sed delimiter", "VERTEX_RIG_IPS=100.64.0.20/g\n"],
    ["a quoted value", 'VERTEX_RIG_IPS="100.64.0.20"\n'],
    ["a token without a digit", rigLine("100.64.0.20 ::")],
  ])("stops with exit 3 before any change with %s", (_name, hosts) => {
    const result = runHostConfig(rel, hosts);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe(
      `VERTEX_RIG_IPS missing or malformed in ${HOSTS_ENV}; nothing changed\n`
    );
  });
});
