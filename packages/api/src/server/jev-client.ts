// Read-only HTTP client for the TypeSafe JEV decisions model on OpenRouter.
// - One POST per call with a bearer key; the key and URL never appear in messages or results.
// - Timeout (default 60 s), 256 KiB response cap, redirects never followed.
// - Failures report only a category and the HTTP status code; never headers or the body.
// The caller decides what goes into `state`: this client sends the body it is given.

export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_DEFAULT_MODEL = "~typesafe/jev-latest";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const PRINTABLE_KEY = /^[\x21-\x7e]{20,512}$/u;

export type JevConfig = Readonly<{ apiKey: string; model: string }>;

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

export type JevClientOptions = Readonly<{
  fetch?: JevFetch;
  timeoutMs?: number;
  maxBytes?: number;
}>;

export type JevCallResult =
  // `document` is untrusted JSON; the caller parses it with a schema.
  | Readonly<{ ok: true; document: unknown }>
  | Readonly<{
      ok: false;
      reason: "http" | "timeout" | "invalid";
      status: number | null;
    }>;

// Null when the key is missing or malformed (the same rules as OPENROUTER_API_KEY).
export const resolveJevConfig = (
  apiKey: string | null | undefined,
  model: string = JEV_DEFAULT_MODEL
): JevConfig | null => {
  if (typeof apiKey !== "string" || !PRINTABLE_KEY.test(apiKey)) return null;
  return { apiKey, model };
};

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<string | null> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export const callJev = async (
  config: JevConfig,
  body: Readonly<Record<string, unknown>>,
  options: JevClientOptions = {}
): Promise<JevCallResult> => {
  const doFetch: JevFetch =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(JEV_DECISIONS_URL, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "timeout" : "http",
        status: null,
      };
    }
    if (response.status !== 200)
      return { ok: false, reason: "http", status: response.status };
    let text: string | null;
    try {
      text = await readCapped(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "timeout" : "invalid",
        status: 200,
      };
    }
    if (text === null) return { ok: false, reason: "invalid", status: 200 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, reason: "invalid", status: 200 };
    }
    return { document: parsed, ok: true };
  } finally {
    clearTimeout(timer);
  }
};
