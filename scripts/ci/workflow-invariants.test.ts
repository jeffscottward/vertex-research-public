import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { NAMED_SHARDS } from "../lib/coverage-lane.ts";

// Durable security and structure invariants for every GitHub workflow. Keep
// this file free of step text, versions and shell snippets: those are free to
// change without weakening the pipeline.

interface Step {
  "continue-on-error"?: unknown;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "continue-on-error"?: unknown;
  if?: string;
  name?: string;
  needs?: string | string[];
  "runs-on"?: unknown;
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown> };
  uses?: string;
}
interface Workflow {
  jobs: Record<string, Job>;
  on: unknown;
  permissions?: unknown;
}

const directory = new URL("../../.github/workflows/", import.meta.url);
const workflows = await Promise.all(
  (await readdir(directory))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map(async (file) => {
      const text = await readFile(new URL(file, directory), "utf8");
      return { file, text, workflow: parse(text) as Workflow };
    })
);
const jobs = workflows.flatMap(({ file, workflow }) => {
  return Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, job }));
});
const steps = jobs.flatMap(({ file, id, job }) => {
  return (job.steps ?? []).map((step) => ({ file, id, step }));
});
const triggers = (on: unknown): string[] => {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on as Record<string, unknown>);
};

// A Python CI script: a shell script in scripts/ci/ with "python" in its file name.
const pythonScript = /scripts\/ci\/[\w-]*python[\w-]*\.sh/u;
// The indexes of the steps that run a Python CI script without an earlier Python
// setup step in the same job: actions/setup-python, no condition, a version input,
// and the action's default update of PATH (the scripts find the interpreter there).
const pythonScriptStepsWithoutSetup = (jobSteps: Step[]): number[] => {
  return jobSteps.flatMap((step, index) => {
    if (!pythonScript.test(step.run ?? "")) return [];
    const ready = jobSteps.slice(0, index).some((earlier) => {
      const version =
        earlier.with?.["python-version"] ??
        earlier.with?.["python-version-file"];
      return (
        earlier.uses?.startsWith("actions/setup-python@") === true &&
        earlier.if === undefined &&
        typeof version === "string" &&
        version !== "" &&
        earlier.with?.["update-environment"] === undefined
      );
    });
    return ready ? [] : [index];
  });
};

describe("GitHub workflow invariants", () => {
  it("finds the workflow set", () => {
    return expect(workflows.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "ci.yml",
        "codeql.yml",
        "dependency-review.yml",
        "scorecard.yml",
      ])
    );
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    const parsedUses = [
      ...jobs.flatMap(({ job }) => job.uses ?? []),
      ...steps.flatMap(({ step }) => step.uses ?? []),
    ];
    const lines = workflows.flatMap(({ file, text }) => {
      return text
        .split("\n")
        .filter((line) => /^\s*(?:-\s+)?uses:/.test(line))
        .map((line) => ({ file, line: line.trim() }));
    });
    expect(lines).toHaveLength(parsedUses.length);
    expect(parsedUses.length).toBeGreaterThan(0);
    for (const { file, line } of lines) {
      expect(line, file).toMatch(
        /^(?:-\s+)?uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d[\w.-]*$/
      );
    }
  });

  it("never triggers on pull_request_target", () => {
    for (const { file, workflow } of workflows) {
      expect(triggers(workflow.on), file).not.toContain("pull_request_target");
    }
  });

  // Bundled Playwright Chromium lags Chrome stable security fixes (card
  // sec-pw-ci-vertex-research-platform, 2026-11-03). Browser jobs use the
  // runner's Google Chrome through the "chrome" channel.
  it("never installs Playwright's bundled Chromium", () => {
    for (const { file, id, step } of steps) {
      expect(step.run ?? "", `${file} ${id}`).not.toMatch(
        /playwright\s+install\b[^\n]*\bchromium/u
      );
    }
  });

  // Vertex development and CI moved to the public repository (owner 2026-11-04,
  // card vertex-ci-github-hosted). A public repository lets fork pull requests start
  // workflows, so no job may use a self-hosted runner: every job runs on a
  // GitHub-hosted runner, which is free for public repositories.
  it("runs every job on GitHub-hosted runners", () => {
    expect(jobs.length).toBeGreaterThan(0);
    for (const { file, id, job } of jobs) {
      const runsOn = JSON.stringify(job["runs-on"] ?? "");
      expect(runsOn, `${file}:${id}`).not.toMatch(/self-hosted|rig/u);
    }
  });

  it("defaults every workflow token to no or read-only permissions", () => {
    for (const { file, workflow } of workflows) {
      const permissions = workflow.permissions;
      if (permissions === "read-all") continue;
      expect(permissions, file).toBeTypeOf("object");
      expect(permissions, file).not.toBeNull();
      for (const scope of Object.values(
        permissions as Record<string, unknown>
      )) {
        expect(["read", "none"], file).toContain(scope);
      }
    }
  });

  it("never persists checkout credentials", () => {
    const checkouts = steps.filter(({ step }) => {
      return step.uses?.startsWith("actions/checkout@");
    });
    expect(checkouts.length).toBeGreaterThan(0);
    for (const { file, id, step } of checkouts) {
      expect(step.with?.["persist-credentials"], `${file}#${id}`).toBe(false);
    }
  });

  it("takes the CI Node.js version from .nvmrc", () => {
    const setups = steps.filter(({ step }) => {
      return step.uses?.startsWith("actions/setup-node@");
    });
    expect(setups.length).toBeGreaterThan(0);
    for (const { file, id, step } of setups) {
      expect(step.with?.["node-version-file"], `${file}#${id}`).toBe(".nvmrc");
      expect(step.with?.["node-version"], `${file}#${id}`).toBeUndefined();
    }
  });

  // Card vertex-ci-python312-missing (2026-11-18): the Python CI scripts need one
  // CPython version, and a runner image may lack it (the ubuntu-latest label moved
  // to an image without it, and every run failed). A job that runs one of these
  // scripts sets up Python itself, in an earlier step that always runs. The script
  // path is step text that this file needs on purpose: it is how a job shows the
  // need. The version is not repeated here; the scripts check it when they run.
  it("sets up Python before every Python CI script", () => {
    const scriptSteps = steps.filter(({ step }) => {
      return pythonScript.test(step.run ?? "");
    });
    expect(scriptSteps.length).toBeGreaterThan(0);
    for (const { file, id, job } of jobs) {
      expect(
        pythonScriptStepsWithoutSetup(job.steps ?? []),
        `${file}#${id}`
      ).toEqual([]);
    }
  });

  it("rejects a missing, late, conditional or versionless Python setup step", () => {
    const script: Step = { run: "bash scripts/ci/test-python.sh venv" };
    const setup: Step = {
      uses: "actions/setup-python@0",
      with: { "python-version": "3.x" },
    };
    const fromFile: Step = {
      ...setup,
      with: { "python-version-file": ".python-version" },
    };
    expect(pythonScriptStepsWithoutSetup([setup, script])).toEqual([]);
    expect(pythonScriptStepsWithoutSetup([fromFile, script])).toEqual([]);
    expect(pythonScriptStepsWithoutSetup([script])).toEqual([0]);
    expect(pythonScriptStepsWithoutSetup([script, setup])).toEqual([0]);
    expect(
      pythonScriptStepsWithoutSetup([{ ...setup, if: "always()" }, script])
    ).toEqual([1]);
    expect(
      pythonScriptStepsWithoutSetup([{ ...setup, with: {} }, script])
    ).toEqual([1]);
    // YAML reads an unquoted version as a number (3.10 becomes 3.1).
    expect(
      pythonScriptStepsWithoutSetup([
        { ...setup, with: { "python-version": 3.1 } },
        script,
      ])
    ).toEqual([1]);
    expect(
      pythonScriptStepsWithoutSetup([
        {
          ...setup,
          with: { "python-version": "3.x", "update-environment": false },
        },
        script,
      ])
    ).toEqual([1]);
  });

  it("runs exactly the four CI verification lanes", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const lanes = Object.values(ci.workflow.jobs).flatMap(
      (job) => job.strategy?.matrix?.["lane"] ?? []
    );
    // The coverage lane is its own job (it waits for the shards), so compare
    // the set of lanes, not the job order.
    return expect([...lanes].sort()).toEqual([
      "browser",
      "core",
      "coverage",
      "integration",
    ]);
  });

  // Card vertex-agent-review-enforcement: the review and owner-decision lines are
  // part of the single required check.
  it("makes ci-gate require the merge-conditions job", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    expect(ci.workflow.jobs["ci-gate"]?.needs).toContain("merge-conditions");
    expect(ci.text).toContain('"${MERGE_CONDITIONS}" == success');
    // The base copy of the gate runs, not the PR's.
    return expect(ci.text).toContain(
      'git show "${BASE_SHA}:scripts/ci/merge-conditions.ts"'
    );
  });

  // Owner 2026-11-01: PR runs and non-live-line push runs replace older runs of the
  // same PR or branch. Owner 2026-11-02: live-line push runs share one group without
  // cancel-in-progress, so a running run finishes and only a queued one is replaced.
  // Manual runs are never cancelled.
  it("cancels superseded PR and branch runs and batches queued live-line runs", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const { concurrency } = ci.workflow as unknown as {
      concurrency: { group: string; "cancel-in-progress": string };
    };
    expect(concurrency.group).toContain(
      "github.event_name == 'workflow_dispatch' && format('run-{0}', github.run_id)"
    );
    expect(concurrency.group).toContain(
      "github.event.pull_request.number || github.ref"
    );
    return expect(concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref != 'refs/heads/vertex/rebuild-darkfactory-20260921') }}"
    );
  });

  // Owner 2026-11-11 (card vertex-code-stewardship): the template init acceptance shard
  // is the longest job. It runs on the nightly run and when the changes job plans it
  // (scripts/ci/ci-changes.sh); the coverage lane then requires its report.
  it("runs the acceptance shard nightly and only when the changes job plans it", async () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const on = ci.workflow.on as Record<string, unknown>;
    expect(on["schedule"]).toEqual([{ cron: expect.any(String) }]);
    const { concurrency } = ci.workflow as unknown as {
      concurrency: { group: string };
    };
    // Its own group: the nightly run never replaces a queued live-line run.
    expect(concurrency.group).toContain(
      "github.event_name == 'schedule' && format('nightly-{0}', github.run_id)"
    );
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & {
        outputs?: Record<string, string>;
        steps?: (Step & { env?: Record<string, string> })[];
      }
    >;
    expect(ciJobs["changes"]!.outputs).toMatchObject({
      acceptance: "${{ steps.plan.outputs.acceptance }}",
      debate: "${{ steps.plan.outputs.debate }}",
      shard_reports: "${{ steps.plan.outputs.shard_reports }}",
      skip_shards: "${{ steps.plan.outputs.skip_shards }}",
    });
    const matrix = ciJobs["coverage-shards"]!.strategy?.matrix;
    expect(matrix?.["shard"]).toContain("acceptance");
    expect(matrix?.["exclude"]).toBe(
      "${{ fromJSON(needs.changes.outputs.skip_shards) }}"
    );
    expect(matrix?.["shard"]).toContain("debate-five-turn");
    // The merge counts the reports against the plan. The changes job counts the
    // planned shards: 12 hashed shards plus the named shards that always run,
    // plus the acceptance and debate-five-turn shards when they are planned.
    expect(
      ciJobs["verification-coverage"]!.steps?.map((step) => step.env)
    ).toContainEqual({
      EXPECTED: "${{ needs.changes.outputs.shard_reports }}",
    });
    const alwaysNamed = NAMED_SHARDS.filter(
      (name) => name !== "acceptance" && name !== "debate-five-turn"
    );
    return expect(
      await readFile(new URL("ci-changes.sh", import.meta.url), "utf8")
    ).toContain(`BASE_SHARD_REPORTS=${12 + alwaysNamed.length}\n`);
  });

  // Card orochi-impl: every named coverage shard of scripts/lib/coverage-lane.ts
  // runs as its own matrix entry, so its files leave the hashed shards.
  it("runs every named coverage shard as its own matrix entry", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const ciJobs = ci.workflow.jobs as Record<string, Job>;
    const shards = ciJobs["coverage-shards"]!.strategy?.matrix?.["shard"];
    return expect(shards).toEqual([
      ...Array.from({ length: 12 }, (_, index) => `${index + 1}/12`),
      ...NAMED_SHARDS.filter((name) => name !== "acceptance"),
      "acceptance",
    ]);
  });

  // Card vertex-ci-queue-pathfilter (2026-11-02): one required check, a light lane
  // that never waits for the coverage shards, and no workflow-level path filters.
  it("gates every CI job behind ci-gate and keeps the light lane independent", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & { needs?: string | string[]; if?: string }
    >;
    const gate = ciJobs["ci-gate"]!;
    expect(gate.if).toBe("${{ always() }}");
    expect([...(gate.needs as string[])].sort()).toEqual(
      Object.keys(ciJobs)
        .filter((id) => id !== "ci-gate")
        .sort()
    );
    expect(ciJobs["verification"]!.needs).toBe("changes");
    expect(ciJobs["coverage-shards"]!.if).toBe(
      "needs.changes.outputs.heavy == 'true'"
    );
    const on = ci.workflow.on as Record<string, Record<string, unknown> | null>;
    expect(on["pull_request"]?.["types"]).toEqual(
      expect.arrayContaining([
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
      ])
    );
    for (const trigger of Object.values(on)) {
      expect(trigger?.["paths-ignore"]).toBeUndefined();
      expect(trigger?.["paths"]).toBeUndefined();
    }
  });

  it("scans tailnet names in the always-on Changes job, before lane planning", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const changes = ci.workflow.jobs["changes"]!;
    expect(changes.if).toBeUndefined();
    expect(changes["continue-on-error"]).toBeUndefined();
    const steps = changes.steps ?? [];
    const ids = steps.map((step) => step.id);
    const scan = steps.find((step) => step.id === "public-names")!;
    expect(scan.run).toMatch(/\bscripts\/public-names\.ts\b.*\$\{?RANGE\b/);
    // The step fails when the scan fails: no `||` fallback masks the exit code.
    expect(scan.run).not.toMatch(/\|\|/);
    expect(scan.env?.["RANGE"]).toMatch(
      /pull_request\.base\.sha.*pull_request\.head\.sha/
    );
    expect(scan.if).toBeUndefined();
    expect(scan["continue-on-error"]).toBeUndefined();
    expect(ids.indexOf("public-names")).toBeLessThan(ids.indexOf("plan"));
    const checkout = steps[0]!;
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    expect(checkout.with?.["sparse-checkout"]).toBeUndefined();
  });

  // Card vertex-ci-draft-ready-race (PR #84): the draft flag in the event can be
  // stale. Card vertex-agent-review-enforcement: the merge-conditions job reads the
  // live draft state from GitHub and reports enforced=true only when it checked a
  // ready PR; only then does a pull request run report the required "ci-gate". A
  // manual run never checks the merge conditions and reports "ci-gate (manual)".
  // A run whose changes job planned lanes for a draft stays "ci-gate (draft)" too.
  it("names the gate from the merge-conditions job's enforced output", () => {
    const ci = workflows.find(({ file }) => file === "ci.yml")!;
    const ciJobs = ci.workflow.jobs as Record<
      string,
      Job & { outputs?: Record<string, string> }
    >;
    expect(ciJobs["changes"]!.outputs?.["draft"]).toBe(
      "${{ steps.plan.outputs.draft }}"
    );
    expect(ciJobs["merge-conditions"]!.outputs?.["enforced"]).toBe(
      "${{ steps.check.outputs.enforced }}"
    );
    return expect(ciJobs["ci-gate"]!.name).toBe(
      "${{ github.event_name == 'workflow_dispatch' && 'ci-gate (manual)' || github.event_name == 'pull_request' && (needs.merge-conditions.outputs.enforced != 'true' || github.event.pull_request.draft && needs.changes.outputs.draft != 'false') && 'ci-gate (draft)' || 'ci-gate' }}"
    );
  });

  // CI copies the two gate files alone from the base commit, so they may import
  // only node: builtins and each other.
  it("keeps the merge-conditions gate self-contained", async () => {
    for (const file of ["../merge-conditions.ts", "merge-conditions.ts"]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(
          spec === "./ci/merge-conditions.ts" || spec?.startsWith("node:"),
          `${file}: ${spec}`
        ).toBe(true);
      }
    }
  });

  return it("keeps the job names that required status checks reference", () => {
    const names = jobs.map(({ job }) => job.name);
    return expect(names).toEqual(
      expect.arrayContaining([
        "Verification (${{ matrix.lane }})",
        "Analyze (${{ matrix.language }})",
        "Dependency Review",
      ])
    );
  });
});
