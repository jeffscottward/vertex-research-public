// Server-only: rendered Academy media per lesson slug, resolved against the optional external media
// host (VERTEX_ACADEMY_MEDIA_BASE_URL; an invalid value falls back to same-origin paths).
import {
  ACADEMY_MEDIA,
  type AcademyMedia,
  withAcademyMediaBaseUrl,
} from "@darkfactory/academy/lessons";
import { parseAcademyMediaBaseUrl } from "@darkfactory/config/server";

export const academyMedia = (): Record<string, AcademyMedia> => {
  const mediaBaseUrl = parseAcademyMediaBaseUrl(process.env) ?? undefined;
  return Object.fromEntries(
    Object.entries(ACADEMY_MEDIA).map(([slug, entry]) => [
      slug,
      withAcademyMediaBaseUrl(entry, mediaBaseUrl),
    ])
  );
};
