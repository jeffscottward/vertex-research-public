import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  researchParityPython,
  researchParityPythonSkip,
  researchParityPythonSkipNote,
} from "../../packages/api/src/server/research-python.test-support.ts";
import {
  DEBATE_BRIDGE_PYTHON_PATH,
  DEBATE_BRIDGE_SCRIPT,
} from "../../packages/api/src/server/vertex-research-chat-debate-bridge.test-support.ts";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";

// Card vertex-debate-path-rule-closure-check (2026-11-15). The debate-five-turn shard
// runs on a pull request only when a changed path matches touches_debate in
// ci-changes.sh. The five-turn test starts a native consumer (DEBATE_BRIDGE_SCRIPT).
// Each first-party Python file that the consumer loads at start must match the rule;
// otherwise a change to that file skips the shard. This test imports the consumer as a
// module, with the interpreter, working folder and search path that the five-turn test
// uses, and names each loaded file under services/ that the rule misses. Importing runs
// the module-level code, not main(); the consumer has no import inside a function.
// Imports inside a function of another module are out of scope (the nightly run and
// the manual run before a deploy cover them).

const repo = fileURLToPath(new URL("../..", import.meta.url));
const changes = join(repo, "scripts/ci/ci-changes.sh");
const script = join(repo, DEBATE_BRIDGE_SCRIPT);

// Runs with -P, so sys.path gets no entry for the working folder. The program puts the
// script's folder first, as `python <script>` does, and PYTHONPATH follows. Request on
// stdin: {"module": "<name>", "folder": "<script folder>", "services": "<folder>"}.
// It prints the sorted absolute paths of the loaded modules under the services folder.
const loader = [
  "import importlib, json, sys",
  "from pathlib import Path",
  "request = json.load(sys.stdin)",
  'sys.path.insert(0, request["folder"])',
  'importlib.import_module(request["module"])',
  'services = Path(request["services"])',
  'files = {getattr(module, "__file__", None) for module in list(sys.modules.values())}',
  "loaded = {Path(file).resolve() for file in files if file}",
  "print(json.dumps(sorted(str(file) for file in loaded if file.is_relative_to(services))))",
].join("\n");

const LoadedFiles = z.array(z.string());

const loadedAtStart = (): string[] => {
  const result = spawnSync(researchParityPython, ["-P", "-c", loader], {
    cwd: join(repo, "services/research"),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: DEBATE_BRIDGE_PYTHON_PATH.map((path) =>
        join(repo, path)
      ).join(":"),
    },
    input: JSON.stringify({
      folder: dirname(script),
      module: basename(script, ".py"),
      services: join(repo, "services"),
    }),
    maxBuffer: 1_048_576,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `importing the debate consumer failed: ${result.error?.message ?? result.stderr}`
    );
  }
  return LoadedFiles.parse(JSON.parse(result.stdout)).map((file) =>
    relative(repo, file)
  );
};

// Locally the test skips without a parity interpreter, like the five-turn test. Unlike
// that test it never skips in GitHub Actions, where scripts/ci/test-python.sh sets the
// interpreter: a missing interpreter fails it there.
const skip =
  researchParityPythonSkip && process.env["GITHUB_ACTIONS"] !== "true";

describe.skipIf(skip)(
  `debate path rule closure${skip ? ` (${researchParityPythonSkipNote})` : ""}`,
  () => {
    it(
      "puts each Python file that the consumer loads at start under touches_debate",
      () => {
        const loaded = loadedAtStart();
        // The import reached each search path folder that the consumer uses today, so an
        // empty or cut list cannot pass.
        expect(loaded).toEqual(
          expect.arrayContaining([
            DEBATE_BRIDGE_SCRIPT,
            "services/research/agents/types.py",
            "services/research/knowledge/__init__.py",
            "services/market-data/vertex_market_data/calendar.py",
            "services/control-client/vertex_control/client.py",
          ])
        );
        const missed = execFileSync("bash", [changes, "debate-misses"], {
          encoding: "utf8",
          input: loaded.join("\n"),
        });
        expect(missed).toBe("");
      },
      scaledTimeout(90_000)
    );
  }
);
