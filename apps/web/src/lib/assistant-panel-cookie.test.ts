import { describe, expect, it } from "vitest";

import {
  parseAssistantPanelCookie,
  serializeAssistantPanelCookie,
} from "./assistant-panel-cookie.ts";
import { MAX_COOKIE_HEADER_LENGTH } from "./theme.ts";

describe("assistant panel cookie", () => {
  it("reads one open or closed value and ignores anything else", () => {
    expect(parseAssistantPanelCookie("vx.assistantPanel=open")).toBe(true);
    expect(
      parseAssistantPanelCookie("a=1; vx.assistantPanel=closed; b=2")
    ).toBe(false);
    for (const header of [
      null,
      undefined,
      "",
      "a=1",
      "vx.assistantPanel=maybe",
      "vx.assistantPanel=",
      "vx.assistantPanelX=open",
      "vx.assistantPanel=open; vx.assistantPanel=closed",
      `vx.assistantPanel=open; pad=${"x".repeat(MAX_COOKIE_HEADER_LENGTH)}`,
    ])
      expect(parseAssistantPanelCookie(header)).toBeUndefined();
    return;
  });

  it("writes a one-year, site-wide, Lax cookie", () => {
    expect(serializeAssistantPanelCookie(true)).toBe(
      "vx.assistantPanel=open; Path=/; Max-Age=31536000; SameSite=Lax; Secure"
    );
    return expect(serializeAssistantPanelCookie(false)).toBe(
      "vx.assistantPanel=closed; Path=/; Max-Age=31536000; SameSite=Lax; Secure"
    );
  });
});
