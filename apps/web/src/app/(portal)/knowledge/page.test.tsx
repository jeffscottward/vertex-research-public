import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestPortalSession: vi.fn(),
  headers: vi.fn(
    async () =>
      new Headers({
        "cf-connecting-ip": "203.0.113.42",
        cookie: "better-auth.session_token=opaque",
      })
  ),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: mocks.getRequestPortalSession,
}));

import KnowledgePage, { metadata } from "./page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.getRequestPortalSession.mockReset();
});

const html = async () => renderToStaticMarkup(await KnowledgePage());

describe("KnowledgePage", () => {
  it("shows operators the fallback note when no kb-chat address is set", async () => {
    vi.stubEnv("VERTEX_KB_CHAT_URL", "");
    mocks.getRequestPortalSession.mockResolvedValueOnce({ isOperator: true });
    const markup = await html();
    expect(metadata).toEqual({ title: "Knowledge chat" });
    expect(markup).toContain(">Knowledge chat</h1>");
    expect(markup).toContain('data-kb-chat="unavailable"');
    expect(markup).not.toContain("<iframe");
  });

  it("frames kb-chat for operators with a title, a fixed sandbox and no referrer", async () => {
    vi.stubEnv("VERTEX_KB_CHAT_URL", "https://rig.example.ts.net/kb");
    mocks.getRequestPortalSession.mockResolvedValueOnce({ isOperator: true });
    const markup = await html();
    // Only the trading and commodities KBs: kb-chat enforces ?category= in its back end.
    expect(markup).toContain(
      'src="https://rig.example.ts.net/kb?category=trading%2Ccommodities"'
    );
    expect(markup).toContain('title="Knowledge chat (kb-chat on the rig)"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"'
    );
  });

  it("never gives a non-operator or a signed-out caller the kb-chat address", async () => {
    vi.stubEnv("VERTEX_KB_CHAT_URL", "https://rig.example.ts.net/kb");
    for (const session of [{ isOperator: false }, null]) {
      mocks.getRequestPortalSession.mockResolvedValueOnce(session);
      const markup = await html();
      expect(markup).toContain(">Knowledge chat</h1>");
      expect(markup).not.toContain("<iframe");
      expect(markup).not.toContain("rig.example.ts.net");
      expect(markup).toContain('data-operator-feature="knowledge-chat"');
    }
    expect(mocks.getRequestPortalSession).toHaveBeenCalledWith(
      "better-auth.session_token=opaque",
      "203.0.113.42"
    );
  });
});
