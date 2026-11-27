// Command line of the recorder of the agent semantic-layer eval (docs/vertex-rebuild/agent-semantic-layer.md):
// every question of tests/integration/semantic-layer/questions.ts, TRIALS times, through the real
// Plan-mode assistant turn against the eval backend (real Postgres + synthetic feeds). The model is
// bridged over stdio so that an OMP session can answer each call with its completion model (no new
// provider). Start it through the bridge: `bun run eval:semantic:record -- [--expect=<n>] [trials]
// [concurrency] [stale | ids...]` (record-session.ts starts the OMP session, bridge.ts starts this
// file). Arguments of this file: [--expect=<n>] [trials] [concurrency] [stale | ids...];
// trials is the number of trials for each question (default 3), concurrency the number of trials
// that run at the same time (default 6).
//   stdout: "@@EVAL " + one message, each on one line. This file prints nothing else on stdout.
//     {"type":"request","key","messages","tools"}   one model call; key = <question>.<trial>#<call>
//     {"type":"selected","keys","reasons"}          the trials of the run, before the first request
//     {"type":"done","key"} / {"type":"failed","key","reason"}   one trial stored / not stored
//     {"type":"finished","count","recorded","failed","notStarted"}   the last line of a recording run
//   stdin:  one JSON object on each line, for each request one of
//     {"key","content","toolCalls":[{"name","arguments"}],"model"}   the model reply
//     {"key","fault"}                                                no model reply: the trial fails
//     A JSON line with a waiting request's key but wrong shape fails only that request as a fault;
//     only non-JSON lines, keyless lines, or unknown-key lines close the bridge and end the run.
//   stderr: the turn log of each trial, and errors.
// Selection (recorder.ts):
//   no ids:  every question; a run that stores every trial drops all other trials and keeps the header.
//   ids:     those questions.
//   stale:   every recorded trial that must be recorded again, every missing trial, and one witness
//            trial for each question whose trials all saw an older tool list. With nothing to record
//            it does not write the recording; it writes the master-rules freeze when its replay
//            froze a search.
//   --expect=<n>: the run stops before the first model request when it selects another number of
//            trials than n. It prints the selection, stores nothing and ends with exit code 1. With
//            `--expect=0` and no bridge this shows what a `stale` run would record.
// Each finished trial is written at once to tests/integration/semantic-layer/eval-recording.fixture.json
// (synthetic data only), so a run that fails or is killed keeps its finished trials: run `stale` again.
// A new trial has no `audit` grade until it is graded; the replay test fails on it until then. Grade
// it by the procedure in the note on the grader change of 2026-11-20 in the document above. Do not
// write grades into the file while a recording runs.
// A wrong-model stop starts no further trial; a trial that is running then ends as usual and is
// stored when its own replies come from the recording model.
// Exit code: 0 every selected trial is stored; 1 a trial failed or the run stopped (a reply from
// another model, a fatal stdin line, or a selection of another size than --expect); 2 wrong arguments.

import { fileURLToPath } from "node:url";

import { startEvalBackend } from "./harness.ts";
import { EVAL_QUESTIONS } from "./questions.ts";
import { createBridgeModel, recordRun } from "./recorder.ts";
import {
  parseCount,
  parseSelection,
  type RecordSelection,
} from "./recording.ts";

const RECORDING = fileURLToPath(
  new URL("./eval-recording.fixture.json", import.meta.url)
);
const MASTER_RULES = fileURLToPath(
  new URL("./master-rules.fixture.json", import.meta.url)
);
const NOTE =
  "Synthetic data only (docs/vertex-rebuild/agent-semantic-layer/fixture.sql and tests/integration/semantic-layer/fixtures.ts). Recorded with the OMP completion model through the real Plan-mode assistant turn.";

const send = (message: object): void => {
  process.stdout.write(`@@EVAL ${JSON.stringify(message)}\n`);
};

let trials: number;
let concurrency: number;
let selection: RecordSelection;
let expectSelected: number | undefined;
try {
  const argv = process.argv.slice(2);
  const expect = argv.find((arg) => arg.startsWith("--expect="));
  if (expect !== undefined) {
    const value = expect.slice("--expect=".length);
    if (!/^\d+$/u.test(value)) {
      throw new Error(`--expect needs a whole number, not "${value}".`);
    }
    expectSelected = Number(value);
  }
  const [trialsArg, concurrencyArg, ...selectors] = argv.filter(
    (arg) => arg !== expect
  );
  trials = parseCount("trials", trialsArg, 3);
  concurrency = parseCount("concurrency", concurrencyArg, 6);
  selection = parseSelection(
    selectors,
    EVAL_QUESTIONS.map((question) => question.id)
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const bridge = createBridgeModel({ input: process.stdin, send });
const backend = await startEvalBackend({ masterRules: "record" });
try {
  const finished = await recordRun({
    backend,
    concurrency,
    emit: (message) => {
      send(message);
      if (
        message.type === "selected" &&
        expectSelected !== undefined &&
        message.keys.length !== expectSelected
      ) {
        console.error(
          `The run selected ${message.keys.length} trials, expected ${expectSelected}: no trial is recorded.`
        );
      }
    },
    ...(expectSelected === undefined ? {} : { expectSelected }),
    files: { masterRules: MASTER_RULES, recording: RECORDING },
    // stdout carries the protocol and has one writer; the turn log goes to stderr.
    log: (entry) => {
      console.error(JSON.stringify(entry));
    },
    model: bridge.model,
    note: NOTE,
    questions: EVAL_QUESTIONS,
    selection,
    trials,
  });
  process.exitCode =
    Object.keys(finished.failed).length === 0 &&
    finished.notStarted.length === 0
      ? 0
      : 1;
} finally {
  await backend.close();
  bridge.close();
}
process.exit();
