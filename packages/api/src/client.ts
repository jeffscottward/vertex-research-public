import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

import type { appContract } from "./contract.ts";

export type ApiClient = ContractRouterClient<typeof appContract>;

export type ApiClientOptions = Readonly<{
  baseUrl: string | URL;
  fetch?: (request: Request) => Promise<Response>;
}>;

/**
 * One oRPC HTTP exchange. "open": response headers arrived (a streamed reply is still running).
 * "closed": the response body ended, failed or was cancelled (for example by an abort).
 */
export type ApiCallObservation = Readonly<{
  phase: "open" | "closed";
  /** Procedure path, for example "assistant.send". */
  path: string;
  /** The server's correlation id (`x-request-id` response header), when present. */
  requestId: string | null;
  /** Date.now() when the request was sent. */
  startedAt: number;
  status: number;
}>;

type ApiCallObserver = (observation: ApiCallObservation) => void;

const observers = new Set<ApiCallObserver>();

/**
 * Calls `observer` when each oRPC response of every client made by createApiClient in this realm
 * opens and when its body closes. The UI click log uses it to link an important click to the
 * request ids of the calls that were running or that it caused. "closed" can be reported more than
 * once for one call, so observers must treat it as idempotent. Returns the function that removes
 * the observer. With no observer, responses pass through unchanged.
 */
export const observeApiCalls = (observer: ApiCallObserver): (() => void) => {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
};

const notify = (observation: ApiCallObservation) => {
  for (const observer of observers) {
    try {
      observer(observation);
    } catch {
      // An observer is diagnostics only; it never fails the API call.
    }
  }
};

/** The same response, with a body that reports "closed" once it ends, fails or is cancelled. */
export const trackResponseBody = (
  response: Response,
  body: ReadableStream<Uint8Array>,
  observation: ApiCallObservation
): Response => {
  // May repeat when a cancel races a read; observers treat "closed" as idempotent.
  const close = () => notify({ ...observation, phase: "closed" });
  const reader = body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    cancel: (reason) => {
      close();
      return reader.cancel(reason);
    },
    pull: async (controller) => {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
  });
  return new Response(tracked, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const createApiClient = (options: ApiClientOptions): ApiClient => {
  const baseUrl = new URL(options.baseUrl);
  const link = new RPCLink({
    adapterInterceptors: [
      async ({ next, path }) => {
        const startedAt = Date.now();
        const response = await next();
        if (observers.size === 0) return response;
        const observation: ApiCallObservation = {
          path: path.join("."),
          phase: "open",
          requestId: response.headers.get("x-request-id"),
          startedAt,
          status: response.status,
        };
        notify(observation);
        // Status 0 (opaque redirect) cannot be rebuilt; such a reply has no body to wait for.
        if (response.body === null || response.status < 200) {
          notify({ ...observation, phase: "closed" });
          return response;
        }
        return trackResponseBody(response, response.body, observation);
      },
    ],
    url: () => new URL("/api/orpc", baseUrl),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return createORPCClient<ApiClient>(link);
};
