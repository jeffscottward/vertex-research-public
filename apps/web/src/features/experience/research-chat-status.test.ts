import {
  VertexResearchChatDebateRunReasonCodeSchema,
  VertexResearchChatResponseReasonCodeSchema,
  type VertexResearchChatRosterEntry,
} from "@darkfactory/api/vertex";
import { describe, expect, it } from "vitest";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import {
  clockAt,
  corpusPinText,
  corpusText,
  deliveryText,
  endedText,
  jobStateText,
  jobText,
  notReadyText,
  pickerStateText,
  reasonText,
  receiptText,
  reportedText,
  responderProblem,
  serverClock,
  unrecordedText,
} from "./research-chat-status.ts";

const at = Date.UTC(2026, 10, 19, 14, 2);
const stamp = "2026-11-19T14:02:00.123456789Z";
const entry = (
  overrides: Partial<VertexResearchChatRosterEntry> = {}
): VertexResearchChatRosterEntry => ({
  availability: "unavailable",
  corpus: {
    collectionId: null,
    reviewId: null,
    snapshotSha256: null,
    status: "incomplete",
  },
  displayName: "Expert A",
  kind: "expert",
  participantId: "expert-a",
  reasonCodes: [],
  specialty: "Corpus perspective",
  ...overrides,
});

describe("research chat status text", () => {
  it("shows a server time as a local clock and keeps text that is not a time", () => {
    expect(clockAt(at)).toMatch(/^\d{2}:\d{2} \S+/u);
    expect(serverClock(stamp)).toBe(clockAt(at));
    return expect(serverClock("not-a-time")).toBe("not-a-time");
  });

  it("describes every contract reason code and names a code it has no description for", () => {
    for (const code of VertexResearchChatResponseReasonCodeSchema.options) {
      // A described code is a sentence, never the fallback and never the bare code.
      const text = reasonText([code]);
      expect(text).not.toBe(code);
      expect(text).not.toMatch(/^code /u);
    }
    for (const code of [
      "research-chat-agent-admission-unavailable",
      "first-mate-configuration-unavailable",
      "governed-prepare-required",
      "corpus-not-qualified",
      "tools-not-integrated",
      ...VertexResearchChatDebateRunReasonCodeSchema.options,
    ])
      expect(reasonText([code])).not.toMatch(/^code /u);
    expect(reasonText(["worker-unavailable", "deadline"])).toBe(
      "the server reported that no research worker could take this request and gave no further cause; nothing was sent; retry later or ask the operator; the request deadline passed before the server finished; prepare again"
    );
    expect(reasonText(["first-mate-configuration-unavailable"])).toBe(
      "no current First Mate advisory configuration could be read (missing, expired, or the read failed); ask the operator to check the advisory configuration"
    );
    // A read that did not complete, a denied read and "no eligible answer" stay distinct.
    expect(
      new Set(
        [
          "projection-unavailable",
          "projection-read-failed",
          "projection-read-denied",
        ].map((code) => reasonText([code]))
      ).size
    ).toBe(3);
    expect(reasonText(["research-runtime-not-configured"])).toContain(
      "not enabled on this deployment"
    );
    return expect(reasonText(["new-code"])).toBe(
      "code new-code (this page has no description for it)"
    );
  });

  it("shows the specific cause and leaves out the broad code it narrows", () => {
    const broad = reasonText(["projection-unavailable"]);
    expect(broad).toContain("not produced yet, expired or revoked");
    for (const cause of [
      "response-not-recorded",
      "response-not-produced",
      "response-publication-unconfirmed",
      "response-input-copies-unconfirmed",
      "response-authority-closed",
      "response-check-incomplete",
    ]) {
      const text = reasonText(["projection-unavailable", cause]);
      expect(text).toBe(reasonText([cause]));
      expect(text).not.toContain(broad);
    }
    expect(reasonText(["projection-unavailable", "deadline"])).toBe(
      `${broad}; ${reasonText(["deadline"])}`
    );
    expect(reasonText(["outcome-unknown", "worker-outcome-unconfirmed"])).toBe(
      "the worker has not reported the outcome of this job; it reconciles when the job lease ends; inspect the same request key then and do not send a replacement"
    );
    expect(reasonText(["response-authority-closed"])).toContain(
      "the server does not say which"
    );
    // A record this account cannot read and a missing one get the same text, with no
    // claim about whether an answer exists.
    expect(reasonText(["response-not-recorded"])).toBe(
      "the server found no worker record for this request that this account can read; check the request key, or prepare a new request"
    );
    return expect(reasonText(["response-check-incomplete"])).toContain(
      "a proof record is missing or a runtime it needs is not configured"
    );
  });

  it("adds the lease end to a job that is not finished, and to no other job", () => {
    const leaseExpiresAt = "2026-09-22T12:10:00.000000001Z";
    const endMs = Date.parse(leaseExpiresAt);
    const clock = serverClock(leaseExpiresAt);
    for (const state of ["leased", "running", "unknown"] as const) {
      const job = { jobId: "job-1", leaseExpiresAt, state };
      expect(jobText(job, endMs - 60_000)).toBe(
        `${jobStateText(state)}; job lease ends ${clock}`
      );
      // A lease end that has passed is not shown as still ahead.
      for (const now of [endMs, endMs + 60_000])
        expect(jobText(job, now)).toBe(
          `${jobStateText(state)}; job lease ended ${clock}`
        );
      expect(jobText({ jobId: "job-1", state }, endMs)).toBe(
        jobStateText(state)
      );
    }
    for (const state of ["succeeded", "failed", "cancelled"] as const)
      expect(jobText({ jobId: "job-1", leaseExpiresAt, state }, endMs)).toBe(
        jobStateText(state)
      );
    expect(clock).toMatch(/^\d{2}:\d{2} \S+$/u);
    // Not today: the date is added, before and after the lease end.
    const running = {
      jobId: "job-1",
      leaseExpiresAt,
      state: "running",
    } as const;
    expect(jobText(running, endMs + 3 * 86_400_000)).toMatch(
      /; job lease ended [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} \S+$/u
    );
    expect(jobText(running, endMs - 3 * 86_400_000)).toMatch(
      /; job lease ends [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} \S+$/u
    );
    return expect(
      jobText({ ...running, leaseExpiresAt: "not a time" }, endMs)
    ).toBe("running; job lease end not a time");
  });

  it("names every job, delivery, receipt and corpus state", () => {
    const jobs = (
      [
        "leased",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ] as const
    ).map(jobStateText);
    expect(new Set(jobs).size).toBe(6);
    expect(jobs[5]).toBe(
      "no result: the worker lease or deadline ended before the worker reported one; this state does not resolve by waiting; inspect the same request key and do not send a replacement"
    );
    expect(deliveryText({ status: "not-applicable" })).toBe(
      "none, because the request was not admitted"
    );
    expect(deliveryText({ status: "pending" })).toBe(
      "pending, the worker has not finished"
    );
    expect(deliveryText({ status: "eligible" })).toBe("answer ready to append");
    expect(
      deliveryText({
        message: { messageId: "agent-2", sequence: "2", threadRevision: "3" },
        status: "appended",
      })
    ).toBe("appended to the conversation");
    expect(
      deliveryText({ reasonCodes: ["cancelled"], status: "unavailable" })
    ).toBe("not deliverable (the job was cancelled; no answer was produced)");
    expect(receiptText({ reasonCodes: [], status: "admitted" })).toBe(
      "admitted"
    );
    expect(
      receiptText({ reasonCodes: ["policy-revoked"], status: "unavailable" })
    ).toBe(
      "not admitted (the governing policy or approval was revoked; prepare a new request)"
    );
    expect(corpusText("unknown")).toBe(
      "review status not reported by the server"
    );
    expect(corpusText("incomplete")).toBe("incomplete");
    expect(corpusText("reviewed")).toBe("reviewed");
    expect(corpusText("not-applicable")).toContain("no corpus by design");
    expect(corpusPinText("collection-a", "reviewed")).toBe("collection-a");
    return expect(corpusPinText(null, "incomplete")).toBe(
      "Not supplied by roster (corpus incomplete)"
    );
  });

  it("gives the cause of a roster entry that cannot take a request", () => {
    expect(notReadyText(entry())).toBe("Not ready: corpus incomplete");
    // A picker line adds the corpus state only when the cause is not already that state.
    expect(pickerStateText(entry())).toBe("Not ready: corpus incomplete");
    expect(
      pickerStateText(entry({ reasonCodes: ["corpus-not-qualified"] }))
    ).toBe(
      "Not ready: the expert corpus has no accepted review yet · corpus incomplete"
    );
    expect(
      notReadyText(
        entry({ availability: "blocked", reasonCodes: ["rights-denied"] })
      )
    ).toBe(
      "Blocked: the source rights do not allow this use; choose other evidence"
    );
    return expect(
      notReadyText(
        entry({
          advisory: {
            authorization: "requires-governed-prepare",
            reasonCodes: ["research-runtime-not-configured"],
            status: "unavailable",
          },
          kind: "first-mate",
          participantId: "first-mate",
          reasonCodes: ["tools-not-integrated"],
        })
      )
    ).toBe(
      "Not ready: research-room coordination tools are not integrated; the research runtime is not enabled on this deployment; nothing was sent; ask the operator to enable it"
    );
  });

  it("names the first responder rule that a selection breaks", () => {
    const participants = [
      entry(),
      entry({ displayName: "Expert B", participantId: "expert-b" }),
    ];
    const members = new Set(["expert-a", "expert-b"]);
    const eligible = new Set(["expert-a"]);
    const problem = (requested: readonly string[]) =>
      responderProblem(requested, participants, members, eligible);
    expect(problem(["expert-a"])).toBeNull();
    expect(problem(Array.from({ length: 9 }, () => "expert-a"))).toBe(
      "9 responders are selected; the limit is 8"
    );
    expect(problem(["expert-a", "expert-a"])).toBe(
      "Expert A is selected twice"
    );
    expect(problem(["outside"])).toBe(
      "Participant outside is not in this room"
    );
    return expect(problem(["expert-b"])).toBe(
      "Expert B is not ready for a request"
    );
  });

  it("states what ended, when, why and the next step", () => {
    expect(
      endedText(
        { next: "Inspect this same key again.", what: "Inspect failed" },
        new VertexReadError("timed-out", { at, seconds: 12 }),
        at
      )
    ).toBe(
      `Inspect failed at ${clockAt(at)} (No response within 12s). Inspect this same key again.`
    );
    expect(reportedText("Preview not prepared", stamp, ["deadline"])).toBe(
      `Preview not prepared (checked ${clockAt(at)}): the request deadline passed before the server finished; prepare again`
    );
    expect(reportedText("Debate metadata not released", undefined, [])).toBe(
      "Debate metadata not released: the server sent no cause"
    );
    expect(reportedText("Debate metadata not released", stamp, [], stamp)).toBe(
      `Debate metadata not released (checked ${clockAt(at)}): the server sent no cause; window ended ${clockAt(at)}`
    );
    return expect(
      reportedText("Preview not prepared", undefined, undefined)
    ).toBe("Preview not prepared: the server sent no cause");
  });

  it("keeps an outcome that is not confirmed distinct from blocked and not done", () => {
    expect(
      unrecordedText({
        checkedAt: stamp,
        reasonCodes: ["model-input-approval-denied"],
        status: "blocked",
      })
    ).toBe(
      `Blocked (checked ${clockAt(at)}): the server denied this approval; nothing was sent to a model; prepare a new preview`
    );
    expect(
      unrecordedText({ reasonCodes: ["cancelled"], status: "unavailable" })
    ).toBe("Not done: the job was cancelled; no answer was produced");
    expect(
      unrecordedText({
        reasonCodes: ["outcome-unknown"],
        stage: "copies",
        startedAt: stamp,
        status: "unknown",
      })
    ).toBe(
      `Outcome not confirmed; last stage started: copies; call started ${clockAt(at)}`
    );
    return expect(
      unrecordedText({ reasonCodes: ["outcome-unknown"], status: "unknown" })
    ).toBe("Outcome not confirmed");
  });
});
