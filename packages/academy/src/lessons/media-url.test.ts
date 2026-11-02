import { describe, expect, it } from "vitest";

import { withAcademyMediaBaseUrl } from "./index.ts";

describe("withAcademyMediaBaseUrl", () => {
  const media = {
    video: "/academy-media/example/lesson.mp4",
    captions: "/academy-media/example/captions.vtt",
    thumbnail: "/academy-media/example/thumb.jpg",
    durationSeconds: 42,
    bytes: 100,
    sha256: "hash",
    renderedAt: "2026-10-28T00:00:00Z",
  };

  it("keeps root-relative URLs when no base URL is configured", () => {
    expect(withAcademyMediaBaseUrl(media, undefined)).toEqual(media);
  });

  it("joins every media path to a configured base URL", () => {
    expect(
      withAcademyMediaBaseUrl(media, "https://rig.example.test/reports/")
    ).toMatchObject({
      video:
        "https://rig.example.test/reports/academy-media/example/lesson.mp4",
      captions:
        "https://rig.example.test/reports/academy-media/example/captions.vtt",
      thumbnail:
        "https://rig.example.test/reports/academy-media/example/thumb.jpg",
    });
  });
});
