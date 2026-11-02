import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Python checks run the real research/control sources in a separate
// interpreter. An explicitly configured interpreter is always used as given and
// fails loudly if broken; only the unconfigured default skips when it cannot
// run the sources, so CI never depends on a private or unpinned local tool.

const defaultParityPython = resolve(
  import.meta.dirname,
  "../../../..",
  "private/tools/research-py312/bin/python"
);
const configuredParityPython = process.env["VERTEX_CHAT_PARITY_PYTHON"];
export const researchParityPython =
  configuredParityPython ?? defaultParityPython;
export const researchParityPythonSkip =
  configuredParityPython === undefined && !existsSync(defaultParityPython);
export const researchParityPythonSkipNote = `Python parity interpreter absent: ${defaultParityPython} (git-ignored local tool; set VERTEX_CHAT_PARITY_PYTHON to run)`;

// services/research/adapters/agno.py DEPENDENCIES: the real SDK invoke path
// refuses any other version, so these pins decide whether it can run at all.
export const RESEARCH_SDK_DISTRIBUTIONS = {
  agno: "1.7.12",
  openai: "1.93.0",
  httpx: "0.28.1",
} as const;
// services/contracts/python pins the WHATWG URL backend used by native semantics.
export const CONTRACTS_URL_DISTRIBUTIONS = { "ada-url": "4.0.0" } as const;

type Distributions = Readonly<Record<string, string | null>>;
const probes = new Map<string, readonly string[]>();
const missingDistributions = (
  python: string,
  distributions: Distributions
): readonly string[] => {
  const key = JSON.stringify([python, distributions]);
  const cached = probes.get(key);
  if (cached !== undefined) return cached;
  const program = [
    "import json, sys",
    "from importlib import metadata",
    "missing = []",
    "for name, pinned in json.load(sys.stdin).items():",
    "    try:",
    "        found = metadata.version(name)",
    "    except metadata.PackageNotFoundError:",
    "        found = None",
    "    if found is None or (pinned is not None and found != pinned):",
    "        missing.append(name + ('' if pinned is None else '==' + pinned))",
    "print(json.dumps(missing))",
  ].join("\n");
  const result = spawnSync(python, ["-c", program], {
    input: JSON.stringify(distributions),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 65_536,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const missing: readonly string[] =
    result.status === 0
      ? JSON.parse(result.stdout)
      : [`interpreter ${python} unavailable`];
  probes.set(key, missing);
  return missing;
};

// Resolve the interpreter named by `variable` (default python3) and decide
// whether a test that needs the given distributions must skip.
export const pinnedPython = (
  variable: string,
  distributions: Distributions
): Readonly<{ python: string; skip: boolean; note: string }> => {
  const configured = process.env[variable];
  const python = configured ?? "python3";
  const missing =
    configured === undefined ? missingDistributions(python, distributions) : [];
  return {
    python,
    skip: missing.length > 0,
    note: `python3 lacks ${missing.join(", ")}; set ${variable} to an interpreter with the pinned distributions to run`,
  };
};
