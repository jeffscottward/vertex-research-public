import {
  ACADEMY_MEDIA,
  ACADEMY_SOURCES,
  lessonSummaries,
  withAcademyMediaBaseUrl,
} from "@darkfactory/academy/lessons";
import { parseAcademyMediaBaseUrl } from "@darkfactory/config/server";
import { headers } from "next/headers";
import { AcademyGallery } from "../../../components/portal/academy/academy-gallery.tsx";
import {
  type AcademySearchParams,
  readAcademyGalleryQuery,
} from "../../../components/portal/academy/academy-gallery-query.ts";
import { OperatorAccessRequired } from "../../../components/portal/agent-ops-client.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Academy" };

export default async function AcademyPage({
  searchParams,
}: Readonly<{ searchParams: Promise<AcademySearchParams> }>) {
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout. The Academy shows private transcripts: operators only.
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  if (session?.isOperator !== true)
    return <OperatorAccessRequired feature="academy" />;
  const mediaBaseUrl = parseAcademyMediaBaseUrl(process.env) ?? undefined;
  const media = Object.fromEntries(
    Object.entries(ACADEMY_MEDIA).map(([slug, entry]) => [
      slug,
      withAcademyMediaBaseUrl(entry, mediaBaseUrl),
    ])
  );
  return (
    <AcademyGallery
      initialQuery={readAcademyGalleryQuery(await searchParams)}
      lessons={lessonSummaries()}
      media={media}
      sourceCount={
        ACADEMY_SOURCES.filter((source) => source.duplicateOf === undefined)
          .length
      }
    />
  );
}
