import { describe, expect, it } from "vitest";

import { parseAcademyMediaBaseUrl } from "./server.ts";

describe("parseAcademyMediaBaseUrl", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["http://rig.tailnet.ts.net/media", null],
    ["not a url", null],
    ["https://user:pw@rig.tailnet.ts.net/media", null],
    ["https://rig.tailnet.ts.net/media?x=1", null],
    ["https://rig.tailnet.ts.net/media", "https://rig.tailnet.ts.net/media"],
  ])("%s -> %s", (value, expected) => {
    expect(
      parseAcademyMediaBaseUrl({ VERTEX_ACADEMY_MEDIA_BASE_URL: value })
    ).toBe(expected);
  });
});
