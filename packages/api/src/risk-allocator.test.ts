import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { createApiClient } from "./client.ts";
import {
  type RiskAllocatorInput,
  RiskAllocatorInputSchema,
} from "./contracts/risk-allocator.ts";
import {
  daysToExpiry,
  OWNER_RISK_CAPS,
  suggestAllocation,
} from "./risk-allocator.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const NLV = 1_000_000;
const AS_OF = "2026-10-22";
const allocate = (input: Omit<RiskAllocatorInput, "asOf" | "nlv">) =>
  suggestAllocation(
    RiskAllocatorInputSchema.parse({ asOf: AS_OF, nlv: NLV, ...input })
  ).rows;

describe("owner risk caps snapshot", () => {
  it("matches the owner rules of 2026-10-16, 2026-10-21 and 2026-10-22", () => {
    expect(OWNER_RISK_CAPS).toMatchObject({
      copyBookNamePct: 10,
      copyBookTotalPct: 50,
      leapsMinDte: 365,
      leapsPremiumPct: 2,
      leapsPremiumPending: { commit: "b218d58", pct: 6 },
      optionsOnly: true,
      shortPremiumPct: 2,
    });
  });
});

describe("LEAPS cap once deployed", () => {
  it("uses 6% NLV when the live cap is raised", () => {
    const [row] = suggestAllocation(
      RiskAllocatorInputSchema.parse({
        asOf: AS_OF,
        candidates: [
          {
            expiry: "2027-10-22",
            kind: "option",
            symbol: "MSFT",
            unitCost: 7000,
          },
        ],
        nlv: NLV,
      }),
      { ...OWNER_RISK_CAPS, leapsPremiumPct: 6, leapsPremiumPending: null }
    ).rows;
    expect(row?.maxUnits).toBe(8);
  });
});

describe("daysToExpiry", () => {
  it("counts calendar days and rejects missing or bad dates", () => {
    expect(daysToExpiry("2027-10-22", AS_OF)).toBe(365);
    expect(daysToExpiry(null, AS_OF)).toBeNull();
    expect(daysToExpiry("2027-13-45", AS_OF)).toBeNull();
  });
});

describe("suggestAllocation", () => {
  it("never sizes shares for a non-Crown name", () => {
    const [row] = allocate({
      candidates: [{ kind: "share", symbol: "AAPL", unitCost: 200 }],
    });
    expect(row).toMatchObject({
      bindingLimit: null,
      maxUnits: 0,
      maxUsd: 0,
      ruleSet: "options-only",
    });
    expect(row?.limits).toEqual([]);
    expect(row?.blockedReasons[0]).toContain("Options only");
  });

  it("caps short-dated premium at 2% NLV, open premium in the name included", () => {
    const [row] = allocate({
      candidates: [
        {
          expiry: "2026-12-18",
          kind: "option",
          symbol: "MSFT",
          unitCost: 1000,
        },
      ],
      positions: [
        { kind: "option", symbol: "MSFT", value: 5000 },
        { kind: "share", symbol: "MSFT", value: 90_000 },
        { kind: "option", symbol: "NVDA", value: 9000 },
      ],
    });
    expect(row).toMatchObject({
      bindingLimit: "option-premium",
      isLeaps: false,
      maxUnits: 15,
      maxUsd: 15_000,
      ruleSet: "options-only",
    });
    expect(row?.limits).toHaveLength(1);
    expect(row?.limits[0]).toMatchObject({ capUsd: 20_000, usedUsd: 5000 });
  });

  it("sizes LEAPS with the live gateway cap (2% until b218d58 deploys)", () => {
    const [row] = allocate({
      candidates: [
        {
          expiry: "2027-10-22",
          kind: "option",
          symbol: "MSFT",
          unitCost: 7000,
        },
      ],
    });
    expect(row).toMatchObject({ isLeaps: true, maxUnits: 2, maxUsd: 14_000 });
  });

  it("applies the short cap when the expiry is missing and blocks expired options", () => {
    const [missing, expired] = allocate({
      candidates: [
        { kind: "option", symbol: "MSFT", unitCost: 1000 },
        {
          expiry: "2026-10-01",
          kind: "option",
          symbol: "MSFT",
          unitCost: 1000,
        },
      ],
    });
    expect(missing).toMatchObject({ isLeaps: false, maxUnits: 20 });
    expect(missing?.blockedReasons[0]).toContain("Expiry missing");
    expect(expired).toMatchObject({ bindingLimit: null, maxUnits: 0 });
  });

  it("uses the 10%/50% caps only for Crown copy-book legs", () => {
    const rows = allocate({
      candidates: [
        { crownCopy: true, kind: "share", symbol: "XOM", unitCost: 100 },
        { crownCopy: true, kind: "share", symbol: "CVX", unitCost: 100 },
        {
          crownCopy: true,
          expiry: "2026-12-18",
          kind: "option",
          symbol: "XOM",
          unitCost: 1000,
        },
      ],
      positions: [
        { crownCopy: true, kind: "share", symbol: "XOM", value: 60_000 },
        { crownCopy: true, kind: "share", symbol: "SLB", value: 400_000 },
        // Not a copy leg: it does not count toward the copy-book caps.
        { kind: "option", symbol: "XOM", value: 15_000 },
      ],
    });
    expect(rows[0]).toMatchObject({
      bindingLimit: "copy-name",
      maxUnits: 400,
      ruleSet: "crown-copy",
    });
    expect(rows[1]).toMatchObject({
      bindingLimit: "copy-total",
      maxUnits: 400,
    });
    expect(rows[2]).toMatchObject({
      bindingLimit: "option-premium",
      maxUnits: 5,
      ruleSet: "crown-copy",
    });
  });
});

const at = new Date("2026-10-22T10:00:00.000Z");
const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-22T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const clientFor = (requestSession: SafeAuthSession | null) =>
  createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request: Request) => {
      const denied = () =>
        new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      const context = createApiContext(request, {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories: {} as unknown as Repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (requestSession === null) throw denied();
          return requestSession;
        },
      });
      return handleApiRequest(request, context);
    },
  });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => new Error("Expected the oRPC call to fail"),
    (error: unknown) => error
  );

describe("riskAllocator procedures", () => {
  it("are operator-only", async () => {
    const denied = await failure(clientFor(null).riskAllocator.caps({}));
    expect(denied).toBeInstanceOf(ORPCError);
    expect(denied).toMatchObject({ code: "UNAUTHORIZED" });
    const outsider = await failure(
      clientFor(session("outsider")).riskAllocator.suggest({
        asOf: AS_OF,
        candidates: [{ kind: "share", symbol: "AAPL", unitCost: 1 }],
        nlv: NLV,
      })
    );
    expect(outsider).toMatchObject({ code: "FORBIDDEN" });
  });

  it("return the caps and advisory rows to operators", async () => {
    const client = clientFor(session("operator"));
    expect(await client.riskAllocator.caps({})).toEqual(OWNER_RISK_CAPS);
    const result = await client.riskAllocator.suggest({
      asOf: AS_OF,
      candidates: [{ kind: "share", symbol: "AAPL", unitCost: 200 }],
      nlv: NLV,
    });
    expect(result.advisoryOnly).toBe(true);
    expect(result.rows[0]?.maxUnits).toBe(0);
  });
});
