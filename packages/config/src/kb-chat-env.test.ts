import { describe, expect, it } from "vitest";

import { parseKbChatUrl, serverEnvSchema } from "./server.ts";

describe("parseKbChatUrl", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["http://rig.tailnet.ts.net/kb", null],
    ["not a url", null],
    ["https://user:pw@rig.tailnet.ts.net/kb", null],
    ["https://rig.tailnet.ts.net/kb?x=1", null],
    ["https://rig.tailnet.ts.net/kb", "https://rig.tailnet.ts.net/kb"],
  ])("%s -> %s", (value, expected) => {
    expect(parseKbChatUrl({ VERTEX_KB_CHAT_URL: value })).toBe(expected);
  });

  it("is an optional server env value", () => {
    const schema = serverEnvSchema.shape.VERTEX_KB_CHAT_URL;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("http://rig.tailnet.ts.net/kb").success).toBe(
      false
    );
  });
});
