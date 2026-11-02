import type {
  ContactEmailDeliveryResult,
  ContactEmailInput,
  ContactEmailPort,
  EmailDeliveryResult,
  EmailPort,
  EmailVerificationEmailInput,
  PasswordResetEmailInput,
} from "../index.ts";
import type { PreviewEmailBinding } from "./preview.ts";

const CAPTURE_PATH = "/v1/capture";
const CAPTURE_TIMEOUT_MS = 5000;
const HMAC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type PreviewCaptureFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type RemotePreviewPortOptions = Readonly<{
  environment: "development" | "test" | "production";
  endpoint: string;
  binding: PreviewEmailBinding;
  trustedAppOrigin?: string | undefined;
  fetcher?: PreviewCaptureFetch | undefined;
}>;

type CaptureOperation = "contact" | "reset-password" | "verify-email";

const DEVELOPMENT_LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};

const assertDevelopmentCaptureOrigin = (
  trustedAppOrigin: string | undefined
): void => {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Development preview transport is unavailable in production builds"
    );
  }
  let origin: URL | null = null;
  try {
    origin = trustedAppOrigin === undefined ? null : new URL(trustedAppOrigin);
  } catch {
    origin = null;
  }
  if (
    origin === null ||
    origin.protocol !== "https:" ||
    DEVELOPMENT_LOOPBACK_HOSTS[origin.hostname] !== true ||
    origin.origin !== trustedAppOrigin
  ) {
    throw new Error(
      "Development preview transport requires a clean loopback HTTPS origin"
    );
  }
};

const previewArtifactPath = (options: RemotePreviewPortOptions): string =>
  options.environment === "test"
    ? "e2e-preview-capture"
    : "development-preview-capture";

const assertCaptureOptions = (options: RemotePreviewPortOptions): URL => {
  if (options.environment !== "test" && options.environment !== "development") {
    throw new Error(
      "Remote preview transport is unavailable outside local development and tests"
    );
  }
  if (options.environment === "development") {
    assertDevelopmentCaptureOrigin(options.trustedAppOrigin);
  }
  if (
    !(
      RUN_ID_PATTERN.test(options.binding.runId) &&
      HMAC_KEY_PATTERN.test(options.binding.hmacKey)
    ) ||
    Buffer.from(options.binding.hmacKey, "base64url").length !== 32
  ) {
    throw new Error("Remote preview binding is invalid");
  }

  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    endpoint.pathname !== CAPTURE_PATH ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (options.environment === "development" &&
      endpoint.href !== options.endpoint)
  ) {
    throw new Error(
      "Remote preview endpoint must be an exact loopback capture URL"
    );
  }
  return endpoint;
};

const capture = async (
  options: RemotePreviewPortOptions,
  endpoint: URL,
  operation: CaptureOperation,
  input:
    | ContactEmailInput
    | EmailVerificationEmailInput
    | PasswordResetEmailInput
): Promise<boolean> => {
  const fetcher = options.fetcher ?? globalThis.fetch;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${options.binding.hmacKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        runId: options.binding.runId,
        operation,
        input,
      }),
    });
    return response.status === 201;
  } catch {
    return false;
  }
};

export const createRemotePreviewEmailPort = (
  options: RemotePreviewPortOptions
): EmailPort => {
  const endpoint = assertCaptureOptions(options);
  const deliver = async (
    operation: "reset-password" | "verify-email",
    input: PasswordResetEmailInput | EmailVerificationEmailInput
  ): Promise<EmailDeliveryResult> => {
    if (await capture(options, endpoint, operation, input)) {
      return {
        status: "previewed",
        provider: "preview",
        artifactPath: previewArtifactPath(options),
      };
    }
    return {
      status: "failed",
      provider: "preview",
      code: "EMAIL_PREVIEW_WRITE_FAILED",
      retryable: false,
    };
  };

  return Object.freeze({
    sendPasswordReset: async (
      input: PasswordResetEmailInput
    ): Promise<EmailDeliveryResult> => {
      return await deliver("reset-password", input);
    },
    sendEmailVerification: async (
      input: EmailVerificationEmailInput
    ): Promise<EmailDeliveryResult> => {
      return await deliver("verify-email", input);
    },
  });
};

export const createRemotePreviewContactEmailPort = (
  options: RemotePreviewPortOptions
): ContactEmailPort => {
  const endpoint = assertCaptureOptions(options);
  return Object.freeze({
    sendContact: async (
      input: ContactEmailInput
    ): Promise<ContactEmailDeliveryResult> => {
      if (await capture(options, endpoint, "contact", input)) {
        return {
          status: "previewed",
          provider: "preview",
          artifactPath: previewArtifactPath(options),
        };
      }
      return {
        status: "not-delivered",
        provider: "preview",
        code: "CONTACT_PREVIEW_WRITE_FAILED",
        retryable: false,
      };
    },
  });
};
