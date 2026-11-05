import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// Fake chat completions endpoint for the browser E2E run. It answers every POST with one
// fixed assistant message in the OpenAI/OpenRouter response shape, so the assistant spec
// sends a message and gets a stubbed reply with no real model key. Loopback only; the app
// reaches it through the run's HTTPS proxy (E2E_ASSISTANT_MODEL_URL). Fictional text only.

export const FAKE_ASSISTANT_MODEL_HOST = "assistant-model-fake";
export const FAKE_ASSISTANT_MODEL_PATH = "/v1/chat/completions";
// Passes the OPENROUTER_API_KEY schema; it is not a real credential.
export const FAKE_ASSISTANT_MODEL_KEY =
  "e2e-fake-openrouter-key-0123456789abcdef";
export const FAKE_ASSISTANT_REPLY =
  "Stubbed reply: this fictional answer comes from the E2E fake model.";

const drain = async (request: IncomingMessage): Promise<void> => {
  for await (const _chunk of request) {
    // Discard the request body.
  }
};

export const startFakeAssistantModel = async (): Promise<
  Readonly<{ port: number; close: () => Promise<void> }>
> => {
  const server = createServer(async (request, response) => {
    await drain(request);
    const ok =
      request.method === "POST" && request.url === FAKE_ASSISTANT_MODEL_PATH;
    response.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        ok
          ? {
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: FAKE_ASSISTANT_REPLY, role: "assistant" },
                },
              ],
              usage: { completion_tokens: 12, prompt_tokens: 40 },
            }
          : { error: { message: "not_found" } }
      )
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return Object.freeze({
    close: async () => {
      server.close();
      await once(server, "close");
    },
    port: (server.address() as AddressInfo).port,
  });
};
