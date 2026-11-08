import { COURSE_LIST } from "@darkfactory/academy";
import { lessonSummaries, sourceCounts } from "@darkfactory/academy/lessons";
import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";
import { AcademyCatalog } from "../../../components/portal/academy/academy-gallery.tsx";
import {
  type AcademySearchParams,
  readAcademyGalleryQuery,
} from "../../../components/portal/academy/academy-gallery-query.ts";
import { OperatorAccessRequired } from "../../../components/portal/agent-ops-client.tsx";
import { academyMedia } from "../../../lib/academy-media.ts";
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
    return (
      <div className="space-y-6">
        <PageHeader title="Academy" variant="portal" />
        <OperatorAccessRequired feature="academy" />
      </div>
    );
  const lessons = lessonSummaries();
  const counts = sourceCounts();
  return (
    <AcademyCatalog
      courses={COURSE_LIST.map((course) => ({
        course: course.id,
        lessons: lessons.filter((lesson) => lesson.course === course.id),
        sourceCount: counts[course.id],
      }))}
      initialQuery={readAcademyGalleryQuery(await searchParams)}
      media={academyMedia()}
    />
  );
}
