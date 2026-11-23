import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options: unknown) => ({ options })),
  drizzleAdapter: vi.fn(() => ({ id: "drizzle-adapter" })),
}));

vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));
vi.mock("@better-auth/drizzle-adapter", () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

import type { EmailDeliveryResult, EmailPort } from "@darkfactory/email";
import {
  redactSemanticEvent,
  type SemanticEvent,
  type StructuredEventSink,
} from "@darkfactory/observability";
import {
  type AuthObservabilityOptions,
  createAuth,
  EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
  PASSWORD_RESET_DELIVERY_ERROR_CODE,
  PASSWORD_RESET_DELIVERY_FAILED_EVENT,
} from "./server.ts";

const BASE_URL = "https://darkfactory.localhost";
const verificationUrl =
  `${BASE_URL}/api/auth/verify-email?token=header.payload.signature` +
  `&callbackURL=${encodeURIComponent(`${BASE_URL}/verify-email?verified=1`)}`;
let backgroundTasks: Promise<unknown>[] = [];

const createEmail = (
  result: EmailDeliveryResult = {
    status: "previewed",
    provider: "preview",
    artifactPath: "/tmp/verification.html",
  }
) => {
  const sendEmailVerification = vi.fn().mockResolvedValue(result);
  const email: EmailPort = {
    sendPasswordReset: vi.fn(),
    sendEmailVerification,
  };
  return { email, sendEmailVerification };
};

type VerificationEmailCallback = (
  input: Readonly<{
    user: Readonly<{ id: string; email: string; name: string }>;
    url: string;
    token: string;
  }>
) => Promise<void>;

type PasswordResetCallback = (
  input: Readonly<{
    user: Readonly<{ id: string; email: string; name: string }>;
    url: string;
    token: string;
  }>
) => Promise<void>;

type CapturedAuthOptions = Readonly<{
  trustedOrigins: readonly string[];
  advanced: Readonly<{
    ipAddress: Readonly<{ ipAddressHeaders: readonly string[] }>;
    database?: Readonly<{
      generateId: (options: {
        model: string;
        size?: number | undefined;
      }) => string;
    }>;
  }>;
  emailAndPassword: Readonly<{
    enabled: boolean;
    autoSignIn: boolean;
    requireEmailVerification: boolean;
    resetPasswordTokenExpiresIn: number;
    sendResetPassword: PasswordResetCallback;
  }>;
  emailVerification: Readonly<{
    sendOnSignUp: boolean;
    sendOnSignIn: boolean;
    autoSignInAfterVerification: boolean;
    expiresIn: number;
    sendVerificationEmail: VerificationEmailCallback;
  }>;
  hooks: Readonly<{ before: unknown }>;
  rateLimit: Readonly<{
    enabled: boolean;
    storage: string;
    customRules: Readonly<
      Record<string, Readonly<{ window: number; max: number }>>
    >;
  }>;
}>;

const createConfiguredAuth = (
  email: EmailPort,
  verificationEmailTokenExpiresInSeconds = 60 * 60,
  verificationRateLimitMax?: number,
  resetPasswordTokenExpiresInSeconds?: number,
  observability?: AuthObservabilityOptions
) => {
  return createAuth({
    database: {} as never,
    secret: "auth-test-secret-with-at-least-32-characters",
    baseURL: BASE_URL,
    email,
    scheduleBackgroundTask: (task) => void backgroundTasks.push(task),
    rateLimitEnabled: false,
    verificationEmailTokenExpiresInSeconds,
    ...(verificationRateLimitMax === undefined
      ? {}
      : { verificationRateLimitMax }),
    ...(resetPasswordTokenExpiresInSeconds === undefined
      ? {}
      : { resetPasswordTokenExpiresInSeconds }),
    ...(observability === undefined ? {} : { observability }),
  }) as unknown as { options: CapturedAuthOptions };
};

describe("Better Auth email verification configuration", () => {
  beforeEach(() => {
    mocks.betterAuth.mockClear();
    mocks.drizzleAdapter.mockClear();
    return (backgroundTasks = []);
  });

  it("requires verification, sends on signup and signin, and uses a bounded one-hour token", () => {
    const { email } = createEmail();
    const auth = createConfiguredAuth(email);
    const options = auth.options;

    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
    });
    expect(options.emailVerification).toMatchObject({
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
    });
    expect(options.emailVerification.sendVerificationEmail).toEqual(
      expect.any(Function)
    );

    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual([
      "cf-connecting-ip",
    ]);
    return expect(options.rateLimit.storage).toBe("database");
  });
  it("throttles public verification resend requests independently of the global limit", () => {
    const { email } = createEmail();
    const auth = createConfiguredAuth(email);

    expect(
      auth.options.rateLimit.customRules["/send-verification-email"]
    ).toEqual({
      window: 60,
      max: 5,
    });
    return expect(auth.options.rateLimit.customRules["/sign-in/email"]).toEqual(
      {
        window: 60,
        max: 10,
      }
    );
  });

  it("propagates optional origins, adapter IDs, and per-route limits", () => {
    const { email } = createEmail();
    const database = { transaction: vi.fn() };
    const generateId = vi.fn(() => "generated-id");
    const auth = createAuth({
      database: database as never,
      secret: "auth-test-secret-with-at-least-32-characters",
      email,
      scheduleBackgroundTask: () => undefined,
      trustedOrigins: [
        BASE_URL,
        "https://admin.darkfactory.localhost",
        BASE_URL,
      ],
      resetRateLimitMax: 7,
      signInRateLimitMax: 11,
      generateId,
    }) as unknown as { options: CapturedAuthOptions };

    expect(auth.options.trustedOrigins).toEqual([
      BASE_URL,
      "https://admin.darkfactory.localhost",
    ]);
    expect(auth.options.advanced.database?.generateId).toBe(generateId);
    expect(auth.options.rateLimit.enabled).toBe(true);
    expect(
      auth.options.rateLimit.customRules["/request-password-reset"]
    ).toEqual({ window: 60, max: 7 });
    expect(auth.options.rateLimit.customRules["/sign-in/email"]).toEqual({
      window: 60,
      max: 11,
    });
    return expect(mocks.drizzleAdapter).toHaveBeenLastCalledWith(
      database,
      expect.objectContaining({ transaction: true })
    );
  });

  it("uses a validated verification resend limit and rejects invalid configuration", () => {
    const { email } = createEmail();
    const configured = createConfiguredAuth(email, 60 * 60, 9);
    expect(
      configured.options.rateLimit.customRules["/send-verification-email"]
    ).toEqual({
      window: 60,
      max: 9,
    });

    for (const invalidMax of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => {
        return createConfiguredAuth(email, 60 * 60, invalidMax);
      }).toThrowError("verificationRateLimitMax must be a positive integer");
    }

    for (const invalidSignInMax of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createAuth({
          database: {} as never,
          secret: "auth-test-secret-with-at-least-32-characters",
          baseURL: BASE_URL,
          email,
          scheduleBackgroundTask: () => undefined,
          rateLimitEnabled: false,
          signInRateLimitMax: invalidSignInMax,
        })
      ).toThrowError("signInRateLimitMax must be a positive integer");
    }
  });

  it("delegates the exact trusted Better Auth URL to the operation-specific port", async () => {
    const { email, sendEmailVerification } = createEmail();
    const auth = createConfiguredAuth(email);

    await auth.options.emailVerification.sendVerificationEmail({
      user: {
        id: "user-1",
        email: "member@domain.test",
        name: "Member Example",
      },
      url: verificationUrl,
      token: "header.payload.signature",
    });

    expect(sendEmailVerification).toHaveBeenCalledOnce();
    return expect(sendEmailVerification).toHaveBeenCalledWith({
      to: "member@domain.test",
      recipientName: "Member Example",
      verificationUrl,
      expiresInMinutes: 60,
    });
  });

  it("delegates reset delivery and converts a typed delivery failure", async () => {
    const sendPasswordReset = vi
      .fn()
      .mockResolvedValueOnce({
        status: "previewed",
        provider: "preview",
        artifactPath: "/tmp/reset.html",
      })
      .mockResolvedValueOnce({
        status: "failed",
        provider: "resend",
        code: "EMAIL_PROVIDER_UNAVAILABLE",
        retryable: true,
      });
    const email: EmailPort = {
      sendPasswordReset,
      sendEmailVerification: vi.fn(),
    };
    const auth = createConfiguredAuth(email);
    const callbackInput = {
      user: {
        id: "user-1",
        email: "member@domain.test",
        name: "Member Example",
      },
      url:
        `${BASE_URL}/api/auth/reset-password/reset-token` +
        `?callbackURL=${encodeURIComponent(`${BASE_URL}/reset-password`)}`,
      token: "reset-token",
    };

    await expect(
      auth.options.emailAndPassword.sendResetPassword(callbackInput)
    ).resolves.toBeUndefined();
    expect(sendPasswordReset).toHaveBeenLastCalledWith({
      to: "member@domain.test",
      recipientName: "Member Example",
      resetUrl: callbackInput.url,
      expiresInMinutes: 60,
    });
    return await expect(
      auth.options.emailAndPassword.sendResetPassword(callbackInput)
    ).rejects.toMatchObject({
      body: {
        code: PASSWORD_RESET_DELIVERY_ERROR_CODE,
        message: "Password reset delivery is unavailable",
      },
    });
  });

  it("logs the non-sensitive email failure code through observability when reset delivery fails", async () => {
    const events: SemanticEvent[] = [];
    const sink: StructuredEventSink = {
      emit: vi.fn((event: SemanticEvent) => {
        events.push(event);
      }),
    };
    const sendPasswordReset = vi
      .fn()
      .mockResolvedValueOnce({
        status: "previewed",
        provider: "preview",
        artifactPath: "/tmp/reset.html",
      })
      .mockResolvedValueOnce({
        status: "failed",
        provider: "preview",
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        retryable: false,
      });
    const email: EmailPort = {
      sendPasswordReset,
      sendEmailVerification: vi.fn(),
    };
    const auth = createConfiguredAuth(email, 60 * 60, undefined, undefined, {
      sink,
      requestId: "req-reset-preview-fail",
    });
    const callbackInput = {
      user: {
        id: "user-secret-id",
        email: "private-reset@domain.test",
        name: "Private Member Name",
      },
      url:
        `${BASE_URL}/api/auth/reset-password/super-secret-reset-token` +
        `?callbackURL=${encodeURIComponent(`${BASE_URL}/reset-password`)}`,
      token: "super-secret-reset-token",
    };

    await expect(
      auth.options.emailAndPassword.sendResetPassword(callbackInput)
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);

    await expect(
      auth.options.emailAndPassword.sendResetPassword(callbackInput)
    ).rejects.toMatchObject({
      body: {
        code: PASSWORD_RESET_DELIVERY_ERROR_CODE,
        message: "Password reset delivery is unavailable",
      },
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    if (!event) throw new Error("Expected failure event");
    expect(event).toMatchObject({
      name: PASSWORD_RESET_DELIVERY_FAILED_EVENT,
      action: "send-password-reset",
      outcome: "failure",
      source: "web",
      errorCategory: "EMAIL_PREVIEW_WRITE_FAILED",
      correlation: {
        requestId: "req-reset-preview-fail",
        route: "/api/auth/request-password-reset",
      },
      attributes: {
        stage: "email-delivery",
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        provider: "preview",
        retryable: false,
      },
    });
    // Redaction accepts the event cleanly without altering the non-sensitive fields.
    expect(redactSemanticEvent(event)).toMatchObject({
      name: PASSWORD_RESET_DELIVERY_FAILED_EVENT,
      errorCategory: "EMAIL_PREVIEW_WRITE_FAILED",
      attributes: {
        stage: "email-delivery",
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        provider: "preview",
        retryable: false,
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("private-reset@domain.test");
    expect(serialized).not.toContain("super-secret-reset-token");
    expect(serialized).not.toContain("Private Member Name");
    return expect(serialized).not.toContain("user-secret-id");
  });

  it.each<readonly [string, () => unknown, string]>([
    [
      "typed Error",
      (): unknown => new TypeError("provider-secret-must-not-escape"),
      "TypeError",
    ],
    [
      "custom Error name",
      (): unknown =>
        Object.assign(new Error("token=super-secret"), {
          name: "PreviewCaptureTimeout",
        }),
      "PreviewCaptureTimeout",
    ],
    [
      "unsafe Error name containing spaces or email",
      (): unknown =>
        Object.assign(new Error("message"), {
          name: "Error for private@domain.test",
        }),
      "Error",
    ],
    [
      "Error with non-string name",
      (): unknown => Object.assign(new Error("message"), { name: undefined }),
      "Error",
    ],
    [
      "Error with throwing name getter",
      (): unknown => {
        const failure = new Error("message");
        Object.defineProperty(failure, "name", {
          get: () => {
            throw new Error("getter-secret-must-not-escape");
          },
        });
        return failure;
      },
      "Error",
    ],
    [
      "non-Error thrown string",
      (): unknown => "raw-secret-string-for-private@domain.test",
      "UnknownError",
    ],
  ])(
    "logs only the sanitized error name and normalizes a thrown reset failure (%s)",
    async (_label, createFailure, expectedErrorName) => {
      const events: SemanticEvent[] = [];
      const sink: StructuredEventSink = {
        emit: vi.fn((event: SemanticEvent) => {
          events.push(event);
        }),
      };
      const email: EmailPort = {
        sendPasswordReset: vi.fn().mockRejectedValue(createFailure()),
        sendEmailVerification: vi.fn(),
      };
      const auth = createConfiguredAuth(email, 60 * 60, undefined, undefined, {
        sink,
        requestId: "req-reset-throw",
      });
      const callbackInput = {
        user: {
          id: "user-1",
          email: "private@domain.test",
          name: "Member Example",
        },
        url: `${BASE_URL}/api/auth/reset-password/secret-reset-token`,
        token: "secret-reset-token",
      };

      const caught = await auth.options.emailAndPassword
        .sendResetPassword(callbackInput)
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(caught).toMatchObject({
        body: {
          code: PASSWORD_RESET_DELIVERY_ERROR_CODE,
          message: "Password reset delivery is unavailable",
        },
      });
      expect(JSON.stringify(caught)).not.toContain(
        "provider-secret-must-not-escape"
      );
      expect(events).toHaveLength(1);
      const [event] = events;
      if (!event) throw new Error("Expected failure event");
      expect(event).toMatchObject({
        name: PASSWORD_RESET_DELIVERY_FAILED_EVENT,
        outcome: "failure",
        errorCategory: expectedErrorName,
        correlation: {
          requestId: "req-reset-throw",
          route: "/api/auth/request-password-reset",
        },
        attributes: {
          stage: "email-delivery",
          errorName: expectedErrorName,
        },
      });
      expect(redactSemanticEvent(event)).toMatchObject({
        name: PASSWORD_RESET_DELIVERY_FAILED_EVENT,
        errorCategory: expectedErrorName,
        attributes: {
          stage: "email-delivery",
          errorName: expectedErrorName,
        },
      });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("private@domain.test");
      expect(serialized).not.toContain("secret-reset-token");
      expect(serialized).not.toContain("provider-secret-must-not-escape");
      expect(serialized).not.toContain("getter-secret-must-not-escape");
      return expect(serialized).not.toContain("raw-secret-string");
    }
  );

  it.each([
    [
      "synchronous throw",
      () => {
        throw new Error("sink exploded");
      },
    ],
    [
      "async rejection",
      async () => {
        throw new Error("sink rejected");
      },
    ],
  ] as const)(
    "still throws PASSWORD_RESET_DELIVERY_FAILED when observability emit fails (%s)",
    async (_label, emit) => {
      const emitSpy = vi.fn(emit);
      const email: EmailPort = {
        sendPasswordReset: vi.fn().mockResolvedValue({
          status: "failed",
          provider: "preview",
          code: "EMAIL_PREVIEW_WRITE_FAILED",
          retryable: false,
        }),
        sendEmailVerification: vi.fn(),
      };
      const auth = createConfiguredAuth(email, 60 * 60, undefined, undefined, {
        sink: { emit: emitSpy },
        requestId: "req-sink-broken",
      });

      await expect(
        auth.options.emailAndPassword.sendResetPassword({
          user: {
            id: "user-1",
            email: "member@domain.test",
            name: "Member Example",
          },
          url: `${BASE_URL}/api/auth/reset-password/reset-token`,
          token: "reset-token",
        })
      ).rejects.toMatchObject({
        body: {
          code: PASSWORD_RESET_DELIVERY_ERROR_CODE,
          message: "Password reset delivery is unavailable",
        },
      });
      return expect(emitSpy).toHaveBeenCalledOnce();
    }
  );

  it("falls back to eventId when observability.requestId is blank so redaction still accepts the event", async () => {
    const events: SemanticEvent[] = [];
    const email: EmailPort = {
      sendPasswordReset: vi.fn().mockResolvedValue({
        status: "failed",
        provider: "preview",
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        retryable: false,
      }),
      sendEmailVerification: vi.fn(),
    };
    const auth = createConfiguredAuth(email, 60 * 60, undefined, undefined, {
      sink: {
        emit: (event) => {
          events.push(event);
        },
      },
      requestId: "   ",
    });

    await expect(
      auth.options.emailAndPassword.sendResetPassword({
        user: {
          id: "user-1",
          email: "member@domain.test",
          name: "Member Example",
        },
        url: `${BASE_URL}/api/auth/reset-password/reset-token`,
        token: "reset-token",
      })
    ).rejects.toMatchObject({
      body: { code: PASSWORD_RESET_DELIVERY_ERROR_CODE },
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    if (!event) throw new Error("Expected failure event");
    expect(event.correlation.requestId).toBe(event.eventId);
    return expect(redactSemanticEvent(event).correlation.requestId).toBe(
      event.eventId
    );
  });

  it("awaits delivery and reports a redacted failure to Better Auth's scheduler", async () => {
    let resolveDelivery!: (result: EmailDeliveryResult) => void;
    const pendingDelivery = new Promise<EmailDeliveryResult>((resolve) => {
      return (resolveDelivery = resolve);
    });
    const email: EmailPort = {
      sendPasswordReset: vi.fn(),
      sendEmailVerification: vi.fn().mockReturnValue(pendingDelivery),
    };
    const auth = createConfiguredAuth(email);

    const delivery = auth.options.emailVerification.sendVerificationEmail({
      user: {
        id: "user-1",
        email: "member@domain.test",
        name: "Member Example",
      },
      url: verificationUrl,
      token: "secret-token-not-for-errors",
    });
    expect(backgroundTasks).toHaveLength(0);

    resolveDelivery({
      status: "failed",
      provider: "resend",
      code: "EMAIL_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    return await expect(delivery).rejects.toMatchObject({
      body: {
        code: EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
        message: "Email verification delivery is unavailable",
      },
    });
  });

  it("redacts thrown provider failures before Better Auth schedules them", async () => {
    const email: EmailPort = {
      sendPasswordReset: vi.fn(),
      sendEmailVerification: vi
        .fn()
        .mockRejectedValue(new Error("provider-secret-must-not-escape")),
    };
    const auth = createConfiguredAuth(email);

    const backgroundError = await auth.options.emailVerification
      .sendVerificationEmail({
        user: {
          id: "user-1",
          email: "member@domain.test",
          name: "Member Example",
        },
        url: verificationUrl,
        token: "secret-token-not-for-errors",
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(backgroundError).toMatchObject({
      body: {
        code: EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
        message: "Email verification delivery is unavailable",
      },
    });
    return expect(JSON.stringify(backgroundError)).not.toContain(
      "provider-secret-must-not-escape"
    );
  });

  it("resolves a successful verification delivery without nesting a background task", async () => {
    const { email } = createEmail();
    const auth = createConfiguredAuth(email);

    await expect(
      auth.options.emailVerification.sendVerificationEmail({
        user: {
          id: "user-1",
          email: "member@domain.test",
          name: "Member Example",
        },
        url: verificationUrl,
        token: "secret-token-not-for-errors",
      })
    ).resolves.toBeUndefined();
    return expect(backgroundTasks).toHaveLength(0);
  });

  it("rejects verification expiry below one minute, above one day, or fractional", () => {
    const { email } = createEmail();

    for (const expiresIn of [0, 59, 61, 86_401, 60.5]) {
      expect(() => createConfiguredAuth(email, expiresIn)).toThrowError(
        "verificationEmailTokenExpiresInSeconds must be a whole-minute integer from 60 to 86400"
      );
    }

    for (const expiresIn of [0, -60, 60.5, 61, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => {
        return createConfiguredAuth(email, 60 * 60, undefined, expiresIn);
      }).toThrowError(
        "resetPasswordTokenExpiresInSeconds must be a positive whole-minute integer"
      );
    }
  });

  return it("installs the email normalization hook used by manual verification requests", () => {
    const { email } = createEmail();
    const auth = createConfiguredAuth(email);
    return expect(auth.options.hooks.before).toEqual(expect.any(Function));
  });
});
