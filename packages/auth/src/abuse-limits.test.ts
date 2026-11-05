import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options: unknown) => ({ options })),
  drizzleAdapter: vi.fn(() => ({ id: "drizzle-adapter" })),
  consume: vi.fn(),
}));

vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));
vi.mock("@better-auth/drizzle-adapter", () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));
vi.mock("./rate-limit-storage.ts", () => ({
  createAtomicAuthRateLimitStorage: () => ({
    get: vi.fn(),
    set: vi.fn(),
    consume: mocks.consume,
  }),
}));

import type { EmailPort } from "@darkfactory/email";
import {
  createAuth,
  EMAIL_VERIFICATION_DELIVERY_ERROR_CODE,
  PASSWORD_RESET_DELIVERY_ERROR_CODE,
} from "./server.ts";

const BASE_URL = "https://darkfactory.localhost";
const EMAIL = "member@domain.test";

type DeliveryCallback = (
  input: Readonly<{
    user: Readonly<{ id: string; email: string; name: string }>;
    url: string;
    token: string;
  }>
) => Promise<void>;

type BeforeHook = (context: {
  path: string;
  body?: unknown;
  context: unknown;
}) => Promise<unknown>;

type CapturedAuthOptions = Readonly<{
  hooks: Readonly<{ before: BeforeHook }>;
  plugins: readonly Readonly<{
    id: string;
    options?: Readonly<{ enabled?: boolean }>;
  }>[];
  rateLimit: Readonly<{
    customRules: Readonly<
      Record<string, Readonly<{ window: number; max: number }>>
    >;
  }>;
  emailAndPassword: Readonly<{ sendResetPassword: DeliveryCallback }>;
  emailVerification: Readonly<{ sendVerificationEmail: DeliveryCallback }>;
}>;

const delivered = {
  status: "previewed",
  provider: "preview",
  artifactPath: "/tmp/mail.html",
} as const;

const createEmail = () => {
  const email: EmailPort = {
    sendPasswordReset: vi.fn().mockResolvedValue(delivered),
    sendEmailVerification: vi.fn().mockResolvedValue(delivered),
  };
  return email;
};

const configure = (
  email: EmailPort,
  overrides: Readonly<{
    rateLimitEnabled?: boolean;
    passwordBreachCheck?: boolean;
  }> = {}
) =>
  (
    createAuth({
      database: {} as never,
      secret: "auth-test-secret-with-at-least-32-characters",
      baseURL: BASE_URL,
      email,
      scheduleBackgroundTask: () => undefined,
      rateLimitEnabled: overrides.rateLimitEnabled ?? true,
      ...(overrides.passwordBreachCheck === undefined
        ? {}
        : { passwordBreachCheck: overrides.passwordBreachCheck }),
    }) as unknown as { options: CapturedAuthOptions }
  ).options;

const deliveryInput = {
  user: { id: "user-1", email: EMAIL, name: "Member Example" },
  url: `${BASE_URL}/api/auth/verify-email?token=t`,
  token: "t",
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

describe("auth abuse limits", () => {
  beforeEach(() => {
    mocks.betterAuth.mockClear();
    mocks.consume.mockReset();
    mocks.consume.mockResolvedValue({ allowed: true, retryAfter: null });
  });

  it("limits sign-up per client to five attempts per hour", () => {
    const options = configure(createEmail());

    return expect(options.rateLimit.customRules["/sign-up/email"]).toEqual({
      window: 3600,
      max: 5,
    });
  });

  it("checks new passwords against the breached-password corpus by default", () => {
    const plugin = configure(createEmail()).plugins.find(
      (candidate) => candidate.id === "have-i-been-pwned"
    );

    return expect(plugin?.options?.enabled).toBe(true);
  });

  it("can disable the breached-password check for offline test runtimes", () => {
    const plugin = configure(createEmail(), {
      passwordBreachCheck: false,
    }).plugins.find((candidate) => candidate.id === "have-i-been-pwned");

    return expect(plugin?.options?.enabled).toBe(false);
  });

  it("limits email sign-in per account with a hashed key", async () => {
    const before = configure(createEmail()).hooks.before;

    await before({
      path: "/sign-in/email",
      body: { email: "  Member@Domain.TEST ", password: "pw" },
      context: {},
    });

    expect(mocks.consume).toHaveBeenCalledOnce();
    const [key, rule] = mocks.consume.mock.calls[0] ?? [];
    expect(key).toBe(`sign-in-email:${await sha256Hex(EMAIL)}`);
    expect(String(key)).not.toContain(EMAIL);
    return expect(rule).toEqual({ window: 900, max: 10 });
  });

  it("rejects an email sign-in when the account limit is exhausted", async () => {
    mocks.consume.mockResolvedValue({ allowed: false, retryAfter: 120 });
    const before = configure(createEmail()).hooks.before;

    return await expect(
      before({
        path: "/sign-in/email",
        body: { email: EMAIL, password: "pw" },
        context: {},
      })
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it.each([
    ["rate limiting is disabled", "/sign-in/email", false],
    ["the path is not sign-in", "/sign-up/email", true],
  ] as const)(
    "does not consume the account limit when %s",
    async (_case, path, rateLimitEnabled) => {
      const before = configure(createEmail(), { rateLimitEnabled }).hooks
        .before;

      await before({ path, body: { email: EMAIL }, context: {} });

      return expect(mocks.consume).not.toHaveBeenCalled();
    }
  );

  it("caps verification and reset mail per recipient and skips silently", async () => {
    const email = createEmail();
    const options = configure(email);
    mocks.consume.mockResolvedValue({ allowed: false, retryAfter: 600 });

    await expect(
      options.emailVerification.sendVerificationEmail(deliveryInput)
    ).resolves.toBeUndefined();
    await expect(
      options.emailAndPassword.sendResetPassword(deliveryInput)
    ).resolves.toBeUndefined();

    expect(email.sendEmailVerification).not.toHaveBeenCalled();
    expect(email.sendPasswordReset).not.toHaveBeenCalled();
    const recipientKey = `auth-email-recipient:${await sha256Hex(EMAIL)}`;
    return expect(mocks.consume.mock.calls).toEqual([
      [recipientKey, { window: 3600, max: 5 }],
      [recipientKey, { window: 3600, max: 5 }],
    ]);
  });

  it("maps a recipient-cap store failure to the normalized delivery errors", async () => {
    const email = createEmail();
    const options = configure(email);
    mocks.consume.mockImplementation(async () => {
      throw new Error("store down");
    });

    await expect(
      options.emailVerification.sendVerificationEmail(deliveryInput)
    ).rejects.toMatchObject({
      body: { code: EMAIL_VERIFICATION_DELIVERY_ERROR_CODE },
    });
    await expect(
      options.emailAndPassword.sendResetPassword(deliveryInput)
    ).rejects.toMatchObject({
      body: { code: PASSWORD_RESET_DELIVERY_ERROR_CODE },
    });
    expect(email.sendEmailVerification).not.toHaveBeenCalled();
    return expect(email.sendPasswordReset).not.toHaveBeenCalled();
  });

  it("delivers mail within the recipient cap", async () => {
    const email = createEmail();
    const options = configure(email);

    await options.emailVerification.sendVerificationEmail(deliveryInput);
    await options.emailAndPassword.sendResetPassword(deliveryInput);

    expect(email.sendEmailVerification).toHaveBeenCalledOnce();
    return expect(email.sendPasswordReset).toHaveBeenCalledOnce();
  });

  it("does not consume the recipient cap when rate limiting is disabled", async () => {
    const email = createEmail();
    const options = configure(email, { rateLimitEnabled: false });

    await options.emailVerification.sendVerificationEmail(deliveryInput);

    expect(mocks.consume).not.toHaveBeenCalled();
    return expect(email.sendEmailVerification).toHaveBeenCalledOnce();
  });
});
