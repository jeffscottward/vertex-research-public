import { createHash } from "node:crypto";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CopilotChatView,
  type CopilotChatInputProps,
  type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import { describe, expect, it, vi } from "vitest";
import {
  VertexResearchChatAgentReferenceMessageSchema,
  VertexResearchChatAdvisoryProfileSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
  type VertexResearchChatAgentReferenceMessage,
  type VertexResearchChatRosterEntry,
  type VertexResearchChatThread,
} from "@darkfactory/api/vertex";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import type {
  ResearchConversationControls,
  ResearchPreparedCandidate,
  ResearchPrivateBody,
  ResearchPrivateView,
  ResearchHumanMessage,
} from "./research-chat-conversation.ts";
import {
  ResearchChatView,
  ResearchConversationPanel,
  ResearchPrivatePanel,
  ResearchReference,
  type ResearchChatViewProps,
} from "./research-chat-view.tsx";
import { VertexResearchChatDebatePrepareOutputSchema } from "@darkfactory/api/vertex";

// Synthetic contract records only; no provider, agent runtime or network mock.
const thread: VertexResearchChatThread = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  environment: "research",
  accountAlias: "fixture-account",
  threadId: "thread-a",
  title: "Synthetic research room",
  ownerActorId: "actor-a",
  participantIds: ["mate-a", "expert-a"],
  createdAt: "2026-09-23T10:00:00Z",
  updatedAt: "2026-09-23T10:00:00Z",
  revision: "1",
};
const participants: readonly VertexResearchChatRosterEntry[] = [
  {
    participantId: "mate-a",
    displayName: "Research coordinator",
    specialty: "Evidence synthesis",
    kind: "first-mate",
    availability: "ready",
    reasonCodes: [],
    corpus: {
      status: "unknown",
      collectionId: null,
      snapshotSha256: null,
      reviewId: null,
    },
  },
  {
    participantId: "expert-a",
    displayName: "Corpus specialist",
    specialty: "Market structure",
    kind: "expert",
    availability: "unavailable",
    reasonCodes: ["corpus-incomplete"],
    corpus: {
      status: "incomplete",
      collectionId: "corpus-a",
      snapshotSha256: null,
      reviewId: null,
    },
  },
];
const message = (
  overrides: Partial<ResearchHumanMessage> = {}
): ResearchHumanMessage => ({
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  threadId: "thread-a",
  messageId: "message-a",
  sequence: "1",
  author: { kind: "user", actorId: "actor-a" },
  kind: "statement",
  body: "Literal evidence\n<script>unsafe()</script>\n[Corpus specialist](https://invalid.example)",
  citations: [],
  recordedAt: "2026-09-23T10:00:00Z",
  ...overrides,
});
const props = (
  overrides: Partial<ResearchChatViewProps> = {}
): ResearchChatViewProps => ({
  selectedThread: thread,
  threads: [thread],
  messages: [message()],
  participants,
  loading: false,
  error: null,
  draft: "Research question",
  sending: false,
  responseStatus: null,
  responseReasonCodes: [],
  requestedParticipantIds: [],
  mode: "discuss",
  onDraftChange: vi.fn(),
  onRequestedParticipantsChange: vi.fn(),
  onModeChange: vi.fn(),
  onSelectThread: vi.fn(),
  onCreateThread: vi.fn(),
  onSendMessage: vi.fn(),
  onRetry: vi.fn(),
  ...overrides,
});
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const elements = (node: ReactNode): Element[] => {
  if (!isValidElement<Element["props"]>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
};
const boundary = (value: ResearchChatViewProps): CopilotChatViewProps => {
  const found = elements(ResearchChatView(value)).find(
    (node) => node.type === CopilotChatView
  );
  if (!found) throw new Error("Missing real controlled CopilotChatView");
  return found.props as unknown as CopilotChatViewProps;
};
const input = (value: ResearchChatViewProps): CopilotChatInputProps =>
  boundary(value).input as CopilotChatInputProps;
const html = (value: ResearchChatViewProps): string =>
  renderToStaticMarkup(<ResearchChatView {...value} />);

// Shape-only synthetic DTOs derived from the released conversation contract
// companion tests. They confer no source, privacy, storage or run authority.
const digest = "a".repeat(64);
const checkedAt = "2026-09-25T00:00:00.000Z";
const notAfter = "2026-09-25T01:00:00.000Z";
const artifact = (artifactId: string) => ({
  artifactId,
  artifactSha256: digest,
});
const nativeClaim = {
  text: "PRIVATE_NATIVE_CLAIM\n<script>claim()</script>",
  kind: "hypothesis",
  citations: [
    {
      evidence_id: "evidence-a",
      source_id: "source-a",
      source_snapshot_id: "source-snapshot-a",
      content_hash: digest,
      excerpt_digest: "b".repeat(64),
      quote: "PRIVATE_NATIVE_QUOTE\n[Not a link](https://synthetic.invalid)",
    },
  ],
};
const profile = VertexResearchChatAdvisoryProfileSchema.parse({
  profile: "vertex-research-chat-advisory-v1",
  responseRequestId: "response-a",
  planId: "plan-a",
  planSha256: digest,
  runId: "run-a",
  traceId: "trace-a",
  taskContract: "task-a",
  modelVersion: "model-a",
  modelUseRequestSha256: digest,
  responseSha256: digest,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    completionCostUsd: "0.01",
  },
  output: {
    claims: [nativeClaim],
    proposals: [
      {
        proposal_id: "proposal-a",
        kind: "backtest-request",
        title: "PRIVATE_NATIVE_PROPOSAL",
        rationale: nativeClaim,
        execution_authorized: false,
      },
    ],
    execution_authorized: false,
  },
  executionAuthorized: false,
});
const profileBytes = new TextEncoder().encode(canonicalArtifactJson(profile));
const profileDigest = createHash("sha256").update(profileBytes).digest("hex");
const reference = (
  overrides: Partial<VertexResearchChatAgentReferenceMessage> = {}
): VertexResearchChatAgentReferenceMessage =>
  VertexResearchChatAgentReferenceMessageSchema.parse({
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    threadId: "thread-a",
    messageId: "agent-3",
    sequence: "3",
    author: { kind: "agent", participantId: "expert-a", runId: "run-a" },
    kind: "advisory-reference",
    parentMessageId: "human-2",
    replyToMessageId: "message-a",
    response: {
      responseRequestId: "response-a",
      planId: "plan-a",
      planSha256: digest,
      requestSha256: digest,
      contextSha256: digest,
      snapshotRevision: "2",
      contextStartSequence: "1",
      jobId: "job-a",
      traceId: "trace-a",
      eventId: "event-a",
      runArtifact: artifact("run-a"),
      advisoryArtifact: {
        artifactId: "advisory-a",
        artifactSha256: profileDigest,
      },
      fenceAcknowledgementsSha256: digest,
    },
    recordedAt: checkedAt,
    ...overrides,
  });
const privateBody = (): ResearchPrivateBody => {
  const value = VertexResearchChatReadResponseContentOutputSchema.parse({
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    reference: reference(),
    checkedAt,
    status: "available",
    notAfter,
    profile,
    sha256: profileDigest,
    byteLength: profileBytes.byteLength,
  });
  if (value.status !== "available")
    throw new Error("Expected synthetic available content");
  return value;
};
const candidate = (): ResearchPreparedCandidate => {
  const value = VertexResearchChatPrepareResponseOutputSchema.parse({
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    status: "prepared",
    preview: {
      responseRequestId: "response-a",
      planId: "plan-a",
      planSha256: digest,
      request: {
        accountAlias: "fixture-account",
        environment: "research",
        threadId: "thread-a",
        parentMessageId: "message-a",
        participantId: "expert-a",
        snapshotRevision: "2",
        contextStartSequence: "1",
        retrievalQuery: "Exact  literal research query",
        idempotencyKey: "original-key",
      },
      context: {
        messageIds: ["message-a"],
        snapshotRevision: "2",
        contextStartSequence: "1",
        highWaterSequence: "1",
        messageCount: 1,
        sha256: digest,
        byteLength: 128,
      },
      expert: {
        participantId: "expert-a",
        configurationSha256: digest,
        modelVersion: "model-a",
      },
      inputs: {
        tokenizeInput: { sha256: digest, byteLength: 256 },
        completionInput: { sha256: digest, byteLength: 512 },
      },
      corpus: {
        collectionId: "collection-a",
        snapshotId: "snapshot-a",
        reviewPins: [
          {
            collectionId: "collection-a",
            evidenceId: "evidence-a",
            artifactId: "evidence-artifact-a",
            artifactSha256: digest,
            reviewId: "review-a",
            reviewVersion: "1.0.0",
            rightsPolicyId: "rights-a",
            rightsVersion: "1.0.0",
          },
        ],
      },
      model: {
        providerId: "provider-a",
        modelVersion: "model-a",
        servedModel: "served-model-a",
        modelPolicySha256: digest,
        destination: {
          scheme: "https",
          hostname: "synthetic.invalid",
          port: "8443",
        },
        tokenizeEndpoint: {
          ...artifact("tokenize-a"),
          endpointId: "tokenize-endpoint-a",
        },
        completionEndpoint: {
          ...artifact("completion-a"),
          endpointId: "completion-endpoint-a",
        },
      },
      retention: {
        policyId: "retention-a",
        policyVersion: "1.0.0",
        artifact: artifact("retention-artifact-a"),
        rules: [
          { kind: "context", cleanupTrigger: "response-attempt-terminal" },
          { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
          { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
        ],
        earlierCleanupTriggers: ["revocation", "rights-expiry"],
        readNotAfter: notAfter,
        guaranteedDeletionDeadline: null,
      },
      storage: {
        storageProfileSha256: digest,
        backendDeploymentId: "storage-a",
        evidence: artifact("storage-evidence-a"),
        namespace: "vertex/chat-copy/v1",
        createSemantics: "conditional-create-no-overwrite",
        readSemantics: "exact-bound-current-bytes-or-fenced",
        fenceSemantics: "conditional-permanent-tombstone-no-resurrection",
        retainedVersions: "no-application-readable-prior-content-version",
        claimScope: "application-managed-copy-namespace-only",
        excludedClaims: [
          "provider",
          "backups",
          "physical-media",
          "RAM",
          "exports",
        ],
      },
      checkedAt,
      notAfter,
    },
  });
  if (value.status !== "prepared")
    throw new Error("Expected synthetic prepared preview");
  return {
    preview: value.preview,
    messages: [message()],
    recordDigests: [
      createHash("sha256")
        .update(canonicalArtifactJson(message()))
        .digest("hex"),
    ],
    selectionKey: "fixture-selection",
    deadline: 15_000,
  };
};
const controls = (
  overrides: Partial<ResearchConversationControls> = {}
): ResearchConversationControls => ({
  start: "1",
  end: "1",
  query: "Exact  literal research query",
  expertId: "expert-a",
  busy: false,
  locked: false,
  candidate: null,
  status: "No request approved",
  operationKey: null,
  canAppend: false,
  onSelectionChange: vi.fn(),
  onPrepare: vi.fn(),
  onApprove: vi.fn(),
  onInspect: vi.fn(),
  onAppend: vi.fn(),
  ...overrides,
});
const readyExpert: VertexResearchChatRosterEntry = {
  participantId: "expert-a",
  displayName: "Ready synthetic expert",
  specialty: "Evidence",
  kind: "expert",
  availability: "ready",
  reasonCodes: [],
  corpus: {
    status: "reviewed",
    collectionId: "collection-a",
    snapshotSha256: digest,
    reviewId: "review-a",
  },
};
const action = (node: ReactNode, name: string): Element => {
  const found = elements(node).find(
    (element) => element.props["data-action"] === name
  );
  if (!found) throw new Error(`Missing controlled action ${name}`);
  return found;
};
const click = (node: Element) => (node.props["onClick"] as () => void)();
const escaped = (value: unknown): string =>
  JSON.stringify(value, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");

describe("controlled research conversation view", () => {
  it("renders real vendor view and composer without a runtime provider", () => {
    const output = html(props());
    expect(output).toContain("data-copilotkit");
    expect(output).toContain('data-testid="copilot-chat-textarea"');
    expect(output).toContain("Send message");
    expect(output).toContain("Research coordinator");
    expect(output).toContain("First mate");
    expect(output).toContain("Human: actor-a");
    expect(output).toContain("Execution authorized: false");
    return expect(output).not.toMatch(
      /Using CopilotKit Intelligence|How can I help|Place order|Submit to broker/
    );
  });

  it("uses server human identity and renders literal multiline text without Markdown or HTML execution", () => {
    const output = html(props());
    expect(output).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(output).toContain("Literal evidence\n");
    expect(output).toContain("[Corpus specialist](https://invalid.example)");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<a href=");
    expect(output).toContain('data-speaker-kind="human"');
    const unknown = html(
      props({
        messages: [
          reference({
            author: {
              kind: "agent",
              participantId: "unknown-agent",
              runId: "run-a",
            },
          }),
        ],
      })
    );
    expect(unknown).toContain("Unknown participant");
    expect(unknown).toContain("unknown-agent");
    const human = html(
      props({
        messages: [message({ author: { kind: "user", actorId: "actor-b" } })],
      })
    );
    return expect(human).toContain("Human: actor-b");
  });

  it("keeps incomplete expertise visibly unavailable, including reasons and unknown corpus state", () => {
    const output = html(
      props({
        responseStatus: "unavailable",
        responseReasonCodes: ["model-admission-unavailable"],
      })
    );
    expect(output).toContain("Unavailable");
    expect(output).toContain("corpus-incomplete");
    expect(output).toContain("Corpus: incomplete");
    expect(output).toContain("Corpus: unknown");
    expect(output).toContain("model-admission-unavailable");
    expect(output).toContain("No agent response was queued");
    expect(output).not.toContain("unavailable..");
    return expect(output).not.toContain("is typing");
  });

  it("distinguishes pending admission from an answer and never rereads the transcript as a live region", () => {
    const output = html(props({ responseStatus: "queued" }));
    expect(output).toContain("Response queued; no completed answer yet");
    expect(output).toContain('aria-live="polite"');
    expect(output).not.toContain('role="log"');
    return expect(html(props({ responseStatus: "not-requested" }))).toContain(
      "Human message only; no agent response requested"
    );
  });

  it("routes controlled draft and sends only through supplied callbacks without clearing the draft", () => {
    const value = props();
    const view = boundary(value);
    const composer = input(value);
    expect(view.inputValue).toBe(value.draft);
    expect(composer.onChange).toBeTypeOf("function");
    composer.onChange?.("");
    expect(value.onDraftChange).not.toHaveBeenCalled();
    const area = composer.textArea as {
      onChange: (event: { target: { value: string } }) => void;
    };
    area.onChange({
      target: { value: "Changed question\nwith a second line" },
    });
    expect(value.onDraftChange).toHaveBeenCalledWith(
      "Changed question\nwith a second line"
    );
    view.onSubmitMessage?.("vendor trimmed text is not authoritative");
    composer.onChange?.("");
    expect(value.onSendMessage).toHaveBeenCalledOnce();
    expect(value.onSendMessage).toHaveBeenCalledWith();
    return expect(value.onDraftChange).not.toHaveBeenCalledWith("");
  });

  it("disables both submission and editing for no thread, pending, loading, failure and invalid scope", () => {
    for (const overrides of [
      { selectedThread: null },
      { sending: true },
      { loading: true },
      { error: "Read failed; outcome unknown" },
      {
        selectedThread: {
          ...thread,
          environment: "live",
        } as unknown as VertexResearchChatThread,
      },
    ]) {
      const value = props(overrides);
      expect(boundary(value).onSubmitMessage).toBeUndefined();
      expect(boundary(value)).not.toHaveProperty("onSubmitMessage");
      expect((input(value).textArea as { disabled: boolean }).disabled).toBe(
        true
      );
      expect(value.onSendMessage).not.toHaveBeenCalled();
    }
    for (const overrides of [
      { draft: "  " },
      { draft: "x".repeat(8001) },
      { requestedParticipantIds: ["expert-a"] },
      { requestedParticipantIds: ["missing-a"] },
    ]) {
      expect(boundary(props(overrides)).onSubmitMessage).toBeUndefined();
    }
  });

  it("blocks only new sends for a stale snapshot while retaining editable draft, history and navigation", () => {
    const value = props({ sendDisabled: true });
    expect(boundary(value)).not.toHaveProperty("onSubmitMessage");
    const area = input(value).textArea as {
      disabled: boolean;
      onChange: (event: { target: { value: string } }) => void;
    };
    expect(area.disabled).toBe(false);
    area.onChange({ target: { value: "Retained draft edited while stale" } });
    expect(value.onDraftChange).toHaveBeenCalledWith(
      "Retained draft edited while stale"
    );
    const select = elements(ResearchChatView(value)).find(
      (node) => node.props["aria-current"] === "page"
    );
    expect(select?.props["disabled"]).toBe(false);
    (select!.props["onClick"] as () => void)();
    expect(value.onSelectThread).toHaveBeenCalledWith("thread-a");
    expect(html(value)).toContain("Literal evidence");
    expect(html(value)).toContain("Research question");
    return expect(value.onSendMessage).not.toHaveBeenCalled();
  });

  it("locks uncertain mutations without calling them sending and keeps read recovery available", () => {
    const value = props({
      mutationLocked: true,
      sending: false,
      error: "Unknown request outcome",
    });
    const tree = elements(ResearchChatView(value));
    expect(boundary(value).onSubmitMessage).toBeUndefined();
    expect((input(value).textArea as { disabled: boolean }).disabled).toBe(
      true
    );
    const select = tree.find((node) => node.props["aria-current"] === "page");
    expect(select?.props["disabled"]).toBe(true);
    (select!.props["onClick"] as () => void)();
    expect(value.onSelectThread).not.toHaveBeenCalled();
    const create = tree.find((node) => node.type === "form");
    (
      create!.props["onSubmit"] as (event: {
        preventDefault: () => void;
        currentTarget: object;
      }) => void
    )({ preventDefault: vi.fn(), currentTarget: {} });
    expect(value.onCreateThread).not.toHaveBeenCalled();
    expect(
      tree.find((node) => node.props["type"] === "submit")?.props["disabled"]
    ).toBe(true);
    const retry = tree.find(
      (node) => node.props["data-action"] === "retry-read"
    );
    expect(retry?.props["disabled"]).toBe(false);
    (retry!.props["onClick"] as () => void)();
    expect(value.onRetry).toHaveBeenCalledOnce();
    expect(value.onSendMessage).not.toHaveBeenCalled();
    expect(html(value)).not.toContain("Sending human message");
    const lockedWithoutError = props({ mutationLocked: true });
    expect(boundary(lockedWithoutError).onSubmitMessage).toBeUndefined();
    return expect(
      (input(lockedWithoutError).textArea as { disabled: boolean }).disabled
    ).toBe(true);
  });

  it("provides empty/loading/error states without manufacturing replies or automatically retrying sends", () => {
    const value = props({
      selectedThread: null,
      threads: [],
      messages: [],
      participants: [],
    });
    expect(html(value)).toContain("Create a research room");
    // The Research page's New room action (research.tsx) opens this form by id.
    expect(html(value)).toContain('id="research-new-room"');
    expect(html(value)).toContain("No participants supplied");
    expect(value.onCreateThread).not.toHaveBeenCalled();
    expect(html(props({ messages: [] }))).toContain("No messages recorded");
    expect(html(props({ loading: true }))).toContain(
      "Loading research conversation"
    );
    const failure = props({ error: "Unknown request outcome" });
    expect(html(failure)).toContain("Unknown request outcome");
    const retry = elements(ResearchChatView(failure)).find(
      (node) => node.props["data-action"] === "retry-read"
    );
    (retry!.props["onClick"] as () => void)();
    expect(failure.onRetry).toHaveBeenCalledOnce();
    return expect(failure.onSendMessage).not.toHaveBeenCalled();
  });

  it("never displays another thread's messages or execution-authorized records", () => {
    const output = html(
      props({
        messages: [
          message({ threadId: "other", body: "CROSS_THREAD_SECRET" }),
          message({
            executionAuthorized: true,
          } as unknown as Partial<ResearchHumanMessage>),
        ],
      })
    );
    expect(output).not.toContain("CROSS_THREAD_SECRET");
    expect(output).not.toContain("Literal evidence");
    return expect(output).toContain("Some records were withheld");
  });

  it("selects threads and conversation modes through explicit controlled callbacks", () => {
    const value = props();
    const tree = elements(ResearchChatView(value));
    const select = tree.find((node) => node.props["aria-current"] === "page");
    (select!.props["onClick"] as () => void)();
    expect(value.onSelectThread).toHaveBeenCalledWith("thread-a");
    const content = boundary(value).children?.({
      messageView: <div />,
      input: <div />,
      scrollView: <div />,
      suggestionView: <div />,
    });
    const mode = elements(content).find(
      (node) => node.props["aria-label"] === "Conversation mode"
    );
    (mode!.props["onChange"] as (event: { target: { value: string } }) => void)(
      { target: { value: "debate" } }
    );
    expect(value.onModeChange).toHaveBeenCalledWith("debate");
    return expect(value.onSendMessage).not.toHaveBeenCalled();
  });

  it("requests only eligible room participants and allows removal of unavailable selections", () => {
    const value = props();
    const choices = elements(ResearchChatView(value)).filter(
      (node) => node.type === "input" && node.props["checked"] === false
    );
    const change = (node: Element | undefined, checked: boolean) => {
      return (
        node!.props["onChange"] as (event: {
          target: { checked: boolean };
        }) => void
      )({ target: { checked } });
    };
    change(choices[0], true);
    expect(value.onRequestedParticipantsChange).toHaveBeenCalledWith([
      "mate-a",
    ]);
    expect(choices[1]?.props["disabled"]).toBe(true);
    change(choices[1], true);
    expect(value.onRequestedParticipantsChange).toHaveBeenCalledOnce();
    const unavailable = props({ requestedParticipantIds: ["expert-a"] });
    const selected = elements(ResearchChatView(unavailable)).find(
      (node) => node.type === "input" && node.props["checked"] === true
    );
    expect(selected?.props["disabled"]).toBe(false);
    change(selected, false);
    expect(unavailable.onRequestedParticipantsChange).toHaveBeenCalledWith([]);
    const pending = props({ sending: true });
    const pendingChoice = elements(ResearchChatView(pending)).find(
      (node) => node.type === "input" && node.props["checked"] === false
    );
    change(pendingChoice, true);
    return expect(pending.onRequestedParticipantsChange).not.toHaveBeenCalled();
  });

  return it("creates a room only from an explicit title and supplied participant identities", () => {
    let title = "  Review cited evidence  ";
    let ids = ["mate-a"];
    // Node SSR has no HTMLFormElement. Only FormData's DOM extraction is stubbed.
    vi.stubGlobal(
      "FormData",
      class {
        get = (_name: string) => title;
        getAll = (_name: string) => ids;
      }
    );
    try {
      const value = props();
      const form = elements(ResearchChatView(value)).find(
        (node) => node.type === "form"
      );
      const submit = form?.props["onSubmit"] as (event: {
        preventDefault: () => void;
        currentTarget: object;
      }) => void;
      const preventDefault = vi.fn();
      submit({ preventDefault, currentTarget: {} });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(value.onCreateThread).toHaveBeenCalledWith(
        "Review cited evidence",
        ["mate-a"]
      );
      expect(value.onSendMessage).not.toHaveBeenCalled();
      for (const invalid of [
        [],
        ["unknown-agent"],
        ["mate-a", "mate-a"],
        Array.from({ length: 17 }, () => "mate-a"),
      ]) {
        ids = invalid;
        submit({ preventDefault, currentTarget: {} });
      }
      ids = ["mate-a"];
      title = " ";
      submit({ preventDefault, currentTarget: {} });
      return expect(value.onCreateThread).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("one-expert explicit consent presentation", () => {
  it("renders exact frozen preview metadata and bound records with distinct local and server digests", () => {
    const prepared = candidate();
    const value = props({
      conversation: controls({ candidate: prepared }),
      participants: [readyExpert],
    });
    const output = html(value);
    expect(output).toContain("Start ORIGINAL sequence");
    expect(output).toContain("End ORIGINAL sequence");
    expect(output).toContain("Exactly one ready expert");
    expect(output).toContain("Server whole-context SHA-256");
    expect(output).toContain("Local exact-record SHA-256");
    expect(output).toContain(prepared.recordDigests[0]);
    expect(prepared.recordDigests[0]).not.toBe(prepared.preview.context.sha256);
    for (const record of [
      prepared.preview.request,
      prepared.preview.context,
      prepared.messages[0],
      prepared.preview.expert,
      prepared.preview.inputs,
      prepared.preview.corpus,
      prepared.preview.model,
      prepared.preview.retention,
      prepared.preview.storage,
    ]) {
      expect(output).toContain(escaped(record));
    }
    expect(output).toContain("plan-a");
    expect(output).toContain("response-a");
    expect(output).toContain("none (null)");
    expect(output).toContain("READ ACCESS not after");
    expect(output).toContain("not a deletion deadline");
    expect(output).toContain("response attempt becomes terminal");
    expect(output).toContain("explicit user cleanup");
    expect(output).toContain("Revocation or rights expiry");
    expect(output).toContain("No physical-deletion SLA");
    expect(output).toContain(
      "Stage-specific tokenize and completion privacy reviews are not yet issued"
    );
    expect(output).not.toContain("PRIVATE_NATIVE_");
    expect(output).not.toContain("Unavailable — do not approve");
    expect(
      html(
        props({
          conversation: controls({
            candidate: { ...prepared, recordDigests: [] },
          }),
          participants: [readyExpert],
        })
      )
    ).toContain("Unavailable — do not approve");
    return expect(value.conversation?.onApprove).not.toHaveBeenCalled();
  });

  it("keeps one-expert controls separate from human send and removes legacy debate and responder multiselect", () => {
    const conversation = controls();
    const value = props({
      conversation,
      participants: [participants[0]!, readyExpert],
      requestedParticipantIds: ["missing-legacy-selection"],
      mode: "debate",
    });
    const output = html(value);
    expect(output).not.toContain('aria-label="Conversation mode"');
    expect(output).not.toContain("Request responders");
    expect(output).not.toContain("Request Research coordinator");
    expect(output).toContain("Human-only message. Send records your text");
    const requestPanel = ResearchConversationPanel({
      controls: conversation,
      participants: value.participants,
      disabled: false,
    });
    const expertSelect = elements(requestPanel).find(
      (node) => node.props["aria-label"] === "Exactly one ready expert"
    );
    expect(expertSelect?.props["multiple"]).toBeUndefined();
    expect(
      elements(expertSelect)
        .filter((node) => node.type === "option")
        .map((node) => node.props["value"])
    ).toEqual(["", "expert-a"]);
    boundary(value).onSubmitMessage?.("not authoritative");
    expect(value.onSendMessage).toHaveBeenCalledOnce();
    expect(conversation.onPrepare).not.toHaveBeenCalled();
    expect(conversation.onApprove).not.toHaveBeenCalled();
    expect(value.onModeChange).not.toHaveBeenCalled();
    return expect(value.onRequestedParticipantsChange).not.toHaveBeenCalled();
  });

  it("passes exact original selection strings and literal query only through controlled callbacks", () => {
    const value = controls();
    const tree = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    for (const [label, field, literal] of [
      ["Start ORIGINAL sequence", "start", "100000000000000000000001"],
      ["End ORIGINAL sequence", "end", "100000000000000000000002"],
      ["Exact literal retrieval query", "query", "  Exact  literal query  "],
      ["Exactly one ready expert", "expertId", "expert-a"],
    ]) {
      const control = elements(tree).find(
        (node) => node.props["aria-label"] === label
      );
      (
        control!.props["onChange"] as (event: {
          target: { value: string };
        }) => void
      )({ target: { value: literal! } });
      expect(value.onSelectionChange).toHaveBeenLastCalledWith(field, literal);
    }
    const expert = elements(tree).find(
      (node) => node.props["aria-label"] === "Exactly one ready expert"
    );
    (
      expert!.props["onChange"] as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: "mate-a" } });
    expect(value.onSelectionChange).toHaveBeenCalledTimes(4);
    expect(value.onPrepare).not.toHaveBeenCalled();
    expect(value.onApprove).not.toHaveBeenCalled();
    click(action(tree, "prepare-response"));
    expect(value.onPrepare).toHaveBeenCalledOnce();
    return expect(value.onApprove).not.toHaveBeenCalled();
  });

  it("requires the deliberate approval button and a current candidate with unlocked controls", () => {
    const value = controls({ candidate: candidate() });
    const tree = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    expect(value.onApprove).not.toHaveBeenCalled();
    expect(action(tree, "approve-response").props["disabled"]).toBe(false);
    // The long approval label wraps inside the column (no page overflow at 375 px).
    expect(action(tree, "approve-response").props["className"]).toContain(
      "[&>[data-slot=button-chrome]]:whitespace-normal"
    );
    click(action(tree, "approve-response"));
    expect(value.onApprove).toHaveBeenCalledOnce();
    expect(value.onApprove).toHaveBeenCalledWith();
    expect(value.onAppend).not.toHaveBeenCalled();
    for (const overrides of [
      { candidate: null },
      { busy: true },
      { locked: true },
      { candidate: { ...candidate(), recordDigests: [] } },
    ]) {
      const blocked = controls({ candidate: candidate(), ...overrides });
      const panel = ResearchConversationPanel({
        controls: blocked,
        participants: [readyExpert],
        disabled: false,
      });
      expect(action(panel, "approve-response").props["disabled"]).toBe(true);
      click(action(panel, "approve-response"));
      expect(blocked.onApprove).not.toHaveBeenCalled();
    }
    const disabled = controls({ candidate: candidate() });
    const disabledPanel = ResearchConversationPanel({
      controls: disabled,
      participants: [readyExpert],
      disabled: true,
    });
    click(action(disabledPanel, "approve-response"));
    return expect(disabled.onApprove).not.toHaveBeenCalled();
  });

  it("blocks invalid preview requests and all selection callbacks while busy, locked or scope-disabled", () => {
    for (const overrides of [
      { expertId: "" },
      { expertId: "mate-a" },
      { start: "" },
      { end: "" },
      { query: "short" },
      { query: "x".repeat(2001) },
      { query: "literal query\nnot single line" },
      { busy: true },
      { locked: true },
    ]) {
      const value = controls(overrides);
      const panel = ResearchConversationPanel({
        controls: value,
        participants: [readyExpert],
        disabled: false,
      });
      expect(action(panel, "prepare-response").props["disabled"]).toBe(true);
      click(action(panel, "prepare-response"));
      expect(value.onPrepare).not.toHaveBeenCalled();
    }
    for (const state of [
      { busy: true, locked: false, disabled: false },
      { busy: false, locked: true, disabled: false },
      { busy: false, locked: false, disabled: true },
    ]) {
      const value = controls(state);
      const panel = ResearchConversationPanel({
        controls: value,
        participants: [readyExpert],
        disabled: state.disabled,
      });
      const query = elements(panel).find(
        (node) => node.props["aria-label"] === "Exact literal retrieval query"
      );
      (
        query!.props["onChange"] as (event: {
          target: { value: string };
        }) => void
      )({ target: { value: "blocked query" } });
      expect(value.onSelectionChange).not.toHaveBeenCalled();
    }
    expect(
      renderToStaticMarkup(
        <ResearchConversationPanel
          controls={controls()}
          participants={participants}
          disabled={false}
        />
      )
    ).toContain("No ready reviewed expert");
    const missingRoom = props({
      selectedThread: null,
      conversation: controls(),
      participants: [readyExpert],
    });
    const nested = elements(ResearchChatView(missingRoom)).find(
      (node) => node.type === ResearchConversationPanel
    );
    expect(nested?.props["disabled"]).toBe(true);
    return expect(nested?.props["participants"]).toEqual([]);
  });

  it("shows original operation state, leaves unknown inspect-only, and requires explicit eligible publication", () => {
    const value = controls({
      operationKey: "original-key",
      status: "Outcome unknown; inspect original operation",
      locked: true,
      canAppend: false,
    });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    const output = renderToStaticMarkup(panel);
    expect(output).toContain("original-key");
    expect(output).toContain("Outcome unknown");
    expect(output).toContain("inspect-only");
    expect(action(panel, "inspect-response").props["disabled"]).toBe(false);
    click(action(panel, "inspect-response"));
    expect(value.onInspect).toHaveBeenCalledOnce();
    expect(action(panel, "append-response").props["disabled"]).toBe(true);
    click(action(panel, "append-response"));
    expect(value.onAppend).not.toHaveBeenCalled();
    expect(value.onApprove).not.toHaveBeenCalled();
    const eligible = controls({
      operationKey: "original-key",
      canAppend: true,
    });
    const eligiblePanel = ResearchConversationPanel({
      controls: eligible,
      participants: [readyExpert],
      disabled: false,
    });
    expect(eligible.onAppend).not.toHaveBeenCalled();
    expect(action(eligiblePanel, "append-response").props["disabled"]).toBe(
      false
    );
    click(action(eligiblePanel, "append-response"));
    expect(eligible.onAppend).toHaveBeenCalledOnce();
    const ineligible = controls({
      operationKey: "original-key",
      canAppend: false,
    });
    click(
      action(
        ResearchConversationPanel({
          controls: ineligible,
          participants: [readyExpert],
          disabled: false,
        }),
        "append-response"
      )
    );
    expect(ineligible.onAppend).not.toHaveBeenCalled();
    for (const inactive of [
      controls(),
      controls({ operationKey: "original-key", busy: true }),
    ]) {
      const inactivePanel = ResearchConversationPanel({
        controls: inactive,
        participants: [readyExpert],
        disabled: false,
      });
      expect(action(inactivePanel, "inspect-response").props["disabled"]).toBe(
        true
      );
      click(action(inactivePanel, "inspect-response"));
      expect(inactive.onInspect).not.toHaveBeenCalled();
    }
  });

  it("allows eligible publication for an existing locked operation without unlocking selection or approval", () => {
    const value = controls({
      operationKey: "original-key",
      candidate: candidate(),
      locked: true,
      canAppend: true,
    });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    expect(action(panel, "append-response").props["disabled"]).toBe(false);
    click(action(panel, "append-response"));
    expect(value.onAppend).toHaveBeenCalledOnce();
    expect(action(panel, "approve-response").props["disabled"]).toBe(true);
    click(action(panel, "approve-response"));
    expect(value.onApprove).not.toHaveBeenCalled();
    expect(action(panel, "prepare-response").props["disabled"]).toBe(true);
    click(action(panel, "prepare-response"));
    expect(value.onPrepare).not.toHaveBeenCalled();
    const query = elements(panel).find(
      (node) => node.props["aria-label"] === "Exact literal retrieval query"
    );
    (
      query!.props["onChange"] as (event: { target: { value: string } }) => void
    )({ target: { value: "Changed locked query" } });
    expect(value.onSelectionChange).not.toHaveBeenCalled();
    for (const blocked of [
      { busy: true, disabled: false },
      { busy: false, disabled: true },
    ]) {
      const locked = controls({
        operationKey: "original-key",
        locked: true,
        canAppend: true,
        busy: blocked.busy,
      });
      const lockedPanel = ResearchConversationPanel({
        controls: locked,
        participants: [readyExpert],
        disabled: blocked.disabled,
      });
      expect(action(lockedPanel, "append-response").props["disabled"]).toBe(
        true
      );
      click(action(lockedPanel, "append-response"));
      expect(locked.onAppend).not.toHaveBeenCalled();
    }
  });

  return it("keeps a valid loaded historical context preview available while only new human sends are disabled", () => {
    const conversation = controls();
    const value = props({
      conversation,
      participants: [readyExpert],
      sendDisabled: true,
    });
    expect(boundary(value)).not.toHaveProperty("onSubmitMessage");
    const nested = elements(ResearchChatView(value)).find(
      (node) => node.type === ResearchConversationPanel
    );
    expect(nested?.props["disabled"]).toBe(false);
    const panel = ResearchConversationPanel({
      controls: conversation,
      participants: nested?.props[
        "participants"
      ] as readonly VertexResearchChatRosterEntry[],
      disabled: nested?.props["disabled"] as boolean,
    });
    expect(action(panel, "prepare-response").props["disabled"]).toBe(false);
    click(action(panel, "prepare-response"));
    expect(conversation.onPrepare).toHaveBeenCalledOnce();
    return expect(value.onSendMessage).not.toHaveBeenCalled();
  });
});

describe("immutable reference and private advisory presentation", () => {
  it("preserves reference provenance without private bytes and reads only on the explicit show action", () => {
    const ref = reference();
    const onView = vi.fn();
    const node = ResearchReference({
      reference: ref,
      name: "Synthetic expert",
      onView,
    });
    const output = renderToStaticMarkup(node);
    expect(output).toContain("Immutable advisory reference");
    expect(output).toContain("Chronology parent");
    expect(output).toContain("human-2");
    expect(output).toContain("Original response-to message");
    expect(output).toContain("message-a");
    expect(output).toContain(escaped(ref.response));
    expect(output).not.toContain("PRIVATE_NATIVE_");
    expect(onView).not.toHaveBeenCalled();
    click(action(node, "view-private-response"));
    expect(onView).toHaveBeenCalledOnce();
    expect(onView).toHaveBeenCalledWith(ref);
    expect(
      action(
        ResearchReference({ reference: ref, name: "Synthetic expert" }),
        "view-private-response"
      ).props["disabled"]
    ).toBe(true);
    const history = html(
      props({
        messages: [
          message(),
          message({
            messageId: "human-2",
            sequence: "2",
            body: "Second human statement.",
          }),
          ref,
        ],
        conversation: controls(),
        privateContent: {
          referenceId: ref.messageId,
          status: "unavailable",
          value: null,
        },
      })
    );
    expect(history).toContain('data-speaker-kind="human"');
    expect(history).toContain('data-speaker-kind="advisory-reference"');
    expect(history).toContain(escaped(ref.response));
    expect(history).toContain("Private answer unavailable");
    return expect(history).not.toContain("PRIVATE_NATIVE_");
  });

  it("renders literal native claims, quotes, proposals and exact evidence pins outside the real vendor tree", () => {
    const body = privateBody();
    const content: ResearchPrivateView = {
      referenceId: body.reference.messageId,
      status: "available",
      value: body,
    };
    const value = props({
      messages: [
        message(),
        message({
          messageId: "human-2",
          sequence: "2",
          body: "Second human statement.",
        }),
        body.reference,
      ],
      conversation: controls(),
      privateContent: content,
      onHideResponse: vi.fn(),
      onViewResponse: vi.fn(),
    });
    const tree = elements(ResearchChatView(value));
    const vendor = tree.find((node) => node.type === CopilotChatView);
    expect(vendor).toBeDefined();
    expect(
      tree.find((node) => node.type === ResearchPrivatePanel)?.props["content"]
    ).toBe(content);
    expect(
      elements(vendor).some((node) => node.type === ResearchPrivatePanel)
    ).toBe(false);
    for (const key of [
      "messages",
      "runtime",
      "agent",
      "privateContent",
      "history",
    ]) {
      expect(boundary(value)).not.toHaveProperty(key);
    }
    const context = tree.find(
      (node) =>
        (node.props["value"] as { messages?: unknown } | undefined)
          ?.messages === value.messages
    );
    expect(context).toBeDefined();
    expect(context?.props["value"]).not.toHaveProperty("privateContent");
    expect(context?.props["value"]).not.toHaveProperty("profile");
    const output = html(value);
    expect(output).toContain("data-copilotkit");
    expect(output).toContain(
      "PRIVATE_NATIVE_CLAIM\n&lt;script&gt;claim()&lt;/script&gt;"
    );
    expect(output).toContain(
      "PRIVATE_NATIVE_QUOTE\n[Not a link](https://synthetic.invalid)"
    );
    expect(output).toContain("PRIVATE_NATIVE_PROPOSAL");
    for (const pin of [
      "evidence-a",
      "source-a",
      "source-snapshot-a",
      digest,
      "b".repeat(64),
      profileDigest,
      "proposal-a",
      "model-a",
      "task-a",
    ]) {
      expect(output).toContain(pin);
    }
    expect(output).toContain("Proposals · not authorized actions");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<a href=");
    expect(
      output.split('aria-label="Current private advisory answer"')[0]
    ).not.toContain("PRIVATE_NATIVE_");
    expect(value.onViewResponse).not.toHaveBeenCalled();
    return expect(value.onHideResponse).not.toHaveBeenCalled();
  });

  it("renders no held answer in idle, loading, unavailable or mismatched-reference states and hides explicitly", () => {
    const body = privateBody();
    for (const status of ["idle", "loading", "unavailable"] as const) {
      const output = renderToStaticMarkup(
        <ResearchPrivatePanel
          content={{
            referenceId: body.reference.messageId,
            status,
            value: body,
          }}
        />
      );
      expect(output).not.toContain("PRIVATE_NATIVE_");
      expect(output).toContain(
        status === "idle"
          ? "Private answer hidden"
          : status === "loading"
            ? "Checking current private read access"
            : "Private answer unavailable"
      );
    }
    const mismatch = renderToStaticMarkup(
      <ResearchPrivatePanel
        content={{
          referenceId: "other-reference",
          status: "available",
          value: body,
        }}
      />
    );
    expect(mismatch).not.toContain("PRIVATE_NATIVE_");
    const onHide = vi.fn();
    const node = ResearchPrivatePanel({
      content: {
        referenceId: body.reference.messageId,
        status: "available",
        value: body,
      },
      onHide,
    });
    expect(onHide).not.toHaveBeenCalled();
    click(action(node, "hide-private-response"));
    expect(onHide).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(node)).toContain("at most 15 seconds");
    expect(renderToStaticMarkup(node)).toContain(
      "not a server deletion request"
    );
    const idle = ResearchPrivatePanel({
      content: { referenceId: null, status: "idle", value: null },
      onHide,
    });
    expect(action(idle, "hide-private-response").props["disabled"]).toBe(true);
    click(action(idle, "hide-private-response"));
    return expect(onHide).toHaveBeenCalledOnce();
  });

  return it("withholds current private bytes when room scope, loading or transcript errors invalidate the view", () => {
    const body = privateBody();
    const privateContent: ResearchPrivateView = {
      referenceId: body.reference.messageId,
      status: "available",
      value: body,
    };
    for (const overrides of [
      { selectedThread: null },
      { selectedThread: { ...thread, threadId: "another-thread" } },
      { loading: true },
      { error: "Current read denied" },
    ]) {
      expect(html(props({ privateContent, ...overrides }))).not.toContain(
        "PRIVATE_NATIVE_"
      );
    }
  });
});

describe("explicit bounded debate controls", () => {
  it("keeps one expert as the controlled default and does no work on selecting debate", () => {
    const value = controls({
      debate: {
        mode: "one-expert",
        frozen: false,
        runKey: null,
        metadata: null,
        canPrepare: false,
        onModeChange: vi.fn(),
        onReadRun: vi.fn(),
      },
    });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    const choice = elements(panel).find(
      (node) => node.props["aria-label"] === "Response workflow"
    )!;
    expect(choice.props["value"]).toBe("one-expert");
    const change = choice.props["onChange"] as (event: {
      target: { value: string };
    }) => void;
    change({ target: { value: "stepwise-debate" } });
    expect(value.debate?.onModeChange).toHaveBeenCalledExactlyOnceWith(
      "stepwise-debate"
    );
    expect(value.onPrepare).not.toHaveBeenCalled();
    return expect(value.onApprove).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 5])(
    "labels and binds only explicit approval of turn %i, including final selected-member synthesis",
    (ordinal) => {
      const base = candidate();
      const speaker =
        ordinal === 5 || ordinal % 2 === 0 ? "expert-b" : "expert-a";
      const predecessors = Array.from({ length: ordinal - 1 }, (_, index) => ({
        ordinal: index + 1,
        participantId: index % 2 === 0 ? "expert-a" : "expert-b",
        responseRequestId: `prior-response-${index}`,
        planId: `prior-plan-${index}`,
        planSha256: digest,
        runId: `prior-run-${index}`,
        copyId: `prior-copy-${index}`,
        reservationSha256: digest,
        contentSha256: digest,
        byteLength: 100,
        publishedAt: checkedAt,
      }));
      const result = VertexResearchChatDebatePrepareOutputSchema.parse({
        schemaVersion: "1.0.0",
        executionAuthorized: false,
        status: "prepared",
        preview: {
          ...base.preview,
          expert: { ...base.preview.expert, participantId: speaker },
          request: {
            ...base.preview.request,
            participantId: speaker,
            debate: {
              profile: "vertex-research-chat-debate-step-v1",
              runKey: "debate-key",
              ordinal,
              predecessors,
            },
          },
          debate: {
            profile: "vertex-research-chat-debate-plan-v1",
            debateRunId: "debate-run",
            runKey: "debate-key",
            ordinal,
            kind: ordinal === 5 ? "synthesis" : "statement",
            configuration: {
              ...artifact("configuration"),
              contractName: "vertex-research-chat-debate-configuration-v1",
              schemaVersion: "1.0.0",
            },
            participantIds: ["expert-a", "expert-b"],
            synthesizerId: "expert-b",
            humanWindowSha256: digest,
            predecessors,
            turnTokens: 100,
            turnCostUsd: "0.1",
            aggregateTokens: 500,
            aggregateCostUsd: "0.5",
            derivedContext: { sha256: digest, byteLength: 100 },
          },
        },
      });
      if (result.status !== "prepared")
        throw new Error("Expected source fixture");
      const value = controls({
        candidate: { ...base, preview: result.preview },
        debate: {
          mode: "stepwise-debate",
          frozen: true,
          runKey: "debate-key",
          metadata: null,
          canPrepare: false,
          onModeChange: vi.fn(),
          onReadRun: vi.fn(),
        },
      });
      const panel = ResearchConversationPanel({
        controls: value,
        participants: [readyExpert],
        disabled: false,
      });
      const output = renderToStaticMarkup(panel);
      expect(output).toContain(
        `Approve displayed ${ordinal === 5 ? "synthesis" : "statement"} step ${ordinal} of 5`
      );
      expect(output).toContain("charges the full ceiling");
      expect(output).toContain("Source-implemented workflow");
      expect(output).toContain(escaped(result.preview.debate));
      expect(output).toContain(escaped(result.preview.model));
      expect(value.onApprove).not.toHaveBeenCalled();
      click(action(panel, "read-debate-run"));
      expect(value.debate?.onReadRun).toHaveBeenCalledOnce();
      expect(value.onPrepare).not.toHaveBeenCalled();
      expect(value.onApprove).not.toHaveBeenCalled();
      click(action(panel, "approve-response"));
      return expect(value.onApprove).toHaveBeenCalledOnce();
    }
  );

  return it("does not enable preparation from missing next-step metadata or imply it authorizes approval", () => {
    const value = controls({
      debate: {
        mode: "stepwise-debate",
        frozen: true,
        runKey: "debate-key",
        metadata: null,
        canPrepare: false,
        onModeChange: vi.fn(),
        onReadRun: vi.fn(),
      },
    });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [readyExpert],
      disabled: false,
    });
    expect(action(panel, "prepare-response").props["disabled"]).toBe(true);
    expect(action(panel, "approve-response").props["disabled"]).toBe(true);
    click(action(panel, "prepare-response"));
    click(action(panel, "approve-response"));
    expect(value.onPrepare).not.toHaveBeenCalled();
    return expect(value.onApprove).not.toHaveBeenCalled();
  });
});

describe("truthful configured First Mate advisory responder", () => {
  const mate: VertexResearchChatRosterEntry = {
    participantId: "first-mate",
    displayName: "First Mate",
    specialty: "Advisory only",
    kind: "first-mate",
    availability: "unavailable",
    reasonCodes: ["tools-not-integrated"],
    corpus: {
      status: "unknown",
      collectionId: null,
      snapshotSha256: null,
      reviewId: null,
    },
    advisory: {
      status: "configured",
      authorization: "requires-governed-prepare",
      reasonCodes: ["governed-prepare-required"],
    },
  };
  it("offers the dedicated configured participant for one explicit governed preview without claiming tool/provider readiness", () => {
    const value = controls({ expertId: "first-mate" });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [mate, readyExpert],
      disabled: false,
    });
    const select = elements(panel).find(
      (node) => node.props["aria-label"] === "Exactly one advisory responder"
    );
    expect(
      elements(select)
        .filter((node) => node.type === "option")
        .map((node) => node.props["value"])
    ).toEqual(["", "first-mate", "expert-a"]);
    expect(value.onPrepare).not.toHaveBeenCalled();
    expect(action(panel, "prepare-response").props["disabled"]).toBe(false);
    click(action(panel, "prepare-response"));
    expect(value.onPrepare).toHaveBeenCalledTimes(1);
    expect(value.onApprove).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(panel)).toContain(
      "provider/context authorization still required"
    );
    return expect(
      html(
        props({
          participants: [mate],
          selectedThread: { ...thread, participantIds: ["first-mate"] },
        })
      )
    ).toContain(
      "Configured for governed advisory requests; provider/context authorization still required"
    );
  });

  for (const invalid of [
    { ...mate, advisory: undefined },
    { ...mate, participantId: "fake-first-mate" },
    {
      ...mate,
      advisory: {
        status: "unavailable" as const,
        authorization: "requires-governed-prepare" as const,
        reasonCodes: ["first-mate-configuration-unavailable" as const],
      },
    },
  ]) {
    it(`does not infer advisory readiness from role or availability (${invalid.participantId}/${invalid.advisory?.status ?? "absent"})`, () => {
      const value = controls({ expertId: invalid.participantId });
      const panel = ResearchConversationPanel({
        controls: value,
        participants: [invalid],
        disabled: false,
      });
      expect(action(panel, "prepare-response").props["disabled"]).toBe(true);
      click(action(panel, "prepare-response"));
      return expect(value.onPrepare).not.toHaveBeenCalled();
    });
  }

  return it("keeps configured First Mate out of the expert-only debate selector", () => {
    const value = controls({
      expertId: "first-mate",
      debate: {
        mode: "stepwise-debate",
        frozen: false,
        runKey: null,
        metadata: null,
        canPrepare: false,
        onModeChange: vi.fn(),
        onReadRun: vi.fn(),
      },
    });
    const panel = ResearchConversationPanel({
      controls: value,
      participants: [mate, readyExpert],
      disabled: false,
    });
    const select = elements(panel).find(
      (node) => node.props["aria-label"] === "Exactly one ready expert"
    );
    expect(
      elements(select)
        .filter((node) => node.type === "option")
        .map((node) => node.props["value"])
    ).toEqual(["", "expert-a"]);
    return expect(action(panel, "prepare-response").props["disabled"]).toBe(
      true
    );
  });
});
