import { z } from "zod";

// Signed confirm tokens for the owner order screen. A preview call issues a token that binds the
// user, the exact action (order fields or permId), a nonce and an expiry. Submit/cancel verify the
// HMAC and the binding, then consume the nonce once (in-process). The nonce also becomes the
// IBKR orderRef, so a replay on another process is refused by the gateway's orderRef check.

const ConfirmClaimsSchema = z
  .object({
    userId: z.string().min(1),
    action: z.string().min(1),
    nonce: z.string().min(1).max(64),
    expiresAt: z.number().int(),
  })
  .strict();

export const CONFIRM_TTL_MS = 120_000;

export type ConfirmClaims = Readonly<{
  userId: string;
  action: string;
  nonce: string;
  expiresAt: number;
}>;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/, "");

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> | null => {
  try {
    return Uint8Array.from(
      atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0)
    );
  } catch {
    return null;
  }
};

export const issueConfirmToken = async (
  secret: string,
  claims: ConfirmClaims
): Promise<string> => {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload)
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
};

const consumed = new Map<string, number>();

// Returns the claims when the token is valid for this user and action, else null. One use only.
export const consumeConfirmToken = async (
  secret: string,
  token: string,
  expected: Readonly<{ userId: string; action: string }>,
  now: number
): Promise<ConfirmClaims | null> => {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined)
    return null;
  const signatureBytes = fromBase64url(signature);
  // crypto.subtle.verify compares in constant time.
  if (
    signatureBytes === null ||
    !(await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      signatureBytes,
      encoder.encode(payload)
    ))
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(fromBase64url(payload) ?? new Uint8Array())
    );
  } catch {
    return null;
  }
  const result = ConfirmClaimsSchema.safeParse(parsed);
  if (!result.success) return null;
  const claims = result.data;
  if (
    claims.userId !== expected.userId ||
    claims.action !== expected.action ||
    claims.expiresAt < now ||
    consumed.has(claims.nonce)
  )
    return null;
  for (const [nonce, expiry] of consumed)
    if (expiry < now) consumed.delete(nonce);
  consumed.set(claims.nonce, claims.expiresAt);
  return claims;
};
