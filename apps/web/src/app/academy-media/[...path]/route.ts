// What: Bare 404 for an Academy media file that the static assets do not hold.
// Used by: Academy thumbnails, videos and captions (packages/academy/src/lessons/media-manifest.json)
// when VERTEX_ACADEMY_MEDIA_BASE_URL is unset and the rendered files are absent (E2E, fresh checkouts).
// See: docs/debugging.md#symptom--where-to-look (503 DATABASE_CAPACITY).
//
// Static assets answer first; this route runs only on a miss. Without it, every
// missing file rendered the not-found page, whose root layout reads the
// signed-in theme through its own request DB scope. One Academy gallery load
// requests about ten thumbnails at once, which filled the 8-scope isolate cap
// and turned concurrent page and session reads into 503 DATABASE_CAPACITY.

const missingMedia = (): Response =>
  new Response(null, {
    headers: { "cache-control": "no-store" },
    status: 404,
  });

export const GET = missingMedia;
export const HEAD = missingMedia;
