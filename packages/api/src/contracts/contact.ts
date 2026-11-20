import { oc } from "@orpc/contract";
import { z } from "zod";

const MAILBOX_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const SINGLE_LINE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]*$/;
const MESSAGE_TEXT_PATTERN =
  /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

export const ContactSubmitInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100).regex(SINGLE_LINE_TEXT_PATTERN),
    email: z.string().trim().max(254).regex(MAILBOX_PATTERN),
    subject: z.string().trim().min(1).max(200).regex(SINGLE_LINE_TEXT_PATTERN),
    message: z.string().trim().min(1).max(5000).regex(MESSAGE_TEXT_PATTERN),
    website: z.string().max(200).optional(),
  })
  .strict();

export const ContactSubmitOutputSchema = z
  .object({
    status: z.enum(["sent", "previewed", "not-delivered"]),
  })
  .strict();

// The request limit check runs before delivery starts, at the edge route and in the service: a
// failed check proves that the message was not sent.
export const CONTACT_LIMIT_CHECK_FAILED_MESSAGE =
  "Message not sent: the request limit check failed inside the API; retry later";

export const CONTACT_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid contact request" },
  VALIDATION_ERROR: {
    status: 422,
    message: "Contact request validation failed",
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: "Contact request payload too large",
  },
  TOO_MANY_REQUESTS: {
    status: 429,
    message: "Too many contact requests",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message:
      "Message delivery not confirmed: the mail delivery request failed; retry later",
  },
} as const;

const contact = oc.errors(CONTACT_ERRORS);

const submit = contact
  .route({
    method: "POST",
    path: "/contact",
    operationId: "contact.submit",
    summary: "Submit a public contact request",
    tags: ["Contact"],
  })
  .input(ContactSubmitInputSchema)
  .output(ContactSubmitOutputSchema);

export const contactContract = { submit };

export type ContactSubmitInput = z.input<typeof ContactSubmitInputSchema>;
export type ContactSubmitOutput = z.infer<typeof ContactSubmitOutputSchema>;
