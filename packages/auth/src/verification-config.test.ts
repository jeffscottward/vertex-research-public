import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

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
  createAuth,
  EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
  PASSWORD_RESET_DELIVERY_ERROR_CODE,
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
  resetPasswordTokenExpiresInSeconds?: number
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

describe("auth email delivery failure diagnostics", () => {
  const user = {
    id: "user-secret-id",
    email: "member-secret@domain.test",
    name: "Member Secret Name",
  };
  const resetUrl = `${BASE_URL}/api/auth/reset-password/reset-secret-token`;
  const sensitiveValues = [
    user.id,
    user.email,
    user.name,
    "reset-secret-token",
    "header.payload.signature",
    "private-message",
  ];
  const failedResult: EmailDeliveryResult = {
    status: "failed",
    provider: "preview",
    code: "EMAIL_PREVIEW_WRITE_FAILED",
    retryable: true,
  };

  // Recipient-limit store failures are covered in abuse-limits.test.ts,
  // which mocks the rate-limit store.
  const createReportingAuth = (
    email: EmailPort,
    onEmailDeliveryFailure = vi.fn()
  ) => {
    const auth = createAuth({
      database: {} as never,
      secret: "auth-test-secret-with-at-least-32-characters",
      baseURL: BASE_URL,
      email,
      scheduleBackgroundTask: () => undefined,
      rateLimitEnabled: false,
      onEmailDeliveryFailure,
    }) as unknown as { options: CapturedAuthOptions };
    const sendReset = () =>
      auth.options.emailAndPassword.sendResetPassword({
        user,
        url: resetUrl,
        token: "reset-secret-token",
      });
    const sendVerification = () =>
      auth.options.emailVerification.sendVerificationEmail({
        user,
        url: verificationUrl,
        token: "header.payload.signature",
      });
    return { onEmailDeliveryFailure, sendReset, sendVerification };
  };

  const portWith = (send: Mock): EmailPort => ({
    sendPasswordReset: send,
    sendEmailVerification: send,
  });

  const expectNoSensitiveValue = (value: unknown) => {
    const serialized = JSON.stringify(value);
    for (const sensitive of sensitiveValues) {
      expect(serialized).not.toContain(sensitive);
    }
  };

  it.each([
    ["password-reset", "sendReset", PASSWORD_RESET_DELIVERY_ERROR_CODE],
    [
      "email-verification",
      "sendVerification",
      EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
    ],
  ] as const)(
    "reports the port failure code for %s and keeps the thrown error",
    async (operation, send, thrownCode) => {
      const reporting = createReportingAuth(
        portWith(vi.fn().mockResolvedValue(failedResult))
      );

      await expect(reporting[send]()).rejects.toMatchObject({
        body: { code: thrownCode },
      });

      expect(reporting.onEmailDeliveryFailure).toHaveBeenCalledOnce();
      expect(reporting.onEmailDeliveryFailure).toHaveBeenCalledWith({
        operation,
        reason: "delivery-failed",
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        provider: "preview",
        retryable: true,
      });
      return expectNoSensitiveValue(
        reporting.onEmailDeliveryFailure.mock.calls
      );
    }
  );

  it("reports a thrown reset port error by name and redacts the thrown error", async () => {
    class ProviderTimeoutError extends Error {
      override name = "ProviderTimeoutError";
    }
    const thrown = new ProviderTimeoutError(`private-message ${user.email}`);
    const reporting = createReportingAuth(
      portWith(vi.fn().mockRejectedValue(thrown))
    );

    const backgroundError = await reporting.sendReset().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(backgroundError).toMatchObject({
      body: { code: PASSWORD_RESET_DELIVERY_ERROR_CODE },
    });
    expectNoSensitiveValue(backgroundError);

    expect(reporting.onEmailDeliveryFailure).toHaveBeenCalledWith({
      operation: "password-reset",
      reason: "delivery-threw",
      errorName: "ProviderTimeoutError",
    });
    return expectNoSensitiveValue(reporting.onEmailDeliveryFailure.mock.calls);
  });

  it.each([
    ["a non-Error value", "private-message", "NonError"],
    [
      "an Error with an unsafe name",
      Object.assign(new Error("private-message"), {
        name: "private-message member-secret@domain.test\nforged",
      }),
      "UnknownError",
    ],
    [
      "an Error with an overlong name",
      Object.assign(new Error("private-message"), { name: "E".repeat(65) }),
      "UnknownError",
    ],
  ] as const)(
    "reports a thrown verification port error from %s by a safe name",
    async (_label, thrown, errorName) => {
      const reporting = createReportingAuth(
        portWith(vi.fn().mockRejectedValue(thrown))
      );

      await expect(reporting.sendVerification()).rejects.toMatchObject({
        body: { code: EMAIL_VERIFICATION_DELIVERY_ERROR_CODE },
      });

      expect(reporting.onEmailDeliveryFailure).toHaveBeenCalledWith({
        operation: "email-verification",
        reason: "delivery-threw",
        errorName,
      });
      return expectNoSensitiveValue(
        reporting.onEmailDeliveryFailure.mock.calls
      );
    }
  );

  it("keeps the thrown error when the diagnostic callback throws", async () => {
    const reporting = createReportingAuth(
      portWith(vi.fn().mockResolvedValue(failedResult)),
      vi.fn(() => {
        throw new Error("sink unavailable");
      })
    );

    await expect(reporting.sendReset()).rejects.toMatchObject({
      body: { code: PASSWORD_RESET_DELIVERY_ERROR_CODE },
    });
    return await expect(reporting.sendVerification()).rejects.toMatchObject({
      body: { code: EMAIL_VERIFICATION_DELIVERY_ERROR_CODE },
    });
  });

  it("contains a rejected promise from an async diagnostic callback", async () => {
    const rejection = Promise.reject(new Error("sink unavailable"));
    const catchSpy = vi.spyOn(rejection, "catch");
    const reporting = createReportingAuth(
      portWith(vi.fn().mockResolvedValue(failedResult)),
      vi.fn(() => rejection)
    );

    await expect(reporting.sendReset()).rejects.toMatchObject({
      body: { code: PASSWORD_RESET_DELIVERY_ERROR_CODE },
    });
    return expect(catchSpy).toHaveBeenCalledOnce();
  });

  return it("reports nothing when delivery succeeds", async () => {
    const reporting = createReportingAuth(
      portWith(
        vi.fn().mockResolvedValue({
          status: "previewed",
          provider: "preview",
          artifactPath: "/tmp/email.html",
        })
      )
    );

    await expect(reporting.sendReset()).resolves.toBeUndefined();
    await expect(reporting.sendVerification()).resolves.toBeUndefined();
    return expect(reporting.onEmailDeliveryFailure).not.toHaveBeenCalled();
  });
});
