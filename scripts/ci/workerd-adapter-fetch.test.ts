import { existsSync } from "node:fs";
import type { SafeAuthSession } from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { RECOVERY_CONFIRMATION } from "../../packages/shared/src/vertex/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedDashboardFetch } from "../../apps/web/src/lib/dashboard-transport.ts";
import { getPortalSession } from "../../apps/web/src/lib/server-session.ts";
import { forwardThemeApiRequest } from "../../apps/web/src/lib/server-theme-api.ts";
import { fetchThemeApiRequest } from "../../apps/web/src/lib/theme-api-timeout.ts";
import { createGroqAiPort } from "../../packages/ai/src/server/groq.ts";
import { createPostHogAnalyticsPort } from "../../packages/analytics/src/server/posthog.ts";
import { createApiClient } from "../../packages/api/src/client.ts";
import { fetchArxivMetadata } from "../../packages/api/src/server/arxiv.ts";
import { createOpenRouterClient } from "../../packages/api/src/server/assistant-runtime.ts";
import { createApiContext } from "../../packages/api/src/server/context.ts";
import { fetchDeploymentStatus } from "../../packages/api/src/server/deploy-status.ts";
import { createBridgeQuotesReader } from "../../packages/api/src/server/golive-live-quotes.ts";
import { handleApiRequest } from "../../packages/api/src/server/handler.ts";
import { fetchIbkrMonitorJson } from "../../packages/api/src/server/ibkr-monitor.ts";
import { setIbkrRecoveryDependenciesForTesting } from "../../packages/api/src/server/ibkr-recovery.ts";
import { callJev } from "../../packages/api/src/server/jev-client.ts";
import { fetchLoopbackStatus } from "../../packages/api/src/server/loopback-status.ts";
import { fetchHistoryDocument } from "../../packages/api/src/server/market-data.ts";
import { fetchBoundedText } from "../../packages/api/src/server/market-news.ts";
import { setNautilusArmDependenciesForTesting } from "../../packages/api/src/server/nautilus-arm.ts";
import { createIbkrOptionsQuoteSource } from "../../packages/api/src/server/options-chain-ibkr.ts";
import { createNasdaqOptionsOpenInterestSource } from "../../packages/api/src/server/options-chain-nasdaq.ts";
import { createYahooOptionsSource } from "../../packages/api/src/server/options-chain-yahoo.ts";
import { fetchPortfolioMonitor } from "../../packages/api/src/server/portfolio-monitor.ts";
import { sendPriceAlertsNtfy } from "../../packages/api/src/server/price-alerts-ntfy.ts";
import { createQuantDataClient } from "../../packages/api/src/server/quantdata-client.ts";
import { fetchBoundedJson } from "../../packages/api/src/server/research-lenses.ts";
import {
  readChart,
  readSwinglytics,
  setResearchScreenOptionsForTesting,
} from "../../packages/api/src/server/research-screen-evidence.ts";
import { createBridgeOrderGateway } from "../../packages/api/src/server/vertex-orders-gateway.ts";
import { createResendContactEmailPort } from "../../packages/email/src/server/contact.ts";
import { createResendNotificationEmailPort } from "../../packages/email/src/server/notification.ts";
import { createResendEmailPort } from "../../packages/email/src/server/provider.ts";
import { createRemotePreviewEmailPort } from "../../packages/email/src/server/remote-preview.ts";
import { createNtfyNotificationAdapter } from "../../packages/notifications/src/server/ntfy.ts";

import {
  discoverOutboundFetchFiles,
  type LoopbackResponseConfig,
  type ReplayRecord,
  startWorkerdReplayHarness,
  withCapturedRequestCache,
  type WorkerdReplayHarness,
} from "./workerd-replay.ts";

// Replays every workerd-reachable fetch-based and fetch-SDK outbound adapter's actual
// RequestInit inside the repository's pinned workerd binary (configured with
// apps/web/wrangler.jsonc's compatibility_date and compatibility_flags) against a loopback
// 200/302 server. Node accepts fetch options that workerd rejects with a TypeError before
// sending any request (e.g. redirect:"error", cache:"default"); running every adapter's real
// RequestInit through workerd in CI closes that gap across all packages.

type AdapterReplayCase = Readonly<{
  /** HTTP methods that must be observed in the 200 pass (guards multi-method adapters against dead POST paths). */
  expectedMethods?: readonly string[];
  /** Whether the adapter is expected to send redirect:"manual" and never follow 302s. */
  expectManualRedirect: boolean;
  /** Repo-relative source file covered by this case. */
  file: string;
  /** Human-readable case label. */
  name: string;
  /** Optional custom 200 loopback response when the adapter requires a specific content-type/body. */
  okResponse?: Omit<LoopbackResponseConfig, "mode">;
  /** Invokes the real adapter with the workerd-replaying fetch wrapper. */
  run: (replayFetch: typeof globalThis.fetch) => Promise<void>;
}>;

const TEST_TOKEN = "t".repeat(48);
const TEST_IDEMPOTENCY_KEY = "a".repeat(64);
const TEST_HMAC_KEY = "k".repeat(43);
const OPERATOR_EMAIL = "operator@domain.test";
const US_REGULAR_SESSION = new Date("2026-11-25T15:00:00.000Z");

const fakeOperatorSession = (): SafeAuthSession => ({
  principal: { role: "admin", status: "active", userId: "operator" },
  session: {
    createdAt: US_REGULAR_SESSION,
    expiresAt: new Date("2026-11-26T15:00:00.000Z"),
    id: "session-operator",
    ipAddress: null,
    updatedAt: US_REGULAR_SESSION,
    userAgent: null,
    userId: "operator",
  },
  user: {
    createdAt: US_REGULAR_SESSION,
    email: OPERATOR_EMAIL,
    emailVerified: true,
    id: "operator",
    image: null,
    name: "Operator",
    role: "admin",
    status: "active",
    updatedAt: US_REGULAR_SESSION,
  },
});

const createInternalProcedureClient = () =>
  createApiClient({
    baseUrl: "https://app.example.test",
    fetch: async (request) => {
      const context = createApiContext(request, {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        ibkrRecovery: {
          token: TEST_TOKEN,
          url: "https://quantvps.tailnet.test:8443/vertex-ibkr-recovery/v1/",
        },
        operatorEmails: [OPERATOR_EMAIL],
        repositories: {
          nautilusArmAudit: {
            countSince: async () => 0,
            record: async () => undefined,
          },
        } as unknown as Repositories,
        requestId: "workerd-replay-req",
        requireRole: async () => fakeOperatorSession(),
        requireSession: async () => fakeOperatorSession(),
        semanticEvents: {
          emit: async () => ({
            analytics: "skipped",
            span: "skipped",
            structuredEvent: "emitted",
          }),
        },
      });
      return await handleApiRequest(request, context);
    },
  });

const ignoreAdapterOutcome = async (
  operation: Promise<unknown>
): Promise<void> => {
  await operation.catch(() => undefined);
};

/** Temporarily binds globalThis.fetch for vendor SDKs (Resend) that do not expose a fetch option. */
const withScopedGlobalFetch = async (
  replayFetch: typeof globalThis.fetch,
  operation: () => Promise<void>
): Promise<void> => {
  const previous = globalThis.fetch;
  globalThis.fetch = replayFetch;
  try {
    await operation();
  } finally {
    globalThis.fetch = previous;
  }
};

const ADAPTER_CASES: readonly AdapterReplayCase[] = [
  {
    expectManualRedirect: true,
    file: "packages/analytics/src/server/posthog.ts",
    name: "analytics/posthog: createPostHogAnalyticsPort",
    run: async (replayFetch) => {
      const port = createPostHogAnalyticsPort({
        apiKey: "phc_workerd_replay_test",
        fetch: replayFetch,
        host: "https://us.i.posthog.com",
      });
      await ignoreAdapterOutcome(
        port.capture({
          consent: "granted",
          distinctId: "user-1",
          event: "workerd_replay_probe",
          eventId: "evt-1",
          properties: { outcome: "success", source: "api" },
        })
      );
    },
  },
  {
    expectManualRedirect: false,
    file: "packages/email/src/server/contact.ts",
    name: "email/contact: createResendContactEmailPort (resend SDK)",
    okResponse: { body: '{"id":"msg-contact-1"}' },
    run: async (replayFetch) => {
      const port = createResendContactEmailPort({
        apiKey: "re_workerd_replay_test",
        from: "alerts@domain.test",
        recipient: "owner@domain.test",
      });
      await withScopedGlobalFetch(replayFetch, async () => {
        await ignoreAdapterOutcome(
          port.sendContact({
            email: "sender@domain.test",
            message: "Workerd replay contact message",
            name: "Sender",
            subject: "Replay contact",
          })
        );
      });
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/email/src/server/notification.ts",
    name: "email/notification: createResendNotificationEmailPort",
    run: async (replayFetch) => {
      const port = createResendNotificationEmailPort({
        apiKey: "re_workerd_replay_test",
        enabled: true,
        fetcher: (url, init) => replayFetch(url, init),
        from: "alerts@domain.test",
      });
      await ignoreAdapterOutcome(
        port.send(
          {
            idempotencyKey: TEST_IDEMPOTENCY_KEY,
            subject: "Workerd replay probe",
            text: "Replay body",
            to: "owner@domain.test",
          },
          new AbortController().signal
        )
      );
    },
  },
  {
    expectManualRedirect: false,
    file: "packages/email/src/server/provider.ts",
    name: "email/provider: createResendEmailPort (resend SDK)",
    okResponse: { body: '{"id":"msg-verify-1"}' },
    run: async (replayFetch) => {
      const port = createResendEmailPort({
        apiKey: "re_workerd_replay_test",
        appEnvironment: "test",
        enabled: true,
        from: "alerts@domain.test",
        trustedAppOrigin: "https://app.example.test",
      });
      await withScopedGlobalFetch(replayFetch, async () => {
        await ignoreAdapterOutcome(
          port.sendEmailVerification({
            expiresInMinutes: 15,
            to: "owner@domain.test",
            verificationUrl:
              "https://app.example.test/api/auth/verify-email?token=hdr.payload.sig&callbackURL=%2Fverify-email%3Fverified%3D1",
          })
        );
      });
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/email/src/server/remote-preview.ts",
    name: "email/remote-preview: createRemotePreviewEmailPort",
    run: async (replayFetch) => {
      const port = createRemotePreviewEmailPort({
        binding: { hmacKey: TEST_HMAC_KEY, runId: "workerd-replay" },
        endpoint: "http://127.0.0.1:4100/v1/capture",
        environment: "test",
        fetcher: replayFetch,
        trustedAppOrigin: "http://127.0.0.1:3000",
      });
      await ignoreAdapterOutcome(
        port.sendEmailVerification({
          expiresInMinutes: 15,
          to: "owner@domain.test",
          verificationUrl: "http://127.0.0.1:3000/verify?token=test",
        })
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/notifications/src/server/ntfy.ts",
    name: "notifications/ntfy: createNtfyNotificationAdapter",
    run: async (replayFetch) => {
      const adapter = createNtfyNotificationAdapter({
        enabled: true,
        fetcher: (url, init) => replayFetch(url, init),
        resolveConfiguration: async () => ({
          bearerToken: TEST_TOKEN,
          enabled: true,
          origin: "https://ntfy.example.test",
          recipientKey: "operator",
          tenantKey: "vertex",
          topic: "alerts",
        }),
      });
      const signal = new AbortController().signal;
      const prep = await adapter.prepare(
        {
          authenticated: true,
          channel: "phone",
          configurationRef: "ntfy-config",
          cooldownMs: 1000,
          enabled: true,
          expiresAt: Date.now() + 60_000,
          purpose: "market-alert",
          recipientKey: "operator",
          recipientRef: "operator",
          tenantKey: "vertex",
        },
        signal
      );
      if (prep.status === "ready") {
        await ignoreAdapterOutcome(
          prep.send(
            {
              body: "Replay alert",
              providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
              title: "Replay",
            },
            signal
          )
        );
      }
    },
  },
  {
    expectManualRedirect: false,
    file: "packages/ai/src/server/groq.ts",
    name: "ai/groq: createGroqAiPort (groq-sdk)",
    okResponse: {
      body: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        id: "cmpl-1",
      }),
      headers: { "content-type": "application/json" },
    },
    run: async (replayFetch) => {
      const port = createGroqAiPort({
        apiKey: "gsk_workerd_replay_test",
        fetch: replayFetch,
        model: "llama-3.1-8b-instant",
      });
      await ignoreAdapterOutcome(port.generateText({ prompt: "ping" }));
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/arxiv.ts",
    name: "api/arxiv: fetchArxivMetadata",
    okResponse: {
      body: "<feed xmlns='http://www.w3.org/2005/Atom'></feed>",
      headers: { "content-type": "application/atom+xml" },
    },
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchArxivMetadata(
          { baseId: "2401.00001", version: 1 },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/assistant-runtime.ts",
    name: "api/assistant-runtime: createOpenRouterClient",
    run: async (replayFetch) => {
      const client = createOpenRouterClient({
        apiKey: "sk-or-workerd-replay",
        fetch: (url, init) => replayFetch(url, init),
        model: "anthropic/claude-sonnet-4",
      });
      await ignoreAdapterOutcome(
        client.complete({
          maxTokens: 64,
          messages: [{ content: "ping", role: "user" }],
          toolChoice: "none",
          tools: [],
        })
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/deploy-status.ts",
    name: "api/deploy-status: fetchDeploymentStatus",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchDeploymentStatus(
          {
            token: TEST_TOKEN,
            url: "https://quantvps.tailnet.test:8443/status.json",
          },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/golive-live-quotes.ts",
    name: "api/golive-live-quotes: createBridgeQuotesReader",
    run: async (replayFetch) => {
      const reader = createBridgeQuotesReader(
        "http://127.0.0.1:8788",
        TEST_TOKEN,
        {
          fetch: (url, init) => replayFetch(url, init),
        }
      );
      await ignoreAdapterOutcome(
        reader([
          {
            long: {
              expiry: "2026-12-18",
              right: "C",
              strike: 200,
              symbol: "AAPL",
            },
            short: {
              expiry: "2026-12-18",
              right: "C",
              strike: 210,
              symbol: "AAPL",
            },
          },
        ])
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/ibkr-monitor.ts",
    name: "api/ibkr-monitor: fetchIbkrMonitorJson",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchIbkrMonitorJson("http://127.0.0.1:8790", "/api/health", {
          fetch: (url, init) => replayFetch(url, init),
        })
      );
    },
  },
  {
    expectedMethods: ["GET", "POST"],
    expectManualRedirect: true,
    file: "packages/api/src/server/ibkr-recovery.ts",
    name: "api/ibkr-recovery: status (GET) and request (POST)",
    okResponse: {
      body: JSON.stringify({
        cooldown: { seconds: 900, until: null },
        gateway: {
          loginState: "logged-out",
          needsLogin: true,
          reason: "2fa-timeout",
          since: "2026-11-25T14:50:00Z",
        },
        generatedAt: "2026-11-25T14:59:59Z",
        history: [],
        request: null,
        schema: "vertex-ibkr-recovery-status-v1",
        version: "1.0.0",
      }),
    },
    run: async (replayFetch) => {
      setIbkrRecoveryDependenciesForTesting({
        fetch: (url, init) => replayFetch(url, init),
      });
      try {
        const client = createInternalProcedureClient();
        await ignoreAdapterOutcome(client.ibkrRecovery.status({}));
        await ignoreAdapterOutcome(
          client.ibkrRecovery.request({ confirmation: RECOVERY_CONFIRMATION })
        );
      } finally {
        setIbkrRecoveryDependenciesForTesting({});
      }
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/jev-client.ts",
    name: "api/jev-client: callJev",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        callJev(
          { apiKey: "sk-or-jev-replay", model: "qwen/qwen-2.5-vl-72b" },
          { messages: [{ content: "ping", role: "user" }] },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/loopback-status.ts",
    name: "api/loopback-status: fetchLoopbackStatus",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchLoopbackStatus(
          "http://127.0.0.1:8791",
          {
            envName: "VERTEX_STATUS_URL",
            file: "status.json",
            label: "Loopback status",
            maxBytes: 65_536,
            missing: "Loopback status missing",
          },
          {
            fetch: (url, init) => replayFetch(url, init),
          }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/market-data.ts",
    name: "api/market-data: fetchHistoryDocument",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchHistoryDocument(
          {
            token: TEST_TOKEN,
            url: "https://history.example.test",
          },
          (base) => `${base}/bars?symbol=AAPL`,
          5000,
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/market-news.ts",
    name: "api/market-news: fetchBoundedText",
    okResponse: {
      body: "<rss><channel></channel></rss>",
      headers: { "content-type": "application/rss+xml" },
    },
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchBoundedText(
          {
            headers: { "user-agent": "VertexResearch/1.0" },
            label: "RSS feed",
            url: "https://feeds.example.test/news.xml",
          },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectedMethods: ["GET", "POST"],
    expectManualRedirect: true,
    file: "packages/api/src/server/nautilus-arm.ts",
    name: "api/nautilus-arm: status (GET) and disarm (POST)",
    run: async (replayFetch) => {
      setNautilusArmDependenciesForTesting({
        fetch: (url, init) => replayFetch(url, init),
      });
      try {
        const client = createInternalProcedureClient();
        await ignoreAdapterOutcome(client.nautilusArm.status({}));
        await ignoreAdapterOutcome(client.nautilusArm.disarm({}));
      } finally {
        setNautilusArmDependenciesForTesting({});
      }
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/options-chain-ibkr.ts",
    name: "api/options-chain-ibkr: createIbkrOptionsQuoteSource",
    run: async (replayFetch) => {
      const source = createIbkrOptionsQuoteSource(
        { token: TEST_TOKEN, url: "https://history.example.test" },
        {
          fetch: (url, init) => replayFetch(url, init),
          now: () => US_REGULAR_SESSION,
        }
      );
      await ignoreAdapterOutcome(source.read("AAPL", "2026-12-18"));
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/options-chain-nasdaq.ts",
    name: "api/options-chain-nasdaq: createNasdaqOptionsOpenInterestSource",
    run: async (replayFetch) => {
      const source = createNasdaqOptionsOpenInterestSource({
        fetch: (url, init) => replayFetch(url, init),
      });
      await ignoreAdapterOutcome(source.read("AAPL", "2026-12-18"));
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/options-chain-yahoo.ts",
    name: "api/options-chain-yahoo: createYahooOptionsSource",
    run: async (replayFetch) => {
      const source = createYahooOptionsSource({
        fetch: (url, init) => replayFetch(url, init),
      });
      await ignoreAdapterOutcome(source.read("AAPL", "2026-12-18"));
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/portfolio-monitor.ts",
    name: "api/portfolio-monitor: fetchPortfolioMonitor",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchPortfolioMonitor(
          { token: TEST_TOKEN, url: "https://portfolio.example.test" },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/price-alerts-ntfy.ts",
    name: "api/price-alerts-ntfy: sendPriceAlertsNtfy",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        sendPriceAlertsNtfy(
          {
            origin: "https://ntfy.example.test",
            token: TEST_TOKEN,
            topic: "price-alerts",
          },
          { body: "AAPL crossed 225", title: "Price alert" },
          "workerd-replay-price-alert",
          US_REGULAR_SESSION,
          (url, init) => replayFetch(url, init)
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/quantdata-client.ts",
    name: "api/quantdata-client: createQuantDataClient",
    run: async (replayFetch) => {
      const client = createQuantDataClient(
        { apiKey: "qd_workerd_replay", baseUrl: "https://v3.quantdata.us" },
        {
          fetch: (url, init) => replayFetch(url, init),
          minIntervalMs: 0,
        }
      );
      await ignoreAdapterOutcome(
        client.request("openInterest", { ticker: "AAPL" }, 0)
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/research-lenses.ts",
    name: "api/research-lenses: fetchBoundedJson",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchBoundedJson(
          {
            headers: { "user-agent": "VertexResearch/1.0" },
            label: "SEC lens",
            maxBytes: 65_536,
            url: "https://data.sec.gov/submissions/CIK0000320193.json",
          },
          { fetch: (url, init) => replayFetch(url, init) }
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "packages/api/src/server/research-screen-evidence.ts",
    name: "api/research-screen-evidence: readSwinglytics and readChart",
    okResponse: {
      body: "<html><body></body></html>",
      headers: { "content-type": "text/html" },
    },
    run: async (replayFetch) => {
      setResearchScreenOptionsForTesting({
        fetch: (url, init) => replayFetch(url, init),
      });
      try {
        await ignoreAdapterOutcome(readSwinglytics());
        await ignoreAdapterOutcome(readChart("AAPL"));
      } finally {
        setResearchScreenOptionsForTesting({});
      }
    },
  },
  {
    expectedMethods: ["GET", "POST"],
    expectManualRedirect: true,
    file: "packages/api/src/server/vertex-orders-gateway.ts",
    name: "api/vertex-orders-gateway: account (GET) and cancel (POST)",
    run: async (replayFetch) => {
      const gateway = createBridgeOrderGateway(
        "http://127.0.0.1:8788",
        (url, init) => replayFetch(url, init),
        TEST_TOKEN
      );
      await ignoreAdapterOutcome(gateway.account());
      await ignoreAdapterOutcome(gateway.cancel(12_345));
    },
  },
  {
    expectManualRedirect: true,
    file: "apps/web/src/lib/dashboard-transport.ts",
    name: "web/dashboard-transport: createAuthenticatedDashboardFetch",
    run: async (replayFetch) => {
      const authenticatedFetch = createAuthenticatedDashboardFetch(
        "better-auth.session_token=test-session",
        "https://app.example.test",
        (request) => replayFetch(request)
      );
      await ignoreAdapterOutcome(
        authenticatedFetch(
          new Request("https://app.example.test/api/rpc/dashboard.overview", {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        )
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "apps/web/src/lib/server-session.ts",
    name: "web/server-session: getPortalSession",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        getPortalSession({
          cookieHeader: "better-auth.session_token=test-session",
          fetch: (request) => replayFetch(request),
        })
      );
    },
  },
  {
    expectedMethods: ["GET", "POST"],
    expectManualRedirect: true,
    file: "apps/web/src/lib/server-theme-api.ts",
    name: "web/server-theme-api: forwardThemeApiRequest (GET and POST)",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        forwardThemeApiRequest({
          cookieHeader: "better-auth.session_token=test-session",
          fetchRequest: (request) => replayFetch(request),
          request: new Request(
            "https://app.example.test/api/rpc/preferences.theme.get",
            { method: "GET" }
          ),
          requestId: "workerd-replay-theme-get",
          trustedOrigin: "https://app.example.test",
        })
      );
      await ignoreAdapterOutcome(
        forwardThemeApiRequest({
          cookieHeader: "better-auth.session_token=test-session",
          fetchRequest: (request) => replayFetch(request),
          request: new Request(
            "https://app.example.test/api/rpc/preferences.theme.set",
            {
              body: JSON.stringify({ theme: "dark" }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }
          ),
          requestId: "workerd-replay-theme-post",
          trustedOrigin: "https://app.example.test",
        })
      );
    },
  },
  {
    expectManualRedirect: true,
    file: "apps/web/src/lib/theme-api-timeout.ts",
    name: "web/theme-api-timeout: fetchThemeApiRequest",
    run: async (replayFetch) => {
      await ignoreAdapterOutcome(
        fetchThemeApiRequest({
          fetchRequest: (request) => replayFetch(request),
          request: new Request(
            "https://app.example.test/api/rpc/preferences.theme.get",
            { cache: "no-store", method: "GET", redirect: "manual" }
          ),
        })
      );
    },
  },
];

/** Tracked non-test files matched by the AST fetch scanner that do NOT run outbound network fetches in workerd. */
const NON_WORKERD_OR_CLIENT_FETCH_FILES: Readonly<Record<string, string>> = {
  "apps/desktop/src/desktop-api.ts": "Electron desktop client, not workerd",
  "apps/desktop/src/electron-ports.ts":
    "Electron desktop IPC/session bridge, not workerd",
  "apps/web/src/app/(portal)/dashboard/page.tsx":
    "Passes globalThis.fetch to dashboard-transport.ts (covered directly above)",
  "apps/web/src/components/account/sign-out-client.ts":
    "Browser client component, not workerd",
  "apps/web/src/components/theme-menu.tsx":
    "Browser client component, not workerd",
  "apps/web/src/features/click-log/install.ts":
    "Browser client click telemetry helper, not workerd",
  "apps/web/src/features/experience/browser-provider.tsx":
    "Browser client oRPC provider, not workerd",
  "packages/jobs/src/server/model-relay.ts":
    "Node/Linux sandbox worker (packages/jobs maps workerd export to unsupported.ts)",
};

/**
 * True when the workspace package (`apps/<name>` or `packages/<name>`) that holds `file` exists.
 * `bun run init --without-operator` deletes the agent-SDLC packages (e.g. packages/jobs) and keeps
 * this test, so an exclusion inside a deleted package is not stale.
 */
const workspacePackageExists = (file: string): boolean => {
  const [area, name] = file.split("/");
  return existsSync(
    new URL(`../../${area}/${name}/package.json`, import.meta.url)
  );
};

const assertNoWorkerdRejection = (
  label: string,
  records: readonly ReplayRecord[]
): void => {
  expect(
    records.length,
    `${label} must invoke fetch at least once`
  ).toBeGreaterThan(0);
  for (const record of records) {
    expect(
      record.workerdError,
      `${label} (${record.method} ${record.originalUrl}) rejected by workerd: ${JSON.stringify(record.workerdError)} with init=${JSON.stringify(record.init)}`
    ).toBeNull();
    expect(
      record.serverHits,
      `${label} (${record.method} ${record.originalUrl}) did not reach loopback server`
    ).toBeGreaterThanOrEqual(1);
  }
};

describe("workerd outbound adapter RequestInit runtime replay", () => {
  let harness: WorkerdReplayHarness | undefined;

  beforeAll(async () => {
    harness = await startWorkerdReplayHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("self-checks that pinned workerd rejects redirect:'error' and cache:'default'", async () => {
    const active = harness as WorkerdReplayHarness;
    expect(active.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(active.compatibilityFlags).toContain("nodejs_compat");
    active.setLoopbackResponse({ mode: "200" });

    const rejectedRedirect = await active.replayRaw("/self-check-redirect", {
      method: "GET",
      redirect: "error",
    });
    expect(rejectedRedirect.serverHits).toBe(0);
    expect(rejectedRedirect.workerdError?.name).toBe("TypeError");

    const rejectedCache = await active.replayRaw("/self-check-cache", {
      cache: "default",
      method: "GET",
      redirect: "manual",
    });
    expect(rejectedCache.serverHits).toBe(0);
    expect(rejectedCache.workerdError?.name).toBe("TypeError");
  });

  it.each(ADAPTER_CASES)(
    "replays $name against loopback 200 and 302 in pinned workerd",
    async (adapterCase) => {
      const active = harness as WorkerdReplayHarness;
      // 1. Loopback 200 pass: workerd must accept RequestInit and reach the server.
      active.setLoopbackResponse({
        mode: "200",
        ...adapterCase.okResponse,
      });
      const okHandle = active.createAdapterFetch();
      await withCapturedRequestCache(() => adapterCase.run(okHandle.fetch));
      assertNoWorkerdRejection(`${adapterCase.name} [200]`, okHandle.records);
      for (const record of okHandle.records) {
        expect(record.responseStatus).toBe(200);
        expect(record.followedRedirect).toBe(false);
      }
      if (adapterCase.expectedMethods !== undefined) {
        const seenMethods = new Set(
          okHandle.records.map((record) => record.method.toUpperCase())
        );
        for (const expectedMethod of adapterCase.expectedMethods) {
          expect(
            seenMethods.has(expectedMethod),
            `${adapterCase.name} [200] did not invoke ${expectedMethod} (observed: ${[...seenMethods].join(", ")})`
          ).toBe(true);
        }
      }

      // 2. Loopback 302 pass: workerd must accept RequestInit; manual-redirect adapters must not follow 302.
      active.setLoopbackResponse({ mode: "302" });
      const redirectHandle = active.createAdapterFetch();
      await withCapturedRequestCache(() =>
        adapterCase.run(redirectHandle.fetch)
      );
      assertNoWorkerdRejection(
        `${adapterCase.name} [302]`,
        redirectHandle.records
      );
      for (const record of redirectHandle.records) {
        const mustStayManual =
          adapterCase.expectManualRedirect ||
          record.init["redirect"] === "manual";
        if (mustStayManual) {
          expect(record.init["redirect"]).toBe("manual");
          expect(record.responseStatus).toBe(302);
          expect(record.followedRedirect).toBe(false);
        }
      }
    }
  );

  it("covers every tracked workerd-reachable fetch/SDK file in packages/ and apps/", () => {
    const discovered = discoverOutboundFetchFiles();
    const covered = new Set(ADAPTER_CASES.map((entry) => entry.file));
    const excluded = new Set(Object.keys(NON_WORKERD_OR_CLIENT_FETCH_FILES));

    const uncovered = discovered.filter(
      (file) => !(covered.has(file) || excluded.has(file))
    );
    expect(
      uncovered,
      "Add new workerd outbound adapters to ADAPTER_CASES (or document non-workerd files in NON_WORKERD_OR_CLIENT_FETCH_FILES)"
    ).toEqual([]);

    const staleExclusions = [...excluded].filter(
      (file) => workspacePackageExists(file) && !discovered.includes(file)
    );
    expect(
      staleExclusions,
      "Remove stale entries from NON_WORKERD_OR_CLIENT_FETCH_FILES"
    ).toEqual([]);

    const overlapping = [...covered].filter((file) => excluded.has(file));
    expect(overlapping).toEqual([]);
  });
});
