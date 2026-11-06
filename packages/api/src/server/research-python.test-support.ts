import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Python checks run the real research/control sources in a separate
// interpreter. VERTEX_TEST_PYTHON names that interpreter for every TS-side
// Python test. An explicitly configured interpreter is always used as given and
// fails loudly if broken. In CI (CI=true) the interpreter-only suites never
// skip: a missing VERTEX_TEST_PYTHON fails them instead.

export const TEST_PYTHON_VARIABLE = "VERTEX_TEST_PYTHON";
const configuredTestPython = process.env[TEST_PYTHON_VARIABLE];
// The interpreter for Python children; python3 on PATH when unset.
export const testPython = configuredTestPython ?? "python3";
// Interpreter-only suites skip only outside CI with no configured interpreter.
export const skipWithoutTestPython =
  configuredTestPython === undefined && process.env["CI"] !== "true";
// The configured interpreter, or an error that names the variable.
export const requireTestPython = (): string => {
  if (configuredTestPython === undefined)
    throw new Error(
      `Explicit existing ${TEST_PYTHON_VARIABLE} is required; no install or fallback`
    );
  return configuredTestPython;
};

const defaultParityPython = resolve(
  import.meta.dirname,
  "../../../..",
  "private/tools/research-py312/bin/python"
);
export const researchParityPython = configuredTestPython ?? defaultParityPython;
export const researchParityPythonSkip =
  configuredTestPython === undefined && !existsSync(defaultParityPython);
export const researchParityPythonSkipNote = `Python parity interpreter absent: ${defaultParityPython} (git-ignored local tool; set ${TEST_PYTHON_VARIABLE} to run)`;

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

// Resolve the test interpreter (default python3) and decide whether a test
// that needs the given distributions must skip.
export const pinnedPython = (
  distributions: Distributions
): Readonly<{ python: string; skip: boolean; note: string }> => {
  const missing =
    configuredTestPython === undefined
      ? missingDistributions(testPython, distributions)
      : [];
  return {
    python: testPython,
    skip: missing.length > 0,
    note: `python3 lacks ${missing.join(", ")}; set ${TEST_PYTHON_VARIABLE} to an interpreter with the pinned distributions to run`,
  };
};
