"use client";

import { alertVariants, Button } from "@darkfactory/ui";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  VertexResearchChatCreateThreadInputSchema,
  VertexResearchChatSendMessageInputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  type VertexResearchChatCreateThreadInput,
  type VertexResearchChatSendMessageInput,
  type VertexResearchChatReadTranscriptPageOutput,
  type VertexResearchChatResponse,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
  type VertexResearchChatNativeEvidenceApproveInput,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  type VertexResearchChatDebateApproveInput,
  type VertexResearchChatDebateStepInput,
  type VertexResearchChatApproveAndRequestResponseInput,
  type VertexResearchChatReadResponseOutput,
  type VertexResearchChatAgentReferenceMessage,
  type VertexResearchChatRosterEntry,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  classifyVertexFailure,
  VertexReadError,
} from "../../components/research/vertex-client.ts";
import { useResearchReadScope } from "../../components/research/read-scope.tsx";
import { ReadNotice } from "../../components/research/research-views.tsx";
import type { ExperienceResearchChatPort, ExperienceScope } from "./ports.ts";
import { useExperienceResource, useExperienceServices } from "./shared.tsx";
import {
  ResearchChatView,
  canRequestExpertPreview,
  canRequestDebatePreview,
} from "./research-chat-view.tsx";
import {
  bindResearchPreview,
  researchLifetime,
  researchLifetimeCurrent,
  researchLifetimeRemaining,
  researchResponseRequest,
  selectResearchHumanWindow,
  type ResearchLifetime,
  type ResearchPreparedCandidate,
  type ResearchConversationControls,
  type ResearchPrivateView,
} from "./research-chat-conversation.ts";
import {
  assertResearchDebateAnchor,
  assertResearchDebatePreview,
  researchDebateSpeaker,
  type ResearchResponseMode,
  type ResearchDebatePreview,
  type ResearchDebateRun,
} from "./research-chat-debate.ts";

type ResearchScope = Readonly<{
  accountAlias: string;
  environment: "research";
}>;
type RoomSelection = ResearchScope &
  Readonly<{ threadId: string; limit: number; cursor: string | null }>;
type PendingMutation =
  | Readonly<{ kind: "create"; input: VertexResearchChatCreateThreadInput }>
  | Readonly<{ kind: "send"; input: VertexResearchChatSendMessageInput }>;
type CurrentPreparedCandidate = ResearchPreparedCandidate & ResearchLifetime;
type ConversationApproval =
  | VertexResearchChatApproveAndRequestResponseInput
  | VertexResearchChatDebateApproveInput
  | VertexResearchChatNativeEvidenceApproveInput;
type PreparationResult =
  | Awaited<ReturnType<ExperienceResearchChatPort["prepareResponse"]>>
  | Awaited<ReturnType<ExperienceResearchChatPort["prepareDebateStep"]>>
  | Awaited<ReturnType<ExperienceResearchChatPort["prepareNativeEvidence"]>>;
type DebateSeed = Readonly<{
  request: VertexResearchChatDebateStepInput;
  messages: ResearchPreparedCandidate["messages"];
}>;
type HeldDebateMetadata = ResearchLifetime &
  Readonly<{ binding: string; value: ResearchDebateRun }>;
const PAGE_SIZE = 100;
const unavailable = (): Promise<never> =>
  Promise.reject(new VertexReadError("unavailable"));

// A current head can advance beyond this immutable transcript boundary. Only
// the fixed high water determines the final page's tail, including references.
export const assertResearchRoomSnapshot = (
  page: VertexResearchChatReadTranscriptPageOutput
): void => {
  if (!VertexResearchChatReadTranscriptPageOutputSchema.safeParse(page).success)
    throw new VertexReadError("malformed");
};

export const sameResearchChatRequest = (
  left: unknown,
  right: unknown
): boolean => {
  try {
    return canonicalArtifactJson(left) === canonicalArtifactJson(right);
  } catch {
    return false;
  }
};

const subscribeNothing = (_listener: () => void) => () => ({});
const retiredRevision = () => -1;
const browserReadable = (): boolean =>
  typeof document !== "undefined" &&
  document.visibilityState === "visible" &&
  typeof navigator !== "undefined" &&
  navigator.onLine;
const EMPTY_PRIVATE: ResearchPrivateView = Object.freeze({
  referenceId: null,
  status: "idle",
  value: null,
});

// Private bodies intentionally bypass useExperienceResource, transcript/ACK
// state and Copilot. This single currently selected reference has local memory
// only, with independent generation/visibility/deadline invalidation.
const useResearchPrivateContent = (
  port: ExperienceResearchChatPort | null,
  scope: ResearchScope,
  threadId: string | null,
  reference: VertexResearchChatAgentReferenceMessage | null,
  viewGeneration: number,
  displayReadable: boolean
) => {
  const auth = useResearchReadScope();
  const revision = useSyncExternalStore(
    auth?.subscribe ?? subscribeNothing,
    auth?.getRevision ?? retiredRevision,
    retiredRevision
  );
  const identity = reference === null ? "" : canonicalArtifactJson(reference);
  const key = JSON.stringify([
    scope.accountAlias,
    threadId,
    revision,
    identity,
    viewGeneration,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [held, setHeld] = useState<
    (ResearchLifetime & { key: string; view: ResearchPrivateView }) | null
  >(null);
  const heldLive = useRef<typeof held>(null);
  const displayLive = useRef(displayReadable);
  displayLive.current = displayReadable;
  const owner = useRef({ auth, port });
  if (owner.current.auth !== auth || owner.current.port !== port) {
    heldLive.current = null;
    owner.current = { auth, port };
  }
  const hold = (value: typeof held) => {
    if (
      value !== null &&
      (!displayLive.current ||
        owner.current.auth !== auth ||
        owner.current.port !== port ||
        currentKey.current !== key)
    )
      return;
    heldLive.current = value;
    return setHeld(value);
  };
  // A denied/timed-out selection cannot be revived by focus, online, a page
  // refresh or effect restart. Only deliberate Show changes viewGeneration.
  // Keep this latch outside the effect so temporary reference=null is inert.
  const terminalSelection = useRef<string | null>(null);
  // Masking an already-held or in-flight private answer permanently retires
  // that read selection, not just its buttons. Loading completion cannot revive it.
  if (
    !displayReadable &&
    (heldLive.current?.key === key || held?.key === key)
  ) {
    terminalSelection.current = key;
    heldLive.current = null;
  }
  const hide = () => {
    terminalSelection.current = key;
    return hold(null);
  };
  useEffect(() => {
    let generation = 0;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const clear = () => {
      generation += 1;
      controller?.abort();
      controller = null;
      clearTimeout(timeout);
      clearTimeout(refresh);
      return hold(null);
    };
    const current = (attempt: number): boolean =>
      !stopped &&
      generation === attempt &&
      currentKey.current === key &&
      displayLive.current &&
      auth?.isCurrent() === true &&
      auth.getRevision() === revision &&
      browserReadable();
    const terminate = (attempt: number) => {
      if (!current(attempt) || reference === null) return;
      terminalSelection.current = key;
      clear();
      return hold({
        key,
        deadline: Number.POSITIVE_INFINITY,
        wallDeadline: Number.POSITIVE_INFINITY,
        view: {
          referenceId: reference.messageId,
          status: "unavailable",
          value: null,
        },
      });
    };
    const load = async () => {
      clear();
      if (
        !displayLive.current ||
        reference === null ||
        reference.threadId !== threadId ||
        port === null ||
        auth === null ||
        !auth.isCurrent() ||
        !browserReadable()
      )
        return;
      if (terminalSelection.current === key) {
        hold({
          key,
          deadline: Number.POSITIVE_INFINITY,
          wallDeadline: Number.POSITIVE_INFINITY,
          view: {
            referenceId: reference.messageId,
            status: "unavailable",
            value: null,
          },
        });
        return;
      }
      const attempt = generation;
      const active = new AbortController();
      controller = active;
      const start = performance.now(),
        wall = Date.now();
      const requestLifetime = {
        deadline: start + 12_000,
        wallDeadline: wall + 12_000,
      };
      hold({
        key,
        ...requestLifetime,
        view: {
          referenceId: reference.messageId,
          status: "loading",
          value: null,
        },
      });
      timeout = setTimeout(
        () => {
          return terminate(attempt);
        },
        researchLifetimeRemaining(
          requestLifetime,
          performance.now(),
          Date.now()
        )
      );
      try {
        const value = await port.readResponseContent(
          {
            ...scope,
            threadId,
            responseRequestId: reference.response.responseRequestId,
            messageId: reference.messageId,
          },
          active.signal
        );
        if (!current(attempt) || active.signal.aborted) return;
        if (
          !researchLifetimeCurrent(
            requestLifetime,
            performance.now(),
            Date.now()
          )
        ) {
          terminate(attempt);
          return;
        }
        clearTimeout(timeout);
        if (canonicalArtifactJson(value.reference) !== identity)
          throw new VertexReadError("malformed");
        const lifetime =
          value.status === "available"
            ? researchLifetime(value.checkedAt, value.notAfter, start, wall)
            : { deadline: start, wallDeadline: wall };
        if (
          value.status !== "available" ||
          !researchLifetimeCurrent(lifetime, performance.now(), Date.now())
        ) {
          terminate(attempt);
          return;
        }
        hold({
          key,
          ...lifetime,
          view: {
            referenceId: reference.messageId,
            status: "available",
            value,
          },
        });
        refresh = setTimeout(
          () => {
            if (current(attempt)) return void load();
            return;
          },
          researchLifetimeRemaining(lifetime, performance.now(), Date.now())
        );
      } catch (error) {
        if (!current(attempt)) return;
        terminate(attempt);
        if (classifyVertexFailure(error).kind === "unauthorized")
          return auth.invalidate();
        return;
      }
    };
    const invalidate = () => {
      return clear();
    };
    const revalidate = () => {
      clear();
      if (browserReadable()) return void load();
      return;
    };
    const visibility = () => {
      if (browserReadable()) {
        return void load();
      }
      return clear();
    };
    const unsubscribe = auth?.subscribe(invalidate);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("offline", invalidate);
    window.addEventListener("online", revalidate);
    window.addEventListener("pageshow", revalidate);
    window.addEventListener("focus", revalidate);
    void load();
    return () => {
      stopped = true;
      clear();
      unsubscribe?.();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("offline", invalidate);
      window.removeEventListener("online", revalidate);
      window.removeEventListener("pageshow", revalidate);
      return window.removeEventListener("focus", revalidate);
    };
  }, [port, auth, revision, key, displayReadable]);
  useEffect(() => {
    // A render after OS suspend must also drop held state, even if its scheduled
    // monotonic timer has not run yet. The render guard below hides it first.
    if (
      held !== null &&
      held.view.value !== null &&
      !researchLifetimeCurrent(held, performance.now(), Date.now())
    )
      hold(null);
    return;
  });
  // Guard the render itself; a stale or retired selection exposes no body.
  const content =
    displayReadable &&
    held !== null &&
    heldLive.current === held &&
    held.key === key &&
    auth?.isCurrent() &&
    browserReadable() &&
    (held.view.status === "unavailable" ||
      researchLifetimeCurrent(held, performance.now(), Date.now()))
      ? held.view
      : EMPTY_PRIVATE;
  return { content, hide };
};

const useResearchConversation = (
  scope: ResearchScope,
  threadId: string | null,
  page: VertexResearchChatReadTranscriptPageOutput | null,
  participants: readonly VertexResearchChatRosterEntry[],
  port: ExperienceResearchChatPort | null,
  refreshReads: () => void,
  privateDisplayReadable: boolean
) => {
  const auth = useResearchReadScope();
  const revision = useSyncExternalStore(
    auth?.subscribe ?? subscribeNothing,
    auth?.getRevision ?? retiredRevision,
    retiredRevision
  );
  const [selection, setSelection] = useState({
    start: "",
    end: "",
    query: "",
    expertId: "",
  });
  const [responseMode, setResponseMode] =
    useState<ResearchResponseMode>("one-expert");
  const debateSeed = useRef<DebateSeed | null>(null);
  const debateAnchor = useRef<ResearchDebatePreview | null>(null);
  const [debateMetadata, setDebateMetadata] =
    useState<HeldDebateMetadata | null>(null);
  const debateMetadataLive = useRef<HeldDebateMetadata | null>(null);
  const [candidate, setCandidate] = useState<CurrentPreparedCandidate | null>(
    null
  );
  const candidateLive = useRef<CurrentPreparedCandidate | null>(null);
  const preparedRequest = useRef<{
    selectionKey: string;
    input: ResearchPreparedCandidate["preview"]["request"];
  } | null>(null);
  const [operation, setOperation] = useState<ConversationApproval | null>(null);
  const operationRef = useRef<ConversationApproval | null>(null);
  const originalPreview = useRef<ResearchPreparedCandidate["preview"] | null>(
    null
  );
  const [observation, setObservation] =
    useState<VertexResearchChatReadResponseOutput | null>(null);
  const observationGeneration = useRef(-1);
  const [reference, setReference] =
    useState<VertexResearchChatAgentReferenceMessage | null>(null);
  const [viewGeneration, setViewGeneration] = useState(0);
  const [status, setStatus] = useState(
    "Choose one expert and an original contiguous human window. Previewing does not approve or request a response."
  );
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const active = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);
  const generation = useRef(0);
  const binding = JSON.stringify([scope.accountAlias, threadId, revision]);
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const selectionKey = useMemo(
    () =>
      canonicalArtifactJson({
        binding,
        selection,
        responseMode,
        page:
          responseMode === "stepwise-debate" || page === null
            ? null
            : { snapshotRevision: page.snapshotRevision, items: page.items },
      }),
    [binding, selection, responseMode, page]
  );
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const cancel = () => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    setBusy(false);
    candidateLive.current = null;
    setCandidate(null);
    observationGeneration.current = -1;
    setObservation(null);
    debateMetadataLive.current = null;
    return setDebateMetadata(null);
  };
  useEffect(() => {
    cancel();
    preparedRequest.current = null;
    setOperation(null);
    operationRef.current = null;
    originalPreview.current = null;
    setObservation(null);
    setReference(null);
    setSettled(false);
    debateSeed.current = null;
    debateAnchor.current = null;
    setResponseMode("one-expert");
    setSelection({ start: "", end: "", query: "", expertId: "" });
    setStatus(
      "Choose one expert and a human-only context window. No response requested."
    );
    return cancel;
  }, [scope.accountAlias, threadId]);
  useEffect(() => {
    setCandidate(null);
    candidateLive.current = null;
    return;
  }, [selectionKey]);
  useEffect(() => {
    const invalidate = () => {
      cancel();
      return setReference(null);
    };
    const visibility = () => {
      if (!browserReadable()) return invalidate();
      return;
    };
    const unsubscribe = auth?.subscribe(invalidate);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("offline", invalidate);
    return () => {
      unsubscribe?.();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", invalidate);
      return window.removeEventListener("offline", invalidate);
    };
  }, [auth]);
  useEffect(() => {
    if (candidate === null) return;
    if (!researchLifetimeCurrent(candidate, performance.now(), Date.now())) {
      candidateLive.current = null;
      setCandidate(null);
      return;
    }
    const timer = setTimeout(
      () => setCandidate(null),
      researchLifetimeRemaining(candidate, performance.now(), Date.now())
    );
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    if (debateMetadata === null) return;
    if (
      !researchLifetimeCurrent(debateMetadata, performance.now(), Date.now())
    ) {
      setDebateMetadata(null);
      return;
    }
    const timer = setTimeout(
      () => setDebateMetadata(null),
      researchLifetimeRemaining(debateMetadata, performance.now(), Date.now())
    );
    return () => clearTimeout(timer);
  });
  const run = <T,>(
    read: (signal: AbortSignal) => Promise<T>,
    consume: (
      value: T,
      start: number,
      wall: number,
      live: () => boolean
    ) => Promise<void> | void,
    failure: string
  ): Promise<void> => {
    // Use the established generic-arrow form; keep async on a nongeneric body.
    const execute = async (): Promise<void> => {
      if (
        active.current !== null ||
        port === null ||
        auth === null ||
        !auth.isCurrent() ||
        !browserReadable()
      )
        return;
      const controller = new AbortController();
      generation.current += 1;
      const request = { controller, generation: generation.current };
      active.current = request;
      setBusy(true);
      const start = performance.now(),
        wall = Date.now();
      const lifetime = {
        deadline: start + 12_000,
        wallDeadline: wall + 12_000,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const owns = (): boolean =>
        active.current === request &&
        generation.current === request.generation &&
        currentBinding.current === binding;
      const live = (): boolean =>
        owns() &&
        !controller.signal.aborted &&
        researchLifetimeCurrent(lifetime, performance.now(), Date.now()) &&
        auth.isCurrent() &&
        auth.getRevision() === revision &&
        browserReadable();
      const fail = (error: unknown) => {
        if (!owns()) return;
        // Retire the WHOLE attempt, including local digest/consume work already
        // awaiting after transport. Preserve original mutation key/plan for inspect.
        generation.current += 1;
        active.current = null;
        controller.abort();
        candidateLive.current = null;
        setCandidate(null);
        debateMetadataLive.current = null;
        setDebateMetadata(null);
        observationGeneration.current = -1;
        setObservation(null);
        setReference(null);
        setBusy(false);
        setStatus(failure);
        if (classifyVertexFailure(error).kind === "unauthorized")
          return auth.invalidate();
        return;
      };
      const work = async () => {
        const value = await read(controller.signal);
        if (!live()) {
          fail(new VertexReadError("unavailable"));
          return;
        }
        await consume(value, start, wall, live);
        // Timers may be delayed; the original request-start deadline is checked
        // synchronously before every commit and again after local consumption.
        if (!live()) return fail(new VertexReadError("unavailable"));
        return;
      };
      try {
        await Promise.race([
          work(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                const error = new VertexReadError("unavailable");
                fail(error);
                return reject(error);
              },
              researchLifetimeRemaining(lifetime, performance.now(), Date.now())
            );
          }),
        ]);
      } catch (error) {
        fail(error);
      } finally {
        clearTimeout(timer);
        if (active.current === request) {
          active.current = null;
          setBusy(false);
        }
      }
    };
    return execute();
  };
  const inspect = () => {
    const original = operationRef.current;
    if (
      original === null ||
      port === null ||
      original.request.threadId !== threadId
    )
      return;
    const {
      accountAlias,
      environment,
      threadId: originalThread,
      idempotencyKey,
    } = original.request;
    setObservation(null);
    setReference(null);
    return void run(
      (signal) =>
        port.readResponse(
          {
            accountAlias,
            environment,
            threadId: originalThread,
            idempotencyKey,
          },
          signal
        ),
      async (value, _start, _wall, live) => {
        const inspectedGeneration = generation.current;
        const expected = originalPreview.current;
        const requestSha256 = await hashArtifact(
          canonicalArtifactJson(original.request)
        );
        if (
          !live() ||
          operationRef.current !== original ||
          generation.current !== inspectedGeneration
        )
          return;
        const receipt = value.receipt,
          request = original.request;
        if (
          expected === null ||
          receipt.responseRequestId !== expected.responseRequestId ||
          receipt.requestSha256 !== requestSha256 ||
          receipt.parentMessageId !== request.parentMessageId ||
          receipt.participantId !== request.participantId ||
          receipt.snapshotRevision !== request.snapshotRevision ||
          receipt.contextStartSequence !== request.contextStartSequence
        )
          throw new VertexReadError("malformed");
        if (
          receipt.status === "admitted" &&
          (receipt.admission.contextSha256 !== expected.context.sha256 ||
            receipt.admission.participantConfigSha256 !==
              expected.expert.configurationSha256 ||
            receipt.admission.collectionId !== expected.corpus.collectionId)
        )
          throw new VertexReadError("malformed");
        if (!live()) return;
        observationGeneration.current = inspectedGeneration;
        setObservation(value);
        setSettled(
          value.delivery.status === "appended" ||
            (!("debate" in request) && value.receipt.status === "unavailable")
        );
        setStatus(
          `Original request: ${value.receipt.status}; delivery: ${value.delivery.status}${value.job === null ? "" : `; worker: ${value.job.state}`}. Inspection never requests new model work.`
        );
        if (value.delivery.status === "appended") return refreshReads();
        return;
      },
      "Original request status unavailable. Outcome may be unknown. Inspect this same key again; do not create a replacement request."
    );
  };
  const currentDebateMetadata =
    debateMetadata !== null &&
    debateMetadata.binding === binding &&
    auth?.isCurrent() &&
    browserReadable() &&
    researchLifetimeCurrent(debateMetadata, performance.now(), Date.now())
      ? debateMetadata.value
      : null;
  debateMetadataLive.current =
    currentDebateMetadata === null ? null : debateMetadata;
  const readDebateRun = () => {
    const seed = debateSeed.current,
      anchor = debateAnchor.current;
    if (
      seed === null ||
      anchor === null ||
      port === null ||
      active.current !== null
    )
      return;
    debateMetadataLive.current = null;
    candidateLive.current = null;
    setCandidate(null);
    setDebateMetadata(null);
    const selector = {
      accountAlias: seed.request.accountAlias,
      environment: seed.request.environment,
      threadId: seed.request.threadId,
      runKey: seed.request.debate.runKey,
    };
    return void run(
      (signal) => port.readDebateRun(selector, signal),
      (value, start, wall, live) => {
        if (
          !live() ||
          debateSeed.current !== seed ||
          debateAnchor.current !== anchor
        )
          return;
        if (value.status !== "available") {
          setStatus(
            "Debate metadata unavailable. No next-step readiness or permission is assumed; inspect the original operation if its outcome is unknown."
          );
          return;
        }
        assertResearchDebateAnchor(value, anchor);
        const original = operationRef.current;
        if (original !== null && "debate" in original.request) {
          const ordinal = original.request.debate.ordinal;
          const debateStep = value.steps.find(
            (entry) => entry.ordinal === ordinal
          );
          if (
            debateStep === undefined ||
            debateStep.idempotencyKey !== original.request.idempotencyKey ||
            debateStep.planId !== original.planId ||
            debateStep.planSha256 !== original.planSha256 ||
            debateStep.responseRequestId !==
              originalPreview.current?.responseRequestId
          )
            throw new VertexReadError("malformed");
          const expected = originalPreview.current;
          if (
            value.nextStep !== null &&
            expected !== null &&
            "debate" in expected
          ) {
            if (
              !sameResearchChatRequest(
                value.nextStep.predecessors.slice(0, ordinal - 1),
                expected.debate.predecessors
              )
            )
              throw new VertexReadError("malformed");
            const previous = value.nextStep.predecessors[ordinal - 1];
            const published = page?.items.find(
              (message): message is VertexResearchChatAgentReferenceMessage =>
                message.kind === "advisory-reference" &&
                message.response.responseRequestId ===
                  expected.responseRequestId
            );
            if (
              previous === undefined ||
              previous.responseRequestId !== expected.responseRequestId ||
              previous.planId !== original.planId ||
              previous.planSha256 !== original.planSha256
            )
              throw new VertexReadError("malformed");
            if (
              published !== undefined &&
              (previous.contentSha256 !==
                published.response.advisoryArtifact.artifactSha256 ||
                previous.copyId !==
                  published.response.advisoryArtifact.artifactId ||
                previous.runId !== published.author.runId)
            )
              throw new VertexReadError("malformed");
          }
        }
        const lifetime = researchLifetime(
          value.checkedAt,
          value.notAfter,
          start,
          wall
        );
        if (
          !(
            live() &&
            researchLifetimeCurrent(lifetime, performance.now(), Date.now())
          )
        )
          return;
        setDebateMetadata({ binding, value, ...lifetime });
        return setStatus(
          value.complete
            ? "Five-turn run complete. No further computation is available."
            : value.nextStep === null
              ? "No next step ready. Prior publication and independent derived-use review remain required; metadata does not grant either."
              : `Server metadata identifies step ${value.nextStep.ordinal} of 5. Prepare and review that step explicitly; reading metadata requests no model work.`
        );
      },
      "Debate metadata unavailable. No request or independent review was issued."
    );
  };
  const canPrepareDebate =
    responseMode === "stepwise-debate" &&
    (operation === null ||
      (settled &&
        currentDebateMetadata !== null &&
        currentDebateMetadata.nextStep !== null &&
        "debate" in operation.request &&
        currentDebateMetadata.nextStep.ordinal ===
          operation.request.debate.ordinal + 1));
  const prepare = () => {
    if (
      page === null ||
      port === null ||
      active.current !== null ||
      (responseMode !== "stepwise-debate" && operationRef.current !== null) ||
      (responseMode === "stepwise-debate" && !canPrepareDebate)
    )
      return;
    if (
      currentSelection.current !== selectionKey ||
      currentBinding.current !== binding ||
      !auth?.isCurrent() ||
      !browserReadable()
    )
      return;
    if (
      responseMode === "stepwise-debate" &&
      operationRef.current !== null &&
      (operationRef.current !== operation ||
        debateMetadata === null ||
        debateMetadataLive.current !== debateMetadata ||
        !researchLifetimeCurrent(debateMetadata, performance.now(), Date.now()))
    )
      return;
    const next =
      responseMode === "stepwise-debate" && operationRef.current !== null
        ? currentDebateMetadata?.nextStep
        : null;
    const selectedParticipant =
      next !== null && next !== undefined && currentDebateMetadata !== null
        ? researchDebateSpeaker(currentDebateMetadata, next.ordinal)
        : selection.expertId;
    const participant = participants.find(
      (value) => value.participantId === selectedParticipant
    );
    const nativeMate =
      responseMode === "first-mate-read-reviewed-evidence-v1" &&
      participant?.participantId === "first-mate" &&
      participant.kind === "first-mate";
    const configuredMate =
      responseMode === "one-expert" &&
      participant?.participantId === "first-mate" &&
      participant.kind === "first-mate" &&
      participant.advisory?.status === "configured" &&
      participant.advisory.authorization === "requires-governed-prepare";
    const debateExpertPreview =
      responseMode === "stepwise-debate" &&
      participant !== undefined &&
      canRequestDebatePreview(participant);
    const ordinaryExpertPreview =
      responseMode === "one-expert" &&
      participant !== undefined &&
      canRequestExpertPreview(participant);
    if (
      participant === undefined ||
      !page.thread.participantIds.includes(participant.participantId) ||
      !(responseMode === "first-mate-read-reviewed-evidence-v1"
        ? nativeMate
        : responseMode === "stepwise-debate"
          ? debateExpertPreview
          : ordinaryExpertPreview || configuredMate)
    ) {
      setStatus(
        "Select a responder in this room for the chosen workflow. Native evidence requires First Mate and separate governed preparation; roster metadata is not permission."
      );
      return;
    }
    try {
      let messages =
        debateSeed.current?.messages ??
        selectResearchHumanWindow(page, selection.start, selection.end);
      let input: ResearchPreparedCandidate["preview"]["request"];
      if (responseMode === "stepwise-debate") {
        if (debateSeed.current === null) {
          const request = VertexResearchChatDebateStepInputSchema.parse({
            ...researchResponseRequest(
              page,
              selection.start,
              selection.end,
              selection.expertId,
              selection.query,
              crypto.randomUUID()
            ),
            debate: {
              profile: "vertex-research-chat-debate-step-v1",
              runKey: crypto.randomUUID(),
              ordinal: 1,
              predecessors: [],
            },
          });
          debateSeed.current = Object.freeze({ request, messages });
        }
        const seed = debateSeed.current;
        const cached = preparedRequest.current?.input;
        input =
          next === null
            ? seed.request
            : cached !== undefined &&
                "debate" in cached &&
                sameResearchChatRequest(cached.debate, next)
              ? cached
              : VertexResearchChatDebateStepInputSchema.parse({
                  ...seed.request,
                  participantId: selectedParticipant,
                  idempotencyKey: crypto.randomUUID(),
                  debate: next,
                });
        messages = seed.messages;
      } else if (responseMode === "first-mate-read-reviewed-evidence-v1") {
        input =
          preparedRequest.current?.selectionKey === selectionKey
            ? preparedRequest.current.input
            : VertexResearchChatNativeEvidenceRequestSchema.parse({
                ...researchResponseRequest(
                  page,
                  selection.start,
                  selection.end,
                  "first-mate",
                  selection.query,
                  crypto.randomUUID()
                ),
                protocol: "first-mate-read-reviewed-evidence-v1",
              });
      } else {
        input =
          preparedRequest.current?.selectionKey === selectionKey
            ? preparedRequest.current.input
            : researchResponseRequest(
                page,
                selection.start,
                selection.end,
                selection.expertId,
                selection.query,
                crypto.randomUUID()
              );
      }
      preparedRequest.current = { selectionKey, input };
      const selected = selectionKey;
      setCandidate(null);
      return void run<PreparationResult>(
        (signal) =>
          "protocol" in input
            ? port.prepareNativeEvidence(
                VertexResearchChatNativeEvidenceRequestSchema.parse(input),
                signal
              )
            : "debate" in input
              ? port.prepareDebateStep(input, signal)
              : port.prepareResponse(input, signal),
        async (value, start, wall, live) => {
          if (!live() || currentSelection.current !== selected) return;
          if (value.status === "unavailable") {
            setStatus(
              `Preview unavailable: ${value.reasonCodes.join(", ")}. No approval submitted.`
            );
            return;
          }
          const preparedGeneration = generation.current;
          const recordDigests = await bindResearchPreview(
            value.preview,
            input,
            messages
          );
          if (
            !live() ||
            generation.current !== preparedGeneration ||
            currentSelection.current !== selected
          )
            return;
          const lifetime = researchLifetime(
            value.preview.checkedAt,
            value.preview.notAfter,
            start,
            wall,
            60_000
          );
          if (
            !researchLifetimeCurrent(lifetime, performance.now(), Date.now())
          ) {
            setStatus(
              "Preview expired before it arrived. No approval submitted."
            );
            return;
          }
          if (!live()) return;
          if ("debate" in value.preview) {
            if (!("debate" in input)) throw new VertexReadError("malformed");
            assertResearchDebatePreview(value.preview, input);
            if (
              !value.preview.debate.participantIds.every((id) =>
                page.thread.participantIds.includes(id)
              )
            )
              throw new VertexReadError("malformed");
            if (debateAnchor.current === null)
              debateAnchor.current = value.preview;
            else {
              assertResearchDebateAnchor(value.preview, debateAnchor.current);
            }
          }
          setCandidate(
            Object.freeze({
              preview: value.preview,
              messages,
              recordDigests,
              selectionKey: selected,
              ...lifetime,
            })
          );
          return setStatus(
            "Review the exact context and destination below. Only the labelled approval action requests a response."
          );
        },
        "Preview unavailable. No approval was submitted; no response receipt has been upgraded."
      );
    } catch {
      setCandidate(null);
      return setStatus(
        "Choose a complete contiguous human-only window of 1–16 messages and a literal single-line retrieval query of 10–2,000 characters. Server context must also fit 65,536 UTF-8 bytes."
      );
    }
  };
  const visibleCandidate =
    candidate !== null &&
    page !== null &&
    candidate.selectionKey === selectionKey &&
    researchLifetimeCurrent(candidate, performance.now(), Date.now()) &&
    auth?.isCurrent() &&
    browserReadable()
      ? candidate
      : null;
  candidateLive.current = visibleCandidate;
  const approve = () => {
    if (
      visibleCandidate === null ||
      candidateLive.current !== visibleCandidate ||
      visibleCandidate.selectionKey !== currentSelection.current ||
      currentBinding.current !== binding ||
      !researchLifetimeCurrent(
        visibleCandidate,
        performance.now(),
        Date.now()
      ) ||
      !auth?.isCurrent() ||
      !browserReadable() ||
      port === null ||
      active.current !== null
    )
      return;
    const { planId, planSha256, request } = visibleCandidate.preview;
    const prior = operationRef.current;
    if (
      prior !== null &&
      !(
        settled &&
        "debate" in prior.request &&
        "debate" in request &&
        request.debate.ordinal === prior.request.debate.ordinal + 1
      )
    )
      return;
    const original: ConversationApproval =
      "protocol" in request
        ? VertexResearchChatNativeEvidenceApproveInputSchema.parse({
            planId,
            planSha256,
            request,
            consent: "approve-bounded-native-evidence-protocol-v1",
          })
        : "debate" in request
          ? VertexResearchChatDebateApproveInputSchema.parse({
              planId,
              planSha256,
              request,
            })
          : VertexResearchChatApproveAndRequestResponseInputSchema.parse({
              planId,
              planSha256,
              request,
            });
    // Pin BEFORE I/O. Blocked/timeout/unknown never proves prior-effect absence.
    operationRef.current = original;
    originalPreview.current = visibleCandidate.preview;
    candidateLive.current = null;
    setOperation(original);
    setCandidate(null);
    setObservation(null);
    setSettled(false);
    setDebateMetadata(null);
    setStatus(
      "Approval and request submitted for this original key. Awaiting acknowledgement."
    );
    return void run(
      (signal) =>
        "protocol" in original.request
          ? port.approveAndRequestNativeEvidence(
              VertexResearchChatNativeEvidenceApproveInputSchema.parse(
                original
              ),
              signal
            )
          : "debate" in original.request
            ? port.approveAndRequestDebateStep(
                VertexResearchChatDebateApproveInputSchema.parse(original),
                signal
              )
            : port.approveAndRequestResponse(
                VertexResearchChatApproveAndRequestResponseInputSchema.parse(
                  original
                ),
                signal
              ),
      (value, _start, _wall, live) => {
        if (!live()) return;
        if (
          value.status === "recorded" &&
          value.receipt.responseRequestId !==
            originalPreview.current?.responseRequestId
        )
          throw new VertexReadError("malformed");
        return setStatus(
          value.status === "recorded"
            ? `Original receipt: ${value.receipt.status}. Inspect this request for current delivery; no answer is implied.`
            : `${value.status === "blocked" ? "Blocked" : "Outcome unknown"}: ${value.reasonCodes.join(", ")}. Prior effects may exist. Inspect only this original request key.`
        );
      },
      "Approval/request not acknowledged. The original plan and key are retained; inspect only this operation. No automatic approval retry or fresh-key model retry."
    );
  };
  const append = () => {
    const original = operationRef.current;
    if (
      original === null ||
      port === null ||
      page === null ||
      observation === null ||
      observation.delivery.status !== "eligible" ||
      active.current !== null ||
      observationGeneration.current !== generation.current ||
      observation.receipt.idempotencyKey !== original.request.idempotencyKey ||
      observation.receipt.threadId !== original.request.threadId ||
      currentBinding.current !== binding ||
      !auth?.isCurrent() ||
      !browserReadable()
    )
      return;
    const input = {
      ...scope,
      threadId: original.request.threadId,
      responseRequestId: observation.receipt.responseRequestId,
      expectedRevision: page.thread.revision,
    };
    setObservation(null);
    setReference(null);
    return void run(
      (signal) => port.appendResponse(input, signal),
      (value, _start, _wall, live) => {
        if (!live()) return;
        if (value.status === "appended") {
          const message = value.message,
            expected = originalPreview.current;
          if (
            expected === null ||
            message.response.planId !== original.planId ||
            message.response.planSha256 !== original.planSha256 ||
            message.response.requestSha256 !==
              observation.receipt.requestSha256 ||
            message.response.contextSha256 !== expected.context.sha256 ||
            message.replyToMessageId !== original.request.parentMessageId ||
            message.author.participantId !== original.request.participantId ||
            message.response.snapshotRevision !==
              original.request.snapshotRevision ||
            message.response.contextStartSequence !==
              original.request.contextStartSequence
          )
            throw new VertexReadError("malformed");
          if (!live()) return;
          setReference(value.message);
          setSettled(true);
          setStatus(
            "Immutable answer reference published. Private content is checked separately against current read access."
          );
          return refreshReads();
        }
        return setStatus(
          `${value.status}: ${value.reasonCodes.join(", ")}. Keep this original request. Inspect and refresh before an explicit append retry.`
        );
      },
      "Append not acknowledged or conversation changed. Refetch this same operation and current conversation revision before explicitly appending again; never regenerate the answer."
    );
  };
  const privateRead = useResearchPrivateContent(
    port,
    scope,
    threadId,
    reference,
    viewGeneration,
    privateDisplayReadable
  );
  const controls: ResearchConversationControls = {
    ...selection,
    busy,
    locked: (operation !== null && !settled) || page === null,
    candidate: visibleCandidate,
    status,
    operationKey: operation?.request.idempotencyKey ?? null,
    canAppend:
      !busy &&
      page !== null &&
      observation?.delivery.status === "eligible" &&
      observationGeneration.current === generation.current &&
      auth?.isCurrent() === true &&
      browserReadable(),
    debate: {
      mode: responseMode,
      frozen: debateSeed.current !== null,
      runKey: debateSeed.current?.request.debate.runKey ?? null,
      metadata: currentDebateMetadata,
      canPrepare: canPrepareDebate,
      onReadRun: readDebateRun,
      onModeChange: (mode) => {
        if (
          active.current !== null ||
          operationRef.current !== null ||
          ![
            "one-expert",
            "stepwise-debate",
            "first-mate-read-reviewed-evidence-v1",
          ].includes(mode)
        )
          return;
        cancel();
        preparedRequest.current = null;
        debateSeed.current = null;
        debateAnchor.current = null;
        return setResponseMode(mode);
      },
    },
    onSelectionChange: (field, value) => {
      if (debateSeed.current !== null) return;
      cancel();
      if (settled) {
        operationRef.current = null;
        originalPreview.current = null;
        setOperation(null);
        setObservation(null);
        setSettled(false);
      }
      return setSelection((previous) => ({ ...previous, [field]: value }));
    },
    onPrepare: prepare,
    onApprove: approve,
    onInspect: inspect,
    onAppend: append,
  };
  return {
    conversation: controls,
    privateContent: privateRead.content,
    navigationLocked: busy || (operation !== null && !settled),
    onViewResponse: (selected: VertexResearchChatAgentReferenceMessage) => {
      if (
        page === null ||
        selected.threadId !== threadId ||
        !page.items.some((message) =>
          sameResearchChatRequest(message, selected)
        )
      )
        return;
      privateRead.hide();
      setReference(selected);
      return setViewGeneration((value) => value + 1);
    },
    onHideResponse: () => {
      privateRead.hide();
      return setReference(null);
    },
  };
};

const ResearchRoom = ({ scope }: { readonly scope: ResearchScope }) => {
  const services = useExperienceServices();
  const port = services.researchChat ?? null;
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [requestedParticipantIds, setRequestedParticipantIds] = useState<
    readonly string[]
  >([]);
  const [mode, setMode] =
    useState<VertexResearchChatSendMessageInput["mode"]>("discuss");
  const [response, setResponse] = useState<VertexResearchChatResponse | null>(
    null
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const pendingRef = useRef<PendingMutation | null>(null);
  const inFlight = useRef(false);
  const currentMessageCursor = useRef(messageCursor);
  currentMessageCursor.current = messageCursor;
  const attempt = useRef(0);
  const mounted = useRef(false);
  const loadDirectory = useMemo(
    () =>
      async (
        input: ResearchScope &
          Readonly<{ limit: number; cursor: string | null }>,
        signal: AbortSignal
      ) => {
        // Directory readiness is independent of the transcript's fixed boundary.
        if (port === null) return unavailable();
        const [roster, threads] = await Promise.all([
          port.roster(
            { accountAlias: input.accountAlias, environment: "research" },
            signal
          ),
          port.listThreads(input, signal),
        ]);
        return { cursor: input.cursor, roster, threads };
      },
    [port]
  );
  const loadRoom = useMemo(
    () => async (input: RoomSelection, signal: AbortSignal) => {
      if (port === null) return unavailable();
      const transcript = await port.readTranscriptPage(input, signal);
      assertResearchRoomSnapshot(transcript);
      return { input, transcript };
    },
    [port]
  );
  const directory = useExperienceResource(loadDirectory);
  const room = useExperienceResource(loadRoom);
  const creation = useExperienceResource(port?.createThread ?? unavailable);
  const sending = useExperienceResource(port?.sendMessage ?? unavailable);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRef.current = null;
      inFlight.current = false;
      return;
    };
  }, []);
  useEffect(() => {
    return void directory.resource.load({
      ...scope,
      limit: PAGE_SIZE,
      cursor: threadCursor,
    });
  }, [directory.resource, scope.accountAlias, threadCursor]);
  useEffect(() => {
    room.resource.clear();
    if (threadId !== null)
      return void room.resource.load({
        ...scope,
        threadId,
        limit: PAGE_SIZE,
        cursor: messageCursor,
      });
    return;
  }, [room.resource, scope.accountAlias, threadId, messageCursor]);

  const directoryValue =
    directory.state.type === "ready" &&
    directory.state.value.cursor === threadCursor
      ? directory.state.value
      : null;
  const roomValue =
    room.state.type === "ready" &&
    room.state.value.input.threadId === threadId &&
    room.state.value.input.cursor === messageCursor
      ? room.state.value
      : null;
  const directoryThread = directoryValue?.threads.items.find(
    (value) => value.threadId === threadId
  );
  const headAdvanced =
    roomValue !== null &&
    (roomValue.transcript.thread.revision !==
      roomValue.transcript.snapshotRevision ||
      (directoryThread !== undefined &&
        BigInt(directoryThread.revision) >
          BigInt(roomValue.transcript.snapshotRevision)));
  const sendDisabled =
    roomValue === null ||
    roomValue.transcript.nextCursor !== null ||
    headAdvanced;
  const readError =
    directory.state.type === "error"
      ? directory.state.failure.detail
      : room.state.type === "error"
        ? room.state.failure.detail
        : null;
  const loading =
    directory.state.type === "idle" ||
    directory.state.type === "loading" ||
    (threadId !== null &&
      (room.state.type === "idle" || room.state.type === "loading"));
  const refreshReads = () => {
    setLocalError(null);
    void directory.resource.load({
      ...scope,
      limit: PAGE_SIZE,
      cursor: threadCursor,
    });
    // A refresh always starts a new snapshot, never resumes the old high water.
    if (messageCursor !== null) {
      return setMessageCursor(null);
    }
    if (threadId !== null)
      return void room.resource.load({
        ...scope,
        threadId,
        limit: PAGE_SIZE,
        cursor: null,
      });
    return;
  };
  const responseInteraction = useResearchConversation(
    scope,
    threadId,
    directory.state.type === "error" ? null : (roomValue?.transcript ?? null),
    directoryValue?.roster.participants ?? [],
    port,
    refreshReads,
    roomValue !== null && !loading && readError === null
  );
  const selectThread = (selected: string) => {
    if (
      pendingRef.current !== null ||
      inFlight.current ||
      responseInteraction.navigationLocked
    )
      return;
    responseInteraction.onHideResponse();
    room.resource.clear();
    setThreadId(selected);
    setMessageCursor(null);
    setDraft("");
    setRequestedParticipantIds([]);
    setResponse(null);
    return setLocalError(null);
  };

  const runMutation = async (request: PendingMutation) => {
    const previous =
      request.kind === "create"
        ? creation.resource.getSnapshot()
        : sending.resource.getSnapshot();
    if (
      (inFlight.current && previous.type !== "error") ||
      (pendingRef.current !== null &&
        !sameResearchChatRequest(pendingRef.current, request))
    )
      return;
    const currentAttempt = ++attempt.current;
    pendingRef.current = request;
    setPending(request);
    inFlight.current = true;
    setLocalError(null);
    setResponse(null);
    try {
      if (request.kind === "create") {
        await creation.resource.load(request.input);
        const result = creation.resource.getSnapshot();
        if (
          !mounted.current ||
          attempt.current !== currentAttempt ||
          pendingRef.current !== request ||
          result.type !== "ready"
        )
          return;
        pendingRef.current = null;
        setPending(null);
        room.resource.clear();
        setThreadId(result.value.threadId);
        setMessageCursor(null);
        setDraft("");
        setRequestedParticipantIds([]);
      } else {
        await sending.resource.load(request.input);
        const result = sending.resource.getSnapshot();
        if (
          !mounted.current ||
          attempt.current !== currentAttempt ||
          pendingRef.current !== request ||
          result.type !== "ready"
        )
          return;
        pendingRef.current = null;
        setPending(null);
        // A persisted human acknowledgement, not a queued or completed answer.
        setDraft("");
        setResponse(result.value.response);
        if (currentMessageCursor.current !== null) {
          setMessageCursor(null);
        } else if (threadId !== null)
          void room.resource.load({
            ...scope,
            threadId,
            limit: PAGE_SIZE,
            cursor: null,
          });
      }
      return void directory.resource.load({
        ...scope,
        limit: PAGE_SIZE,
        cursor: threadCursor,
      });
    } finally {
      if (mounted.current && attempt.current === currentAttempt)
        inFlight.current = false;
    }
  };

  const createThread = (title: string, participantIds: readonly string[]) => {
    if (
      pendingRef.current !== null ||
      port === null ||
      responseInteraction.navigationLocked
    )
      return;
    try {
      const input = Object.freeze(
        VertexResearchChatCreateThreadInputSchema.parse({
          ...scope,
          title,
          participantIds: [...participantIds],
          idempotencyKey: crypto.randomUUID(),
        })
      );
      return void runMutation(Object.freeze({ kind: "create", input }));
    } catch {
      return setLocalError(
        "Enter a room title and choose 1–16 distinct configured participants."
      );
    }
  };
  const sendMessage = () => {
    if (pendingRef.current !== null || port === null || roomValue === null)
      return;
    if (roomValue.transcript.nextCursor !== null) {
      setLocalError("Open the final message page before adding a message.");
      return;
    }
    if (headAdvanced) {
      setLocalError(
        "New messages are available. Refresh to latest before sending a new message."
      );
      return;
    }
    try {
      const input = Object.freeze(
        VertexResearchChatSendMessageInputSchema.parse({
          ...scope,
          threadId: roomValue.transcript.thread.threadId,
          expectedRevision: roomValue.transcript.snapshotRevision,
          idempotencyKey: crypto.randomUUID(),
          body: draft,
          requestedParticipantIds: [],
          mode: "discuss",
        })
      );
      return void runMutation(Object.freeze({ kind: "send", input }));
    } catch {
      return setLocalError(
        "Enter a nonblank message of at most 8,000 characters without unsafe control characters."
      );
    }
  };
  const mutationState =
    pending?.kind === "create" ? creation.state : sending.state;
  const mutationFailed = pending !== null && mutationState.type === "error";
  if (port === null)
    return (
      <ReadNotice title="Research chat unavailable">
        The research-room service is not configured. No message has been sent or
        agent started.
      </ReadNotice>
    );
  return (
    <section aria-label="Shared research room">
      {localError === null ? null : <p role="alert">{localError}</p>}
      {mutationFailed ? (
        <section
          className={alertVariants()}
          aria-label="Research chat acknowledgement recovery"
        >
          <h3>Write not acknowledged — outcome may be unknown</h3>
          <p>
            {mutationState.type === "error" ? mutationState.failure.detail : ""}{" "}
            Your draft and exact request are retained in this open room.
            Refreshing reads does not resend it.
          </p>
          <Button
            type="button"
            onClick={() => {
              if (pendingRef.current !== null)
                return void runMutation(pendingRef.current);
              return;
            }}
          >
            Retry the same request
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              if (!mutationFailed) return;
              attempt.current += 1;
              inFlight.current = false;
              pendingRef.current = null;
              setPending(null);
              creation.resource.clear();
              sending.resource.clear();
              setDraft("");
              refreshReads();
              return setLocalError(
                "Retry state discarded. The earlier write may still exist; inspect the conversation before sending a new message."
              );
            }}
          >
            Discard local retry state
          </Button>
        </section>
      ) : null}
      {headAdvanced ? (
        <section
          className={alertVariants()}
          aria-label="Newer research messages available"
        >
          <p>
            New messages are available. This page remains a fixed snapshot;
            refresh to latest before sending a new message. Your draft is
            retained.
          </p>
          <Button variant="outline" type="button" onClick={refreshReads}>
            Refresh to latest
          </Button>
        </section>
      ) : null}
      <ResearchChatView
        conversation={responseInteraction.conversation}
        privateContent={responseInteraction.privateContent}
        onViewResponse={responseInteraction.onViewResponse}
        onHideResponse={responseInteraction.onHideResponse}
        selectedThread={roomValue?.transcript.thread ?? null}
        threads={directoryValue?.threads.items ?? []}
        messages={roomValue?.transcript.items ?? []}
        participants={directoryValue?.roster.participants ?? []}
        loading={loading}
        error={readError}
        draft={draft}
        onDraftChange={setDraft}
        sending={pending !== null && mutationState.type === "loading"}
        mutationLocked={pending !== null}
        sendDisabled={sendDisabled}
        responseStatus={response?.status ?? null}
        responseReasonCodes={response?.reasonCodes ?? []}
        requestedParticipantIds={requestedParticipantIds}
        onRequestedParticipantsChange={setRequestedParticipantIds}
        mode={mode}
        onModeChange={setMode}
        onSelectThread={selectThread}
        onCreateThread={createThread}
        onSendMessage={sendMessage}
        onRetry={refreshReads}
      />
      <nav
        className="vx-ex-table-pager"
        aria-label="Research conversation pages"
      >
        <Button
          variant="outline"
          type="button"
          disabled={pending !== null || threadCursor === null}
          onClick={() => {
            responseInteraction.onHideResponse();
            return setThreadCursor(null);
          }}
        >
          First room page
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={
            pending !== null || directoryValue?.threads.nextCursor === null
          }
          onClick={() => {
            responseInteraction.onHideResponse();
            return setThreadCursor(directoryValue?.threads.nextCursor ?? null);
          }}
        >
          Next room page
        </Button>
        {threadId === null ? null : (
          <>
            <Button
              variant="outline"
              type="button"
              disabled={pending !== null || messageCursor === null}
              onClick={() => {
                responseInteraction.onHideResponse();
                return setMessageCursor(null);
              }}
            >
              First message page
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={
                pending !== null || roomValue?.transcript.nextCursor === null
              }
              onClick={() => {
                responseInteraction.onHideResponse();
                return setMessageCursor(
                  roomValue?.transcript.nextCursor ?? null
                );
              }}
            >
              Next message page
            </Button>
            <span>
              {roomValue === null
                ? "No transcript page loaded"
                : roomValue.transcript.nextCursor === null
                  ? "Final loaded message page"
                  : "More recorded messages remain"}
            </span>
          </>
        )}
      </nav>
    </section>
  );
};

export const ResearchChatRoom = ({
  scope,
}: {
  readonly scope: ExperienceScope;
}) =>
  scope.environment === "research" ? (
    <ResearchRoom
      scope={{ accountAlias: scope.accountAlias, environment: "research" }}
      key={scope.accountAlias}
    />
  ) : (
    <ReadNotice title="Choose the research environment for conversations">
      Paper and live observations do not authorize research-room messages or
      agent actions.
    </ReadNotice>
  );
