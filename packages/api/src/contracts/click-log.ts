import { oc } from "@orpc/contract";
import { z } from "zod";

// UI click log (card vertex-click-log): the portal records clicks and form submits so an operator
// can see what a user did before a problem. Debug data only, kept 14 days. An event never holds
// typed text, field values, tokens or numbers shown on screen: the client and the server both run
// redactClickText (../click-log-redaction.ts) over every text field. The user id comes from the
// session, never from the input.

export const CLICK_LOG_BATCH_MAX = 25;
export const CLICK_LOG_QUERY_LIMIT_MAX = 1000;
export const CLICK_LOG_LABEL_MAX = 80;
export const CLICK_LOG_ROUTE_MAX = 300;
export const CLICK_LOG_REQUEST_IDS_MAX = 8;

export const CLICK_LOG_KINDS = ["click", "submit"] as const;
export const CLICK_LOG_ROLES = [
  "button",
  "link",
  "menuitem",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "summary",
  "form",
] as const;

export const CLICK_LOG_API_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Click log storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const RouteSchema = z.string().min(1).max(CLICK_LOG_ROUTE_MAX).startsWith("/");
// Same shape as the server's correlation ids (resolveApiRequestId in ../server/context.ts).
export const ClickLogRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const ClickLogBuildShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{7,40}|unknown)$/u);

export const ClickLogEventInputSchema = z
  .object({
    at: z.iso.datetime({ offset: true }),
    important: z.boolean(),
    kind: z.enum(CLICK_LOG_KINDS),
    label: z.string().max(CLICK_LOG_LABEL_MAX),
    requestIds: z.array(ClickLogRequestIdSchema).max(CLICK_LOG_REQUEST_IDS_MAX),
    role: z.enum(CLICK_LOG_ROLES),
    route: RouteSchema,
    targetRoute: z.string().min(1).max(CLICK_LOG_ROUTE_MAX).nullable(),
    testId: z.string().max(CLICK_LOG_LABEL_MAX).nullable(),
  })
  .strict();
export type ClickLogEventInput = z.infer<typeof ClickLogEventInputSchema>;

export const ClickLogRecordInputSchema = z
  .object({
    buildSha: ClickLogBuildShaSchema,
    events: z.array(ClickLogEventInputSchema).min(1).max(CLICK_LOG_BATCH_MAX),
    tabId: z.uuid(),
  })
  .strict();
export type ClickLogRecordInput = z.infer<typeof ClickLogRecordInputSchema>;

export const ClickLogRecordOutputSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

export const ClickLogQueryInputSchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CLICK_LOG_QUERY_LIMIT_MAX)
      .optional(),
    to: z.iso.datetime({ offset: true }),
    /** A user id or an email address. Omit it to read every user. */
    user: z.string().trim().min(1).max(320).optional(),
  })
  .strict()
  .refine((input) => Date.parse(input.from) <= Date.parse(input.to), {
    message: "from must not be after to",
  });
export type ClickLogQueryInput = z.infer<typeof ClickLogQueryInputSchema>;

export const ClickLogEventSchema = z.object({
  buildSha: z.string(),
  id: z.string(),
  important: z.boolean(),
  kind: z.enum(CLICK_LOG_KINDS),
  label: z.string(),
  occurredAt: z.date(),
  receivedAt: z.date(),
  recordRequestId: z.string(),
  requestIds: z.array(z.string()),
  role: z.enum(CLICK_LOG_ROLES),
  route: z.string(),
  tabId: z.string(),
  targetRoute: z.string().nullable(),
  testId: z.string().nullable(),
  userEmail: z.string().nullable(),
  userId: z.string(),
});
export type ClickLogEvent = z.infer<typeof ClickLogEventSchema>;

export const ClickLogQueryOutputSchema = z.object({
  events: z.array(ClickLogEventSchema),
  truncated: z.boolean(),
});

const base = oc.errors(CLICK_LOG_API_ERRORS);
const TAGS = ["Click log"];

const record = base
  .route({
    method: "POST",
    operationId: "clickLog.record",
    path: "/click-log/events",
    summary: "Record a batch of the signed-in user's UI clicks (debug log)",
    tags: TAGS,
  })
  .input(ClickLogRecordInputSchema)
  .output(ClickLogRecordOutputSchema);

const query = base
  .route({
    method: "GET",
    operationId: "clickLog.query",
    path: "/click-log/events",
    summary:
      "Read recorded UI clicks for one user or all users in a time range",
    tags: TAGS,
  })
  .input(ClickLogQueryInputSchema)
  .output(ClickLogQueryOutputSchema);

export const clickLogContract = { query, record };
