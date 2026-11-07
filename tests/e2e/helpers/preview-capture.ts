import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  ContactEmailInput,
  EmailVerificationEmailInput,
  PasswordResetEmailInput,
} from "@darkfactory/email";
import {
  createPreviewContactEmailPort,
  createPreviewEmailPort,
  type PreviewEmailBinding,
} from "@darkfactory/email/server";

const CAPTURE_PATH = "/v1/capture";
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

type CaptureOperation = "contact" | "reset-password" | "verify-email";
type CapturePayload = Readonly<{
  version: 1;
  runId: string;
  operation: CaptureOperation;
  input: Record<string, unknown>;
}>;

export type PreviewCaptureServerOptions = Readonly<{
  appOrigin: string;
  authDirectory: string;
  contactDirectory: string;
  binding: PreviewEmailBinding;
  /** Fixed loopback port; the app server learns the endpoint before capture starts. */
  port?: number;
}>;

export type PreviewCaptureServer = Readonly<{
  endpoint: string;
  close: () => Promise<void>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const parsePayload = (value: unknown): CapturePayload | null => {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, ["input", "operation", "runId", "version"])
    )
  ) {
    return null;
  }
  if (
    value["version"] !== 1 ||
    typeof value["runId"] !== "string" ||
    !isRecord(value["input"]) ||
    (value["operation"] !== "contact" &&
      value["operation"] !== "reset-password" &&
      value["operation"] !== "verify-email")
  ) {
    return null;
  }
  return value as CapturePayload;
};

const hasValidAuthorization = (
  request: IncomingMessage,
  hmacKey: string
): boolean => {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  const actual = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${hmacKey}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 1 ||
    declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new Error("Invalid preview capture content length");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new Error("Preview capture payload is too large");
    }
    chunks.push(bytes);
  }
  if (size !== declaredLength)
    throw new Error("Preview capture body is incomplete");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const respond = (
  response: ServerResponse,
  status: number,
  body: "accepted" | "rejected"
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ status: body }));
};

// The rig status file server (ENGINE_STATUS_URL) for the E2E app. Mission control, /markets and
// /calendar read its market context file on load; without it every operator page answered
// NOT_CONFIGURED (HTTP 503). It holds no section yet, as before the rig's first push of the
// day, so the pages show their typed "not collected" states. status.json stays absent (404).
const MARKET_CONTEXT_PATH = "/markets.json";
const marketContextDocument = (now: Date): string =>
  JSON.stringify({
    generatedAt: Math.floor(now.getTime() / 1000),
    gex: null,
    host: "e2e",
    macro: null,
    missing: ["gex", "macro", "news"],
    news: null,
    schema: "vertex-market-context-v1",
  });

/** Answers GET /markets.json from loopback; false for every other request. */
const serveMarketContext = (
  request: IncomingMessage,
  response: ServerResponse
): boolean => {
  const remoteAddress = request.socket.remoteAddress;
  if (
    request.method !== "GET" ||
    request.url !== MARKET_CONTEXT_PATH ||
    (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1")
  )
    return false;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(marketContextDocument(new Date()));
  return true;
};

export const startPreviewCaptureServer = async (
  options: PreviewCaptureServerOptions
): Promise<PreviewCaptureServer> => {
  const authEmail = createPreviewEmailPort({
    binding: options.binding,
    directory: options.authDirectory,
    environment: "test",
    trustedAppOrigin: options.appOrigin,
  });
  const contactEmail = createPreviewContactEmailPort({
    directory: options.contactDirectory,
    environment: "test",
  });

  const server = createServer(async (request, response) => {
    try {
      const remoteAddress = request.socket.remoteAddress;
      if (serveMarketContext(request, response)) return;
      if (
        request.method !== "POST" ||
        request.url !== CAPTURE_PATH ||
        (remoteAddress !== "127.0.0.1" &&
          remoteAddress !== "::ffff:127.0.0.1") ||
        request.headers["content-type"] !== "application/json" ||
        !hasValidAuthorization(request, options.binding.hmacKey)
      ) {
        respond(response, 404, "rejected");
        return;
      }

      const payload = parsePayload(await readRequestBody(request));
      if (payload === null || payload.runId !== options.binding.runId) {
        respond(response, 400, "rejected");
        return;
      }

      const result =
        payload.operation === "contact"
          ? await contactEmail.sendContact(payload.input as ContactEmailInput)
          : payload.operation === "reset-password"
            ? await authEmail.sendPasswordReset(
                payload.input as PasswordResetEmailInput
              )
            : await authEmail.sendEmailVerification(
                payload.input as EmailVerificationEmailInput
              );
      if (result.status !== "previewed") {
        respond(response, 503, "rejected");
        return;
      }
      return respond(response, 201, "accepted");
    } catch {
      if (response.headersSent) return response.destroy();
      return respond(response, 400, "rejected");
    }
  });
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 16;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    return server.listen(
      { exclusive: true, host: "127.0.0.1", port: options.port ?? 0 },
      () => {
        server.off("error", onError);
        return resolve();
      }
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Preview capture server did not bind an owned TCP port");
  }

  return Object.freeze({
    close: async (): Promise<void> => {
      server.closeIdleConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        return server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    endpoint: `http://127.0.0.1:${address.port}${CAPTURE_PATH}`,
  });
};
